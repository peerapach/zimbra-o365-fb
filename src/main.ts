import { loadConfig } from './config/load.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ValidatedConfig } from './config/validate.js';
import { createListeners } from './http/listeners.js';
import type { SurfaceListener } from './http/listeners.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AvailabilityProvider, Provider, Surface, TargetResult, WindowUtc } from './core/types.js';
import { loadDirectory } from './directory/load.js';
import { normalizeAddress } from './directory/resolve.js';
import { createFreeBusyService } from './freebusy/service.js';
import { createRequestAdmission } from './resilience/bulkhead.js';
import { createEwsFault, createEwsRoute } from './ews/route.js';
import { authenticate, AUTH_FAILURE } from './security/auth.js';
import { createRateControls, createSourceResolver } from './security/rate-limit.js';
import type { loadPrincipals, Principal } from './security/principals.js';
import { routeAutodiscover } from './autodiscover/route.js';
import type { DestinationStream } from 'pino';
import { createSanitizedLogger } from './observability/logging.js';
import { createMetrics } from './observability/metrics.js';
import { createHealth } from './observability/health.js';

export interface GatewayRuntime {
  readonly registry: ReturnType<typeof loadPrincipals>;
  readonly providers: Readonly<Record<Provider, AvailabilityProvider>>;
  readonly monoMs: () => number;
  /** Approved listener-owned ingress metadata, never derived from HTTP headers. */
  readonly secureTransport: Readonly<Record<Surface, boolean>>;
  readonly policyRevision: string;
  readonly protocolProfile: unknown;
  /** Required with an injected config loader; production reads the original directory JSON. */
  readonly directoryInput?: unknown;
}

function sameDirectory(source: unknown, configured: ValidatedConfig['directory']): boolean {
  try {
    const raw = source as ValidatedConfig['directory'];
    if (raw.schemaVersion !== configured.schemaVersion || raw.entries.length !== configured.entries.length) return false;
    return raw.entries.every((entry, index) => {
      const expected = configured.entries[index]!;
      return entry.id === expected.id && entry.provider === expected.provider && entry.enabled === expected.enabled
        && entry.graphObjectId === expected.graphObjectId
        && normalizeAddress(entry.canonicalSmtp) === expected.canonicalSmtp
        && entry.aliases.length === expected.aliases.length
        && entry.aliases.every((alias, position) => normalizeAddress(alias) === expected.aliases[position])
        && entry.allowedPrincipals.length === expected.allowedPrincipals.length
        && entry.allowedPrincipals.every((id, position) => id === expected.allowedPrincipals[position]);
    });
  } catch { return false; }
}

interface StartupDependencies {
  runtime?: GatewayRuntime;
  load?: typeof loadConfig;
  create?: typeof createListeners;
  listen?: (app: SurfaceListener, address: { host: string; port: number }) => Promise<unknown>;
  close?: (app: SurfaceListener) => Promise<void>;
  logDestination?: DestinationStream;
  metrics?: ReturnType<typeof createMetrics>;
}

export async function startGateway(path: string, dependencies: StartupDependencies = {}) {
  const config = (dependencies.load ?? loadConfig)(path);
  const runtime = dependencies.runtime;
  if (config.environment === 'production' && !runtime) throw new Error('Gateway runtime dependencies required');
  const listeners = (dependencies.create ?? createListeners)(config);
  const listen = dependencies.listen ?? ((app, address) => app.listen(address));
  const close = dependencies.close ?? (app => app.close());
  const logger = createSanitizedLogger(dependencies.logDestination ?? process.stdout);
  const metrics = dependencies.metrics ?? createMetrics();
  const health = createHealth({ graceMs: config.limits.shutdownGraceMs, logger,
    close: async () => {
      const closed = await Promise.allSettled(Object.values(listeners).map(async app => close(app)));
      if (closed.some(result => result.status === 'rejected')) throw new Error('Gateway shutdown failed');
    }, force: () => { for (const app of Object.values(listeners)) app.server.closeAllConnections(); } });
  const observations = new WeakMap<FastifyRequest,
    { kind: 'complete'; window: WindowUtc; results: readonly TargetResult[] } | { kind: 'rejected'; reason: 'parser' | 'internal' }>();
  const finalized = new WeakSet<FastifyRequest>();
  const deadlines = new WeakMap<FastifyRequest, number>();
  const rejection = (surface: Surface, reason: string) => {
    metrics.rejection(surface, reason); logger.record('rejection', { surface, outcome: 'rejected' });
  };
  try {
    listeners.management.get('/readyz', async (_request, reply) => {
      const result = health.readiness(); return reply.code(result.status).send(result.body);
    });
    listeners.management.get('/metrics', async (_request, reply) => {
      const result = await metrics.render(listeners.management.surface);
      return result ? reply.type(result.contentType).send(result.body) : reply.code(404).send({ error: 'Request rejected' });
    });
    for (const app of Object.values(listeners)) app.addHook('onClose', async () => { health.unready(); });
    for (const app of [listeners.public, listeners.private]) {
      app.addHook('onRequest', async (request, reply) => {
        if (runtime) deadlines.set(request, runtime.monoMs() + config.limits.totalRequestDeadlineMs);
        if (!health.accepting()) return reply.header('connection', 'close').code(503).send({ error: 'Service unavailable' });
      });
      app.addHook('onResponse', async (request, reply) => {
        if (finalized.has(request)) return;
        const observation = observations.get(request);
        observations.delete(request);
        if (app.surface === 'management') return;
        finalized.add(request);
        // Irreversible outcomes are recorded only after the final HTTP status is committed.
        if (observation) {
          if (observation.kind === 'complete' && reply.statusCode === 200) {
            metrics.availability(app.surface, observation.window, observation.results, reply.statusCode);
            health.observe(app.surface, observation.window, observation.results);
            logger.record('request', { surface: app.surface, statusCode: reply.statusCode });
          } else rejection(app.surface, observation.kind === 'rejected' ? observation.reason : 'internal');
          return;
        }
        if (reply.statusCode >= 400 && request.routeOptions.url === '/EWS/Exchange.asmx') rejection(app.surface, reply.statusCode === 401 ? 'auth'
          : reply.statusCode === 429 || reply.statusCode === 503 ? 'admission' : reply.statusCode >= 500 ? 'internal' : 'parser');
        else logger.record(reply.statusCode >= 400 ? 'rejection' : 'request', { surface: app.surface, statusCode: reply.statusCode });
      });
    }
    if (runtime) {
      let directory: ReturnType<typeof loadDirectory>;
      try {
        const raw: unknown = dependencies.load === undefined
          ? JSON.parse(readFileSync(resolve(dirname(path), config.directoryFile), 'utf8')) as unknown
          : runtime.directoryInput;
        const source: unknown = structuredClone(raw);
        directory = loadDirectory(source, config.principals, runtime.policyRevision);
        if (!sameDirectory(source, config.directory)) throw new Error();
      } catch { throw new Error('Invalid gateway directory'); }
      const service = createFreeBusyService(directory, runtime.providers, { monoMs: runtime.monoMs, telemetry: metrics });
      const admit = createRequestAdmission();
      const rate = createRateControls(config.limits, runtime.monoMs);
      const source = createSourceResolver([]);
      for (const app of [listeners.public, listeners.private]) {
        const surface = app.surface;
        if (surface === 'management') throw new Error('Invalid application listener');
        const authenticated = new WeakMap<FastifyRequest, Principal>();
        const clientSignals = new WeakMap<FastifyRequest, AbortSignal>();
        const departures = new WeakMap<FastifyRequest, () => void>();
        const rateLimited = (request: FastifyRequest, reply: FastifyReply) => {
          request.raw.pause();
          reply.raw.once('finish', () => request.raw.destroy());
          return reply.header('connection', 'close').code(429).send({ error: 'Request rejected' });
        };
        app.addHook('onResponse', async request => { departures.get(request)?.(); });
        app.addHook('onSend', (request, reply, payload, done) => {
          if (request.routeOptions.url === '/EWS/Exchange.asmx' && reply.statusCode === 200) {
            const deadline = deadlines.get(request);
            const now = runtime.monoMs();
            if (deadline === undefined || !Number.isFinite(now) || now >= deadline || clientSignals.get(request)?.aborted) {
              const fault = createEwsFault('Server');
              reply.code(fault.status).removeHeader('content-length');
              return done(null, fault.body);
            }
          }
          done(null, payload);
        });
        app.addHook('onRequest', async (request, reply) => {
          let peer: string;
          try { peer = source(request.raw.socket.remoteAddress, undefined); }
          catch { return rateLimited(request, reply); }
          if (!rate.preAuth(peer)) return rateLimited(request, reply);
          const leave = admit(surface);
          if (!leave) {
            request.raw.pause();
            reply.raw.once('finish', () => request.raw.destroy());
            return reply.header('connection', 'close').code(503).send({ error: 'Service unavailable' });
          }
          const client = new AbortController();
          clientSignals.set(request, AbortSignal.any([client.signal, health.signal]));
          const release = () => {
            leave(); departures.delete(request);
            request.raw.removeListener('aborted', aborted); reply.raw.removeListener('close', closed);
          };
          const abandoned = () => {
            if (reply.raw.writableFinished || finalized.has(request) || request.routeOptions.url !== '/EWS/Exchange.asmx') return;
            finalized.add(request); observations.delete(request); rejection(surface, 'internal');
          };
          const aborted = () => { abandoned(); client.abort(); release(); };
          const closed = () => { if (!reply.raw.writableFinished) { abandoned(); client.abort(); } release(); };
          departures.set(request, release);
          request.raw.once('aborted', aborted); reply.raw.once('close', closed);
          if (request.raw.aborted || (reply.raw.destroyed && !reply.raw.writableFinished)) aborted();
          const principal = authenticate(runtime.registry, { surface, authorization: request.headers.authorization,
            secureTransport: runtime.secureTransport[surface] });
          if (!principal) {
            request.raw.pause();
            reply.raw.once('finish', () => request.raw.destroy());
            return reply.header('connection', 'close').header('www-authenticate', AUTH_FAILURE.challenge)
              .code(AUTH_FAILURE.status).send({ error: AUTH_FAILURE.error });
          }
          if (!rate.postAuth(principal.id)) return rateLimited(request, reply);
          authenticated.set(request, principal);
        });
        // Fastify's documented early reply keeps bounded ingestion and bypasses the 503 fallback.
        app.addHook('preHandler', async (request, reply) => {
          const principal = authenticated.get(request);
          const clientSignal = clientSignals.get(request);
          if (!principal || !clientSignal) return reply.code(401).send({ error: AUTH_FAILURE.error });
          if (request.routeOptions.url === '/EWS/Exchange.asmx') {
            const deadline = deadlines.get(request);
            if (deadline === undefined) throw new Error('Missing request deadline');
            // Capture route candidates; onResponse owns the one finalized observation.
            const ews = createEwsRoute(service, config.limits, runtime.monoMs, {
              complete: (_surface, window, results) => { if (!finalized.has(request)) observations.set(request, { kind: 'complete', window, results }); },
              rejected: (_surface, reason) => { if (!finalized.has(request)) observations.set(request, { kind: 'rejected', reason }); },
            });
            let result = await ews(principal, surface, request.body, request.headers.soapaction, clientSignal, deadline);
            // Awaiting the route yields once more; never commit success after that deadline.
            if (clientSignal.aborted || runtime.monoMs() >= deadline) result = createEwsFault('Server');
            return reply.type('text/xml; charset=utf-8').code(result.status).send(result.body);
          }
          if (surface === 'm365-inbound' && request.routeOptions.url === '/autodiscover/autodiscover.xml') {
            const result = routeAutodiscover({ principal, body: request.body, entries: config.directory.entries,
              advertisedOrigin: config.public.advertisedOrigin, profile: runtime.protocolProfile });
            return reply.headers(result.headers).code(result.status).send(result.body);
          }
        });
      }
    }
    for (const name of ['public', 'private', 'management'] as const) {
      await listen(listeners[name], { host: config[name].bind, port: config[name].port });
    }
    if (runtime) health.ready();
    return Object.freeze(Object.defineProperty({ ...listeners }, 'shutdown', { value: health.shutdown })) as typeof listeners & { shutdown(): Promise<void> };
  } catch (error) {
    const cleanup = await Promise.allSettled(Object.values(listeners).map(async app => close(app)));
    const failures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason as unknown);
    throw new AggregateError([error, ...failures], 'Gateway startup failed');
  }
}

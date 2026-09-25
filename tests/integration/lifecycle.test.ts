import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../../src/config/validate.js';
import type { AvailabilityProvider, CallContext, TargetResult } from '../../src/core/types.js';
import type { SurfaceListener } from '../../src/http/listeners.js';
import { startGateway } from '../../src/main.js';
import { loadPrincipals } from '../../src/security/principals.js';
import { createHealth, installShutdownHandler } from '../../src/observability/health.js';
import { createSanitizedLogger } from '../../src/observability/logging.js';

const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const config = validateConfig(json('config/example.json'), json('config/directory.example.json'), json('contracts/limits.json'), () => true);
const secret = 'W25-SENSITIVE-password-000000000000';
const registry = loadPrincipals(config, path => Buffer.from(createHash('sha256').update(path.endsWith('exo-interop') ? secret : `${secret}-private`).digest('hex')));
const fixture = readFileSync('fixtures/ews/request.xml', 'utf8');
const apps: Array<Awaited<ReturnType<typeof startGateway>>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.shutdown())); vi.useRealTimers(); });
const headers = { 'content-type': 'text/xml', authorization: `Basic ${Buffer.from(`exo-interop:${secret}`).toString('base64')}` };
async function setup(options: { lookup?: AvailabilityProvider['lookup']; real?: boolean; graceMs?: number;
  listen?: (app: SurfaceListener) => Promise<unknown>; runtime?: boolean } = {}) {
  const lines: string[] = [];
  const lookup = vi.fn(options.lookup ?? (async (target, window): Promise<TargetResult> =>
    ({ kind: 'ok', targetId: target.entryId, coverage: window, slots: [], observedAtMs: window.startMs })));
  const app = await startGateway('/synthetic/config', {
    load: () => options.graceMs ? { ...config, limits: { ...config.limits, shutdownGraceMs: options.graceMs } } : config,
    logDestination: { write: line => { lines.push(line); } },
    listen: options.listen ?? (options.real ? instance => instance.listen({ host: '127.0.0.1', port: 0 }) : async () => {}),
    ...(options.runtime === false ? {} : { runtime: { registry, directoryInput: json('config/directory.example.json'),
      monoMs: () => performance.now(), policyRevision: 'W25-fixture', protocolProfile: json('config/protocol-profiles.example.json'),
      secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true },
      providers: { graph: { kind: 'graph', lookup }, zimbra: { kind: 'zimbra', lookup } } } }),
  });
  apps.push(app);
  return { app, lookup, lines };
}
function send(app: SurfaceListener, body = fixture) {
  return app.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers, payload: body });
}
function socketRequest(app: SurfaceListener) {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('No localhost listener');
  return new Promise<number>(resolve => {
    const client = request({ hostname: '127.0.0.1', port: address.port, path: '/EWS/Exchange.asmx', method: 'POST', headers }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode ?? 0));
      response.once('aborted', () => resolve(0));
    });
    client.once('error', () => resolve(0)); client.end(fixture);
  });
}

describe('W25 management and telemetry', () => {
  it('stays unready until all listeners are usable, then serves probes without backend calls', async () => {
    const during: number[] = [];
    const { app, lookup } = await setup({ listen: async listener => {
      if (listener.surface === 'management') during.push((await listener.inject('/readyz')).statusCode);
    } });
    expect(during).toEqual([503]);
    for (let n = 0; n < 10; n++) {
      expect((await app.management.inject('/healthz')).json()).toEqual({ status: 'ok' });
      expect((await app.management.inject('/readyz')).statusCode).toBe(200);
      expect((await app.management.inject('/metrics')).statusCode).toBe(200);
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(Object.keys(app)).toEqual(['public', 'private', 'management']);
  });

  it('does not declare a gateway ready without runtime credentials/providers', async () => {
    const { app } = await setup({ runtime: false });
    expect((await app.management.inject('/healthz')).statusCode).toBe(200);
    expect((await app.management.inject('/readyz')).statusCode).toBe(503);
  });

  it('keeps management endpoints off both application surfaces and rejects other management paths/methods', async () => {
    const { app } = await setup();
    for (const side of [app.public, app.private]) {
      for (const url of ['/healthz', '/readyz', '/metrics']) expect((await side.inject(url)).statusCode).toBe(404);
    }
    for (const url of ['/debug', '/config', '/EWS/Exchange.asmx']) expect((await app.management.inject(url)).statusCode).toBe(404);
    for (const url of ['/readyz', '/metrics']) {
      for (const method of ['HEAD', 'POST', 'PUT'] as const) expect((await app.management.inject({ method, url })).statusCode).toBe(404);
    }
  });

  it('observes HTTP200 provider failure as unknown and degraded while readiness/liveness stay up', async () => {
    const { app, lookup, lines } = await setup({ lookup: async target => ({ kind: 'error', targetId: target.entryId, reason: 'backend-unavailable' }) });
    expect((await send(app.public)).statusCode).toBe(200);
    const ready = await app.management.inject('/readyz');
    expect(ready.statusCode).toBe(200);
    expect(ready.json().providers).toEqual({ graph: 'unknown', zimbra: 'degraded' });
    expect((await app.management.inject('/healthz')).statusCode).toBe(200);
    const metrics = await app.management.inject('/metrics');
    expect(metrics.body).toContain('freebusy_requests_total{surface="m365-inbound",outcome="unknown"} 1');
    expect(metrics.body).not.toContain('outcome="useful"} 1');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lines.join('')).not.toMatch(/W25-SENSITIVE|bob@|authorization|authToken/);
  });

  it('records useful requests and parser/auth/body rejections without double counting or sensitive logs', async () => {
    const { app, lines } = await setup();
    expect((await send(app.public)).statusCode).toBe(200);
    expect((await send(app.public, `<secret>${secret}</secret>`)).statusCode).toBe(500);
    expect((await app.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: { 'content-type': 'text/xml' }, payload: secret })).statusCode).toBe(401);
    expect((await app.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: { ...headers, 'content-type': 'text/plain' }, payload: secret })).statusCode).toBe(415);
    const metrics = (await app.management.inject('/metrics')).body;
    expect(metrics).toContain('freebusy_requests_total{surface="m365-inbound",outcome="useful"} 1');
    expect(metrics).toContain('freebusy_requests_total{surface="m365-inbound",outcome="failure"} 3');
    expect(metrics).toContain('freebusy_rejections_total{surface="m365-inbound",reason="parser"} 2');
    expect(metrics).toContain('freebusy_rejections_total{surface="m365-inbound",reason="auth"} 1');
    expect(lines.join('')).toContain('"event":"request"');
    expect(lines.join('')).toContain('"event":"rejection"');
    expect(lines.join('')).not.toMatch(/W25-SENSITIVE|bob@|authorization|authToken/);
  });

  it.each(['unknown-slot', 'partial-coverage'])('reports %s as degraded without failing readiness', async scenario => {
    const { app } = await setup({ lookup: async (target, window) => ({ kind: 'ok', targetId: target.entryId,
      coverage: scenario === 'partial-coverage' ? { ...window, endMs: window.startMs + 1800000 } : window,
      slots: scenario === 'unknown-slot' ? [{ startMs: window.startMs, endMs: window.endMs, status: 'unknown' }] : [],
      observedAtMs: window.startMs }) });
    expect((await send(app.public)).statusCode).toBe(200);
    const response = await app.management.inject('/readyz');
    expect(response.statusCode).toBe(200);
    expect(response.json().providers.zimbra).toBe('degraded');
  });

  it('keeps Autodiscover successes/rejections and unrelated HTTP errors out of availability counters', async () => {
    const { app } = await setup();
    expect((await send(app.public)).statusCode).toBe(200);
    const payload = readFileSync('fixtures/autodiscover/request.xml', 'utf8');
    expect((await app.public.inject({ method: 'POST', url: '/autodiscover/autodiscover.xml', headers, payload })).statusCode).toBe(200);
    expect((await app.public.inject({ method: 'POST', url: '/autodiscover/autodiscover.xml',
      headers: { 'content-type': 'text/xml' }, payload })).statusCode).toBe(401);
    expect((await app.public.inject('/unrelated')).statusCode).toBe(404);
    const metrics = (await app.management.inject('/metrics')).body;
    const requests = metrics.split('\n').filter(line => line.startsWith('freebusy_requests_total{'));
    expect(requests).toEqual(['freebusy_requests_total{surface="m365-inbound",outcome="useful"} 1']);
    expect(metrics).not.toContain('freebusy_rejections_total{');
  });
});

describe('W25 bounded shutdown', () => {
  it('drains a real in-flight socket to completion without prematurely aborting provider work', async () => {
    let complete!: (result: TargetResult) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let context!: CallContext;
    let success!: TargetResult;
    const { app, lines } = await setup({ real: true, lookup: (target, window, ctx) => {
      context = ctx; success = { kind: 'ok', targetId: target.entryId, coverage: window, slots: [], observedAtMs: window.startMs };
      entered(); return new Promise(resolve => { complete = resolve; });
    } });
    const response = socketRequest(app.public); await started;
    const stopped = app.shutdown();
    expect(app.shutdown()).toBe(stopped);
    expect(context.signal.aborted).toBe(false);
    const nextResponse = socketRequest(app.public);
    complete(success);
    expect(await response).toBe(200);
    expect([0, 503]).toContain(await nextResponse);
    await stopped;
    expect(Object.values(app).every(instance => !instance.server.listening)).toBe(true);
    expect(lines.join('')).toContain('"outcome":"draining"');
    expect(lines.join('')).toContain('"outcome":"stopped"');
  });

  it('aborts leftover provider work and closes real sockets by the grace deadline', async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let context!: CallContext;
    const { app } = await setup({ real: true, graceMs: 40, lookup: (_target, _window, ctx) => {
      context = ctx; entered(); return new Promise(() => {});
    } });
    const response = socketRequest(app.public); await started;
    const before = performance.now();
    await app.shutdown();
    expect(performance.now() - before).toBeLessThan(1000);
    expect(context.signal.aborted).toBe(true);
    expect(await response).not.toBe(200);
  });

  it('marks unready before close, rejects new work and stays bounded even if resource close stalls', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const closed: number[] = [];
    const force = vi.fn();
    const health = createHealth({ graceMs: 10000, logger: createSanitizedLogger({ write: line => { lines.push(line); } }),
      close: () => { closed.push(health.readiness().status); return new Promise(() => {}); }, force });
    health.ready();
    const stop = health.shutdown();
    expect(health.readiness().status).toBe(503);
    expect(health.accepting()).toBe(false);
    await vi.advanceTimersByTimeAsync(9999);
    expect(health.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await stop;
    expect(closed).toEqual([503]);
    expect(force).toHaveBeenCalledTimes(1);
    expect(health.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles repeated SIGTERM once and reports sanitized shutdown failure through exit status', async () => {
    for (const failed of [false, true]) {
      const signals = new EventEmitter();
      let finish!: () => void;
      const shutdown = vi.fn(() => new Promise<void>((resolve, reject) => { finish = () => failed ? reject(new Error(secret)) : resolve(); }));
      const exit = vi.fn();
      installShutdownHandler(shutdown, signals, exit);
      signals.emit('SIGTERM'); signals.emit('SIGTERM');
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
      finish(); await Promise.resolve(); await Promise.resolve();
      expect(exit).toHaveBeenCalledWith(failed ? 1 : 0);
      expect(signals.listenerCount('SIGTERM')).toBe(0);
    }
  });

  it('forces resources on close failure and returns only a sanitized failure', async () => {
    const lines: string[] = [];
    const force = vi.fn();
    const health = createHealth({ graceMs: 10000, force,
      logger: createSanitizedLogger({ write: line => { lines.push(line); } }),
      close: async () => { throw new Error(secret); } });
    health.ready();
    await expect(health.shutdown()).rejects.toThrow('Gateway shutdown failed');
    expect(health.signal.aborted).toBe(true);
    expect(force).toHaveBeenCalledTimes(1);
    expect(lines.join('')).not.toContain(secret);
  });

  it('handles an actual child-process SIGTERM and exits after shutdown despite remaining handles', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { installShutdownHandler } from './src/observability/health.ts';
      installShutdownHandler(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        process.stdout.write('drained\\n');
      });
      setInterval(() => {}, 1000);
      process.stdout.write('ready\\n');
    `], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('ready\n')) resolve(); });
        child.once('error', reject);
        child.once('exit', () => { if (!output.includes('ready\n')) reject(new Error('Child failed to start')); });
      });
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(output).toContain('drained\n');
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  });
});

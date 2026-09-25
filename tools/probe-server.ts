import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeAutodiscover } from '../src/autodiscover/route.js';
import { encodePoxSettings } from '../src/autodiscover/response.js';
import { encodeAvailabilityResponse } from '../src/ews/response.js';
import { decodeAvailability } from '../src/ews/request.js';
import { authenticate, AUTH_FAILURE } from '../src/security/auth.js';
import type { Principal } from '../src/security/principals.js';
import { parseXmlBounded, type XmlNode } from '../src/xml/parse.js';
import { fixedProbeResult, SYNTHETIC_EMAIL, type ProbeScenario } from './probe-provider.js';

const profile = Object.freeze({ schemaVersion: 1, status: 'candidate-not-live-verified', productionApproved: false,
  autodiscover: Object.freeze({ responseProtocol: 'EXPR', fields: Object.freeze(['ASUrl', 'EwsUrl']), gateEvidence: null }) });
const limits = Object.freeze({ maxTargetsPerRequest: 100, minIntervalMinutes: 5, maxIntervalMinutes: 1440,
  maxRangeDays: 61, maxGridSlotsPerTarget: 17568 });
const failures = Object.freeze({ status: 404, headers: Object.freeze({ 'content-type': 'text/plain; charset=utf-8' }), body: 'Request rejected' });
const unauthorized = Object.freeze({ status: AUTH_FAILURE.status,
  headers: Object.freeze({ 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': AUTH_FAILURE.challenge }),
  body: AUTH_FAILURE.error });
const scenarios: readonly ProbeScenario[] = ['success', 'not-authorized', 'not-found', 'timeout', 'backend-unavailable'];

interface LabConfig {
  readonly mode: 'lab'; readonly enabled: true; readonly surface: 'm365-inbound' | 'zimbra-inbound';
  readonly bind: '127.0.0.1'; readonly port: number; readonly advertisedOrigin: string;
  readonly syntheticEmail: typeof SYNTHETIC_EMAIL; readonly principalId: string; readonly username: string;
  readonly secretSha256: string; readonly scenario: ProbeScenario;
}
interface LogEvent { readonly correlationId: string; readonly operation: 'ews' | 'autodiscover' | 'rejected';
  readonly view: string | null; readonly timezone: null; readonly outcome: 'ok' | 'error' }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateLabConfig(value: unknown): LabConfig {
  const keys = ['mode', 'enabled', 'surface', 'bind', 'port', 'advertisedOrigin', 'syntheticEmail',
    'principalId', 'username', 'secretSha256', 'scenario'];
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || value.mode !== 'lab' || value.enabled !== true || (value.surface !== 'm365-inbound' && value.surface !== 'zimbra-inbound')
    || value.bind !== '127.0.0.1' || !Number.isSafeInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535
    || value.syntheticEmail !== SYNTHETIC_EMAIL || typeof value.principalId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.principalId)
    || typeof value.username !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.username)
    || typeof value.secretSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.secretSha256)
    || !scenarios.includes(value.scenario as ProbeScenario)
    || encodePoxSettings(value.advertisedOrigin, profile) === undefined) throw new Error('Invalid lab configuration');
  return Object.freeze(value as unknown as LabConfig);
}

export function createLabProbe(raw: unknown, log?: (event: LogEvent) => void,
  parser: (bytes: Uint8Array) => XmlNode = parseXmlBounded) {
  const config = validateLabConfig(raw);
  const digest = Buffer.from(config.secretSha256, 'hex');
  const principal: Principal = Object.freeze({ id: config.principalId, username: config.username, surface: config.surface,
    allowedProvider: config.surface === 'm365-inbound' ? 'zimbra' : 'graph' });
  const registry = Object.freeze({ verify(username: string, candidate: Uint8Array) {
    const actual = candidate.byteLength === 32 ? candidate : Buffer.alloc(32);
    return timingSafeEqual(actual, digest) && username === config.username ? principal : undefined;
  } });
  const entries = Object.freeze([Object.freeze({ provider: 'zimbra', enabled: true, canonicalSmtp: SYNTHETIC_EMAIL,
    aliases: Object.freeze([]), allowedPrincipals: Object.freeze([config.principalId]) })]);
  const emit = (operation: LogEvent['operation'], view: string | null, outcome: LogEvent['outcome']) =>
    log?.(Object.freeze({ correlationId: randomUUID(), operation, view, timezone: null, outcome }));
  const handle = (input: unknown) => {
    if (!record(input)) { emit('rejected', null, 'error'); return failures; }
    const operation = input.path === '/EWS/Exchange.asmx' ? 'ews'
      : input.path === '/autodiscover/autodiscover.xml' ? 'autodiscover' : 'rejected';
    const reject = () => { emit(operation, null, 'error'); return failures; };
    if (input.method !== 'POST' || operation === 'rejected' || typeof input.contentType !== 'string'
      || !/^text\/xml(?:; charset=utf-8)?$/i.test(input.contentType)
      || !(input.body instanceof Uint8Array) || input.body.byteLength > 262144) return reject();
    const caller = authenticate(registry, { surface: config.surface, authorization: input.authorization, secureTransport: true });
    if (!caller) { emit(operation, null, 'error'); return unauthorized; }
    if (operation === 'autodiscover') {
      if (config.surface !== 'm365-inbound') return reject();
      const result = routeAutodiscover({ principal: caller, body: input.body,
        advertisedOrigin: config.advertisedOrigin, profile, entries }, parser);
      emit(operation, null, result.status === 200 ? 'ok' : 'error');
      return result;
    }
    try {
      if (input.soapAction !== undefined && typeof input.soapAction !== 'string') return reject();
      const decoded = decodeAvailability(parser(input.body), { limits,
        ...(typeof input.soapAction === 'string' ? { soapAction: input.soapAction } : {}) });
      const results = decoded.addresses.map(address => address.toLowerCase() === SYNTHETIC_EMAIL
        ? fixedProbeResult(address, decoded.window, config.scenario)
        : { kind: 'error' as const, targetId: 'unknown', reason: 'not-found' as const });
      const body = encodeAvailabilityResponse(decoded.window, results);
      emit(operation, decoded.requestedView, results.every(result => result.kind === 'ok') ? 'ok' : 'error');
      return Object.freeze({ status: 200, headers: Object.freeze({ 'content-type': 'text/xml; charset=utf-8' }), body });
    } catch {
      return reject();
    }
  };
  return Object.freeze({ handle });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = validateLabConfig(JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')));
    const probe = createLabProbe(config, event => process.stdout.write(`${JSON.stringify(event)}\n`));
    const server = createServer({ maxHeaderSize: 16384 }, async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          if (!(chunk instanceof Buffer) || (size += chunk.byteLength) > 262144) throw new Error('Request rejected');
          chunks.push(chunk);
        }
        const result = probe.handle({ method: request.method, path: request.url, authorization: request.headers.authorization,
          contentType: request.headers['content-type'], soapAction: request.headers.soapaction, body: Buffer.concat(chunks) });
        response.writeHead(result.status, result.headers).end(result.body);
      } catch {
        response.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' }).end('Request rejected');
      }
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 5000;
    server.keepAliveTimeout = 5000;
    let listenFailed = false;
    server.on('error', () => {
      if (listenFailed) return;
      listenFailed = true;
      process.stderr.write('Lab probe could not listen\n');
      process.exitCode = 1;
    });
    server.listen(config.port, config.bind);
  } catch {
    process.stderr.write('Invalid lab configuration\n');
    process.exitCode = 1;
  }
}

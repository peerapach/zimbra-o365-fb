import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../../src/config/validate.js';
import { startGateway } from '../../src/main.js';
import { loadPrincipals } from '../../src/security/principals.js';

const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const config = validateConfig(json('config/example.json'), json('config/directory.example.json'), json('contracts/limits.json'), () => true);
const fixture = readFileSync('fixtures/ews/request.xml', 'utf8');
const exoSecret = 'E'.repeat(40);
const zimbraSecret = 'Z'.repeat(40);
const credentials = loadPrincipals(config, path => Buffer.from(createHash('sha256')
  .update(path.endsWith('exo-interop') ? exoSecret : zimbraSecret).digest('hex')));
const apps: Array<Awaited<ReturnType<typeof startGateway>>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.shutdown())); });

async function setup(maxRateLimitKeys = config.limits.maxRateLimitKeys) {
  let now = 0;
  const verify = vi.fn(credentials.verify);
  const lookup = vi.fn(async (target: { entryId: string }, window: { startMs: number; endMs: number }) => ({
    kind: 'ok' as const, targetId: target.entryId, coverage: window, slots: [], observedAtMs: window.startMs,
  }));
  const app = await startGateway('/synthetic/config', {
    load: () => ({ ...config, limits: { ...config.limits, maxRateLimitKeys } }),
    listen: async () => {},
    logDestination: { write: () => {} },
    runtime: {
      registry: { verify }, directoryInput: json('config/directory.example.json'),
      monoMs: () => now, policyRevision: 'W28a-fixture', protocolProfile: json('config/protocol-profiles.example.json'),
      secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true },
      providers: { graph: { kind: 'graph', lookup }, zimbra: { kind: 'zimbra', lookup } },
    },
  });
  apps.push(app);
  return { app, verify, lookup, advance: (ms: number) => { now += ms; } };
}

function send(app: Awaited<ReturnType<typeof startGateway>>, side: 'public' | 'private', secret: string,
  peer = '198.51.100.1', forwarded?: string, body = fixture) {
  const username = side === 'public' ? 'exo-interop' : 'zimbra-interop';
  return app[side].inject({ method: 'POST', url: '/EWS/Exchange.asmx', remoteAddress: peer,
    headers: { 'content-type': 'text/xml', authorization: `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}`,
      ...(forwarded ? { 'x-forwarded-for': forwarded } : {}) }, payload: body });
}

describe.each([
  ['public', exoSecret], ['private', zimbraSecret],
] as const)('W28a %s listener', (side, secret) => {
  it('limits wrong-password guesses by raw peer before credential work, ignoring forwarded spoofing', async () => {
    const { app, verify, lookup, advance } = await setup();
    for (let n = 0; n < config.limits.unauthenticatedBurstPerSource; n++) {
      expect((await send(app, side, `${secret}bad`, '198.51.100.5', `192.0.2.${n + 1}`)).statusCode).toBe(401);
    }
    expect(verify).toHaveBeenCalledTimes(config.limits.unauthenticatedBurstPerSource);
    const blocked = await send(app, side, `${secret}bad`, '198.51.100.5', '192.0.2.250');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).not.toContain(secret);
    expect(verify).toHaveBeenCalledTimes(config.limits.unauthenticatedBurstPerSource);
    expect(lookup).not.toHaveBeenCalled();
    advance(500);
    expect((await send(app, side, `${secret}bad`, '198.51.100.5')).statusCode).toBe(401);
  });

  it('limits an authenticated principal across distinct socket peers before provider work', async () => {
    const { app, verify, lookup } = await setup();
    for (let n = 0; n < config.limits.authenticatedBurstPerPrincipal; n++) {
      expect((await send(app, side, secret, `198.51.100.${n + 1}`)).statusCode).toBe(200);
    }
    const before = lookup.mock.calls.length;
    const blocked = await send(app, side, secret, '198.51.100.250', undefined, '<invalid');
    expect(blocked.statusCode).toBe(429);
    expect(lookup).toHaveBeenCalledTimes(before);
    expect(verify).toHaveBeenCalledTimes(config.limits.authenticatedBurstPerPrincipal + 1);
    expect((await app.management.inject('/readyz')).statusCode).toBe(200);
  });
});

it('fails closed when bounded source-key storage is exhausted without evicting active buckets', async () => {
  const { app, verify } = await setup(2);
  expect((await send(app, 'public', `${exoSecret}bad`, '198.51.100.1')).statusCode).toBe(401);
  expect((await send(app, 'public', `${exoSecret}bad`, '198.51.100.2')).statusCode).toBe(401);
  expect((await send(app, 'public', `${exoSecret}bad`, '198.51.100.3')).statusCode).toBe(429);
  expect(verify).toHaveBeenCalledTimes(2);
});

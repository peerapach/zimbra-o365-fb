import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../../src/config/validate.js';
import type { AvailabilityProvider, Failure, TargetResult } from '../../src/core/types.js';
import { startGateway } from '../../src/main.js';
import { loadPrincipals } from '../../src/security/principals.js';

const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const config = validateConfig(json('config/example.json'), json('config/directory.example.json'), json('contracts/limits.json'), () => true);
const fixture = readFileSync('fixtures/ews/request.xml', 'utf8');
const apps: Array<Awaited<ReturnType<typeof startGateway>>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.shutdown())); });
async function setup(lookup?: AvailabilityProvider['lookup'], generation = '') {
  let now = 0;
  const secret = `W28_SYNTHETIC_SECRET_CANARY_00000000${generation}`;
  const extra = config.principals.map(principal => ({ ...principal, id: `${principal.id}-denied`, username: `${principal.username}-denied`, secretFile: `${principal.secretFile}-denied` }));
  const runtimeConfig = validateConfig({ ...json('config/example.json') as object, principals: [...config.principals, ...extra] },
    json('config/directory.example.json'), json('contracts/limits.json'), () => true);
  const registry = loadPrincipals(runtimeConfig, path => Buffer.from(createHash('sha256').update(path.endsWith('-denied') ? `${secret}-${path}`
    : path.endsWith('exo-interop') ? secret : `${secret}-private`).digest('hex')));
  const success: AvailabilityProvider['lookup'] = async (target, window) => ({ kind: 'ok', targetId: target.entryId, coverage: window,
    observedAtMs: window.startMs, slots: [{ startMs: window.startMs, endMs: window.endMs, status: 'busy' }] });
  const graph = vi.fn(lookup ?? success); const zimbra = vi.fn(lookup ?? success); const logs: string[] = [];
  const app = await startGateway('/synthetic/config', { load: () => runtimeConfig, listen: async () => {}, logDestination: { write: text => { logs.push(text); } },
    runtime: { registry, directoryInput: json('config/directory.example.json'), monoMs: () => now, policyRevision: 'W28-security',
      protocolProfile: json('config/protocol-profiles.example.json'), secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true },
      providers: { graph: { kind: 'graph', lookup: graph }, zimbra: { kind: 'zimbra', lookup: zimbra } } } });
  apps.push(app);
  const authorization = (side: 'public' | 'private') => `Basic ${Buffer.from(side === 'public' ? `exo-interop:${secret}` : `zimbra-interop:${secret}-private`).toString('base64')}`;
  const deniedAuthorization = (side: 'public' | 'private') => {
    const principal = extra.find(item => item.surface === (side === 'public' ? 'm365-inbound' : 'zimbra-inbound'))!;
    return `Basic ${Buffer.from(`${principal.username}:${secret}-${principal.secretFile}`).toString('base64')}`;
  };
  return { app, graph, zimbra, logs, registry, authorization, deniedAuthorization, advance: (ms: number) => { now += ms; },
    send: (side: 'public' | 'private', options: { auth?: string; peer?: string; forwarded?: string; body?: string | Buffer; url?: string; headers?: Record<string, string> } = {}) => app[side].inject({
      method: 'POST', url: options.url ?? '/EWS/Exchange.asmx', remoteAddress: options.peer ?? '192.0.2.5',
      headers: { 'content-type': 'text/xml', ...(options.auth === undefined ? {} : { authorization: options.auth }),
        ...(options.forwarded === undefined ? {} : { 'x-forwarded-for': options.forwarded }), ...options.headers },
      payload: options.body ?? (side === 'public' ? fixture : fixture.replaceAll('bob@zfb.example.invalid', 'alice@company.example.invalid')) }) };
}

describe.each(['public', 'private'] as const)('W28 auth and policy on %s listener', side => {
  it('enforces the source brute-force burst despite spoofed forwarding headers', async () => {
    const state = await setup();
    for (let index = 0; index < config.limits.unauthenticatedBurstPerSource; index++) {
      expect((await state.send(side, { forwarded: `198.51.100.${index + 1}` })).statusCode).toBe(401);
    }
    const denied = await state.send(side, { forwarded: '203.0.113.1' });
    expect(denied.statusCode).toBe(429);
    expect(state.graph).not.toHaveBeenCalled(); expect(state.zimbra).not.toHaveBeenCalled();
    state.advance(500);
    expect((await state.send(side)).statusCode).toBe(401);
  });

  it('enforces the principal burst across distinct source addresses, including cached lookups', async () => {
    const state = await setup(); const auth = state.authorization(side);
    for (let index = 0; index < config.limits.authenticatedBurstPerPrincipal; index++) {
      expect((await state.send(side, { auth, peer: `192.0.2.${index + 1}` })).statusCode).toBe(200);
    }
    expect((await state.send(side, { auth, peer: '192.0.2.100' })).statusCode).toBe(429);
    expect(state[side === 'public' ? 'zimbra' : 'graph']).toHaveBeenCalledTimes(1);
    state.advance(100);
    expect((await state.send(side, { auth, peer: '192.0.2.101' })).statusCode).toBe(200);
  });

  it('never returns a warm authorized cache entry through wrong-surface or invalid credentials', async () => {
    const state = await setup(); const auth = state.authorization(side);
    expect((await state.send(side, { auth })).body).toContain('22222222');
    const wrong = state.authorization(side === 'public' ? 'private' : 'public');
    for (const credential of [wrong, `${auth.slice(0, -4)}AAAA`, 'Bearer W28_AUTH_CANARY', 'Basic !!!!']) {
      const response = await state.send(side, { auth: credential });
      expect(response.statusCode).toBe(401); expect(response.body).not.toContain('MergedFreeBusy');
    }
    const other = side === 'public' ? 'private' : 'public';
    const warmTarget = side === 'public' ? fixture : fixture.replaceAll('bob@zfb.example.invalid', 'alice@company.example.invalid');
    const cross = await state.send(other, { auth: state.authorization(other), body: warmTarget });
    expect(cross.statusCode).toBe(200); expect(cross.body).toContain('ErrorNoFreeBusyAccess');
    expect(cross.body).not.toContain('22222222');
    expect(state[side === 'public' ? 'zimbra' : 'graph']).toHaveBeenCalledTimes(1);
    expect(state[side === 'public' ? 'graph' : 'zimbra']).not.toHaveBeenCalled();
  });

  it('authorizes a valid but ungranted principal before consulting a warm cache', async () => {
    const state = await setup();
    expect((await state.send(side, { auth: state.authorization(side) })).body).toContain('22222222');
    const before = (await state.app.management.inject({ method: 'GET', url: '/metrics' })).body.split('\n').filter(line => line.startsWith('freebusy_cache_total{'));
    const denied = await state.send(side, { auth: state.deniedAuthorization(side) });
    expect(denied.statusCode).toBe(200); expect(denied.body).toContain('ErrorNoFreeBusyAccess');
    expect(denied.body).not.toContain('MergedFreeBusy>');
    const after = (await state.app.management.inject({ method: 'GET', url: '/metrics' })).body.split('\n').filter(line => line.startsWith('freebusy_cache_total{'));
    expect(after).toEqual(before);
    expect(state[side === 'public' ? 'zimbra' : 'graph']).toHaveBeenCalledTimes(1);
  });

  it('rejects the old credential after replacement and cannot reuse its old positive cache', async () => {
    const old = await setup(); const oldAuth = old.authorization(side);
    expect((await old.send(side, { auth: oldAuth })).body).toContain('22222222');
    await old.app.shutdown();
    const replacement = await setup(undefined, '-rotated');
    const denied = await replacement.send(side, { auth: oldAuth });
    expect(denied.statusCode).toBe(401); expect(denied.body).not.toContain('MergedFreeBusy');
    expect(replacement.graph).not.toHaveBeenCalled(); expect(replacement.zimbra).not.toHaveBeenCalled();
    expect((await replacement.send(side, { auth: replacement.authorization(side) })).body).toContain('22222222');
  });

  it.each([
    ['UTF16 media', fixture, { 'content-type': 'text/xml; charset=utf-16' }, 415],
    ['compressed body', fixture, { 'content-encoding': 'gzip' }, 415],
    ['multipart', fixture, { 'content-type': 'multipart/related; boundary=W28_CANARY' }, 415],
    ['UTF16 bytes', Buffer.from(fixture, 'utf16le'), {}, 500],
    ['DOCTYPE', '<!DOCTYPE r [<!ENTITY e SYSTEM "file:///W28_PRIVATE_CANARY">]><r>&e;</r>', {}, 500],
    ['duplicate body', fixture.replace('</s:Body>', '</s:Body><s:Body/>'), {}, 500],
    ['oversized bytes', Buffer.alloc(config.limits.maxRequestBytes + 1, 'x'), {}, 413],
  ] as const)('rejects %s on the real listener before provider work', async (_name, body, headers, status) => {
    const state = await setup(); const response = await state.send(side, { auth: state.authorization(side), body, headers });
    expect(response.statusCode).toBe(status);
    expect(response.body + state.logs.join('')).not.toMatch(/W28_|file:\/\/|MergedFreeBusy/);
    expect(state.graph).not.toHaveBeenCalled(); expect(state.zimbra).not.toHaveBeenCalled();
  });

  it('rejects unauthorized malformed XML before the parser and keeps diagnostics generic', async () => {
    const state = await setup();
    const response = await state.send(side, { body: '<!DOCTYPE r [<!ENTITY e SYSTEM "https://attacker.invalid/W28_CANARY">]><r>&e;</r>' });
    expect(response.statusCode).toBe(401); expect(response.body).not.toContain('s:Client');
    expect(response.body + state.logs.join('')).not.toMatch(/W28_|attacker\.invalid|DOCTYPE/);
    expect(state.graph).not.toHaveBeenCalled(); expect(state.zimbra).not.toHaveBeenCalled();
  });

  it.each(['/metrics', '/readyz', '/healthz', '/ews/exchange.asmx', '/EWS/Exchange.asmx/extra', '/service/admin/soap', '/autodiscover/GetUserSettings'])
    ('does not expose the probed path %s', async url => {
      const state = await setup(); const response = await state.send(side, { auth: state.authorization(side), url });
      expect(response.statusCode).toBe(404); expect(response.body).not.toMatch(/W28_|Merge|provider|pilot-/);
      expect(state.graph).not.toHaveBeenCalled(); expect(state.zimbra).not.toHaveBeenCalled();
    });

  it.each<Failure | 'throw'>(['not-authorized', 'not-found', 'timeout', 'throttled', 'backend-unavailable', 'invalid-response', 'unsupported-timezone', 'throw'])
    ('sanitizes response/log/metrics for provider failure %s without caching it as free', async reason => {
      const state = await setup(async target => {
        if (reason === 'throw') throw new Error('W28_BODY_CANARY authToken=W28_TOKEN_CANARY');
        return { kind: 'error', targetId: target.entryId, reason, subject: 'W28_SUBJECT_CANARY',
          location: 'W28_LOCATION_CANARY', body: 'W28_BODY_CANARY', email: target.canonicalSmtp } as TargetResult;
      });
      for (let count = 0; count < 2; count++) {
        const response = await state.send(side, { auth: state.authorization(side) });
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain(['not-authorized', 'not-found'].includes(reason) ? 'ErrorNoFreeBusyAccess' : 'ErrorInternalServerError');
        expect(response.body).not.toMatch(/MergedFreeBusy>|W28_|example\.invalid|CalendarEventDetails/);
      }
      expect(state[side === 'public' ? 'zimbra' : 'graph']).toHaveBeenCalledTimes(2);
      const metrics = await state.app.management.inject({ method: 'GET', url: '/metrics' });
      expect(metrics.body + state.logs.join('')).not.toMatch(/W28_|example\.invalid|pilot-|authToken|subject|location/);
      expect(metrics.body + state.logs.join('')).not.toContain(state.authorization(side));
    });
});

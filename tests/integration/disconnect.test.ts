import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { validateConfig } from '../../src/config/validate.js';
import type { CallContext, Target, TargetResult, WindowUtc } from '../../src/core/types.js';
import { createListeners, type SurfaceListener } from '../../src/http/listeners.js';
import { startGateway } from '../../src/main.js';
import { loadPrincipals } from '../../src/security/principals.js';

const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const fixture = readFileSync('fixtures/ews/request.xml', 'utf8');
const password = 'synthetic-W23a-password-0000000000';
const payload = (address = 'bob@example.invalid') => fixture.replace('bob@zfb.example.invalid', address);
function headers(privateSide = false) {
  return { 'content-type': 'text/xml', authorization: `Basic ${Buffer.from(privateSide
    ? `zimbra-interop:${password}-private` : `exo-interop:${password}`).toString('base64')}` };
}
interface Call { target: Target; window: WindowUtc; ctx: CallContext; resolve(result: TargetResult): void }
const success = (call: Call): TargetResult => ({ kind: 'ok', targetId: call.target.entryId, coverage: call.window,
  slots: [{ startMs: call.window.startMs, endMs: call.window.endMs, status: 'busy' }], observedAtMs: call.window.startMs });
async function setup() {
  const base = json('config/directory.example.json') as { schemaVersion: number; entries: unknown[] };
  const directory = { ...base, entries: [...base.entries, ...Array.from({ length: 40 }, (_, n) => ({
    id: `extra${n}`, provider: 'zimbra', canonicalSmtp: `extra${n}@example.invalid`, aliases: [], enabled: true, allowedPrincipals: ['pilot-exo'],
  }))] };
  const baseConfig = validateConfig(json('config/example.json'), directory, json('contracts/limits.json'), () => true);
  // Keep the 31-socket disconnect/admission scenario reachable from one loopback peer.
  const config = { ...baseConfig, limits: { ...baseConfig.limits,
    unauthenticatedBurstPerSource: 100, authenticatedBurstPerPrincipal: 100 } };
  const registry = loadPrincipals(config, path => Buffer.from(createHash('sha256').update(path.endsWith('exo-interop') ? password : `${password}-private`).digest('hex')));
  const calls: Call[] = [];
  const entered = new Map<string, { request: IncomingMessage; response: ServerResponse; parsed: boolean }>();
  const clients: ClientRequest[] = [];
  const listeners = await startGateway('/synthetic/config', { load: () => config,
    listen: app => app.listen({ host: '127.0.0.1', port: 0 }),
    create: configuration => {
      const apps = createListeners(configuration);
      for (const app of [apps.public, apps.private]) {
        app.addHook('onRequest', async (request, reply) => {
          entered.set(String(request.headers['x-test-id']), { request: request.raw, response: reply.raw, parsed: false });
        });
        app.addHook('preHandler', async request => { entered.get(String(request.headers['x-test-id']))!.parsed = true; });
      }
      return apps;
    },
    runtime: { registry, directoryInput: directory, monoMs: () => performance.now(), policyRevision: 'W23a',
      protocolProfile: json('config/protocol-profiles.example.json'), secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true },
      providers: { graph: { kind: 'graph', lookup: (target, window, ctx) => new Promise(resolve => calls.push({ target, window, ctx, resolve })) },
        zimbra: { kind: 'zimbra', lookup: (target, window, ctx) => new Promise(resolve => calls.push({ target, window, ctx, resolve })) } } } });
  function send(id: string, address = 'bob@example.invalid', partial = false, app: SurfaceListener = listeners.public) {
    const bound = app.server.address(); if (!bound || typeof bound === 'string') throw new Error('Missing loopback port');
    const body = payload(address);
    let client!: ClientRequest;
    const response = new Promise<{ status: number; body: string }>(resolve => {
      client = httpRequest({ hostname: '127.0.0.1', port: bound.port, path: '/EWS/Exchange.asmx', method: 'POST',
        headers: { ...headers(app === listeners.private), 'x-test-id': id, 'content-length': Buffer.byteLength(body), connection: 'close' } }, incoming => {
        let text = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { text += String(chunk); });
        incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0, body: text }));
      });
      client.once('error', error => resolve({ status: 0, body: error.message }));
    });
    clients.push(client);
    if (partial) client.write(body.slice(0, 10)); else client.end(body);
    return { client, response };
  }
  return { ...listeners, calls, entered, send,
    close: async () => {
      for (const client of clients) client.destroy();
      for (const call of calls) call.resolve(success(call));
      await Promise.all(Object.values(listeners).map(app => app.close()));
    } };
}
async function settled() { await setImmediate(); await setImmediate(); }

it.each(['public', 'private'] as const)('cancels an orphan promptly after a fully accepted %s socket disconnect', async side => {
  const app = await setup();
  try {
    const call = app.send('orphan', side === 'public' ? 'bob@example.invalid' : 'alice@tenant.example.invalid', false, app[side]);
    await vi.waitFor(() => expect(app.calls).toHaveLength(1));
    // The request body has ended normally; its raw close must not cancel availability.
    expect(app.entered.get('orphan')!.request.complete).toBe(true);
    expect(app.calls[0]!.ctx.signal.aborted).toBe(false);
    call.client.destroy(); await call.response;
    await vi.waitFor(() => expect(app.entered.get('orphan')!.response.destroyed).toBe(true)); await settled();
    expect(app.calls[0]!.ctx.signal.aborted).toBe(true);
    expect((await app.management.inject('/healthz')).statusCode).toBe(200);
  } finally { await app.close(); }
});

it('keeps shared provider work alive for a still-interested authorized caller after the other socket leaves', async () => {
  const app = await setup();
  try {
    const first = app.send('first'); const second = app.send('second');
    await vi.waitFor(() => expect(app.entered.get('first')?.parsed).toBe(true));
    await vi.waitFor(() => expect(app.entered.get('second')?.parsed).toBe(true)); await settled();
    expect(app.calls).toHaveLength(1);
    first.client.destroy(); await first.response;
    await vi.waitFor(() => expect(app.entered.get('first')!.response.destroyed).toBe(true)); await settled();
    expect(app.calls[0]!.ctx.signal.aborted).toBe(false);
    app.calls[0]!.resolve(success(app.calls[0]!));
    const response = await second.response;
    expect(response.status).toBe(200); expect(response.body).toContain('<m:ResponseCode>NoError</m:ResponseCode>');
    expect(response.body).toContain('<t:MergedFreeBusy>22222222</t:MergedFreeBusy>');
    expect(app.calls).toHaveLength(1);
  } finally { await app.close(); }
});

it('removes a disconnected queued job before it can consume the next available provider permit', async () => {
  const app = await setup();
  try {
    const active = Array.from({ length: 4 }, (_, n) => app.send(`active${n}`, `extra${n}@example.invalid`));
    await vi.waitFor(() => expect(app.calls).toHaveLength(4));
    const queued = app.send('queued', 'extra4@example.invalid');
    await vi.waitFor(() => expect(app.entered.get('queued')?.parsed).toBe(true)); await settled();
    queued.client.destroy(); await queued.response;
    await vi.waitFor(() => expect(app.entered.get('queued')!.response.destroyed).toBe(true)); await settled();
    const completed = app.calls.find(call => call.target.entryId === 'extra0')!;
    completed.resolve(success(completed)); await active[0]!.response; await settled();
    expect(app.calls.map(call => call.target.entryId).sort()).toEqual(['extra0', 'extra1', 'extra2', 'extra3']);
    for (const call of app.calls) call.resolve(success(call));
    expect((await Promise.all(active.map(call => call.response))).every(response => response.status === 200)).toBe(true);
  } finally { await app.close(); }
});

it('releases partial-body abort admission once and preserves normal responses and management', async () => {
  const app = await setup();
  try {
    const partial = app.send('partial', 'bob@example.invalid', true);
    await vi.waitFor(() => expect(app.entered.has('partial')).toBe(true));
    partial.client.destroy(); await partial.response;
    await vi.waitFor(() => expect(app.entered.get('partial')!.request.aborted).toBe(true)); await settled();
    expect(app.calls).toHaveLength(0);
    const active = Array.from({ length: 31 }, (_, n) => app.send(`held${n}`));
    await vi.waitFor(() => expect(app.entered.get('held30')?.parsed).toBe(true)); await settled();
    expect(app.calls).toHaveLength(1);
    expect((await app.send('overflow').response).status).toBe(503);
    expect((await app.management.inject('/healthz')).statusCode).toBe(200);
    app.calls[0]!.resolve(success(app.calls[0]!));
    expect((await Promise.all(active.map(call => call.response))).every(response => response.status === 200)).toBe(true);
    const completed = await app.send('normal').response;
    expect(completed.status).toBe(200); expect(completed.body).toContain('<m:ResponseCode>NoError</m:ResponseCode>');
    expect(app.calls).toHaveLength(1); // Complete normal replies preserve the verified cache result.
  } finally { await app.close(); }
});

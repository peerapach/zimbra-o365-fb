import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { XMLBuilderImpl } from 'xmlbuilder2/lib/builder/XMLBuilderImpl.js';
import { validateConfig } from '../../src/config/validate.js';
import type { CallContext, TargetResult, WindowUtc } from '../../src/core/types.js';
import { createEwsRoute } from '../../src/ews/route.js';
import { loadDirectory } from '../../src/directory/load.js';
import { createFreeBusyService } from '../../src/freebusy/service.js';
import { createListeners } from '../../src/http/listeners.js';
import { startGateway } from '../../src/main.js';
import { loadPrincipals, type Principal } from '../../src/security/principals.js';

const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const config = validateConfig(json('config/example.json'), json('config/directory.example.json'), json('contracts/limits.json'), () => true);
const fixture = readFileSync('fixtures/ews/request.xml');
const principal: Principal = { id: 'pilot-exo', username: 'exo-interop', surface: 'm365-inbound', allowedProvider: 'zimbra' };
const success = (window: WindowUtc): TargetResult => ({ kind: 'ok', targetId: 'fixture', coverage: window, observedAtMs: window.startMs,
  slots: [{ startMs: window.startMs, endMs: window.endMs, status: 'busy' }] });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('W31b total request deadline', () => {
  it('deducts slow loopback body receipt from provider time and cleans orphan work', async () => {
    const password = 'W31b-synthetic-password-000000000000';
    const registry = loadPrincipals(config, path => Buffer.from(createHash('sha256')
      .update(path.endsWith('exo-interop') ? password : `${password}-private`).digest('hex')));
    let slow = true;
    let providerSignal: AbortSignal | undefined;
    const app = await startGateway('/synthetic/config', { load: () => config, logDestination: { write: () => {} },
      listen: listener => listener.listen({ host: '127.0.0.1', port: 0 }),
      runtime: { registry, directoryInput: json('config/directory.example.json'), monoMs: () => performance.now(), policyRevision: 'W31b',
        secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true }, protocolProfile: json('config/protocol-profiles.example.json'),
        providers: { graph: { kind: 'graph', lookup: async () => { throw new Error('Wrong provider'); } }, zimbra: { kind: 'zimbra',
          lookup: async (target, window, ctx) => {
            providerSignal = ctx.signal;
            if (slow) await sleep(4300, undefined, { signal: ctx.signal });
            return { ...success(window), targetId: target.entryId };
          } } } } });
    const address = app.public.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    const headers = { 'content-type': 'text/xml', 'content-length': fixture.length,
      authorization: `Basic ${Buffer.from(`exo-interop:${password}`).toString('base64')}`, connection: 'close' };
    let client: ReturnType<typeof request> | undefined;
    try {
      const started = performance.now();
      const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
        client = request({ hostname: '127.0.0.1', port: address.port, method: 'POST', path: '/EWS/Exchange.asmx', headers }, incoming => {
          let body = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { body += String(chunk); });
          incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0, body })); incoming.once('error', reject);
        });
        client.once('error', reject); client.write(fixture.subarray(0, 10));
      });
      await sleep(4300); client!.end(fixture.subarray(10));
      const result = await response;
      const elapsed = performance.now() - started;
      expect(result.body).not.toContain('<m:ResponseCode>NoError</m:ResponseCode>');
      expect(result.body).toMatch(/s:Server|ErrorInternalServerError/);
      expect(elapsed).toBeLessThan(8500); //500ms scheduling allowance, not a changed production deadline.
      expect(providerSignal?.aborted).toBe(true);
      slow = false;
      const recovered = await app.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers, payload: fixture });
      expect(recovered.body).toContain('<m:ResponseCode>NoError</m:ResponseCode>');
      const metrics = (await app.management.inject('/metrics')).body;
      expect(metrics).toContain('freebusy_pending_work{provider="zimbra",state="active"} 0');
      expect(metrics).toContain('freebusy_pending_work{provider="zimbra",state="queued"} 0');
    } finally { client?.destroy(); await app.shutdown(); }
  }, 15000);

  it('uses only the remaining subscriber budget and cancels at the response reserve', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 1_004_300;
    let context: CallContext | undefined;
    const caller = new AbortController();
    const observer = { complete: vi.fn(), rejected: vi.fn() };
    const route = createEwsRoute(async (_principal, _surface, _addresses, window, ctx) => {
      context = ctx;
      return new Promise(resolve => ctx.signal.addEventListener('abort', () => resolve([
        { kind: 'error', targetId: String(window.startMs), reason: 'timeout' },
      ]), { once: true }));
    }, config.limits, () => now, observer);
    const pending = route(principal, 'm365-inbound', fixture, undefined, caller.signal, 1_008_000);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(context?.deadlineMonoMs).toBe(1_007_750);
      now = 1_007_750; await vi.advanceTimersByTimeAsync(3450);
      expect(context?.signal.aborted).toBe(true);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(response.body).toContain('<m:ResponseCode>ErrorInternalServerError</m:ResponseCode>');
      expect(observer.complete).toHaveBeenCalledTimes(1);
      expect(observer.rejected).not.toHaveBeenCalled();
    } finally { caller.abort(); await pending; }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['classification', 'emission'] as const)('does not return success when %s crosses the absolute deadline', async phase => {
    let now = 1_000_000;
    let events = 0;
    const original = XMLBuilderImpl.prototype.ele;
    vi.spyOn(XMLBuilderImpl.prototype, 'ele').mockImplementation(function (this: XMLBuilderImpl, ...args) {
      if (args.includes('t:CalendarEvent')) events++;
      if (phase === 'emission' && args.includes('t:StartTime')) now = 1_008_000;
      return original.apply(this, args);
    });
    const route = createEwsRoute(async (_principal, _surface, _addresses, window) => {
      const result = success(window);
      if (result.kind !== 'ok') throw new Error('Invalid fixture');
      return [{ ...result, get slots() { if (phase === 'classification') now = 1_008_000; return result.slots; } }];
    }, config.limits, () => now);
    const response = await route(principal, 'm365-inbound', fixture, undefined);
    expect(response.status).toBe(500);
    expect(response.body).toContain('<faultcode>s:Server</faultcode>');
    expect(response.body).not.toContain('FreeBusyResponse');
    expect(events).toBe(phase === 'classification' ? 0 : 1);
  });

  it('keeps a shared provider flight alive after the earlier ingress subscriber expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 1_004_300;
    let shared: CallContext | undefined;
    let finish: (() => void) | undefined;
    let calls = 0;
    const directory = loadDirectory(json('config/directory.example.json'), config.principals, 'W31b-shared');
    const service = createFreeBusyService(directory, { graph: { kind: 'graph', lookup: async () => { throw new Error('Wrong provider'); } },
      zimbra: { kind: 'zimbra', lookup: async (target, window, ctx) => {
        calls++; shared = ctx;
        return new Promise(resolve => { finish = () => resolve({ ...success(window), targetId: target.entryId }); });
      } } }, { monoMs: () => now });
    const route = createEwsRoute(service, config.limits, () => now);
    const first = route(principal, 'm365-inbound', fixture, undefined, undefined, 1_008_000);
    await vi.advanceTimersByTimeAsync(0);
    now = 1_007_000; await vi.advanceTimersByTimeAsync(2700);
    const second = route(principal, 'm365-inbound', fixture, undefined, undefined, 1_015_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(shared?.deadlineMonoMs).toBe(1_012_050); //Independent flight starts at body completion, not first ingress.
    now = 1_007_750; await vi.advanceTimersByTimeAsync(750);
    expect((await first).body).not.toContain('<m:ResponseCode>NoError</m:ResponseCode>');
    expect(shared?.signal.aborted).toBe(false);
    now = 1_008_000; finish!();
    expect((await second).body).toContain('<m:ResponseCode>NoError</m:ResponseCode>');
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1_007_750, 1_008_000, NaN])('starts no service work after ingestion leaves no provider budget at %s', now => {
    const service = vi.fn<Parameters<typeof createEwsRoute>[0]>(async (_principal, _surface, _addresses, window) => [success(window)]);
    const route = createEwsRoute(service, config.limits, () => now);
    return route(principal, 'm365-inbound', fixture, undefined, undefined, 1_008_000).then(response => {
      expect(response.status).toBe(500);
      expect(response.body).toContain('<faultcode>s:Server</faultcode>');
      expect(service).not.toHaveBeenCalled();
    });
  });

  it('allows rendering inside the existing reserve but rejects a provider completing at total expiry', async () => {
    let now = 1_000_000;
    const route = createEwsRoute(async (_principal, _surface, _addresses, window) => {
      now = 1_007_749;
      const result = success(window);
      if (result.kind !== 'ok') throw new Error('Invalid fixture');
      return [{ ...result, get slots() { now = 1_007_999; return result.slots; } }];
    }, config.limits, () => now);
    expect((await route(principal, 'm365-inbound', fixture, undefined)).body).toContain('<m:ResponseCode>NoError</m:ResponseCode>');
    now = 1_000_000;
    const late = createEwsRoute(async (_principal, _surface, _addresses, window) => {
      now = 1_008_000; return [success(window)];
    }, config.limits, () => now);
    expect((await late(principal, 'm365-inbound', fixture, undefined)).body).toContain('<faultcode>s:Server</faultcode>');
  });

  it('bounds an aggregate service that ignores the provider cutoff and never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 1_004_300;
    let signal: AbortSignal | undefined;
    const observer = { complete: vi.fn(), rejected: vi.fn() };
    const route = createEwsRoute(async (_principal, _surface, _addresses, _window, ctx) => {
      signal = ctx.signal; return new Promise<readonly TargetResult[]>(() => {});
    }, config.limits, () => now, observer);
    const pending = route(principal, 'm365-inbound', fixture, undefined, undefined, 1_008_000);
    now = 1_007_750; await vi.advanceTimersByTimeAsync(3450);
    expect(signal?.aborted).toBe(true);
    now = 1_008_000; await vi.advanceTimersByTimeAsync(250);
    expect((await pending).body).toContain('<faultcode>s:Server</faultcode>');
    expect(observer.complete).not.toHaveBeenCalled();
    expect(observer.rejected).toHaveBeenCalledExactlyOnceWith('m365-inbound', 'internal');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a completed attendee beside a timed-out attendee during the reserve', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 1_000_000;
    let pendingSignal: AbortSignal | undefined;
    const raw = json('config/directory.example.json') as { schemaVersion: number; entries: unknown[] };
    const directory = loadDirectory({ ...raw, entries: [...raw.entries, { id: 'late', provider: 'zimbra',
      canonicalSmtp: 'late@example.invalid', aliases: [], allowedPrincipals: ['pilot-exo'], enabled: true }] }, config.principals, 'W31b-partial');
    const service = createFreeBusyService(directory, { graph: { kind: 'graph', lookup: async () => { throw new Error('Wrong provider'); } },
      zimbra: { kind: 'zimbra', lookup: async (target, window, ctx) => {
        if (target.entryId !== 'late') return { ...success(window), targetId: target.entryId };
        pendingSignal = ctx.signal; return new Promise<TargetResult>(() => {});
      } } }, { monoMs: () => now });
    const mailbox = '<t:MailboxData><t:Email><t:Address>late@example.invalid</t:Address></t:Email>'
      + '<t:AttendeeType>Required</t:AttendeeType><t:ExcludeConflicts>false</t:ExcludeConflicts></t:MailboxData>';
    const body = Buffer.from(fixture.toString().replace('</m:MailboxDataArray>', `${mailbox}</m:MailboxDataArray>`));
    const route = createEwsRoute(service, config.limits, () => now);
    const pending = route(principal, 'm365-inbound', body, undefined);
    await vi.advanceTimersByTimeAsync(0);
    now = 1_007_750; await vi.advanceTimersByTimeAsync(7750);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body.split('<m:ResponseCode>NoError</m:ResponseCode>').length - 1).toBe(1);
    expect(response.body.split('<m:ResponseCode>ErrorInternalServerError</m:ResponseCode>').length - 1).toBe(1);
    expect(pendingSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['synchronous', 'microtask'] as const)('records finalized success before %s observation work advances the clock', async timing => {
    let now = 1_000_000;
    const password = 'W31b-final-send-synthetic-password';
    const registry = loadPrincipals(config, path => Buffer.from(createHash('sha256')
      .update(path.endsWith('exo-interop') ? password : `${password}-private`).digest('hex')));
    const app = await startGateway('/synthetic/config', { load: () => config, listen: async () => {},
      logDestination: { write: line => {
        if (line.includes('"event":"request"')) {
          if (timing === 'synchronous') now = 1_008_000;
          else queueMicrotask(() => { now = 1_008_000; });
        }
      } }, runtime: { registry, directoryInput: json('config/directory.example.json'), monoMs: () => now, policyRevision: 'W31b-final-send',
        secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true }, protocolProfile: json('config/protocol-profiles.example.json'),
        providers: { graph: { kind: 'graph', lookup: async () => { throw new Error('Wrong provider'); } },
          zimbra: { kind: 'zimbra', lookup: async (target, window) => ({ ...success(window), targetId: target.entryId }) } } } });
    try {
      const response = await app.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx', payload: fixture,
        headers: { 'content-type': 'text/xml', authorization: `Basic ${Buffer.from(`exo-interop:${password}`).toString('base64')}` } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<m:ResponseCode>NoError</m:ResponseCode>');
      const metrics = (await app.management.inject('/metrics')).body;
      expect(metrics).toContain('freebusy_requests_total{surface="m365-inbound",outcome="useful"} 1');
      expect(metrics).not.toContain('freebusy_requests_total{surface="m365-inbound",outcome="failure"}');
    } finally { await app.shutdown(); }
  });

  describe.each(['public', 'private'] as const)('%s final response telemetry', side => {
    it.each(['synchronous', 'microtask'] as const)('counts exactly one failure after %s pre-send expiry', async timing => {
      let now = 1_000_000;
      let expire = true;
      const password = 'W31b-final-outcome-synthetic-password';
      const registry = loadPrincipals(config, path => Buffer.from(createHash('sha256')
        .update(path.endsWith('exo-interop') ? password : `${password}-private`).digest('hex')));
      const lookup = async (target: { entryId: string }, window: WindowUtc) => ({ ...success(window), targetId: target.entryId });
      const app = await startGateway('/synthetic/config', { load: () => config, listen: async () => {}, logDestination: { write: () => {} },
        create: configuration => {
          const listeners = createListeners(configuration);
          listeners[side].addHook('onSend', async (_request, _reply, payload) => {
            if (expire) {
              if (timing === 'microtask') await Promise.resolve();
              now = 1_008_000;
            }
            return payload;
          });
          return listeners;
        }, runtime: { registry, directoryInput: json('config/directory.example.json'), monoMs: () => now, policyRevision: 'W31b-outcomes',
          secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true }, protocolProfile: json('config/protocol-profiles.example.json'),
          providers: { graph: { kind: 'graph', lookup }, zimbra: { kind: 'zimbra', lookup } } } });
      const surface = side === 'public' ? 'm365-inbound' : 'zimbra-inbound';
      const provider = side === 'public' ? 'zimbra' : 'graph';
      const send = () => app[side].inject({ method: 'POST', url: '/EWS/Exchange.asmx',
        payload: side === 'public' ? fixture : fixture.toString().replace('bob@zfb.example.invalid', 'alice@company.example.invalid'),
        headers: { 'content-type': 'text/xml', authorization: `Basic ${Buffer.from(side === 'public'
          ? `exo-interop:${password}` : `zimbra-interop:${password}-private`).toString('base64')}` } });
      try {
        const response = await send();
        expect(response.statusCode).toBe(500);
        expect(response.body).toContain('<faultcode>s:Server</faultcode>');
        expect(response.body).not.toContain('FreeBusyResponse');
        const metrics = (await app.management.inject('/metrics')).body;
        expect(metrics.split('\n').filter(line => line.startsWith('freebusy_requests_total{')))
          .toEqual([`freebusy_requests_total{surface="${surface}",outcome="failure"} 1`]);
        expect(metrics).not.toContain('freebusy_target_results_total{');
        expect((await app.management.inject('/readyz')).json().providers[provider]).toBe('unknown');
        expire = false;
        expect((await send()).body).toContain('<m:ResponseCode>NoError</m:ResponseCode>');
        const recovered = (await app.management.inject('/metrics')).body;
        expect(recovered).toContain(`freebusy_requests_total{surface="${surface}",outcome="failure"} 1`);
        expect(recovered).toContain(`freebusy_requests_total{surface="${surface}",outcome="useful"} 1`);
        expect((await app.management.inject('/readyz')).json().providers[provider]).toBe('healthy');
      } finally { await app.shutdown(); }
    });
  });

  it.each(['public', 'private'] as const)('finalizes one failure when a %s peer leaves before onResponse can run', async side => {
    const password = 'W31b-disconnect-synthetic-password';
    const registry = loadPrincipals(config, path => Buffer.from(createHash('sha256')
      .update(path.endsWith('exo-interop') ? password : `${password}-private`).digest('hex')));
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let signal: AbortSignal | undefined;
    const lookup = async (_target: unknown, _window: WindowUtc, ctx: CallContext) => {
      signal = ctx.signal; entered(); return new Promise<TargetResult>(() => {});
    };
    const app = await startGateway('/synthetic/config', { load: () => config, logDestination: { write: () => {} },
      listen: listener => listener.listen({ host: '127.0.0.1', port: 0 }),
      runtime: { registry, directoryInput: json('config/directory.example.json'), monoMs: () => performance.now(), policyRevision: 'W31b-disconnect',
        secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true }, protocolProfile: json('config/protocol-profiles.example.json'),
        providers: { graph: { kind: 'graph', lookup }, zimbra: { kind: 'zimbra', lookup } } } });
    const address = app[side].server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    const client = request({ hostname: '127.0.0.1', port: address.port, method: 'POST', path: '/EWS/Exchange.asmx',
      headers: { 'content-type': 'text/xml', authorization: `Basic ${Buffer.from(side === 'public'
        ? `exo-interop:${password}` : `zimbra-interop:${password}-private`).toString('base64')}` } });
    const disconnected = new Promise<void>(resolve => client.once('error', () => resolve()));
    try {
      client.end(side === 'public' ? fixture : fixture.toString().replace('bob@zfb.example.invalid', 'alice@company.example.invalid'));
      await started; client.destroy(); await disconnected;
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      const metrics = (await app.management.inject('/metrics')).body;
      expect(metrics.split('\n').filter(line => line.startsWith('freebusy_requests_total{')))
        .toEqual([`freebusy_requests_total{surface="${side === 'public' ? 'm365-inbound' : 'zimbra-inbound'}",outcome="failure"} 1`]);
    } finally { client.destroy(); await app.shutdown(); }
  });
});

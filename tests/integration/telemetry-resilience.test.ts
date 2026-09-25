import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvailabilityProvider, CallContext, Provider, Target, TargetResult, WindowUtc } from '../../src/core/types.js';
import type { AvailabilityCacheOptions } from '../../src/cache/availability.js';
import { validateConfig } from '../../src/config/validate.js';
import { loadDirectory } from '../../src/directory/load.js';
import { createFreeBusyService } from '../../src/freebusy/service.js';
import { createBulkhead } from '../../src/resilience/bulkhead.js';
import { createMetrics } from '../../src/observability/metrics.js';
import { startGateway } from '../../src/main.js';
import { loadPrincipals } from '../../src/security/principals.js';

const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const config = validateConfig(json('config/example.json'), json('config/directory.example.json'), json('contracts/limits.json'), () => true);
const apps: Array<Awaited<ReturnType<typeof startGateway>>> = [];
const controllers: AbortController[] = [];
const controller = () => { const value = new AbortController(); controllers.push(value); return value; };
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(async () => {
  for (const item of controllers.splice(0)) item.abort();
  await vi.advanceTimersByTimeAsync(0);
  await Promise.all(apps.splice(0).map(app => app.shutdown()));
  vi.useRealTimers();
});
const window: WindowUtc = { startMs: 1789351200000, endMs: 1789354800000, intervalMinutes: 30 };
const principals = [
  { id: 'g', username: 'g', surface: 'zimbra-inbound' as const, allowedProvider: 'graph' as const },
  { id: 'z', username: 'z', surface: 'm365-inbound' as const, allowedProvider: 'zimbra' as const },
];
const success = (target: Target): TargetResult => ({ kind: 'ok', targetId: target.entryId, coverage: window, slots: [], observedAtMs: window.startMs });
async function exporter(metrics: ReturnType<typeof createMetrics>) {
  const app = await startGateway('/synthetic/config', { load: () => config, listen: async () => {}, metrics, logDestination: { write: () => {} } });
  apps.push(app);
  return async () => { const response = await app.management.inject('/metrics'); expect(response.statusCode).toBe(200); return response.body; };
}
async function setup(options: AvailabilityCacheOptions = {}) {
  const metrics = createMetrics();
  const text = await exporter(metrics);
  let now = 1000000;
  const root = controller();
  const directory = loadDirectory({ schemaVersion: 1, entries: (['graph', 'zimbra'] as const).flatMap(provider =>
    Array.from({ length: 150 }, (_, n) => ({ id: `${provider}${n}`, provider, canonicalSmtp: `${provider}${n}@example.invalid`,
      aliases: [], enabled: true, allowedPrincipals: [provider === 'graph' ? 'g' : 'z'] }))) }, principals, 'W25b');
  const calls: Array<{ target: Target; ctx: CallContext; resolve(result: TargetResult): void }> = [];
  const lookup = vi.fn<AvailabilityProvider['lookup']>((target, _window, ctx) => new Promise(resolve => calls.push({ target, ctx, resolve })));
  const service = createFreeBusyService(directory, { graph: { kind: 'graph', lookup }, zimbra: { kind: 'zimbra', lookup } },
    { ...options, monoMs: () => now, telemetry: metrics });
  const run = (provider: Provider, ids: number[], signal = root.signal, deadline = now + 7750) => {
    const principal = principals[provider === 'graph' ? 0 : 1]!;
    return service(principal, principal.surface, ids.map(n => `${provider}${n}@example.invalid`), window,
      { signal: AbortSignal.any([root.signal, signal]), deadlineMonoMs: deadline });
  };
  return { text, run, service, lookup, calls, metrics, root, tick: () => vi.advanceTimersByTimeAsync(0), setNow: (next: number) => { now = next; } };
}

describe('management-exported resilience state', () => {
  it('records real miss/coalesced/hit work, excludes duplicate attendees and denied warm-cache access', async () => {
    const app = await setup();
    const first = app.run('graph', [0, 0]); await app.tick();
    const second = app.run('graph', [0]); await app.tick();
    let text = await app.text();
    expect(text).toContain('freebusy_cache_total{provider="graph",outcome="miss"} 1');
    expect(text).toContain('freebusy_cache_total{provider="graph",outcome="coalesced"} 1');
    expect(text).toContain('freebusy_pending_work{provider="graph",state="active"} 1');
    app.calls[0]!.resolve(success(app.calls[0]!.target));
    expect(await first).toHaveLength(2); await second;
    await app.run('graph', [0]);
    const denied = await app.service(principals[1]!, 'm365-inbound', ['graph0@example.invalid'], window,
      { signal: app.root.signal, deadlineMonoMs: 1007750 });
    expect(denied[0]).toMatchObject({ kind: 'error', reason: 'not-authorized' });
    text = await app.text();
    expect(text).toContain('freebusy_cache_total{provider="graph",outcome="hit"} 1');
    expect(text).toContain('freebusy_pending_work{provider="graph",state="active"} 0');
    expect(app.lookup).toHaveBeenCalledTimes(1);
    expect(text).not.toMatch(/graph0|example\.invalid/);
  });

  it.each(['flight', 'subscriber', 'deadline'])('counts actual cache %s rejection without scheduling extra work', async reason => {
    const app = await setup(reason === 'flight' ? { maxFlights: 1 } : reason === 'subscriber' ? { maxSubscribers: 1 } : {});
    const pending = app.run('graph', [0]); await app.tick();
    const expired = controller(); if (reason === 'deadline') expired.abort();
    const denied = await app.run('graph', [reason === 'flight' ? 1 : 0], expired.signal);
    expect(denied[0]).toMatchObject({ reason: reason === 'deadline' ? 'timeout' : 'throttled' });
    expect(await app.text()).toContain('freebusy_cache_total{provider="graph",outcome="rejected"} 1');
    expect(app.lookup).toHaveBeenCalledTimes(1);
    app.root.abort(); await pending; await app.tick();
    expect(await app.text()).toContain('freebusy_pending_work{provider="graph",state="active"} 0');
  });

  it('exports bounded queue saturation and releases all active/queued gauges after cancellation', async () => {
    const metrics = createMetrics(); const text = await exporter(metrics);
    const cancel = controller();
    const schedule = createBulkhead(() => 1000000, metrics.queue);
    const ctx = { signal: cancel.signal, deadlineMonoMs: 1007750 };
    const work = Array.from({ length: 132 }, (_, n) => schedule('graph', `canary${n}@example.invalid`, ctx, () => new Promise<TargetResult>(() => {})));
    await vi.advanceTimersByTimeAsync(0);
    expect(await text()).toContain('freebusy_pending_work{provider="graph",state="active"} 4');
    expect(await text()).toContain('freebusy_pending_work{provider="graph",state="queued"} 128');
    expect(await schedule('graph', 'overflow', ctx, async () => { throw new Error('Must not start'); })).toMatchObject({ reason: 'throttled' });
    const other = schedule('zimbra', 'other', ctx, () => new Promise<TargetResult>(() => {}));
    expect(await text()).toContain('freebusy_pending_work{provider="zimbra",state="active"} 1');
    cancel.abort(); await Promise.all([...work, other]);
    for (const provider of ['graph', 'zimbra']) for (const state of ['active', 'queued']) {
      expect(await text()).toContain(`freebusy_pending_work{provider="${provider}",state="${state}"} 0`);
    }
    expect(await text()).not.toMatch(/canary|example\.invalid/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('updates queue gauges when a waiting subscriber deadline expires', async () => {
    const app = await setup();
    const busy = app.run('graph', [0, 1, 2, 3]); await app.tick();
    const queued = app.run('graph', [4], app.root.signal, 1000020); await app.tick();
    expect(await app.text()).toContain('freebusy_pending_work{provider="graph",state="queued"} 1');
    app.setNow(1000020); await vi.advanceTimersByTimeAsync(20);
    expect((await queued)[0]).toMatchObject({ reason: 'timeout' });
    await app.tick();
    expect(await app.text()).toContain('freebusy_pending_work{provider="graph",state="queued"} 0');
    expect(app.lookup).toHaveBeenCalledTimes(4);
    app.root.abort(); await busy;
  });

  it('moves a waiting job into the released slot without losing active or queued counts', async () => {
    const app = await setup();
    const pending = app.run('graph', [0, 1, 2, 3, 4]); await app.tick();
    expect(await app.text()).toContain('freebusy_pending_work{provider="graph",state="queued"} 1');
    app.calls[0]!.resolve(success(app.calls[0]!.target)); await app.tick();
    expect(app.calls).toHaveLength(5);
    expect(await app.text()).toContain('freebusy_pending_work{provider="graph",state="queued"} 0');
    expect(await app.text()).toContain('freebusy_pending_work{provider="graph",state="active"} 4');
    for (const call of app.calls.slice(1)) call.resolve(success(call.target));
    expect((await pending).every(result => result.kind === 'ok')).toBe(true);
    expect(await app.text()).toContain('freebusy_pending_work{provider="graph",state="active"} 0');
  });

  it.each(['cancel', 'not-authorized', 'backend-unavailable', 'success'] as const)('tracks open -> half-open -> settled on probe %s', async outcome => {
    const app = await setup();
    app.lookup.mockImplementation(async target => ({ kind: 'error', targetId: target.entryId, reason: 'backend-unavailable' }));
    for (let n = 0; n < 5; n++) await app.run('graph', [n]);
    expect(await app.text()).toContain('freebusy_breaker_state{provider="graph"} 1');
    expect(await app.text()).toContain('freebusy_breaker_state{provider="zimbra"} 0');
    await app.run('graph', [5]); expect(app.lookup).toHaveBeenCalledTimes(5);
    app.setNow(1030000);
    app.lookup.mockImplementation((target, _window, ctx) => new Promise(resolve => app.calls.push({ target, ctx, resolve })));
    const cancel = controller(); const probe = app.run('graph', [6], cancel.signal); await app.tick();
    expect(await app.text()).toContain('freebusy_breaker_state{provider="graph"} 2');
    await app.run('graph', [7]); expect(app.lookup).toHaveBeenCalledTimes(6);
    if (outcome === 'cancel') cancel.abort();
    else app.calls[0]!.resolve(outcome === 'success' ? success(app.calls[0]!.target)
      : { kind: 'error', targetId: app.calls[0]!.target.entryId, reason: outcome });
    await probe; await app.tick();
    expect(await app.text()).toContain(`freebusy_breaker_state{provider="graph"} ${outcome === 'success' ? 0 : 1}`);
    expect(await app.text()).toContain('freebusy_pending_work{provider="graph",state="active"} 0');
  });

  it('does not add identity-based series as many cache entries are populated', async () => {
    const app = await setup(); app.lookup.mockImplementation(async target => success(target));
    await app.run('graph', [0]);
    const names = (value: string) => value.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.slice(0, line.lastIndexOf(' ')));
    const first = names(await app.text());
    for (let n = 1; n < 100; n++) await app.run('graph', [n]);
    expect(names(await app.text())).toEqual(first);
    expect(await app.text()).toContain('freebusy_cache_total{provider="graph",outcome="miss"} 100');
    expect(await app.text()).not.toMatch(/graph\d|example\.invalid/);
  });
});

it('wires the main runtime service to its own management registry without test-side metric updates', async () => {
  const secret = 'W25b-synthetic-credential-000000000';
  const registry = loadPrincipals(config, path => Buffer.from(createHash('sha256').update(path.endsWith('exo-interop') ? secret : `${secret}-private`).digest('hex')));
  const lookup: AvailabilityProvider['lookup'] = async (target, requested) => ({ ...success(target), coverage: requested });
  const app = await startGateway('/synthetic/config', { load: () => config, listen: async () => {}, logDestination: { write: () => {} },
    runtime: { registry, directoryInput: json('config/directory.example.json'), monoMs: () => 1000000, policyRevision: 'W25b-runtime',
      protocolProfile: json('config/protocol-profiles.example.json'), secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true },
      providers: { graph: { kind: 'graph', lookup }, zimbra: { kind: 'zimbra', lookup } } } });
  apps.push(app);
  for (let n = 0; n < 2; n++) {
    const response = await app.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx',
      headers: { 'content-type': 'text/xml', authorization: `Basic ${Buffer.from(`exo-interop:${secret}`).toString('base64')}` },
      payload: readFileSync('fixtures/ews/request.xml', 'utf8') });
    expect(response.statusCode).toBe(200);
  }
  const text = (await app.management.inject('/metrics')).body;
  expect(text).toContain('freebusy_cache_total{provider="zimbra",outcome="miss"} 1');
  expect(text).toContain('freebusy_cache_total{provider="zimbra",outcome="hit"} 1');
  expect(text).toContain('freebusy_pending_work{provider="zimbra",state="active"} 0');
  expect(text).toContain('freebusy_breaker_state{provider="zimbra"} 0');
});

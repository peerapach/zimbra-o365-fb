import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvailabilityProvider, CallContext, Provider, Target, TargetResult, WindowUtc } from '../../src/core/types.js';
import { loadDirectory } from '../../src/directory/load.js';
import { createFreeBusyService } from '../../src/freebusy/service.js';
import { createBulkhead, createRequestAdmission } from '../../src/resilience/bulkhead.js';
import { createCircuitBreaker } from '../../src/resilience/breaker.js';

const window: WindowUtc = { startMs: 1789351200000, endMs: 1789354800000, intervalMinutes: 30 };
const principals = [
  { id: 'g', username: 'g', surface: 'zimbra-inbound' as const, allowedProvider: 'graph' as const },
  { id: 'z', username: 'z', surface: 'm365-inbound' as const, allowedProvider: 'zimbra' as const },
];
const success = (target: Target): TargetResult => ({ kind: 'ok', targetId: target.entryId, coverage: window, slots: [], observedAtMs: window.startMs });
function setup() {
  let now = 1_000_000;
  const directory = loadDirectory({ schemaVersion: 1, entries: (['graph', 'zimbra'] as const).flatMap(provider =>
    Array.from({ length: 200 }, (_, n) => ({ id: `${provider}${n}`, provider, canonicalSmtp: `${provider}${n}@example.invalid`,
      aliases: [], enabled: true, allowedPrincipals: [provider === 'graph' ? 'g' : 'z'] }))) }, principals, 'W23');
  const calls: Array<{ target: Target; ctx: CallContext; resolve: (result: TargetResult) => void }> = [];
  const lookup = vi.fn<AvailabilityProvider['lookup']>((target, _window, ctx) => new Promise(resolve => calls.push({ target, ctx, resolve })));
  const service = createFreeBusyService(directory, { graph: { kind: 'graph', lookup }, zimbra: { kind: 'zimbra', lookup } }, { monoMs: () => now });
  const ctx = (duration = 7750, signal = new AbortController().signal) => ({ signal, deadlineMonoMs: now + duration });
  return { calls, lookup, service, ctx, monoMs: () => now,
    advance: async (ms: number) => { now += ms; await vi.advanceTimersByTimeAsync(ms); },
    run: (provider: Provider, ids: number[], context = ctx()) => {
      const principal = principals[provider === 'graph' ? 0 : 1]!;
      return service(principal, principal.surface, ids.map(n => `${provider}${n}@example.invalid`), window, context);
    } };
}
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('W23 service bulkheads and independent circuits', () => {
  it('starts at most four jobs per provider and keeps the other provider independent', async () => {
    const app = setup(); const controller = new AbortController();
    const graph = app.run('graph', [0, 1, 2, 3, 4, 5, 6], app.ctx(7750, controller.signal));
    const zimbra = app.run('zimbra', [0], app.ctx(7750, controller.signal));
    await app.advance(0);
    const started = app.calls.map(call => call.target.provider);
    controller.abort(); await Promise.all([graph, zimbra]);
    expect(started.filter(provider => provider === 'graph')).toHaveLength(4);
    expect(started.filter(provider => provider === 'zimbra')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('opens only the failed provider after five backend failures and admits only one cooldown probe', async () => {
    const app = setup();
    app.lookup.mockImplementation(async target => ({ kind: 'error', targetId: target.entryId, reason: 'backend-unavailable' }));
    for (let n = 0; n < 5; n++) await app.run('graph', [n]);
    expect((await app.run('graph', [5]))[0]).toMatchObject({ reason: 'backend-unavailable' });
    expect(app.lookup).toHaveBeenCalledTimes(5);
    app.lookup.mockImplementation(async target => success(target));
    expect((await app.run('zimbra', [0]))[0]).toMatchObject({ kind: 'ok' });
    await app.advance(29999); await app.run('graph', [5]); expect(app.lookup).toHaveBeenCalledTimes(6);
    await app.advance(1);
    app.lookup.mockImplementation((target, _window, ctx) => new Promise(resolve => app.calls.push({ target, ctx, resolve })));
    const probe = app.run('graph', [6]); await app.advance(0);
    expect((await app.run('graph', [7]))[0]).toMatchObject({ reason: 'backend-unavailable' });
    expect(app.calls).toHaveLength(1);
    app.calls[0]!.resolve(success(app.calls[0]!.target)); await probe;
    app.lookup.mockImplementation(async target => success(target));
    expect((await app.run('graph', [8]))[0]).toMatchObject({ kind: 'ok' });
  });

  it('preserves queue elapsed time in the original shared deadline and excludes expired subscribers', async () => {
    const app = setup(); const controller = new AbortController();
    const pending = app.run('graph', [0, 1, 2, 3, 4], app.ctx(7750, controller.signal));
    await app.advance(0); await app.advance(1000);
    app.calls[0]!.resolve(success(app.calls[0]!.target)); await app.advance(0);
    expect(app.calls).toHaveLength(5);
    expect(app.calls[4]!.ctx.deadlineMonoMs).toBe(1_007_750);
    expect(app.calls[4]!.ctx.deadlineMonoMs - app.monoMs()).toBe(6750);
    const expires = app.run('graph', [5], app.ctx(20)); await app.advance(20);
    expect((await expires)[0]).toMatchObject({ reason: 'timeout' });
    app.calls[1]!.resolve(success(app.calls[1]!.target)); await app.advance(0);
    expect(app.calls).toHaveLength(5);
    controller.abort(); await pending; expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['not-authorized', 'not-found', 'invalid-response', 'unsupported-timezone', 'abort', 'deadline'] as const)
    ('releases a neutral half-open %s without delaying the next healthy target or admitting concurrent probes', async reason => {
      const app = setup();
      app.lookup.mockImplementation(async target => ({ kind: 'error', targetId: target.entryId, reason: 'backend-unavailable' }));
      for (let n = 0; n < 5; n++) await app.run('graph', [n]);
      await app.advance(30000);
      app.lookup.mockImplementation((target, _window, ctx) => new Promise(resolve => app.calls.push({ target, ctx, resolve })));
      const controller = new AbortController();
      const probe = app.run('graph', [5], app.ctx(reason === 'deadline' ? 10 : 7750, controller.signal));
      await app.advance(0);
      expect((await app.run('graph', [6]))[0]).toMatchObject({ reason: 'backend-unavailable' });
      expect(app.calls).toHaveLength(1);
      if (reason === 'abort') controller.abort();
      else if (reason === 'deadline') await app.advance(10);
      else app.calls[0]!.resolve({ kind: 'error', targetId: 'graph5', reason });
      await probe; await app.advance(0);
      const recovery = app.run('graph', [7]); await app.advance(0);
      const admitted = app.calls.length;
      if (admitted === 2) {
        expect((await app.run('graph', [8]))[0]).toMatchObject({ reason: 'backend-unavailable' });
        expect(app.calls).toHaveLength(2);
        app.calls[1]!.resolve(success(app.calls[1]!.target));
      }
      expect((await recovery)[0]).toMatchObject({ kind: 'ok' });
      expect(admitted).toBe(2);
      app.lookup.mockImplementation(async target => success(target));
      expect((await app.run('graph', [9]))[0]).toMatchObject({ kind: 'ok' });
      expect(vi.getTimerCount()).toBe(0);
    });

  it('keeps authorized duplicate subscriptions coalesced and refuses cross-surface work under load', async () => {
    const app = setup(); const a = new AbortController(); const b = new AbortController();
    const first = app.run('graph', [0, 1, 2, 3, 4], app.ctx(7750, a.signal));
    const duplicate = app.run('graph', [4, 4], app.ctx(7750, b.signal));
    await app.advance(0); a.abort(); await first; await app.advance(0);
    expect(app.calls.map(call => call.target.entryId)).toEqual(['graph0', 'graph1', 'graph2', 'graph3', 'graph4']);
    const denied = await app.service(principals[1]!, 'm365-inbound', ['graph4@example.invalid'], window, app.ctx());
    expect(denied[0]).toMatchObject({ reason: 'not-authorized' });
    app.calls[4]!.resolve(success(app.calls[4]!.target));
    expect((await duplicate).map(result => result.kind)).toEqual(['ok', 'ok']);
    expect(app.calls).toHaveLength(5); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['not-authorized', 'not-found', 'unsupported-timezone', 'invalid-response'] as const)('never opens a provider circuit for per-target %s', async reason => {
    const app = setup(); app.lookup.mockImplementation(async target => ({ kind: 'error', targetId: target.entryId, reason }));
    for (let n = 0; n < 8; n++) expect((await app.run('graph', [n]))[0]).toMatchObject({ reason });
    expect(app.lookup).toHaveBeenCalledTimes(8);
  });

  it('treats repeated caller cancellations as neutral and releases every active permit', async () => {
    const app = setup();
    for (let n = 0; n < 8; n++) {
      const controller = new AbortController(); const pending = app.run('graph', [n], app.ctx(7750, controller.signal));
      await app.advance(0); controller.abort(); expect((await pending)[0]).toMatchObject({ reason: 'timeout' });
    }
    expect(app.calls).toHaveLength(8); expect(app.calls.every(call => call.ctx.signal.aborted)).toBe(true);
    app.lookup.mockImplementation(async target => success(target));
    expect((await app.run('graph', [9]))[0]).toMatchObject({ kind: 'ok' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an oversized direct call before creating target promises', async () => {
    const app = setup();
    await expect(app.run('graph', Array.from({ length: 101 }, (_, n) => n))).rejects.toThrow();
    expect(app.lookup).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('reserves a flight for the other provider when one provider saturates all shared-work capacity', async () => {
    const app = setup(); const controller = new AbortController();
    const a = app.run('graph', Array.from({ length: 100 }, (_, n) => n), app.ctx(7750, controller.signal));
    const b = app.run('graph', Array.from({ length: 100 }, (_, n) => n + 100), app.ctx(7750, controller.signal));
    await app.advance(0);
    app.lookup.mockImplementation(async target => success(target));
    const isolated = await app.run('zimbra', [0]);
    controller.abort(); const results = [...await a, ...await b];
    expect(isolated[0]).toMatchObject({ kind: 'ok' });
    expect(results.filter(result => result.kind === 'error' && result.reason === 'throttled')).toHaveLength(73);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('W23 scheduler bounds and circuit generations', () => {
  it('bounds the aggregate queue at 128 across both providers and recovers without cancellation leaks', async () => {
    let now = 1000000;
    const schedule = createBulkhead(() => now);
    for (let cycle = 0; cycle < 3; cycle++) {
      const controller = new AbortController(); const ctx = { signal: controller.signal, deadlineMonoMs: now + 7750 };
      const calls: CallContext[] = [];
      const operation = (bounded: CallContext): Promise<TargetResult> => { calls.push(bounded); return new Promise(() => {}); };
      const jobs = Array.from({ length: 136 }, (_, n) => schedule(n % 2 ? 'graph' : 'zimbra', `t${n}`, ctx, operation));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(8);
      expect(await schedule('graph', 'overflow', ctx, operation)).toMatchObject({ reason: 'throttled' });
      expect(await schedule('zimbra', 'overflow', ctx, operation)).toMatchObject({ reason: 'throttled' });
      controller.abort(); expect((await Promise.all(jobs)).every(result => result.kind === 'error' && result.reason === 'timeout')).toBe(true);
      expect(calls.every(context => context.signal.aborted)).toBe(true); expect(vi.getTimerCount()).toBe(0);
      now += 1;
    }
  });

  it('expires queued and uncooperative active jobs without invoking expired work or leaking timers', async () => {
    let now = 1000; const schedule = createBulkhead(() => now); const invoked: string[] = [];
    const jobs = Array.from({ length: 8 }, (_, n) => schedule('graph', `t${n}`, { signal: new AbortController().signal, deadlineMonoMs: 1020 }, async () => {
      invoked.push(`t${n}`); return new Promise<TargetResult>(() => {});
    }));
    await vi.advanceTimersByTimeAsync(0); now = 1020; await vi.advanceTimersByTimeAsync(20);
    expect((await Promise.all(jobs)).every(result => result.kind === 'error' && result.reason === 'timeout')).toBe(true);
    expect(invoked).toEqual(['t0', 't1', 't2', 't3']); expect(vi.getTimerCount()).toBe(0);
    expect(await schedule('zimbra', 'fresh', { signal: new AbortController().signal, deadlineMonoMs: 1040 }, async () =>
      ({ kind: 'error', targetId: 'fresh', reason: 'not-found' }))).toMatchObject({ reason: 'not-found' });
  });

  it('ignores stale successes from the previous circuit generation and reopens a failed probe', async () => {
    let now = 0; const circuit = createCircuitBreaker(() => now); const completions: Array<(result: TargetResult) => void> = [];
    const ctx = () => ({ signal: new AbortController().signal, deadlineMonoMs: now + 7750 });
    const active = Array.from({ length: 6 }, () => circuit('graph', 'g', ctx(), () => new Promise(resolve => completions.push(resolve))));
    for (let n = 0; n < 5; n++) completions[n]!({ kind: 'error', targetId: 'g', reason: 'backend-unavailable' });
    await Promise.all(active.slice(0, 5)); completions[5]!(success({ entryId: 'g', provider: 'graph', canonicalSmtp: 'g@example.invalid' })); await active[5];
    const operation = vi.fn(async (): Promise<TargetResult> => ({ kind: 'error', targetId: 'g', reason: 'backend-unavailable' }));
    await circuit('graph', 'g', ctx(), operation); expect(operation).not.toHaveBeenCalled();
    now = 30000; await circuit('graph', 'g', ctx(), operation); expect(operation).toHaveBeenCalledTimes(1);
    await circuit('graph', 'g', ctx(), operation); expect(operation).toHaveBeenCalledTimes(1);
    now = 60000; await circuit('graph', 'g', ctx(), operation); expect(operation).toHaveBeenCalledTimes(2);
  });

  it('resets consecutive backend failures only on healthy normalized results', async () => {
    const circuit = createCircuitBreaker(() => 0); const ctx = { signal: new AbortController().signal, deadlineMonoMs: 1000 };
    const failure = async (): Promise<TargetResult> => ({ kind: 'error', targetId: 'g', reason: 'backend-unavailable' });
    for (let n = 0; n < 4; n++) await circuit('graph', 'g', ctx, failure);
    await circuit('graph', 'g', ctx, async () => success({ entryId: 'g', provider: 'graph', canonicalSmtp: 'g@example.invalid' }));
    const calls = vi.fn(failure); for (let n = 0; n < 5; n++) await circuit('graph', 'g', ctx, calls);
    await circuit('graph', 'g', ctx, calls); expect(calls).toHaveBeenCalledTimes(5);
  });

  it('does not over-release request capacity when error and response-close both fire', () => {
    const admit = createRequestAdmission(); const releases = Array.from({ length: 32 }, (_, n) => admit(n % 2 ? 'm365-inbound' : 'zimbra-inbound')!);
    expect(admit('zimbra-inbound')).toBeUndefined(); releases[0]!(); releases[0]!();
    const replacement = admit('zimbra-inbound'); expect(replacement).toBeTypeOf('function'); expect(admit('m365-inbound')).toBeUndefined();
    replacement!(); for (const release of releases) release();
    expect(Array.from({ length: 32 }, (_, n) => admit(n % 2 ? 'm365-inbound' : 'zimbra-inbound')).every(release => typeof release === 'function')).toBe(true);
    expect(admit('m365-inbound')).toBeUndefined();
  });
});

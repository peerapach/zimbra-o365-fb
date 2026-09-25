import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvailabilityProvider, Surface, Target, TargetResult, WindowUtc } from '../../src/core/types.js';
import { loadDirectory } from '../../src/directory/load.js';
import { createFreeBusyService } from '../../src/freebusy/service.js';
import type { Principal } from '../../src/security/principals.js';

const principal: Principal = { id: 'one', username: 'one', surface: 'm365-inbound', allowedProvider: 'zimbra' };
const second: Principal = { ...principal, id: 'two', username: 'two' };
const privatePrincipal: Principal = { id: 'private', username: 'private', surface: 'zimbra-inbound', allowedProvider: 'graph' };
const window: WindowUtc = { startMs: 1789351200000, endMs: 1789354800000, intervalMinutes: 30 };
function success(target: Target, requested: WindowUtc): TargetResult {
  return { kind: 'ok', targetId: target.entryId, coverage: requested, slots: [], observedAtMs: window.startMs };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup(options: { ttlMs?: number; maxEntries?: number; maxBytes?: number; flightTimeoutMs?: number;
  maxFlights?: number; maxSubscribers?: number } = {}) {
  let mono = 0;
  const build = (revision: string, allowed = true) => loadDirectory({ schemaVersion: 1, entries: [
    ...['a', 'b', 'c'].map(id => ({ id, provider: 'zimbra', canonicalSmtp: `${id}@example.invalid`, aliases: [`${id}@alias.invalid`],
      enabled: allowed, allowedPrincipals: ['one', 'two'] })),
    { id: 'graph', provider: 'graph', canonicalSmtp: 'g@example.invalid', aliases: [], enabled: true, allowedPrincipals: ['private'] },
  ] }, [principal, second, privatePrincipal], revision);
  let directory = build('initial');
  const resolveTarget = vi.fn((...args: Parameters<typeof directory.resolveTarget>) => directory.resolveTarget(...args));
  const lookup = vi.fn<AvailabilityProvider['lookup']>(async (target, requested) => success(target, requested));
  const graph = vi.fn<AvailabilityProvider['lookup']>(async (target, requested) => success(target, requested));
  const service = createFreeBusyService({ ...directory, resolveTarget },
    { zimbra: { kind: 'zimbra', lookup }, graph: { kind: 'graph', lookup: graph } }, { ...options, monoMs: () => mono });
  return { lookup, graph, service, resolveTarget,
    reload: (revision: string, allowed = true) => { directory = build(revision, allowed); },
    setMono: (value: number) => { mono = value; },
    advance: async (ms: number) => { mono += ms; await vi.advanceTimersByTimeAsync(ms); },
    run: (addresses = ['a@example.invalid'], request: { principal?: Principal; surface?: Surface; window?: WindowUtc;
      signal?: AbortSignal; deadline?: number } = {}) => service(request.principal ?? principal, request.surface ?? 'm365-inbound', addresses,
      request.window ?? window, { signal: request.signal ?? new AbortController().signal, deadlineMonoMs: request.deadline ?? mono + 8000 }),
  };
}
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('W21 authorized bounded availability cache', () => {
  it('reuses validated results across requests while authorizing every ordered duplicate', async () => {
    const app = setup();
    await app.run();
    const results = await app.run(['a@alias.invalid', 'missing@example.invalid', 'a@example.invalid']);
    expect(results.map(result => [result.kind, result.targetId])).toEqual([['ok', 'a'], ['error', 'unresolved'], ['ok', 'a']]);
    expect(app.lookup).toHaveBeenCalledTimes(1);
    expect(app.resolveTarget).toHaveBeenCalledTimes(4);
    expect(Object.isFrozen(results)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cannot use a warm cache after a grant revocation or on a wrong listener', async () => {
    const app = setup(); await app.run();
    const denied = await app.run(undefined, { principal: privatePrincipal, surface: 'zimbra-inbound' });
    expect(denied[0]).toEqual({ kind: 'error', targetId: 'unresolved', reason: 'not-authorized' });
    app.reload('revoked', false);
    expect((await app.run())[0]).toEqual(denied[0]);
    expect(app.lookup).toHaveBeenCalledTimes(1);
    expect(app.graph).not.toHaveBeenCalled();
  });

  it('isolates principal, provider, target, exact window and interval keys', async () => {
    const app = setup(); await app.run();
    await app.run(undefined, { principal: second });
    await app.run(['b@example.invalid']);
    await app.run(undefined, { window: { ...window, startMs: window.startMs + 1 } });
    await app.run(undefined, { window: { ...window, endMs: window.endMs - 1 } });
    await app.run(undefined, { window: { ...window, intervalMinutes: 15 } });
    await app.run(['g@example.invalid'], { principal: privatePrincipal, surface: 'zimbra-inbound' });
    await app.run();
    expect(app.lookup).toHaveBeenCalledTimes(6);
    expect(app.graph).toHaveBeenCalledTimes(1);
  });

  it('invalidates on generation changes and never resurrects a rolled-back generation', async () => {
    const app = setup(); await app.run();
    app.reload('new-profile'); await app.run();
    app.reload('initial'); await app.run();
    expect(app.lookup).toHaveBeenCalledTimes(3);
  });

  it('expires at 30 seconds using monotonic time despite wall-clock jumps, without refreshing TTL on hits', async () => {
    const app = setup(); await app.run();
    vi.setSystemTime(0); app.setMono(29999); await app.run();
    vi.setSystemTime(8640000000000000); await app.run();
    expect(app.lookup).toHaveBeenCalledTimes(1);
    app.setMono(30000); await app.run();
    expect(app.lookup).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently read result when entry capacity is reached', async () => {
    const app = setup({ maxEntries: 2 });
    await app.run(['a@example.invalid']); await app.run(['b@example.invalid']); await app.run(['a@example.invalid']);
    await app.run(['c@example.invalid']); await app.run(['a@example.invalid']); await app.run(['b@example.invalid']);
    expect(app.lookup.mock.calls.map(call => call[0].entryId)).toEqual(['a', 'b', 'c', 'b']);
  });

  it('does not retain an entry larger than the estimated byte budget', async () => {
    const app = setup({ maxBytes: 1 }); await app.run(); await app.run();
    expect(app.lookup).toHaveBeenCalledTimes(2);
  });

  it('evicts on aggregate estimated bytes even below the entry-count bound', async () => {
    // One small result fits; two exceed this budget including keys and object overhead.
    const app = setup({ maxBytes: 1500, maxEntries: 5000 });
    await app.run(['a@example.invalid']); await app.run(['a@example.invalid']);
    expect(app.lookup).toHaveBeenCalledTimes(1);
    await app.run(['b@example.invalid']); await app.run(['a@example.invalid']);
    expect(app.lookup.mock.calls.map(call => call[0].entryId)).toEqual(['a', 'b', 'a']);
  });

  it('starts TTL at successful completion, not the start of slow provider work', async () => {
    const app = setup(); const pending = deferred<TargetResult>(); app.lookup.mockReturnValueOnce(pending.promise);
    const first = app.run(); await vi.advanceTimersByTimeAsync(0); await app.advance(1000);
    pending.resolve(success(app.lookup.mock.calls[0]![0], window)); await first;
    app.setMono(30000); await app.run(); expect(app.lookup).toHaveBeenCalledTimes(1);
    app.setMono(31000); await app.run(); expect(app.lookup).toHaveBeenCalledTimes(2);
  });

  it.each(['error', 'unknown', 'partial', 'malformed'])('never caches %s data or falls back to stale success', async scenario => {
    const app = setup(); await app.run(); app.setMono(30000);
    app.lookup.mockImplementation(async (target, requested) => {
      const raw = success(target, requested);
      if (raw.kind !== 'ok') throw new Error();
      if (scenario === 'error') return { kind: 'error', targetId: target.entryId, reason: 'backend-unavailable' };
      if (scenario === 'partial') return { ...raw, coverage: { ...requested, endMs: requested.endMs - 1 } };
      if (scenario === 'unknown') return { ...raw, slots: [{ startMs: requested.startMs, endMs: requested.endMs, status: 'unknown' }] };
      return { ...raw, observedAtMs: NaN };
    });
    const results = await app.run(); await app.run();
    expect(app.lookup).toHaveBeenCalledTimes(3);
    if (scenario === 'error' || scenario === 'malformed') expect(results[0]).toMatchObject({ kind: 'error' });
    else expect(results[0]).not.toEqual(success({ entryId: 'a' } as Target, window));
  });

  it('stores only owned W20 allowlisted results, never mutable provider metadata', async () => {
    const app = setup();
    const raw = { kind: 'ok' as const, targetId: 'a', coverage: { ...window, subject: 'SUBJECT_CANARY' }, slots: [],
      observedAtMs: window.startMs, body: 'BODY_CANARY' };
    app.lookup.mockResolvedValue(raw);
    await app.run(); raw.coverage.endMs = 0;
    const result = (await app.run())[0];
    expect(result).toEqual({ kind: 'ok', targetId: 'a', coverage: window, slots: [], observedAtMs: window.startMs });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('CANARY');
    expect(app.lookup).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent requests with an independent context and isolates subscriber cancellation', async () => {
    const app = setup(); const pending = deferred<TargetResult>();
    app.lookup.mockReturnValue(pending.promise);
    const first = new AbortController();
    const a = app.run(undefined, { signal: first.signal, deadline: 100 });
    const b = app.run(undefined, { deadline: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.lookup).toHaveBeenCalledTimes(1);
    const shared = app.lookup.mock.calls[0]![2];
    expect(shared.signal).not.toBe(first.signal);
    expect(shared.deadlineMonoMs).toBe(7750);
    first.abort(); expect((await a)[0]).toMatchObject({ reason: 'timeout' });
    expect(shared.signal.aborted).toBe(false);
    pending.resolve(success(app.lookup.mock.calls[0]![0], window));
    expect((await b)[0]).toMatchObject({ kind: 'ok' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces each subscriber deadline without cancelling a longer-lived subscriber', async () => {
    const app = setup(); const pending = deferred<TargetResult>(); app.lookup.mockReturnValue(pending.promise);
    const a = app.run(undefined, { deadline: 10 }); const b = app.run(undefined, { deadline: 100 });
    await app.advance(10);
    expect((await a)[0]).toMatchObject({ reason: 'timeout' });
    expect(app.lookup.mock.calls[0]![2].signal.aborted).toBe(false);
    pending.resolve(success(app.lookup.mock.calls[0]![0], window));
    expect((await b)[0]).toMatchObject({ kind: 'ok' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts orphaned work immediately and late completion cannot cache or delete its replacement', async () => {
    const app = setup(); const old = deferred<TargetResult>(); const replacement = deferred<TargetResult>();
    app.lookup.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
    const controller = new AbortController(); const a = app.run(undefined, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0); controller.abort(); await a;
    expect(app.lookup.mock.calls[0]![2].signal.aborted).toBe(true);
    const b = app.run(); await vi.advanceTimersByTimeAsync(0);
    old.resolve(success(app.lookup.mock.calls[0]![0], window)); await vi.advanceTimersByTimeAsync(0);
    const c = app.run(); await vi.advanceTimersByTimeAsync(0);
    expect(app.lookup).toHaveBeenCalledTimes(2);
    replacement.resolve({ kind: 'error', targetId: 'a', reason: 'not-found' });
    expect((await b)[0]).toMatchObject({ reason: 'not-found' }); expect((await c)[0]).toMatchObject({ reason: 'not-found' });
    await app.run(); expect(app.lookup).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds shared work even when all subscribers have longer deadlines and the provider ignores abort', async () => {
    const app = setup(); app.lookup.mockImplementation(() => new Promise<TargetResult>(() => {}));
    const a = app.run(undefined, { deadline: 100000 }); const b = app.run(undefined, { deadline: 100000 });
    await vi.advanceTimersByTimeAsync(0);
    await app.advance(7750);
    expect((await a)[0]).toMatchObject({ reason: 'timeout' }); expect((await b)[0]).toMatchObject({ reason: 'timeout' });
    expect(app.lookup.mock.calls[0]![2].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects aborted/expired subscribers even on a warm cache without starting work', async () => {
    const app = setup(); await app.run(); const controller = new AbortController(); controller.abort();
    expect((await app.run(undefined, { signal: controller.signal }))[0]).toMatchObject({ reason: 'timeout' });
    expect((await app.run(undefined, { deadline: 0 }))[0]).toMatchObject({ reason: 'timeout' });
    expect((await app.run(undefined, { deadline: Infinity }))[0]).toMatchObject({ reason: 'timeout' });
    expect(app.lookup).toHaveBeenCalledTimes(1);
  });

  it('does not cache completion after every subscriber deadline expires before its timer callback runs', async () => {
    const app = setup(); const pending = deferred<TargetResult>(); app.lookup.mockReturnValueOnce(pending.promise);
    const first = app.run(undefined, { deadline: 10 }); await vi.advanceTimersByTimeAsync(0);
    app.setMono(11); // Model an event-loop delay: deadline passed but timer callback has not run.
    pending.resolve(success(app.lookup.mock.calls[0]![0], window));
    expect((await first)[0]).toMatchObject({ reason: 'timeout' });
    await app.run(); expect(app.lookup).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts old-generation flights and refuses to store their late successes', async () => {
    const app = setup(); const pending = deferred<TargetResult>(); app.lookup.mockReturnValueOnce(pending.promise);
    const old = app.run(); await vi.advanceTimersByTimeAsync(0);
    app.reload('changed'); const current = await app.run();
    expect((await old)[0]).toMatchObject({ kind: 'error' });
    expect(app.lookup.mock.calls[0]![2].signal.aborted).toBe(true);
    pending.resolve(success(app.lookup.mock.calls[0]![0], window)); await vi.advanceTimersByTimeAsync(0);
    expect(await app.run()).toEqual(current); expect(app.lookup).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds flights and per-flight subscribers with explicit failures and cleans up afterwards', async () => {
    const app = setup({ maxFlights: 1, maxSubscribers: 1 }); const pending = deferred<TargetResult>();
    app.lookup.mockReturnValueOnce(pending.promise); const a = app.run(); await vi.advanceTimersByTimeAsync(0);
    expect((await app.run())[0]).toMatchObject({ kind: 'error', reason: 'throttled' });
    expect((await app.run(['b@example.invalid']))[0]).toMatchObject({ kind: 'error', reason: 'throttled' });
    pending.resolve(success(app.lookup.mock.calls[0]![0], window)); await a;
    expect((await app.run(['b@example.invalid']))[0]).toMatchObject({ kind: 'ok' });
    expect(app.lookup).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces one global subscriber cap across distinct flights and releases capacity on departure', async () => {
    const app = setup({ maxSubscribers: 2, maxFlights: 3 });
    const aResult = deferred<TargetResult>(); const bResult = deferred<TargetResult>();
    app.lookup.mockReturnValueOnce(aResult.promise).mockReturnValueOnce(bResult.promise);
    const controller = new AbortController();
    const a = app.run(['a@example.invalid'], { signal: controller.signal });
    const b = app.run(['b@example.invalid']); await vi.advanceTimersByTimeAsync(0);
    const third = await app.run(['c@example.invalid']);
    const coalesced = app.run(['b@example.invalid']);
    // Clean up both pending flights even on the RED implementation before asserting.
    controller.abort(); await a;
    bResult.resolve(success(app.lookup.mock.calls[1]![0], window)); await b;
    expect(third[0]).toMatchObject({ kind: 'error', reason: 'throttled' });
    expect((await coalesced)[0]).toMatchObject({ kind: 'error', reason: 'throttled' });
    expect(app.lookup).toHaveBeenCalledTimes(2);
    expect((await app.run(['c@example.invalid']))[0]).toMatchObject({ kind: 'ok' });
    expect(app.lookup).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains global accounting until old-generation subscribers finish cleanup', async () => {
    const app = setup({ maxSubscribers: 1 }); const pending = deferred<TargetResult>();
    app.lookup.mockReturnValueOnce(pending.promise);
    const old = app.run(); await vi.advanceTimersByTimeAsync(0);
    app.reload('rollover');
    expect((await app.run())[0]).toMatchObject({ reason: 'throttled' });
    expect((await old)[0]).toMatchObject({ reason: 'timeout' });
    expect((await app.run())[0]).toMatchObject({ kind: 'ok' });
    expect(app.lookup).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ ttlMs: 30001 }, { maxEntries: 5001 }, { maxBytes: 33554433 }, { flightTimeoutMs: 7751 },
    { maxFlights: 129 }, { maxSubscribers: 3201 }, { maxEntries: 0 }, { ttlMs: NaN }])('rejects unbounded cache options %#', options => {
    expect(() => setup(options)).toThrow();
  });
});

import type { CallContext, Provider, TargetResult, WindowUtc } from '../core/types.js';
import { abortable } from '../http/outbound.js';
import { resultFailure, sanitizeTargetResult } from '../security/result-policy.js';
import type { createMetrics } from '../observability/metrics.js';

export interface AvailabilityCacheOptions {
  readonly monoMs?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly flightTimeoutMs?: number;
  readonly maxFlights?: number;
  /** Global retained-subscriber bound across all shared flights. */
  readonly maxSubscribers?: number;
  readonly telemetry?: Pick<ReturnType<typeof createMetrics>, 'cache' | 'queue' | 'breaker'>;
}
interface Entry { result: TargetResult; expires: number; bytes: number }
interface Flight { provider: Provider; controller: AbortController; subscribers: Set<CallContext>; promise: Promise<TargetResult> }

/** Private per-service storage. Call lookup only after resolving current target authorization. */
export function createAvailabilityCache(options: AvailabilityCacheOptions = {}) {
  const monoMs = options.monoMs ?? (() => performance.now());
  const defaults = { ttlMs: 30000, maxEntries: 5000, maxBytes: 33554432, flightTimeoutMs: 7750, maxFlights: 128, maxSubscribers: 3200 };
  const bounds = { ...defaults, ...options };
  for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] <= 0 || bounds[key] > defaults[key]) throw new Error('Invalid cache bounds');
  }
  const entries = new Map<string, Entry>();
  const flights = new Map<string, Flight>();
  let bytes = 0;
  let subscribers = 0;
  let generation: string | undefined;
  function remove(key: string) {
    const previous = entries.get(key);
    if (previous) { bytes -= previous.bytes; entries.delete(key); }
  }
  function synchronize(next: string) {
    if (generation === next) return;
    generation = next;
    entries.clear(); bytes = 0;
    for (const active of flights.values()) active.controller.abort();
    flights.clear();
  }
  function store(key: string, result: TargetResult, window: WindowUtc) {
    if (result.kind !== 'ok' || result.coverage.startMs !== window.startMs || result.coverage.endMs !== window.endMs
      || result.slots.some(slot => slot.status === 'unknown')) return;
    // Conservative estimate includes UTF-16 strings, records, array references and map overhead.
    const size = 2 * (key.length + JSON.stringify(result).length) + 256 + result.slots.length * 128;
    if (size > bounds.maxBytes) return;
    remove(key);
    while (entries.size >= bounds.maxEntries || bytes + size > bounds.maxBytes) remove(entries.keys().next().value!);
    entries.set(key, { result, expires: monoMs() + bounds.ttlMs, bytes: size });
    bytes += size;
  }
  function start(provider: Provider, key: string, targetId: string, window: WindowUtc, load: (ctx: CallContext) => Promise<TargetResult>): Flight {
    const controller = new AbortController();
    const deadlineMonoMs = monoMs() + bounds.flightTimeoutMs;
    const timer = setTimeout(() => controller.abort(), bounds.flightTimeoutMs);
    const active: Flight = { provider, controller, subscribers: new Set(), promise: Promise.resolve(resultFailure(targetId, 'timeout')) };
    flights.set(key, active);
    active.promise = (async () => {
      try {
        // Defer provider invocation until the first subscriber has attached.
        const raw = await abortable(Promise.resolve().then(() => {
          if (controller.signal.aborted) return resultFailure(targetId, 'timeout');
          return load({ signal: controller.signal, deadlineMonoMs });
        }), controller.signal);
        if (controller.signal.aborted || monoMs() >= deadlineMonoMs) return resultFailure(targetId, 'timeout');
        const result = sanitizeTargetResult(raw, targetId, window);
        const interested = [...active.subscribers].some(subscriber => !subscriber.signal.aborted && monoMs() < subscriber.deadlineMonoMs);
        if (flights.get(key) === active && interested) store(key, result, window);
        return result;
      } catch { return resultFailure(targetId, controller.signal.aborted ? 'timeout' : 'backend-unavailable'); }
      finally {
        clearTimeout(timer);
        if (flights.get(key) === active) flights.delete(key);
      }
    })();
    return active;
  }
  return Object.freeze({
    async lookup(provider: Provider, key: string, version: string, targetId: string, window: WindowUtc, ctx: CallContext,
      load: (ctx: CallContext) => Promise<TargetResult>): Promise<TargetResult> {
      synchronize(version);
      const rejected = (reason: 'timeout' | 'throttled') => {
        options.telemetry?.cache(provider, 'rejected'); return resultFailure(targetId, reason);
      };
      const now = monoMs();
      const remaining = ctx.deadlineMonoMs - now;
      if (ctx.signal.aborted || !Number.isFinite(now) || !Number.isFinite(remaining) || remaining <= 0) return rejected('timeout');
      const cached = entries.get(key);
      if (cached && now < cached.expires) {
        entries.delete(key); entries.set(key, cached);
        options.telemetry?.cache(provider, 'hit');
        return cached.result;
      }
      remove(key);
      if (subscribers >= bounds.maxSubscribers) return rejected('throttled');
      let active = flights.get(key);
      // Reserve one flight for the other provider; tiny injected test bounds remain usable.
      const providerFlights = [...flights.values()].filter(flight => flight.provider === provider).length;
      if (!active && (flights.size >= bounds.maxFlights || providerFlights >= Math.max(1, bounds.maxFlights - 1))) {
        return rejected('throttled');
      }
      options.telemetry?.cache(provider, active ? 'coalesced' : 'miss');
      active ??= start(provider, key, targetId, window, load);
      const controller = new AbortController();
      const signal = AbortSignal.any([ctx.signal, controller.signal]);
      const subscriber = { signal, deadlineMonoMs: ctx.deadlineMonoMs };
      active.subscribers.add(subscriber);
      subscribers++;
      const timer = setTimeout(() => controller.abort(), Math.min(remaining, 2147483647));
      try {
        const result = await abortable(active.promise, signal);
        return signal.aborted || monoMs() >= ctx.deadlineMonoMs ? resultFailure(targetId, 'timeout') : result;
      } catch { return resultFailure(targetId, 'timeout'); }
      finally {
        clearTimeout(timer);
        active.subscribers.delete(subscriber);
        subscribers--;
        if (active.subscribers.size === 0) {
          active.controller.abort();
          if (flights.get(key) === active) flights.delete(key);
        }
      }
    },
  });
}

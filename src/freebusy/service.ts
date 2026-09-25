import type { AvailabilityProvider, CallContext, Provider, Surface, Target, TargetResult, WindowUtc } from '../core/types.js';
import type { loadDirectory } from '../directory/load.js';
import { abortable } from '../http/outbound.js';
import type { Principal } from '../security/principals.js';
import { resultFailure, sanitizeTargetResult } from '../security/result-policy.js';
import { createAvailabilityCache, type AvailabilityCacheOptions } from '../cache/availability.js';
import { createBulkhead } from '../resilience/bulkhead.js';
import { createCircuitBreaker } from '../resilience/breaker.js';

export function createFreeBusyService(directory: ReturnType<typeof loadDirectory>, providers: Readonly<Record<Provider, AvailabilityProvider>>,
  options: AvailabilityCacheOptions = {}) {
  const cache = createAvailabilityCache(options);
  const monoMs = options.monoMs ?? (() => performance.now());
  const schedule = createBulkhead(monoMs, options.telemetry?.queue);
  const circuit = createCircuitBreaker(monoMs, options.telemetry?.breaker);
  async function lookup(target: Target, window: WindowUtc, ctx: CallContext): Promise<TargetResult> {
    const error = (reason: 'invalid-response' | 'backend-unavailable' | 'timeout') => resultFailure(target.entryId, reason);
    if (ctx.signal.aborted) return error('timeout');
    try {
      const provider = providers[target.provider];
      if (provider.kind !== target.provider) return error('invalid-response');
      const result = await abortable(provider.lookup(target, window, ctx), ctx.signal);
      return sanitizeTargetResult(result, target.entryId, window);
    } catch {
      return error(ctx.signal.aborted ? 'timeout' : 'backend-unavailable');
    }
  }
  return async (principal: Principal, surface: Surface, addresses: readonly string[], window: WindowUtc, ctx: CallContext) => {
    if (addresses.length > 100) throw new Error('Too many targets');
    const work = new Map<string, Promise<TargetResult>>();
    return Object.freeze(await Promise.all(addresses.map(address => {
      // Resolve/authorize every original entry before consulting even request-local work.
      const target = directory.resolveTarget(principal, surface, address);
      if (!target) return resultFailure('unresolved', 'not-authorized');
      let pending = work.get(target.entryId);
      if (!pending) {
        const key = JSON.stringify([principal.id, surface, target.provider, target.entryId, target.canonicalSmtp, target.graphObjectId,
          window.startMs, window.endMs, window.intervalMinutes, target.configVersion]);
        pending = cache.lookup(target.provider, key, target.configVersion, target.entryId, window, ctx, shared =>
          schedule(target.provider, target.entryId, shared, scheduled =>
            circuit(target.provider, target.entryId, scheduled, () => lookup(target, window, scheduled))));
        work.set(target.entryId, pending);
      }
      return pending;
    })));
  };
}

import type { CallContext, Provider, TargetResult } from '../core/types.js';
import { resultFailure } from '../security/result-policy.js';
import type { createMetrics } from '../observability/metrics.js';

interface Circuit { failures: number; retryAt: number; probe: boolean; generation: number }

/** Candidate policy: five backend failures, 30s cooldown, one half-open probe. */
export function createCircuitBreaker(monoMs: () => number, observe?: ReturnType<typeof createMetrics>['breaker']) {
  const fresh = (): Circuit => ({ failures: 0, retryAt: 0, probe: false, generation: 0 });
  const states: Record<Provider, Circuit> = { graph: fresh(), zimbra: fresh() };
  const publish = (provider: Provider) => {
    const state = states[provider];
    let value = 'closed';
    if (state.failures >= 5) value = state.probe ? 'half-open' : 'open';
    observe?.(provider, value);
  };
  for (const provider of ['graph', 'zimbra'] as const) publish(provider);
  return async (provider: Provider, targetId: string, ctx: CallContext,
    operation: () => Promise<TargetResult>): Promise<TargetResult> => {
    const state = states[provider];
    const halfOpen = state.failures >= 5;
    if (halfOpen && (monoMs() < state.retryAt || state.probe)) return resultFailure(targetId, 'backend-unavailable');
    if (ctx.signal.aborted || monoMs() >= ctx.deadlineMonoMs) return resultFailure(targetId, 'timeout');
    if (halfOpen) { state.probe = true; publish(provider); }
    const generation = state.generation;
    let result: TargetResult;
    try { result = await operation(); }
    catch { result = resultFailure(targetId, 'backend-unavailable'); }
    if (generation !== state.generation) return result;
    const cancelled = ctx.signal.aborted || monoMs() >= ctx.deadlineMonoMs;
    // invalid-response also represents rejected input in existing adapters, so remains neutral.
    const failed = !cancelled && result.kind === 'error'
      && ['backend-unavailable', 'timeout', 'throttled'].includes(result.reason);
    if (!cancelled && result.kind === 'ok') {
      state.failures = 0; state.probe = false;
      if (halfOpen) state.generation++;
    } else if (failed && (halfOpen || ++state.failures >= 5)) {
      state.failures = 5; state.retryAt = monoMs() + 30000; state.probe = false; state.generation++;
    } else if (halfOpen) {
      // Neutral per-target outcomes/cancellation neither prove recovery nor extend cooldown.
      state.probe = false;
    }
    publish(provider);
    return result;
  };
}

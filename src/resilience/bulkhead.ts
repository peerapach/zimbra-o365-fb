import type { CallContext, Provider, Surface, TargetResult } from '../core/types.js';
import { resultFailure } from '../security/result-policy.js';
import type { createMetrics } from '../observability/metrics.js';

/** One instance shared by the two application listeners; releases are idempotent. */
export function createRequestAdmission() {
  let active = 0;
  const surfaces: Record<Surface, number> = { 'm365-inbound': 0, 'zimbra-inbound': 0 };
  return (surface: Surface) => {
    if (active >= 32 || surfaces[surface] >= 31) return undefined;
    active++; surfaces[surface]++;
    let released = false;
    return () => { if (!released) { released = true; active--; surfaces[surface]--; } };
  };
}

interface Job { provider: Provider; start(): void }

export function createBulkhead(monoMs: () => number, observe?: ReturnType<typeof createMetrics>['queue']) {
  const active: Record<Provider, number> = { graph: 0, zimbra: 0 };
  const queue: Job[] = [];
  const publish = (provider: Provider) => observe?.(provider, active[provider], queue.filter(job => job.provider === provider).length);
  for (const provider of ['graph', 'zimbra'] as const) publish(provider);
  let draining = false;
  function drain() {
    if (draining) return;
    draining = true;
    try {
      for (let index = 0; index < queue.length;) {
        const job = queue[index]!;
        if (active[job.provider] >= 4) { index++; continue; }
        queue.splice(index, 1); job.start();
      }
    } finally { draining = false; }
  }
  return async (provider: Provider, targetId: string, ctx: CallContext,
    operation: (ctx: CallContext) => Promise<TargetResult>): Promise<TargetResult> => {
    const remaining = ctx.deadlineMonoMs - monoMs();
    if (ctx.signal.aborted || !Number.isFinite(remaining) || remaining <= 0) return resultFailure(targetId, 'timeout');
    if (active[provider] >= 4 && queue.length >= 128) return resultFailure(targetId, 'throttled');
    return new Promise(resolve => {
      let started = false;
      let settled = false;
      const finish = (result: TargetResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); ctx.signal.removeEventListener('abort', cancel);
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        if (started) active[provider]--;
        publish(provider);
        resolve(result); drain();
      };
      const controller = new AbortController();
      const bounded = { signal: AbortSignal.any([ctx.signal, controller.signal]), deadlineMonoMs: ctx.deadlineMonoMs };
      const cancel = () => { controller.abort(); finish(resultFailure(targetId, 'timeout')); };
      const timer = setTimeout(cancel, Math.min(remaining, 2147483647));
      const job: Job = { provider, start() {
        if (ctx.signal.aborted || monoMs() >= ctx.deadlineMonoMs) { cancel(); return; }
        started = true; active[provider]++;
        publish(provider);
        Promise.resolve().then(() => {
          if (bounded.signal.aborted || monoMs() >= ctx.deadlineMonoMs) return resultFailure(targetId, 'timeout');
          return operation(bounded);
        }).then(result => {
          if (bounded.signal.aborted || monoMs() >= ctx.deadlineMonoMs) cancel();
          else finish(result);
        }, () => finish(resultFailure(targetId, bounded.signal.aborted ? 'timeout' : 'backend-unavailable')));
      } };
      ctx.signal.addEventListener('abort', cancel, { once: true });
      if (ctx.signal.aborted) cancel();
      else if (active[provider] < 4) job.start();
      else { queue.push(job); publish(provider); }
    });
  };
}

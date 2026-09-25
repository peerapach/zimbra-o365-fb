import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { WindowUtc } from '../core/types.js';
import { sanitizeTargetResult } from '../security/result-policy.js';

const surfaces = ['m365-inbound', 'zimbra-inbound', 'management'];
const providers = ['graph', 'zimbra'];
function category(value: unknown, choices: readonly string[]): string {
  return typeof value === 'string' && choices.includes(value) ? value : 'other';
}

function classify(value: unknown, window: WindowUtc): 'useful' | 'unknown' | 'failure' {
  let targetId: unknown;
  // Read only the identity needed by the sanitizer; it never becomes a label.
  try { targetId = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'targetId')?.value : undefined; }
  catch { return 'failure'; }
  if (typeof targetId !== 'string') return 'failure';
  const result = sanitizeTargetResult(value, targetId, window);
  if (result.kind === 'error') return 'failure';
  return result.coverage.startMs === window.startMs && result.coverage.endMs === window.endMs
    && !result.slots.some(slot => slot.status === 'unknown') ? 'useful' : 'unknown';
}

/** Private registry and finite labels: no arbitrary identity or request metadata enters prom-client. */
export function createMetrics() {
  const registry = new Registry();
  const registers = [registry];
  const requests = new Counter({ name: 'freebusy_requests_total', help: 'Requests by semantic outcome', labelNames: ['surface', 'outcome'], registers });
  const rejections = new Counter({ name: 'freebusy_rejections_total', help: 'Requests rejected before availability', labelNames: ['surface', 'reason'], registers });
  const results = new Counter({ name: 'freebusy_target_results_total', help: 'Normalized target outcomes', labelNames: ['surface', 'outcome'], registers });
  const attempts = new Counter({ name: 'freebusy_provider_attempts_total', help: 'Provider attempts by outcome', labelNames: ['provider', 'outcome'], registers });
  const latency = new Histogram({ name: 'freebusy_provider_duration_seconds', help: 'Provider attempt duration',
    labelNames: ['provider'], buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 3, 8], registers });
  const cache = new Counter({ name: 'freebusy_cache_total', help: 'Cache lookup outcomes', labelNames: ['provider', 'outcome'], registers });
  const pending = new Gauge({ name: 'freebusy_pending_work', help: 'Active and queued provider work', labelNames: ['provider', 'state'], registers });
  const breaker = new Gauge({ name: 'freebusy_breaker_state', help: 'Breaker state: closed 0, open 1, half-open 2, other 3', labelNames: ['provider'], registers });
  return Object.freeze({
    rejection(surface: unknown, reason: unknown): void {
      const label = category(surface, surfaces);
      rejections.inc({ surface: label, reason: category(reason, ['parser', 'auth', 'admission', 'internal']) });
      requests.inc({ surface: label, outcome: 'failure' });
    },
    availability(surface: unknown, window: WindowUtc, values: readonly unknown[], httpStatus: number): void {
      const label = category(surface, surfaces);
      let useful = values.length > 0;
      for (const value of values) {
        const outcome = classify(value, window);
        results.inc({ surface: label, outcome });
        useful &&= outcome === 'useful';
      }
      requests.inc({ surface: label, outcome: httpStatus !== 200 ? 'failure' : useful ? 'useful' : 'unknown' });
    },
    provider(provider: unknown, outcome: unknown, durationMs: number): void {
      const label = category(provider, providers);
      attempts.inc({ provider: label, outcome: category(outcome, ['useful', 'unknown', 'failure', 'timeout',
        'not-authorized', 'not-found', 'throttled', 'backend-unavailable', 'invalid-response', 'http-2xx', 'http-4xx', 'http-5xx', 'http-other']) });
      if (Number.isFinite(durationMs) && durationMs >= 0) latency.observe({ provider: label }, durationMs / 1000);
    },
    cache(provider: unknown, outcome: unknown): void {
      cache.inc({ provider: category(provider, providers), outcome: category(outcome, ['hit', 'miss', 'coalesced', 'rejected']) });
    },
    queue(provider: unknown, active: number, queued: number): void {
      for (const [state, value] of [['active', active], ['queued', queued]] as const) {
        if (Number.isSafeInteger(value) && value >= 0) pending.set({ provider: category(provider, providers), state }, value);
      }
    },
    breaker(provider: unknown, state: unknown): void {
      const label = category(state, ['closed', 'open', 'half-open']);
      breaker.set({ provider: category(provider, providers) }, label === 'closed' ? 0 : label === 'open' ? 1 : label === 'half-open' ? 2 : 3);
    },
    async render(surface: unknown): Promise<{ contentType: string; body: string } | undefined> {
      if (surface !== 'management') return undefined;
      return { contentType: registry.contentType, body: await registry.metrics() };
    },
  });
}

import { describe, expect, it } from 'vitest';
import { createSanitizedLogger } from '../../src/observability/logging.js';
import { createMetrics } from '../../src/observability/metrics.js';
import type { TargetResult, WindowUtc } from '../../src/core/types.js';

const window: WindowUtc = { startMs: 0, endMs: 3600000, intervalMinutes: 30 };
const canary = 'SECRET_TOKEN_person@example.invalid';
const ok = (targetId = canary): TargetResult => ({ kind: 'ok', targetId, coverage: window, slots: [], observedAtMs: 0 });

describe('sanitized logging', () => {
  it('retains useful categories but never raw fields in success or error records', () => {
    const lines: string[] = [];
    const logger = createSanitizedLogger({ write: line => { lines.push(line); } });
    const err = Object.assign(new Error(canary), { code: 'timeout', response: { body: canary }, token: canary });
    for (const event of ['request', 'provider', 'rejection', 'lifecycle', canary]) {
      logger.record(event, { surface: 'm365-inbound', provider: 'zimbra', outcome: 'unknown', statusCode: 200,
        durationMs: 12, err, req: { headers: { authorization: canary }, body: canary }, res: { body: canary },
        targetId: canary, requestId: canary, msg: canary, stack: canary, authorization: canary });
    }
    expect(lines).toHaveLength(5);
    expect(lines.join('')).not.toContain(canary);
    const record = JSON.parse(lines[0]!);
    expect(record.data).toEqual({ surface: 'm365-inbound', provider: 'zimbra', outcome: 'unknown', statusCode: 200, durationMs: 12 });
    expect(record.err).toEqual({ code: 'timeout' });
    expect(record.msg).toBe('gateway');
  });

  it('ignores inherited fields, hostile getters, arbitrary category strings and error serialization hooks', () => {
    const lines: string[] = [];
    const logger = createSanitizedLogger({ write: line => { lines.push(line); } });
    const input = Object.create({ outcome: 'useful' }) as Record<string, unknown>;
    Object.defineProperty(input, 'surface', { get() { throw new Error(canary); } });
    Object.assign(input, { provider: canary, statusCode: Infinity, durationMs: -1,
      err: { code: canary, toJSON() { throw new Error(canary); } } });
    expect(() => logger.record(canary, input)).not.toThrow();
    expect(lines.join('')).not.toContain(canary);
    expect(JSON.parse(lines[0]!).err).toEqual({ code: 'other' });
    logger.record('request', null);
    expect(lines).toHaveLength(2);
  });
});

describe('bounded semantic telemetry', () => {
  it('counts parser and pre-service rejection as failed requests without a fabricated window', async () => {
    const metrics = createMetrics();
    metrics.rejection('m365-inbound', 'parser');
    metrics.rejection('m365-inbound', 'auth');
    metrics.rejection('m365-inbound', canary);
    const output = (await metrics.render('management'))!.body;
    expect(output).toContain('freebusy_rejections_total{surface="m365-inbound",reason="parser"} 1');
    expect(output).toContain('freebusy_rejections_total{surface="m365-inbound",reason="auth"} 1');
    expect(output).toContain('freebusy_rejections_total{surface="m365-inbound",reason="other"} 1');
    expect(output).toContain('freebusy_requests_total{surface="m365-inbound",outcome="failure"} 3');
    expect(output).not.toContain(canary);
  });

  it('does not count HTTP200 Unknown, partial coverage, failure or malformed data as useful', async () => {
    const metrics = createMetrics();
    const partial = { ...ok(), coverage: { ...window, endMs: 1800000 } };
    const unknown = { ...ok(), slots: [{ startMs: 0, endMs: 1800000, status: 'unknown' }] };
    for (const result of [partial, unknown, { kind: 'error', targetId: canary, reason: 'timeout' }, null]) {
      metrics.availability('m365-inbound', window, [result], 200);
    }
    metrics.availability('m365-inbound', window, [ok()], 200);
    metrics.availability('m365-inbound', window, [ok()], 503);
    const output = await metrics.render('management');
    expect(output?.body).toContain('freebusy_requests_total{surface="m365-inbound",outcome="unknown"} 4');
    expect(output?.body).toContain('freebusy_requests_total{surface="m365-inbound",outcome="useful"} 1');
    expect(output?.body).toContain('freebusy_requests_total{surface="m365-inbound",outcome="failure"} 1');
    expect(output?.body).toContain('freebusy_target_results_total{surface="m365-inbound",outcome="unknown"} 2');
    expect(output?.body).toContain('freebusy_target_results_total{surface="m365-inbound",outcome="failure"} 2');
    expect(output?.body).not.toContain(canary);
  });

  it('counts mixed and empty requests as incomplete and preserves duplicate target counts', async () => {
    const metrics = createMetrics();
    metrics.availability('zimbra-inbound', window, [ok(), ok(), { kind: 'error', targetId: canary, reason: 'not-found' }], 200);
    metrics.availability('zimbra-inbound', window, [], 200);
    const body = (await metrics.render('management'))!.body;
    expect(body).toContain('freebusy_requests_total{surface="zimbra-inbound",outcome="unknown"} 2');
    expect(body).toContain('freebusy_target_results_total{surface="zimbra-inbound",outcome="useful"} 2');
  });

  it('keeps series bounded across target identities and invalid runtime label strings', async () => {
    const metrics = createMetrics();
    const exercise = (count: number) => {
      for (let n = 0; n < count; n++) {
        metrics.availability(`user${n}@example.invalid`, window, [ok(`target${n}`)], 200);
        metrics.provider(`token${n}`, `request${n}`, 25);
        metrics.cache(`key${n}`, `email${n}`);
        metrics.queue(`identity${n}`, 3, 2);
        metrics.breaker(`identity${n}`, `state${n}`);
      }
    };
    exercise(1);
    const series = (text: string) => text.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.slice(0, line.lastIndexOf(' ')));
    const before = series((await metrics.render('management'))!.body);
    exercise(1000);
    const output = (await metrics.render('management'))!.body;
    expect(series(output)).toEqual(before);
    expect(output).not.toMatch(/example\.invalid|target\d|token\d|request\d|identity\d/);
  });

  it('exports provider latency, timeout, cache and queue/breaker state with finite numeric values', async () => {
    const metrics = createMetrics();
    metrics.provider('graph', 'timeout', 125);
    metrics.provider('graph', 'timeout', NaN);
    metrics.cache('graph', 'hit');
    metrics.queue('graph', 4, 3);
    metrics.queue('graph', Infinity, -1);
    metrics.breaker('graph', 'open');
    const output = (await metrics.render('management'))!.body;
    expect(output).toContain('freebusy_provider_attempts_total{provider="graph",outcome="timeout"} 2');
    expect(output).toContain('freebusy_provider_duration_seconds_sum{provider="graph"} 0.125');
    expect(output).toContain('freebusy_provider_duration_seconds_count{provider="graph"} 1');
    expect(output).toContain('freebusy_cache_total{provider="graph",outcome="hit"} 1');
    expect(output).toContain('freebusy_pending_work{provider="graph",state="active"} 4');
    expect(output).toContain('freebusy_pending_work{provider="graph",state="queued"} 3');
    expect(output).toContain('freebusy_breaker_state{provider="graph"} 1');
    expect(output).not.toMatch(/NaN|Infinity/);
  });

  it('exposes its private registry only to management and does not share state between instances', async () => {
    const metrics = createMetrics();
    metrics.cache('graph', 'hit');
    for (const surface of ['m365-inbound', 'zimbra-inbound', canary, undefined]) {
      expect(await metrics.render(surface)).toBeUndefined();
    }
    const output = await metrics.render('management');
    expect(output?.contentType).toContain('text/plain');
    expect((await createMetrics().render('management'))!.body).not.toContain('outcome="hit"} 1');
  });
});

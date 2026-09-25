import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { TargetResult, WindowUtc } from '../../src/core/types.js';
import { loadDirectory } from '../../src/directory/load.js';
import { createFreeBusyService } from '../../src/freebusy/service.js';
import { createEwsRoute } from '../../src/ews/route.js';
import { encodeAvailabilityResponse } from '../../src/ews/response.js';
import type { Principal } from '../../src/security/principals.js';
import type { ValidatedConfig } from '../../src/config/validate.js';

const principal: Principal = { id: 'pilot-exo', username: 'exo', surface: 'm365-inbound', allowedProvider: 'zimbra' };
const targetId = 'pilot-zimbra-bob';
const window: WindowUtc = { startMs: 1789351200000, endMs: 1789365600000, intervalMinutes: 30 };
const halfHour = 1_800_000;
const details = { subject: 'SUBJECT_CANARY', location: 'LOCATION_CANARY', body: 'BODY_CANARY',
  eventId: 'EVENT_ID_CANARY', organizer: 'ORGANIZER_CANARY', attendees: ['ATTENDEE_CANARY'] };
const directory = loadDirectory(JSON.parse(readFileSync('config/directory.example.json', 'utf8')),
  [principal, { id: 'pilot-zimbra', username: 'zimbra', surface: 'zimbra-inbound', allowedProvider: 'graph' }], 'privacy-test');
const limits: ValidatedConfig['limits'] = JSON.parse(readFileSync('contracts/limits.json', 'utf8'));
const ctx = () => ({ signal: new AbortController().signal, deadlineMonoMs: performance.now() + 8000 });
const invalid = { kind: 'error', targetId, reason: 'invalid-response' };
function good() {
  return { kind: 'ok' as const, targetId, coverage: { ...window }, observedAtMs: window.startMs,
    slots: [{ startMs: window.startMs, endMs: window.startMs + halfHour, status: 'busy' }] };
}
function setup(value: unknown, rejected = false) {
  const lookup = vi.fn(async () => {
    if (rejected) throw new Error('BODY_CANARY');
    return value as TargetResult; // Deliberately adversarial runtime provider, not a typed-data guarantee.
  });
  const resolveTarget = vi.fn(directory.resolveTarget);
  const graph = vi.fn(async (): Promise<TargetResult> => { throw new Error('Unexpected provider'); });
  const service = createFreeBusyService({ ...directory, resolveTarget },
    { graph: { kind: 'graph', lookup: graph }, zimbra: { kind: 'zimbra', lookup } });
  return { service, lookup, graph, resolveTarget,
    run: (addresses = ['bob@example.invalid'], requested = window) => service(principal, 'm365-inbound', addresses, requested, ctx()) };
}
function noSecrets(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  expect(text).not.toMatch(/CANARY|CalendarEventDetails|canonicalSmtp/);
}

describe('W20 immutable allowlisted result boundary', () => {
  it('strips provider details before exposing structured/cache-candidate results or XML', async () => {
    const raw = { ...good(), ...details, coverage: { ...window, ...details },
      slots: [{ ...good().slots[0], ...details }] };
    const [result] = await setup(raw).run();
    expect(result).toEqual(good());
    noSecrets(result);
    const xml = encodeAvailabilityResponse(window, [result]);
    noSecrets(xml);
    expect(xml).toContain('<t:MergedFreeBusy>20000000</t:MergedFreeBusy>');
  });

  it('owns and deeply freezes every allowed object without freezing or retaining provider objects', async () => {
    const raw = good();
    const results = await setup(raw).run(['bob@example.invalid', 'bob@zfb.example.invalid']);
    const result = results[0]!;
    expect(Object.isFrozen(results)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toBe(raw);
    if (result.kind !== 'ok') throw new Error('Expected success');
    expect(result.coverage).not.toBe(raw.coverage);
    expect(result.slots).not.toBe(raw.slots);
    expect(result.slots[0]).not.toBe(raw.slots[0]);
    for (const object of [result.coverage, result.slots, ...result.slots]) expect(Object.isFrozen(object)).toBe(true);
    raw.coverage.endMs = 0;
    raw.slots[0]!.status = 'BODY_CANARY';
    raw.slots.push({ startMs: 0, endMs: 1, status: 'BODY_CANARY' });
    expect(result).toEqual(good());
    expect(results[1]).toEqual(good());
    noSecrets(results);
  });

  it('does not evaluate extra getters, toJSON methods, or nested provider metadata', async () => {
    let touched = 0;
    const secretGetter = { get: () => { touched++; throw new Error('BODY_CANARY'); }, enumerable: true };
    const raw = good();
    for (const item of [raw, raw.coverage, raw.slots, raw.slots[0]!]) {
      Object.defineProperty(item, 'subject', secretGetter);
      Object.defineProperty(item, 'toJSON', secretGetter);
    }
    const [result] = await setup(raw).run();
    expect(result).toEqual(good());
    noSecrets(result);
    expect(touched).toBe(0);
  });

  it.each(['not-found', 'not-authorized', 'timeout', 'throttled', 'backend-unavailable', 'invalid-response', 'unsupported-timezone'])
    ('keeps only fixed error metadata for %s', async reason => {
      const raw = { kind: 'error', targetId, reason, ...details, slots: [details], error: { message: 'BODY_CANARY' } };
      const [result] = await setup(raw).run();
      expect(result).toEqual({ kind: 'error', targetId, reason });
      expect(Object.isFrozen(result)).toBe(true);
      expect(result).not.toBe(raw);
      noSecrets(result);
      noSecrets(encodeAvailabilityResponse(window, [result]));
    });

  it.each([
    () => null, () => [], () => 'BODY_CANARY', () => ({ ...good(), kind: 'BODY_CANARY' }),
    () => ({ ...good(), targetId: 'BODY_CANARY' }), () => ({ ...good(), targetId: 1 }),
    () => ({ ...good(), observedAtMs: NaN }), () => ({ ...good(), observedAtMs: Infinity }),
    () => ({ ...good(), observedAtMs: 8640000000000001 }), () => ({ ...good(), observedAtMs: 1.1 }),
    () => ({ ...good(), observedAtMs: 'BODY_CANARY' }), () => ({ ...good(), coverage: null }),
    () => ({ ...good(), coverage: [] }), () => ({ ...good(), coverage: { ...window, intervalMinutes: 15 } }),
    () => ({ ...good(), coverage: { ...window, startMs: window.startMs - 1 } }),
    () => ({ ...good(), coverage: { ...window, endMs: window.endMs + 1 } }),
    () => ({ ...good(), coverage: { ...window, startMs: window.endMs } }),
    () => ({ ...good(), coverage: { ...window, endMs: NaN } }),
    () => ({ ...good(), coverage: { ...window, intervalMinutes: '30' } }),
    () => ({ ...good(), slots: null }), () => ({ ...good(), slots: {} }), () => ({ ...good(), slots: new Array(1) }),
    () => ({ ...good(), slots: [null] }), () => ({ ...good(), slots: [{ ...good().slots[0], status: 'BODY_CANARY' }] }),
    () => ({ ...good(), slots: [{ ...good().slots[0], status: 'Busy' }] }),
    () => ({ ...good(), slots: [{ ...good().slots[0], startMs: window.startMs - 1 }] }),
    () => ({ ...good(), slots: [{ ...good().slots[0], endMs: window.endMs + 1 }] }),
    () => ({ ...good(), slots: [{ ...good().slots[0], endMs: window.startMs }] }),
    () => ({ ...good(), slots: [{ ...good().slots[0], endMs: 1.1 }] }),
    () => ({ ...good(), slots: [{ ...good().slots[0], startMs: 'BODY_CANARY' }] }),
    () => ({ ...good(), slots: Array.from({ length: 20001 }, () => good().slots[0]) }),
    () => ({ kind: 'error', targetId, reason: 'BODY_CANARY', ...details }),
    () => ({ kind: 'error', targetId, reason: undefined }),
    () => Object.create(good()),
    () => { const value: Record<string, unknown> = good(); delete value.observedAtMs; return value; },
    () => ({ ...good(), coverage: Object.create(window) }),
    () => ({ ...good(), slots: [Object.create(good().slots[0]!)] }),
    () => new Proxy(good(), { getOwnPropertyDescriptor() { throw new Error('BODY_CANARY'); } }),
  ])('rejects malformed runtime result %# as a complete non-disclosing failure', async value => {
    const [result] = await setup(value()).run();
    expect(result).toEqual(invalid);
    expect(Object.isFrozen(result)).toBe(true);
    const xml = encodeAvailabilityResponse(window, [result]);
    expect(xml).toContain('ErrorInternalServerError');
    expect(xml).not.toContain('MergedFreeBusy>');
    noSecrets(result);
    noSecrets(xml);
  });

  it.each(['kind', 'targetId', 'coverage', 'slots', 'observedAtMs'])('rejects required accessor %s without executing it', async field => {
    let touched = 0;
    const raw = good();
    Object.defineProperty(raw, field, { get: () => { touched++; return 'BODY_CANARY'; } });
    expect((await setup(raw).run())[0]).toEqual(invalid);
    expect(touched).toBe(0);
  });

  it('preserves partial coverage and explicit unknown instead of inventing free time', async () => {
    const coverage = { ...window, endMs: window.startMs + 2 * halfHour };
    const raw = { ...good(), coverage, slots: [{ startMs: coverage.startMs, endMs: coverage.startMs + halfHour, status: 'unknown' }] };
    const [result] = await setup(raw).run();
    expect(result).toEqual(raw);
    expect(encodeAvailabilityResponse(window, [result])).toContain('<t:MergedFreeBusy>40444444</t:MergedFreeBusy>');
    raw.slots[0]!.endMs = coverage.endMs + 1;
    expect((await setup(raw).run())[0]).toEqual(invalid);
  });

  it.each(['free', 'tentative', 'busy', 'oof', 'unknown'])('retains normalized status %s without any private metadata', async status => {
    const raw = { ...good(), slots: [{ ...good().slots[0], status, ...details }] };
    const [result] = await setup(raw).run();
    expect(result).toMatchObject({ kind: 'ok', slots: [{ status }] });
    noSecrets(result);
  });

  it('preserves duplicate order, authorizes each original target and never performs wrong-surface work', async () => {
    const app = setup({ ...good(), ...details });
    const results = await app.run(['bob@example.invalid', 'missing@example.invalid', 'bob@zfb.example.invalid', 'alice@company.example.invalid']);
    expect(results.map(result => result.kind)).toEqual(['ok', 'error', 'ok', 'error']);
    expect(results[1]).toEqual({ kind: 'error', targetId: 'unresolved', reason: 'not-authorized' });
    expect(Object.isFrozen(results[1])).toBe(true);
    expect(app.resolveTarget).toHaveBeenCalledTimes(4);
    expect(app.lookup).toHaveBeenCalledTimes(1);
    expect(app.graph).not.toHaveBeenCalled();
    const denied = await app.service(principal, 'zimbra-inbound', ['bob@example.invalid'], window, ctx());
    expect(denied[0]).toEqual(results[1]);
    expect(app.lookup).toHaveBeenCalledTimes(1);
    noSecrets(results);
  });

  it('creates immutable sanitized failures for provider throws and pre-aborted requests', async () => {
    const app = setup(undefined, true);
    const [result] = await app.run();
    expect(result).toEqual({ kind: 'error', targetId, reason: 'backend-unavailable' });
    expect(Object.isFrozen(result)).toBe(true);
    const controller = new AbortController(); controller.abort();
    const timeout = await app.service(principal, 'm365-inbound', ['bob@example.invalid'], window,
      { signal: controller.signal, deadlineMonoMs: 0 });
    expect(timeout[0]).toEqual({ kind: 'error', targetId, reason: 'timeout' });
    expect(Object.isFrozen(timeout[0])).toBe(true);
    expect(app.lookup).toHaveBeenCalledTimes(1);
    noSecrets(result);
  });

  it.each(['success', 'error', 'malformed', 'throw'])('DetailedMerged %s path never discloses provider sentinels', async scenario => {
    const value = scenario === 'error' ? { kind: 'error', targetId, reason: 'not-found', ...details }
      : { ...good(), ...details, ...(scenario === 'malformed' ? { observedAtMs: 'BODY_CANARY' } : {}) };
    const app = setup(value, scenario === 'throw');
    const route = createEwsRoute(app.service, limits, () => performance.now());
    const response = await route(principal, 'm365-inbound', readFileSync('fixtures/ews/request.xml'), undefined);
    expect(response.status).toBe(200);
    noSecrets(response.body);
    expect(response.body).not.toContain('Detailed');
    expect(response.body).toContain(scenario === 'success' ? '<t:FreeBusyViewType>FreeBusyMerged' : '<t:FreeBusyViewType>None');
  });
});

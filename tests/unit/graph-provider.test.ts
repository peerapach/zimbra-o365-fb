import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createGraphProvider } from '../../src/providers/graph.js';
import { normalizeGraph } from '../../src/providers/graph-map.js';
import type { CallContext, HttpResponse, HttpTransport, Target, TokenSource, WindowUtc } from '../../src/core/types.js';

const success: unknown = JSON.parse(readFileSync(new URL('../../fixtures/graph/success.json', import.meta.url), 'utf8'));
const overflow: unknown = JSON.parse(readFileSync(new URL('../../fixtures/graph/error.json', import.meta.url), 'utf8'));
const requestFixture: unknown = JSON.parse(readFileSync(new URL('../../fixtures/graph/request.json', import.meta.url), 'utf8'));
const base = 1789351200000;
const minute = 60000;
const window: WindowUtc = { startMs: base, endMs: base + 240 * minute, intervalMinutes: 30 };
const target: Target = { entryId: 'alice-entry', provider: 'graph', canonicalSmtp: 'alice@tenant.example.invalid' };
const context = (): CallContext => ({ signal: new AbortController().signal, deadlineMonoMs: 4000 });
const span = (startMs: number, endMs: number, status: string) => ({ startMs, endMs, status });

function changedSchedule(payload: unknown): { value: Array<Record<string, unknown>> } {
  return structuredClone(payload) as { value: Array<Record<string, unknown>> };
}

function httpResponse(value: unknown, status = 200): HttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(value)) };
}

function harness(response: HttpResponse) {
  const request = vi.fn<HttpTransport['request']>().mockResolvedValue(response);
  const getToken = vi.fn<TokenSource['getToken']>().mockResolvedValue('synthetic-token');
  const transport: HttpTransport = { request };
  const tokenSource: TokenSource = { getToken };
  const provider = createGraphProvider({ transport, tokenSource, wallMs: () => 1790000000000, monoMs: () => 0 });
  return { provider, request, getToken };
}

describe('Graph response normalization', () => {
  it('maps the checked-in schedule to the golden free/busy intervals and drops private details', () => {
    const result = normalizeGraph(success, target, window, 1790000000000);
    expect(result).toEqual({
      kind: 'ok', targetId: 'alice-entry', coverage: window, observedAtMs: 1790000000000,
      slots: [
        span(base, base + 30 * minute, 'free'),
        span(base + 30 * minute, base + 60 * minute, 'busy'),
        span(base + 60 * minute, base + 90 * minute, 'tentative'),
        span(base + 90 * minute, base + 150 * minute, 'oof'),
        span(base + 150 * minute, base + 240 * minute, 'free'),
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_LEAK_(?:SUBJECT|LOCATION|ELSEWHERE)/);
  });

  it('keeps an unrecognized event status unknown even when the merged view says free', () => {
    const payload = changedSchedule(success);
    const scheduleItems = payload.value[0]?.scheduleItems as Array<Record<string, unknown>>;
    scheduleItems.push({
      status: 'futureGraphStatus', start: { dateTime: '2026-09-14T04:30:00', timeZone: 'UTC' },
      end: { dateTime: '2026-09-14T05:00:00', timeZone: 'UTC' }, subject: 'DO_NOT_LEAK_FUTURE',
    });
    const result = normalizeGraph(payload, target, window, 1790000000000);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.slots).toContainEqual(span(base + 150 * minute, base + 180 * minute, 'unknown'));
    expect(JSON.stringify(result)).not.toContain('DO_NOT_LEAK_FUTURE');
  });

  it('rejects overflow, including the Graph 5006 fixture, instead of returning partial availability', () => {
    expect(normalizeGraph(overflow, target, window, 1790000000000)).toEqual({
      kind: 'error', targetId: 'alice-entry', reason: 'invalid-response',
    });
  });

  it.each([
    ['missing', { value: [] }],
    ['duplicate', { value: [...(success as { value: unknown[] }).value, ...(success as { value: unknown[] }).value] }],
    ['unrelated', { value: [{ ...(success as { value: Array<Record<string, unknown>> }).value[0], scheduleId: 'bob@example.test' }] }],
  ])('rejects a %s schedule result rather than binding it by position', (_label, payload) => {
    expect(normalizeGraph(payload, target, window, 1790000000000)).toMatchObject({ kind: 'error', reason: 'invalid-response' });
  });

  it.each([
    ['missing scheduleItems', { value: [{ scheduleId: target.canonicalSmtp, availabilityView: '00000000' }] }],
    ['missing status', { value: [{ scheduleId: target.canonicalSmtp, availabilityView: '00000000', scheduleItems: [{ start: { dateTime: '2026-09-14T02:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-09-14T02:30:00', timeZone: 'UTC' } }] }] }],
    ['invalid timestamp', { value: [{ scheduleId: target.canonicalSmtp, availabilityView: '00000000', scheduleItems: [{ status: 'busy', start: { dateTime: '2026-09-14T02:00:00', timeZone: 'Europe/London' }, end: { dateTime: '2026-09-14T02:30:00', timeZone: 'UTC' } }] }] }],
    ['wrong grid length', { value: [{ ...(success as { value: Array<Record<string, unknown>> }).value[0], availabilityView: '0000000' }] }],
    ['unknown grid value', { value: [{ ...(success as { value: Array<Record<string, unknown>> }).value[0], availabilityView: '02134000' }] }],
    ['contradictory grid', { value: [{ ...(success as { value: Array<Record<string, unknown>> }).value[0], availabilityView: '00133000' }] }],
  ])('rejects %s instead of treating incomplete data as free', (_label, payload) => {
    expect(normalizeGraph(payload, target, window, 1790000000000)).toMatchObject({ kind: 'error', reason: 'invalid-response' });
  });
});

describe('Graph getSchedule provider', () => {
  it('sends one fixed POST using the target mailbox path and canonical schedule entry in UTC', async () => {
    const response = httpResponse(success);
    const { provider, request, getToken } = harness(response);
    const mailboxTarget: Target = { ...target, graphObjectId: '11111111-2222-3333-4444-555555555555' };
    const ctx = context();
    await expect(provider.lookup(mailboxTarget, window, ctx)).resolves.toMatchObject({ kind: 'ok', targetId: 'alice-entry' });
    expect(getToken).toHaveBeenCalledWith(ctx);
    expect(request).toHaveBeenCalledTimes(1);
    const call = request.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call).toMatchObject({
      url: 'https://graph.microsoft.com/v1.0/users/11111111-2222-3333-4444-555555555555/calendar/getSchedule',
      method: 'POST', headers: {
        authorization: 'Bearer synthetic-token', accept: 'application/json', 'content-type': 'application/json',
      }, maxResponseBytes: 4194304, signal: ctx.signal,
    });
    expect(JSON.parse(call!.body)).toEqual(requestFixture);
  });

  it('encodes canonical SMTP as a path component when no Graph object ID is configured', async () => {
    const response = httpResponse({ value: [{ scheduleId: 'a+b@example.test', availabilityView: '0', scheduleItems: [] }] });
    const { provider, request } = harness(response);
    await provider.lookup({ ...target, canonicalSmtp: 'a+b@example.test' }, { ...window, endMs: base + 30 * minute }, context());
    expect(request.mock.calls[0]?.[0].url).toBe('https://graph.microsoft.com/v1.0/users/a%2Bb%40example.test/calendar/getSchedule');
  });

  it.each([
    [401, 'not-authorized'], [403, 'not-authorized'], [429, 'throttled'], [500, 'backend-unavailable'], [302, 'invalid-response'], [600, 'invalid-response'],
  ] as const)('maps HTTP %s to a typed failure', async (status, reason) => {
    const { provider } = harness(httpResponse({ error: 'synthetic' }, status));
    await expect(provider.lookup(target, window, context())).resolves.toMatchObject({ kind: 'error', targetId: 'alice-entry', reason });
  });

  it('blocks a non-Graph target before token acquisition or transport', async () => {
    const { provider, request, getToken } = harness(httpResponse(success));
    await expect(provider.lookup({ ...target, provider: 'zimbra' }, window, context()))
      .resolves.toMatchObject({ kind: 'error', targetId: 'alice-entry', reason: 'not-authorized' });
    expect(getToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('maps malformed JSON and token/transport failures to sanitized typed errors', async () => {
    const malformed: HttpResponse = { status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{') };
    const invalid = harness(malformed);
    await expect(invalid.provider.lookup(target, window, context())).resolves.toMatchObject({ kind: 'error', reason: 'invalid-response' });

    const unavailable = harness(httpResponse(success));
    unavailable.getToken.mockRejectedValue(new Error('SENSITIVE_TOKEN'));
    const result = await unavailable.provider.lookup(target, window, context());
    expect(result).toEqual({ kind: 'error', targetId: 'alice-entry', reason: 'backend-unavailable' });
    expect(JSON.stringify(result)).not.toContain('SENSITIVE_TOKEN');
    expect(unavailable.request).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON media type before parsing the response body', async () => {
    const html = { ...httpResponse(success), headers: { 'content-type': 'text/html' } };
    const { provider } = harness(html);
    await expect(provider.lookup(target, window, context()))
      .resolves.toMatchObject({ kind: 'error', targetId: 'alice-entry', reason: 'invalid-response' });
  });
});

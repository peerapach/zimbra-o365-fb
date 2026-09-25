import { describe, expect, it, vi } from 'vitest';
import { XMLBuilderImpl } from 'xmlbuilder2/lib/builder/XMLBuilderImpl.js';
import { readFileSync } from 'node:fs';
import { validateConfig } from '../../src/config/validate.js';
import type { TargetResult } from '../../src/core/types.js';
import { createEwsRoute } from '../../src/ews/route.js';
import { encodeAvailabilityResponse } from '../../src/ews/response.js';
import { parseXmlBounded, type XmlNode } from '../../src/xml/parse.js';

const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const MESSAGES = 'http://schemas.microsoft.com/exchange/services/2006/messages';
const TYPES = 'http://schemas.microsoft.com/exchange/services/2006/types';
const base = 1789351200000;
const minute = 60000;
const window = { startMs: base, endMs: base + 60 * minute, intervalMinutes: 30 };
const coverage = { startMs: window.startMs, endMs: window.endMs, intervalMinutes: window.intervalMinutes };
const slot = (startMs: number, endMs: number, status: string) => ({ startMs, endMs, status });
const success = (targetId: string, status = 'busy') => ({
  kind: 'ok', targetId, coverage, slots: [slot(base, base + 30 * minute, status)], observedAtMs: base,
});
const error = (targetId: string, reason: unknown) => ({ kind: 'error', targetId, reason });
const parse = (xml: string) => parseXmlBounded(Buffer.from(xml, 'utf8'));
const descendants = (node: XmlNode): readonly XmlNode[] => [node, ...node.children.flatMap(descendants)];
const child = (node: XmlNode, uri: string, local: string): XmlNode => {
  const matches = node.children.filter(item => item.uri === uri && item.local === local);
  expect(matches).toHaveLength(1);
  return matches[0]!;
};
function responseNodes(xml: string): readonly XmlNode[] {
  const root = parse(xml);
  const body = child(root, SOAP, 'Body');
  const operation = child(body, MESSAGES, 'GetUserAvailabilityResponse');
  return child(operation, MESSAGES, 'FreeBusyResponseArray').children;
}

function expectError(response: XmlNode, code: string): void {
  const message = child(response, MESSAGES, 'ResponseMessage');
  expect(message.attributes).toEqual([{ uri: '', local: 'ResponseClass', value: 'Error' }]);
  expect(child(message, MESSAGES, 'ResponseCode').text).toBe(code);
  const view = child(response, MESSAGES, 'FreeBusyView');
  expect(view.children.map(node => node.uri + '|' + node.local)).toEqual([TYPES + '|FreeBusyViewType']);
  expect(view.children[0]!.text).toBe('None');
  expect(descendants(response).some(node => node.uri === TYPES &&
    ['MergedFreeBusy', 'CalendarEventArray', 'CalendarEvent'].includes(node.local))).toBe(false);
}

function expectSuccess(response: XmlNode, merged: string): void {
  const message = child(response, MESSAGES, 'ResponseMessage');
  expect(message.attributes).toEqual([{ uri: '', local: 'ResponseClass', value: 'Success' }]);
  expect(child(message, MESSAGES, 'ResponseCode').text).toBe('NoError');
  const view = child(response, MESSAGES, 'FreeBusyView');
  expect(view.children.map(node => node.uri + '|' + node.local)).toEqual([
    TYPES + '|FreeBusyViewType', TYPES + '|MergedFreeBusy', TYPES + '|CalendarEventArray',
  ]);
  expect(view.children[1]!.text).toBe(merged);
}

describe('EWS per-target response errors', () => {
  it('rejects maximal duplicate event amplification before allocating any CalendarEvent', () => {
    const maximal = { startMs: base, endMs: base + 17568 * 5 * minute, intervalMinutes: 5 };
    const value = { kind: 'ok', targetId: 'duplicate', coverage: maximal, observedAtMs: base,
      slots: Array.from({ length: 17568 }, (_, index) => slot(base + index * 5 * minute, base + (index + 1) * 5 * minute, index % 2 ? 'oof' : 'busy')) };
    const original = XMLBuilderImpl.prototype.ele;
    let events = 0;
    const guarded = vi.spyOn(XMLBuilderImpl.prototype, 'ele').mockImplementation(function (this: XMLBuilderImpl, ...args) {
      if (args.includes('t:CalendarEvent')) { events++; throw new Error('Unsafe CalendarEvent allocation intercepted'); }
      return original.apply(this, args);
    });
    try {
      expect(() => encodeAvailabilityResponse(maximal, Array(100).fill(value))).toThrow('Availability response exceeds byte limit');
      const mergedOnly = encodeAvailabilityResponse(maximal, Array(100).fill(value), { requestedView: 'MergedOnly' });
      expect(Buffer.byteLength(mergedOnly)).toBeLessThan(8_388_608);
      expect(mergedOnly.split('<m:FreeBusyResponse>').length - 1).toBe(100);
      expect(mergedOnly.split('<t:MergedFreeBusy>').length - 1).toBe(100);
      expect(events).toBe(0);
    } finally { guarded.mockRestore(); }
  });

  it.each(['MergedOnly', 'None'] as const)('does not allocate discarded events for a %s response', requestedView => {
    const original = XMLBuilderImpl.prototype.ele;
    const guarded = vi.spyOn(XMLBuilderImpl.prototype, 'ele').mockImplementation(function (this: XMLBuilderImpl, ...args) {
      if (args.includes('t:CalendarEvent')) throw new Error('Discarded CalendarEvent allocation intercepted');
      return original.apply(this, args);
    });
    try {
      const xml = encodeAvailabilityResponse(window, [success('merged')], { requestedView });
      const view = child(responseNodes(xml)[0]!, MESSAGES, 'FreeBusyView');
      expect(view.children.map(node => node.local)).toEqual(requestedView === 'None' ? ['FreeBusyViewType'] : ['FreeBusyViewType', 'MergedFreeBusy']);
      expect(view.children.map(node => node.text)).toEqual(requestedView === 'None' ? ['None'] : ['MergedOnly', '20']);
    } finally { guarded.mockRestore(); }
  });

  it.each(['None', 'MergedOnly', 'FreeBusy', 'FreeBusyMerged', 'DetailedMerged'] as const)(
    'accounts for the last closing byte and preserves namespaces in %s', requestedView => {
      const results = [success('same-id'), error('hidden', 'timeout'), success('same-id', 'tentative')];
      const xml = encodeAvailabilityResponse(window, results, { requestedView });
      const bytes = Buffer.byteLength(xml, 'utf8');
      expect(encodeAvailabilityResponse(window, results, { requestedView, maxResponseBytes: bytes })).toBe(xml);
      expect(encodeAvailabilityResponse(window, results, { requestedView, maxResponseBytes: bytes + 1 })).toBe(xml);
      expect(() => encodeAvailabilityResponse(window, results, { requestedView, maxResponseBytes: bytes - 1 }))
        .toThrow('Availability response exceeds byte limit');
      const nodes = responseNodes(xml);
      expect(nodes).toHaveLength(3);
      expectError(nodes[1]!, 'ErrorInternalServerError');
      for (const index of [0, 2]) {
        const view = child(nodes[index]!, MESSAGES, 'FreeBusyView');
        expect(child(view, TYPES, 'FreeBusyViewType').text).toBe(requestedView === 'DetailedMerged' ? 'FreeBusyMerged' : requestedView);
        expect(view.children.every(node => node.uri === TYPES)).toBe(true);
      }
    });

  it('snapshots duplicate object results once but does not deduplicate distinct same-ID results', () => {
    const first = success('same-id');
    const readSlots = vi.fn(() => first.slots);
    const value = { ...first, get slots() { return readSlots(); } };
    const nodes = responseNodes(encodeAvailabilityResponse(window, [value, success('same-id', 'tentative'), value]));
    expect(readSlots).toHaveBeenCalledTimes(1);
    expectSuccess(nodes[0]!, '20'); expectSuccess(nodes[1]!, '10'); expectSuccess(nodes[2]!, '20');
  });

  it.each([0, -1, 1.5, NaN, Infinity, 8_388_609])('rejects an invalid byte limit %s', maxResponseBytes => {
    expect(() => encodeAvailabilityResponse(window, [success('target')], { maxResponseBytes })).toThrow('Invalid response options');
  });

  it('returns a complete sanitized Server fault when the configured route byte limit is exceeded', async () => {
    const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
    const config = validateConfig(json('config/example.json'), json('config/directory.example.json'), json('contracts/limits.json'), () => true);
    let attendeeCount = 0;
    const route = createEwsRoute(async (_principal, _surface, addresses, requested) => {
      attendeeCount = addresses.length;
      const result: TargetResult = { kind: 'ok', targetId: 'PRIVATE_CANARY', coverage: requested, observedAtMs: requested.startMs,
        slots: Array.from({ length: 17568 }, (_, index) => ({ startMs: requested.startMs + index * 5 * minute,
          endMs: requested.startMs + (index + 1) * 5 * minute, status: index % 2 ? 'oof' : 'busy' })) };
      return addresses.map(() => result);
    }, config.limits, () => performance.now());
    const mailbox = '<t:MailboxData><t:Email><t:Address>bob@zfb.example.invalid</t:Address></t:Email>'
      + '<t:AttendeeType>Required</t:AttendeeType><t:ExcludeConflicts>false</t:ExcludeConflicts></t:MailboxData>';
    const request = readFileSync('fixtures/ews/request.xml', 'utf8')
      .replace('2026-09-14T06:00:00Z', '2026-11-14T02:00:00Z').replace('>30<', '>5<')
      .replace('<m:MailboxDataArray>', `<m:MailboxDataArray>${mailbox.repeat(99)}`);
    const result = await route({ id: 'fixture', surface: 'm365-inbound', username: 'fixture', allowedProvider: 'zimbra' },
      'm365-inbound', Buffer.from(request), undefined);
    expect(attendeeCount).toBe(100);
    expect(result.status).toBe(500);
    const fault = child(child(parse(result.body), SOAP, 'Body'), SOAP, 'Fault');
    expect(child(fault, '', 'faultcode').text).toBe('s:Server');
    expect(child(fault, '', 'faultstring').text).toBe('Service unavailable');
    expect(result.body).not.toMatch(/PRIVATE_CANARY|FreeBusyResponse|exceeds|RangeError/);
    expect(Buffer.byteLength(result.body)).toBeLessThan(500);
  });

  it.each([
    ['not-authorized', 'ErrorNoFreeBusyAccess'],
    ['not-found', 'ErrorNoFreeBusyAccess'],
    ['timeout', 'ErrorInternalServerError'],
    ['throttled', 'ErrorInternalServerError'],
    ['backend-unavailable', 'ErrorInternalServerError'],
    ['invalid-response', 'ErrorInternalServerError'],
    ['unsupported-timezone', 'ErrorInternalServerError'],
  ] as const)('maps %s to a non-free EWS response', (reason, code) => {
    const [response] = responseNodes(encodeAvailabilityResponse(window, [error('target', reason)]));
    expectError(response!, code);
  });

  it('makes unauthorized and nonexistent target responses indistinguishable', () => {
    const denied = encodeAvailabilityResponse(window, [error('same-private-target', 'not-authorized')]);
    const missing = encodeAvailabilityResponse(window, [error('same-private-target', 'not-found')]);
    expect(denied).toBe(missing);
    expectError(responseNodes(denied)[0]!, 'ErrorNoFreeBusyAccess');
  });

  it('preserves mixed result order and duplicate target entries', () => {
    const xml = encodeAvailabilityResponse(window, [
      success('duplicate-id', 'busy'),
      error('hidden-id', 'timeout'),
      success('duplicate-id', 'tentative'),
      error('duplicate-id', 'not-found'),
    ]);
    const output = responseNodes(xml);
    expect(output).toHaveLength(4);
    expectSuccess(output[0]!, '20');
    expectError(output[1]!, 'ErrorInternalServerError');
    expectSuccess(output[2]!, '10');
    expectError(output[3]!, 'ErrorNoFreeBusyAccess');
  });

  it('turns malformed and missing success data into errors without erasing valid results', () => {
    const xml = encodeAvailabilityResponse(window, [
      success('valid'),
      { kind: 'ok', targetId: 'broken', coverage, slots: null, observedAtMs: base },
      { targetId: 'missing-kind', coverage, slots: [] },
    ]);
    const output = responseNodes(xml);
    expect(output).toHaveLength(3);
    expectSuccess(output[0]!, '20');
    expectError(output[1]!, 'ErrorInternalServerError');
    expectError(output[2]!, 'ErrorInternalServerError');
  });

  it('isolates a revoked proxy entry between valid results', () => {
    const revoked = Proxy.revocable(success('revoked-entry'), {});
    revoked.revoke();
    const xml = encodeAvailabilityResponse(window, [success('before'), revoked.proxy, success('after')]);
    const output = responseNodes(xml);
    expect(output).toHaveLength(3);
    expectSuccess(output[0]!, '20');
    expectError(output[1]!, 'ErrorInternalServerError');
    expectSuccess(output[2]!, '20');
  });

  it('converts a throwing result-index accessor to one sanitized target error', () => {
    const results: unknown[] = [success('before'), success('throwing-index')];
    Object.defineProperty(results, '1', {
      get: () => { throw new Error('INDEX-READ-SECRET'); },
    });
    const xml = encodeAvailabilityResponse(window, results);
    const output = responseNodes(xml);
    expect(output).toHaveLength(2);
    expectSuccess(output[0]!, '20');
    expectError(output[1]!, 'ErrorInternalServerError');
    expect(xml).not.toContain('INDEX-READ-SECRET');
  });

  it('uses one validated target count when a result read changes array length', () => {
    const values: unknown[] = [success('before'), success('removed')];
    let lengthReads = 0;
    const changingLength = new Proxy(values, {
      get(target, property, receiver) {
        if (property === 'length') return ++lengthReads === 1 ? 2 : 1;
        if (property === '0') target.pop();
        return Reflect.get(target, property, receiver);
      },
    });
    const xml = encodeAvailabilityResponse(window, changingLength);
    const output = responseNodes(xml);
    expect(lengthReads).toBe(1);
    expect(output).toHaveLength(2);
    expectSuccess(output[0]!, '20');
    expectError(output[1]!, 'ErrorInternalServerError');
  });

  it('fails closed on unknown result discriminants and failure reasons', () => {
    const xml = encodeAvailabilityResponse(window, [
      { kind: 'error', reason: 'unexpected-private-reason', targetId: 'a' },
      { kind: 'future-kind', targetId: 'b' },
      null,
    ]);
    const output = responseNodes(xml);
    expect(output).toHaveLength(3);
    for (const response of output) expectError(response, 'ErrorInternalServerError');
  });

  it('does not serialize target identifiers, backend details, or arbitrary fields', () => {
    const xml = encodeAvailabilityResponse(window, [
      {
        ...success('TARGET-SENTINEL'),
        subject: 'SUBJECT-SENTINEL',
        location: 'LOCATION-SENTINEL',
        eventId: 'EVENT-SENTINEL',
      },
      {
        ...error('PRIVATE-TARGET-SENTINEL', 'backend-unavailable'),
        backendMessage: 'BACKEND-MESSAGE-SENTINEL',
        cause: { responseBody: 'SECRET-BODY-SENTINEL' },
      },
    ]);
    for (const secret of [
      'TARGET-SENTINEL', 'SUBJECT-SENTINEL', 'LOCATION-SENTINEL', 'EVENT-SENTINEL',
      'PRIVATE-TARGET-SENTINEL', 'BACKEND-MESSAGE-SENTINEL', 'SECRET-BODY-SENTINEL',
    ]) expect(xml).not.toContain(secret);
    expect(parse(xml).uri).toBe(SOAP);
  });

  it('uses fixed SOAP and EWS namespaces and emits a well-formed document', () => {
    const xml = encodeAvailabilityResponse(window, [success('private-id'), error('private-id', 'timeout')]);
    const root = parse(xml);
    expect(root).toMatchObject({ uri: SOAP, local: 'Envelope' });
    expect(root.children.map(node => node.uri + '|' + node.local)).toEqual([SOAP + '|Body']);
    const body = root.children[0]!;
    expect(body.children.map(node => node.uri + '|' + node.local)).toEqual([MESSAGES + '|GetUserAvailabilityResponse']);
    const operation = body.children[0]!;
    expect(operation.children.map(node => node.uri + '|' + node.local)).toEqual([MESSAGES + '|FreeBusyResponseArray']);
    expect(operation.children[0]!.children.map(node => node.uri + '|' + node.local)).toEqual([
      MESSAGES + '|FreeBusyResponse', MESSAGES + '|FreeBusyResponse',
    ]);
    expect(parseXmlBounded(Buffer.from(xml, 'utf8'))).toMatchObject({ local: 'Envelope', uri: SOAP });
  });

  it('emits a successful all-free view only for complete validated coverage', () => {
    const free = { kind: 'ok', targetId: 'private-id', coverage, slots: [], observedAtMs: base };
    const [response] = responseNodes(encodeAvailabilityResponse(window, [free]));
    expectSuccess(response!, '00');
    const view = child(response!, MESSAGES, 'FreeBusyView');
    expect(child(view, TYPES, 'CalendarEventArray').children).toHaveLength(0);
  });

  it('keeps uncovered portions unknown instead of returning them as free', () => {
    const partialCoverage = { ...coverage, endMs: base + 30 * minute };
    const partial = { kind: 'ok', targetId: 'private-id', coverage: partialCoverage, slots: [], observedAtMs: base };
    const [response] = responseNodes(encodeAvailabilityResponse(window, [partial]));
    expectSuccess(response!, '04');
    const view = child(response!, MESSAGES, 'FreeBusyView');
    const events = child(view, TYPES, 'CalendarEventArray');
    expect(child(child(events, TYPES, 'CalendarEvent'), TYPES, 'BusyType').text).toBe('NoData');
  });

  it('rejects invalid outer inputs and result counts above the request limit', () => {
    expect(() => encodeAvailabilityResponse(window, [])).toThrow();
    expect(() => encodeAvailabilityResponse(window, Array.from({ length: 101 }, () => success('id')))).toThrow();
    expect(() => encodeAvailabilityResponse({ ...window, endMs: base }, [success('id')])).toThrow();
    expect(() => encodeAvailabilityResponse(window, { kind: 'ok' })).toThrow();
  });

  it('sanitizes invalid outer arrays and invalid length access', () => {
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    expect(() => encodeAvailabilityResponse(window, revoked.proxy)).toThrowError('Invalid availability results');
    const badLength = new Proxy([success('target')], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('OUTER-LENGTH-SECRET');
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => encodeAvailabilityResponse(window, badLength)).toThrowError('Invalid availability results');
  });

  it('does not mutate caller-owned request or provider data', () => {
    const requestWindow = { ...window };
    const resultList = [success('private-id'), error('private-id', 'timeout')];
    const before = structuredClone({ requestWindow, resultList });
    encodeAvailabilityResponse(requestWindow, resultList);
    expect({ requestWindow, resultList }).toEqual(before);
  });
});

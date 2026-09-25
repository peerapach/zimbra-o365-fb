import { Temporal } from '@js-temporal/polyfill';
import { create } from 'xmlbuilder2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateLegacyProfile } from '../../src/time/legacy-profile.js';
import { parseXmlBounded } from '../../src/xml/parse.js';
import { parseInstant } from '../../src/time/instants.js';
import { resolveCandidateZone } from '../../src/time/zones.js';

const TYPES = 'http://schemas.microsoft.com/exchange/services/2006/types';
const blocked = { kind: 'error', reason: 'unsupported-timezone', code: 'BLOCKED_PROTOCOL' };
// Original synthetic signatures, not captured from any Zimbra/Exchange client.
const fixedRule = { Bias: 0, Time: '00:00:00', DayOrder: 1, Month: 1, DayOfWeek: 'Sunday' };
const pacificStandard = { Bias: 0, Time: '02:00:00', DayOrder: 1, Month: 11, DayOfWeek: 'Sunday' };
const pacificDaylight = { Bias: -60, Time: '02:00:00', DayOrder: 2, Month: 3, DayOfWeek: 'Sunday' };
const londonStandard = { Bias: 0, Time: '02:00:00', DayOrder: 5, Month: 10, DayOfWeek: 'Sunday' };
const londonDaylight = { Bias: -60, Time: '01:00:00', DayOrder: 5, Month: 3, DayOfWeek: 'Sunday' };
function xml(bias: number, standard = fixedRule, daylight = fixedRule): string {
  const document = create().ele('TimeZone', { xmlns: TYPES });
  document.ele('Bias').txt(String(bias));
  for (const [name, values] of [['StandardTime', standard], ['DaylightTime', daylight]] as const) {
    const rule = document.ele(name);
    for (const [field, value] of Object.entries(values)) rule.ele(field).txt(String(value));
  }
  return document.end();
}
const utcXml = xml(0);
const bangkokXml = xml(-420);
const pacificXml = xml(480, pacificStandard, pacificDaylight);
const londonXml = xml(0, londonStandard, londonDaylight);
const node = (value: string) => parseXmlBounded(Buffer.from(value));
const range = (start = '2026-01-01T00:00:00Z', end = '2026-01-02T00:00:00Z', offsets: Record<string, unknown> = {}) =>
  ({ startMs: Date.parse(start), endMs: Date.parse(end), ...offsets });
afterEach(() => vi.restoreAllMocks());

describe('W19 synthetic legacy SerializableTimeZone signatures', () => {
  it.each([
    [utcXml, 'UTC', 'synthetic-utc-2026', 'Etc/UTC', '+00:00'],
    [utcXml, 'Etc/UTC', 'synthetic-utc-2026', 'Etc/UTC', '+00:00'],
    [utcXml, 'Greenwich Standard Time', 'synthetic-utc-2026', 'Etc/UTC', '+00:00'],
    [bangkokXml, 'SE Asia Standard Time', 'synthetic-bangkok-2026', 'Asia/Bangkok', '+07:00'],
    [bangkokXml, 'Asia/Bangkok', 'synthetic-bangkok-2026', 'Asia/Bangkok', '+07:00'],
    [pacificXml, 'Pacific Standard Time', 'synthetic-pacific-2026', 'America/Los_Angeles', '-08:00'],
    [londonXml, 'GMT Standard Time', 'synthetic-london-2026', 'Europe/London', '+00:00'],
  ])('matches complete body and %s context %#', (body, context, profileId, zone, offset) => {
    const result = validateLegacyProfile(node(body), context, range());
    expect(result).toEqual({ kind: 'ok', profileId, zone, status: 'candidate-not-live-verified', productionApproved: false,
      startOffset: offset, endOffset: offset, transitions: [] });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('canonicalizes field order and integer lexical forms without dropping fields', () => {
    const reversed = Object.fromEntries(Object.entries(fixedRule).reverse()) as typeof fixedRule;
    const body = xml(0, reversed, reversed).replaceAll('<Bias>0</Bias>', '<Bias> +000 </Bias>');
    expect(validateLegacyProfile(node(body), 'UTC', range())).toEqual(validateLegacyProfile(node(utcXml), 'UTC', range()));
  });

  it.each([
    [pacificXml, 'Pacific Standard Time', '2026-03-08T09:00:00Z', '2026-03-08T11:00:00Z', '2026-03-08T10:00:00Z', '-08:00', '-07:00'],
    [pacificXml, 'America/Los_Angeles', '2026-11-01T08:00:00Z', '2026-11-01T10:00:00Z', '2026-11-01T09:00:00Z', '-07:00', '-08:00'],
    [londonXml, 'GMT Standard Time', '2026-03-29T00:00:00Z', '2026-03-29T02:00:00Z', '2026-03-29T01:00:00Z', '+00:00', '+01:00'],
    [londonXml, 'Europe/London', '2026-10-25T00:00:00Z', '2026-10-25T02:00:00Z', '2026-10-25T01:00:00Z', '+01:00', '+00:00'],
  ])('checks start, end and the independent transition vector %#', (body, context, start, end, change, before, after) => {
    const result = validateLegacyProfile(node(body), context, range(start, end, { startOffset: before, endOffset: after }));
    expect(result).toMatchObject({ kind: 'ok', startOffset: before, endOffset: after,
      transitions: [{ atMs: Date.parse(change), fromOffset: before, toOffset: after }] });
  });

  it('checks a transition at the exclusive endpoint and uses its post-transition offset', () => {
    const result = validateLegacyProfile(node(pacificXml), 'Pacific Standard Time',
      range('2026-03-08T09:59:59.999Z', '2026-03-08T10:00:00Z', { startOffset: '-08:00', endOffset: '-07:00' }));
    expect(result).toMatchObject({ kind: 'ok', transitions: [{ atMs: Date.parse('2026-03-08T10:00:00Z'), fromOffset: '-08:00', toOffset: '-07:00' }] });
    expect(validateLegacyProfile(node(pacificXml), 'Pacific Standard Time',
      range('2026-03-08T10:00:00Z', '2026-03-08T10:00:00.001Z', { startOffset: '-07:00', endOffset: '-07:00' })))
      .toMatchObject({ kind: 'ok', transitions: [] });
  });

  it('fails if Temporal does not report the independently expected transition', () => {
    vi.spyOn(Temporal.ZonedDateTime.prototype, 'getTimeZoneTransition').mockReturnValue(null);
    expect(validateLegacyProfile(node(pacificXml), 'Pacific Standard Time', range('2026-03-01T00:00:00Z', '2026-03-15T00:00:00Z'))).toEqual(blocked);
  });

  it.each([
    [utcXml, 'GMT Standard Time'], [londonXml, 'UTC'], [londonXml, 'Greenwich Standard Time'],
    [pacificXml, 'Europe/London'], [bangkokXml, 'UTC'], [utcXml, undefined], [utcXml, ''],
    [utcXml, 'PST'], [utcXml, '+00:00'], [utcXml, {}],
  ])('blocks inconsistent/unknown/missing context %# despite matching current offsets', (body, context) => {
    expect(validateLegacyProfile(node(body), context, range())).toEqual(blocked);
  });

  it.each([
    { startOffset: '-07:00' }, { endOffset: '+00:00' }, { startOffset: '-00:00' }, { startOffset: '-08:00:00' },
    { startOffset: undefined }, { startOffset: '' }, { startOffset: -480 }, { startOffset: 'secret-canary' },
  ])('blocks invalid or contradictory explicit offsets %#', offsets => {
    expect(validateLegacyProfile(node(pacificXml), 'Pacific Standard Time', range(undefined, undefined, offsets))).toEqual(blocked);
  });

  it('accepts explicit Z only when the matched body and resolved context are actually UTC', () => {
    expect(validateLegacyProfile(node(utcXml), 'Greenwich Standard Time', range(undefined, undefined, { startOffset: 'Z', endOffset: '+00:00' })))
      .toMatchObject({ kind: 'ok', startOffset: '+00:00' });
    expect(validateLegacyProfile(node(londonXml), 'GMT Standard Time', range('2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', { startOffset: 'Z' }))).toEqual(blocked);
  });

  it.each([
    utcXml.replace('<Bias>0</Bias>', ''),
    utcXml.replace('<Bias>0</Bias>', '<Bias>0</Bias><Bias>0</Bias>'),
    utcXml.replace('</TimeZone>', '<Unknown>private-canary</Unknown></TimeZone>'),
    utcXml.replace('<StandardTime>', '<StandardTime unexpected="private-canary">'),
    utcXml.replace('</StandardTime>', '<Year>2026</Year></StandardTime>'),
    utcXml.replace('</DaylightTime>', '<Year>0000</Year></DaylightTime>'),
    utcXml.replace('<Time>00:00:00</Time>', ''),
    utcXml.replace('<Time>00:00:00</Time>', '<Time>00:00:00</Time><Time>00:00:00</Time>'),
    utcXml.replace('<DayOrder>1</DayOrder>', '<DayOrder><Nested>1</Nested></DayOrder>'),
    utcXml.replace('<DayOrder>1</DayOrder>', '<DayOrder>1.0</DayOrder>'),
    utcXml.replace('<Month>1</Month>', '<Month>0</Month>'),
    utcXml.replace('<DayOfWeek>Sunday</DayOfWeek>', '<DayOfWeek>Monday</DayOfWeek>'),
    utcXml.replace('<Time>00:00:00</Time>', '<Time>01:00:00</Time>'),
    utcXml.replace('<StandardTime>', '<StandardTime xmlns="urn:foreign">'),
    utcXml.replace('<Bias>0</Bias>', '<Bias xmlns="urn:foreign">0</Bias>'),
    utcXml.replace(TYPES, 'urn:foreign'),
    utcXml.replace('<Bias>0</Bias>', '<Bias secret="private-canary">0</Bias>'),
    utcXml.replace('<Bias>0</Bias>', '<Bias>0</Bias>unexpected-text'),
  ])('blocks unsupported/incomplete/custom/foreign/duplicate signature %#', body => {
    const result = validateLegacyProfile(node(body), 'UTC', range());
    expect(result).toEqual(blocked);
    expect(JSON.stringify(result)).not.toContain('private-canary');
  });

  it('does not accept older US DST rules even when the current winter offset matches', () => {
    const oldRules = xml(480, { ...pacificStandard, DayOrder: 5, Month: 10 }, { ...pacificDaylight, DayOrder: 1, Month: 4 });
    expect(validateLegacyProfile(node(oldRules), 'Pacific Standard Time', range())).toEqual(blocked);
  });

  it.each([
    range('2025-12-31T23:59:59.999Z', '2026-01-01T00:00:00Z'),
    range('2026-12-31T00:00:00Z', '2027-01-01T00:00:00.001Z'),
    range('2026-01-01T00:00:00Z', '2026-03-03T00:00:00.001Z'),
    { startMs: 1, endMs: 0 }, { startMs: NaN, endMs: Infinity }, { startMs: 1780000000000.1, endMs: 1780000000001 },
    { ...range(), startMs: '2026-01-01T00:00:00Z' }, { ...range(), unknown: 1 }, {}, null,
  ])('blocks unsupported coverage or invalid range %#', requested => {
    expect(validateLegacyProfile(node(utcXml), 'UTC', requested)).toEqual(blocked);
  });

  it('allows exactly the 61-day bound and the reviewed coverage end', () => {
    expect(validateLegacyProfile(node(utcXml), 'UTC', range('2026-01-01T00:00:00Z', '2026-03-03T00:00:00Z'))).toMatchObject({ kind: 'ok' });
    expect(validateLegacyProfile(node(utcXml), 'UTC', range('2026-12-31T00:00:00Z', '2027-01-01T00:00:00Z'))).toMatchObject({ kind: 'ok' });
  });

  it('keeps legacy profile recognition separate from deployed and bare candidate contexts', () => {
    expect(() => parseInstant('2026-01-01T00:00:00', 'Greenwich Standard Time')).toThrow();
    expect(() => resolveCandidateZone('Greenwich Standard Time')).toThrow();
  });
});

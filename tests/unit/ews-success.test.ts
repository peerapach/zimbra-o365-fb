import { describe, expect, it } from 'vitest';
import { normalizeFreeBusyGrid } from '../../src/freebusy/grid.js';
import { encodeFreeBusySuccess } from '../../src/ews/success.js';
import { parseXmlBounded, type XmlNode } from '../../src/xml/parse.js';

const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const MESSAGES = 'http://schemas.microsoft.com/exchange/services/2006/messages';
const TYPES = 'http://schemas.microsoft.com/exchange/services/2006/types';
const base = 1789351200000;
const minute = 60000;
const window = { startMs: base, endMs: base + 240 * minute, intervalMinutes: 30 };
const fullCoverage = [{ startMs: window.startMs, endMs: window.endMs }];
const span = (start: number, end: number) => ({ startMs: start, endMs: end });
const slot = (start: number, end: number, status: string) => ({ ...span(start, end), status });
const parse = (xml: string) => parseXmlBounded(Buffer.from(xml, 'utf8'));
const all = (node: XmlNode): readonly XmlNode[] => [node, ...node.children.flatMap(all)];
const named = (node: XmlNode, uri: string, local: string) =>
  all(node).filter(child => child.uri === uri && child.local === local);
const child = (node: XmlNode, uri: string, local: string) => {
  const matches = node.children.filter(item => item.uri === uri && item.local === local);
  expect(matches).toHaveLength(1);
  return matches[0]!;
};

describe('free/busy normalization', () => {
  it('matches the eight-slot golden vector and coalesces normalized intervals', () => {
    const grid = normalizeFreeBusyGrid(window, fullCoverage, [
      slot(base, base + 30 * minute, 'free'),
      slot(base + 30 * minute, base + 60 * minute, 'busy'),
      slot(base + 60 * minute, base + 90 * minute, 'tentative'),
      slot(base + 90 * minute, base + 150 * minute, 'oof'),
      slot(base + 150 * minute, base + 240 * minute, 'free'),
    ]);
    expect(grid.merged).toBe('02133000');
    expect(grid.intervals).toEqual([
      slot(base, base + 30 * minute, 'free'),
      slot(base + 30 * minute, base + 60 * minute, 'busy'),
      slot(base + 60 * minute, base + 90 * minute, 'tentative'),
      slot(base + 90 * minute, base + 150 * minute, 'oof'),
      slot(base + 150 * minute, base + 240 * minute, 'free'),
    ]);
    expect(Object.isFrozen(grid)).toBe(true);
    expect(Object.isFrozen(grid.intervals)).toBe(true);
    expect(grid.intervals.every(Object.isFrozen)).toBe(true);
  });

  it('returns zeros and no intervals only for complete all-free coverage', () => {
    const grid = normalizeFreeBusyGrid(window, fullCoverage, []);
    expect(grid.merged).toBe('00000000');
    expect(grid.intervals).toEqual([slot(base, base + 240 * minute, 'free')]);
    expect(normalizeFreeBusyGrid(window, window, []).merged).toBe('00000000');
    expect(normalizeFreeBusyGrid(window, [], []).merged).toBe('44444444');
    expect(() => normalizeFreeBusyGrid(window, { ...window, intervalMinutes: 0 }, [])).toThrow();
  });

  it('keeps uncovered disjoint gaps unknown while covered gaps are free', () => {
    const coverage = [
      span(base, base + 30 * minute),
      span(base + 60 * minute, base + 90 * minute),
    ];
    const grid = normalizeFreeBusyGrid(
      { ...window, endMs: base + 120 * minute },
      coverage,
      [],
    );
    expect(grid.merged).toBe('0404');
    expect(grid.intervals).toEqual([
      slot(base, base + 30 * minute, 'free'),
      slot(base + 30 * minute, base + 60 * minute, 'unknown'),
      slot(base + 60 * minute, base + 90 * minute, 'free'),
      slot(base + 90 * minute, base + 120 * minute, 'unknown'),
    ]);
  });

  it('clips valid half-open intervals and ignores an event exactly at query end', () => {
    const query = { startMs: base, endMs: base + 60 * minute, intervalMinutes: 30 };
    const grid = normalizeFreeBusyGrid(query, [span(base, query.endMs)], [
      slot(base - 15 * minute, base + 15 * minute, 'busy'),
      slot(query.endMs - 15 * minute, query.endMs + 15 * minute, 'busy'),
      slot(query.endMs, query.endMs + 30 * minute, 'oof'),
    ]);
    expect(grid.merged).toBe('22');
    expect(grid.intervals).toEqual([
      slot(base, base + 15 * minute, 'busy'),
      slot(base + 15 * minute, query.endMs - 15 * minute, 'free'),
      slot(query.endMs - 15 * minute, query.endMs, 'busy'),
    ]);
  });

  it('keeps a final partial slot and an event spanning midnight at exact boundaries', () => {
    const midnight = Date.UTC(2026, 8, 15);
    const query = { startMs: midnight - 30 * minute, endMs: midnight + 35 * minute, intervalMinutes: 30 };
    const coverage = [span(query.startMs, query.endMs)];
    const slots = [slot(midnight, query.endMs, 'busy')];
    const partial = normalizeFreeBusyGrid(query, coverage, slots);
    expect(partial.merged).toBe('022');
    const xml = encodeFreeBusySuccess(query, coverage, slots);
    const start = named(parse(xml), TYPES, 'StartTime')[0]!;
    const end = named(parse(xml), TYPES, 'EndTime')[0]!;
    expect(start.text).toBe('2026-09-15T00:00:00.000+00:00');
    expect(end.text).toBe('2026-09-15T00:35:00.000+00:00');
  });

  it('uses unknown > OOF > busy > tentative > free independent of input order', () => {
    const query = { startMs: base, endMs: base + 30 * minute, intervalMinutes: 30 };
    const overlaps = [
      slot(base, base + 30 * minute, 'free'),
      slot(base, base + 30 * minute, 'tentative'),
      slot(base, base + 30 * minute, 'busy'),
      slot(base, base + 30 * minute, 'oof'),
    ];
    const merged = new Set([
      normalizeFreeBusyGrid(query, [span(base, query.endMs)], overlaps).merged,
      normalizeFreeBusyGrid(query, [span(base, query.endMs)], overlaps.slice().reverse()).merged,
    ]);
    expect(merged).toEqual(new Set(['3']));
    expect(normalizeFreeBusyGrid(query, [span(base, query.endMs)], [
      ...overlaps, slot(base, base + 30 * minute, 'unknown'),
    ]).merged).toBe('4');
    expect(normalizeFreeBusyGrid(query, [span(base, query.endMs)], [
      slot(base, base + 30 * minute, 'busy'),
      slot(base, base + 30 * minute, 'free'),
    ]).merged).toBe('2');
  });

  it.each([
    [null, fullCoverage, []],
    [window, null, []],
    [window, fullCoverage, null],
    [window, fullCoverage, [null]],
    [window, fullCoverage, [span(base, base)]],
    [window, fullCoverage, [slot(base, base + minute, 'unknown-ish')]],
    [window, [span(base + 1, base)], []],
    [{ ...window, startMs: Number.MAX_SAFE_INTEGER + 1 }, fullCoverage, []],
    [{ ...window, endMs: window.startMs }, fullCoverage, []],
    [{ ...window, intervalMinutes: 0 }, fullCoverage, []],
  ])('rejects malformed windows, coverage, and intervals', (query, coverage, intervals) => {
    expect(() => normalizeFreeBusyGrid(query, coverage, intervals)).toThrow();
  });

  it('does not mutate caller-owned windows, coverage, or slots', () => {
    const query = { ...window };
    const coverage = [span(base, window.endMs)];
    const slots = [slot(base, base + minute, 'busy')];
    const before = structuredClone({ query, coverage, slots });
    normalizeFreeBusyGrid(query, coverage, slots);
    expect({ query, coverage, slots }).toEqual(before);
  });
});

describe('successful EWS FreeBusyMerged serialization', () => {
  it('emits the candidate success shape with only fixed namespaces and normalized intervals', () => {
    const xml = encodeFreeBusySuccess(window, fullCoverage, [
      slot(base + 30 * minute, base + 60 * minute, 'busy'),
      slot(base + 60 * minute, base + 90 * minute, 'tentative'),
      slot(base + 90 * minute, base + 150 * minute, 'oof'),
    ]);
    const root = parse(xml);
    expect(root).toMatchObject({ uri: SOAP, local: 'Envelope' });
    expect(root.children.map(node => node.uri + '|' + node.local)).toEqual([SOAP + '|Body']);
    const response = child(child(child(child(root, SOAP, 'Body'), MESSAGES, 'GetUserAvailabilityResponse'),
      MESSAGES, 'FreeBusyResponseArray'), MESSAGES, 'FreeBusyResponse');
    const message = child(response, MESSAGES, 'ResponseMessage');
    expect(message.attributes).toEqual([{ uri: '', local: 'ResponseClass', value: 'Success' }]);
    expect(message.children.map(node => node.uri + '|' + node.local)).toEqual([MESSAGES + '|ResponseCode']);
    expect(message.children[0]!.text).toBe('NoError');
    const view = child(response, MESSAGES, 'FreeBusyView');
    expect(view.children.map(node => node.uri + '|' + node.local)).toEqual([
      TYPES + '|FreeBusyViewType', TYPES + '|MergedFreeBusy', TYPES + '|CalendarEventArray',
    ]);
    expect(view.children[0]!.text).toBe('FreeBusyMerged');
    expect(view.children[1]!.text).toBe('02133000');
    expect(named(root, TYPES, 'CalendarEvent')).toHaveLength(3);
    expect(named(root, TYPES, 'CalendarEvent').map(event =>
      event.children.map(node => node.uri + '|' + node.local))).toEqual([
      [TYPES + '|StartTime', TYPES + '|EndTime', TYPES + '|BusyType'],
      [TYPES + '|StartTime', TYPES + '|EndTime', TYPES + '|BusyType'],
      [TYPES + '|StartTime', TYPES + '|EndTime', TYPES + '|BusyType'],
    ]);
    expect(named(root, TYPES, 'CalendarEventDetails')).toHaveLength(0);
    expect(named(root, TYPES, 'WorkingHours')).toHaveLength(0);
    expect(parseXmlBounded(Buffer.from(xml, 'utf8'))).toMatchObject({ local: 'Envelope' });
  });

  it('emits an empty event array for complete all-free and NoData intervals for unknown', () => {
    const free = parse(encodeFreeBusySuccess(window, fullCoverage, []));
    expect(named(free, TYPES, 'MergedFreeBusy')[0]!.text).toBe('00000000');
    expect(named(free, TYPES, 'CalendarEvent')).toHaveLength(0);
    const unknown = parse(encodeFreeBusySuccess(window, [], []));
    expect(named(unknown, TYPES, 'MergedFreeBusy')[0]!.text).toBe('44444444');
    expect(named(unknown, TYPES, 'BusyType').map(node => node.text)).toEqual(['NoData']);
  });

  it('ignores backend-only sentinel fields and never serializes caller XML fragments', () => {
    const privateSlot = {
      ...slot(base + minute, base + 2 * minute, 'busy'),
      eventId: 'PRIVATE-SENTINEL',
      subject: '<t:CalendarEventDetails>SECRET</t:CalendarEventDetails>',
      location: 'PRIVATE-LOCATION',
    };
    const xml = encodeFreeBusySuccess(window, fullCoverage, [privateSlot]);
    expect(xml).not.toContain('PRIVATE-SENTINEL');
    expect(xml).not.toContain('PRIVATE-LOCATION');
    expect(xml).not.toContain('SECRET');
    expect(xml).not.toContain('CalendarEventDetails');
    expect(parse(xml).uri).toBe(SOAP);
  });
});

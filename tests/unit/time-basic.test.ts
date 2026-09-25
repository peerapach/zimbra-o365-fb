import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseInstant } from '../../src/time/instants.js';
import { createWindow } from '../../src/time/window.js';

const limits = { minIntervalMinutes: 5, maxIntervalMinutes: 1440, maxRangeDays: 61, maxGridSlotsPerTarget: 17568 };
const golden = JSON.parse(readFileSync(new URL('../../fixtures/golden/timeline.json', import.meta.url), 'utf8')) as {
  utc: { start: string; end: string }; bangkok: { start: string; end: string };
  window: { startMs: number; endMs: number; intervalMinutes: number };
};

describe('deterministic fixed-profile instants', () => {
  it('maps the independent UTC and Bangkok golden window to epoch milliseconds', () => {
    for (const representation of [golden.utc, golden.bangkok]) {
      expect(createWindow(parseInstant(representation.start), parseInstant(representation.end), 30, limits)).toEqual(golden.window);
    }
  });

  it.each([
    ['2026-09-14T02:00:00', 'UTC', 1789351200000],
    ['2026-09-14T02:00:00', 'Etc/UTC', 1789351200000],
    ['2026-09-14T09:00:00', 'Asia/Bangkok', 1789351200000],
    ['2026-09-14T09:00:00', 'SE Asia Standard Time', 1789351200000],
    ['2026-09-14T09:00:00+07:00', 'Asia/Bangkok', 1789351200000],
    ['1970-01-01T00:00:00Z', 'UTC', 0],
    ['1970-01-01T00:00:00+00:00', 'Etc/UTC', 0],
    ['1970-01-01T00:00:00.123456789', 'UTC', 123],
  ])('resolves %s using %s', (value, zone, expected) => {
    expect(parseInstant(value, zone)).toBe(expected);
  });

  it.each([
    ['1970-01-01T00:00:01Z', 1000],
    ['1970-01-01T05:30:00+05:30', 0],
    ['1969-12-31T18:15:00-05:45', 0],
    ['1970-01-01T00:00:00.1Z', 100],
    ['1970-01-01T00:00:00.12Z', 120],
    ['1970-01-01T00:00:00.123Z', 123],
    ['1970-01-01T00:00:00.123999999Z', 123],
    ['1969-12-31T23:59:59.999999999Z', -1],
    ['2024-02-29T00:00:00Z', 1709164800000],
  ])('parses the explicit instant %s without clock inference', (value, expected) => {
    expect(parseInstant(value)).toBe(expected);
  });

  it.each([
    '', '2026-09-14', '02:00:00Z', '2026-09-14T02:00:00',
    '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-13-01T00:00:00Z',
    '2026-01-00T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z',
    '2016-12-31T23:59:60Z', '2026-09-14 02:00:00Z', '2026-09-14T02:00Z',
    '2026-09-14T02:00:00+24:00', '2026-09-14T02:00:00+07:60',
    '2026-09-14T02:00:00-00:00', '2026-09-14T02:00:00+0700',
    '2026-09-14T02:00:00.Z', '2026-09-14T02:00:00.1234567890Z',
    '2026-09-14T02:00:00Z[UTC]', '2026-09-14T02:00:00Z\n',
    null, undefined, 1789351200000, {},
  ])('rejects malformed, ambiguous, or incomplete timestamp %j', value => {
    expect(() => parseInstant(value)).toThrow();
  });

  it.each(['GMT Standard Time', 'Greenwich Standard Time', 'Europe/London', 'America/Los_Angeles', '+07:00', '', 'utc', null, {}, { Bias: 0 }])(
    'rejects unsupported or incomplete zone %j even with an explicit instant', zone => {
      expect(() => parseInstant('2026-09-14T02:00:00', zone)).toThrow();
      expect(() => parseInstant('2026-09-14T02:00:00Z', zone)).toThrow();
    },
  );

  it.each([
    ['2026-09-14T09:00:00+07:00', 'UTC'],
    ['2026-09-14T02:00:00Z', 'Asia/Bangkok'],
    ['2026-09-14T09:00:00-07:00', 'SE Asia Standard Time'],
    ['2026-09-14T09:00:00+07:01', 'Asia/Bangkok'],
    ['2026-02-30T09:00:00', 'Asia/Bangkok'],
  ])('rejects invalid date or contradictory context %s / %s', (value, zone) => {
    expect(() => parseInstant(value, zone)).toThrow();
  });
});

describe('bounded half-open windows', () => {
  it('preserves exact endpoints and returns immutable coverage', () => {
    const result = createWindow(1789351200123, 1789351500124, 5, limits);
    expect(result).toEqual({ startMs: 1789351200123, endMs: 1789351500124, intervalMinutes: 5 });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('counts the final partial slot toward the grid limit', () => {
    const twoSlots = { ...limits, maxGridSlotsPerTarget: 2 };
    expect(createWindow(0, 600000, 5, twoSlots).endMs).toBe(600000);
    expect(createWindow(0, 599999, 5, twoSlots).endMs).toBe(599999);
    expect(() => createWindow(0, 600001, 5, twoSlots)).toThrow();
  });

  it('accepts a one-millisecond range and the exact policy range and interval bounds', () => {
    expect(createWindow(-1, 0, 5, limits).startMs).toBe(-1);
    expect(createWindow(0, 5270400000, 5, limits).endMs).toBe(5270400000);
    expect(createWindow(0, 1, 1440, limits).intervalMinutes).toBe(1440);
    expect(() => createWindow(0, 5270400001, 5, limits)).toThrow();
  });

  it.each([
    [0, 0, 5], [1, 0, 5], [0.1, 1, 5], [0, 1.1, 5],
    [NaN, 1, 5], [0, Infinity, 5], [0, Number.MAX_SAFE_INTEGER + 1, 5],
    [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 5],
    [0, 1, 0], [0, 1, 4], [0, 1, 5.5], [0, 1, 1441], [0, 1, NaN],
    ['0', 1, 5], [0, '1', 5], [0, 1, '5'], [null, 1, 5],
  ])('rejects invalid endpoints/interval %j %j %j', (start, end, interval) => {
    expect(() => createWindow(start, end, interval, limits)).toThrow();
  });

  it.each([
    { minIntervalMinutes: 0 }, { minIntervalMinutes: 1441 }, { maxIntervalMinutes: Infinity },
    { maxIntervalMinutes: Number.MAX_SAFE_INTEGER }, { maxRangeDays: Number.MAX_SAFE_INTEGER },
    { maxRangeDays: 0 }, { maxRangeDays: 1.5 }, { maxGridSlotsPerTarget: 0 }, { maxGridSlotsPerTarget: NaN },
  ])('rejects invalid bounds and arithmetic overflow %j', override => {
    expect(() => createWindow(0, 1, 5, { ...limits, ...override })).toThrow();
  });
});

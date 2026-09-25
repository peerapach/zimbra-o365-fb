import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseCandidateZonedInstant, formatCandidateZonedInstant, parseInstant } from '../../src/time/instants.js';
import { createWindow } from '../../src/time/window.js';
import { normalizeFreeBusyGrid } from '../../src/freebusy/grid.js';

const limits = { minIntervalMinutes: 5, maxIntervalMinutes: 1440, maxRangeDays: 61, maxGridSlotsPerTarget: 17568 };
const utc = (milliseconds: number): string => new Date(milliseconds).toISOString();

describe('W18 opt-in candidate named zones, not deployment profile approval', () => {
  it.each([
    ['2026-01-15T12:00:00', 'America/Los_Angeles', '2026-01-15T20:00:00.000Z', '2026-01-15T12:00:00.000-08:00'],
    ['2026-07-15T12:00:00', 'Pacific Standard Time', '2026-07-15T19:00:00.000Z', '2026-07-15T12:00:00.000-07:00'],
    ['2026-01-15T12:00:00', 'Europe/London', '2026-01-15T12:00:00.000Z', '2026-01-15T12:00:00.000+00:00'],
    ['2026-07-15T12:00:00', 'GMT Standard Time', '2026-07-15T11:00:00.000Z', '2026-07-15T12:00:00.000+01:00'],
    ['2026-09-14T09:00:00', 'SE Asia Standard Time', '2026-09-14T02:00:00.000Z', '2026-09-14T09:00:00.000+07:00'],
    ['2026-09-14T09:00:00', 'Asia/Bangkok', '2026-09-14T02:00:00.000Z', '2026-09-14T09:00:00.000+07:00'],
    ['2026-09-14T02:00:00', 'UTC', '2026-09-14T02:00:00.000Z', '2026-09-14T02:00:00.000+00:00'],
    ['2026-09-14T02:00:00', 'Etc/UTC', '2026-09-14T02:00:00.000Z', '2026-09-14T02:00:00.000+00:00'],
  ])('converts %s in exact candidate %s and round trips with its real offset', (local, zone, expectedUtc, expectedLocal) => {
    const milliseconds = parseCandidateZonedInstant(local, zone);
    expect(utc(milliseconds)).toBe(expectedUtc);
    expect(Number.isSafeInteger(milliseconds)).toBe(true);
    expect(formatCandidateZonedInstant(milliseconds, zone)).toBe(expectedLocal);
    expect(parseCandidateZonedInstant(expectedLocal, zone)).toBe(milliseconds);
  });

  it.each([
    ['2026-03-08T02:30:00', 'America/Los_Angeles'],
    ['2026-03-29T01:30:00', 'Europe/London'],
    ['2026-11-01T01:30:00', 'Pacific Standard Time'],
    ['2026-10-25T01:30:00', 'GMT Standard Time'],
  ])('rejects DST gap/fold %s in %s without explicit disambiguation', (local, zone) => {
    expect(() => parseCandidateZonedInstant(local, zone)).toThrow(RangeError);
  });

  it.each([
    ['1919-01-01T12:00:00', 'Asia/Bangkok'],
    ['1880-01-01T12:00:00', 'America/Los_Angeles'],
    ['1800-01-01T12:00:00', 'Europe/London'],
  ])('rejects historical local time %s in %s whose offset cannot round trip through the wire grammar', (local, zone) => {
    expect(() => parseCandidateZonedInstant(local, zone)).toThrow(RangeError);
  });

  it.each([
    ['2026-11-01T01:30:00-07:00', 'America/Los_Angeles', '2026-11-01T08:30:00.000Z'],
    ['2026-11-01T01:30:00-08:00', 'Pacific Standard Time', '2026-11-01T09:30:00.000Z'],
    ['2026-10-25T01:30:00+01:00', 'Europe/London', '2026-10-25T00:30:00.000Z'],
    ['2026-10-25T01:30:00Z', 'GMT Standard Time', '2026-10-25T01:30:00.000Z'],
  ])('accepts explicit fold side %s in %s', (local, zone, expectedUtc) => {
    const milliseconds = parseCandidateZonedInstant(local, zone);
    expect(utc(milliseconds)).toBe(expectedUtc);
    expect(parseCandidateZonedInstant(formatCandidateZonedInstant(milliseconds, zone), zone)).toBe(milliseconds);
  });

  it.each([
    ['2026-03-08T02:30:00-08:00', 'America/Los_Angeles'],
    ['2026-03-08T02:30:00-07:00', 'America/Los_Angeles'],
    ['2026-03-29T01:30:00Z', 'Europe/London'],
    ['2026-03-29T01:30:00+01:00', 'Europe/London'],
    ['2026-07-15T12:00:00-08:00', 'Pacific Standard Time'],
    ['2026-01-15T12:00:00+01:00', 'GMT Standard Time'],
    ['2026-11-01T01:30:00-06:00', 'America/Los_Angeles'],
    ['2026-09-14T02:00:00-00:00', 'UTC'],
  ])('rejects impossible local time or contradictory offset %s in %s', (local, zone) => {
    expect(() => parseCandidateZonedInstant(local, zone)).toThrow(RangeError);
  });

  it.each(['Greenwich Standard Time', 'Pacific Daylight Time', 'PST', 'GMT', 'America/New_York', 'europe/london',
    ' Europe/London', 'Europe/London\n', '+01:00', '__proto__', 'constructor', '', null, undefined, {}])(
    'rejects unknown/unapproved candidate %j even with an explicit instant', zone => {
      expect(() => parseCandidateZonedInstant('2026-07-15T12:00:00Z', zone)).toThrow(RangeError);
      expect(() => formatCandidateZonedInstant(0, zone)).toThrow(RangeError);
    },
  );

  it.each(['2026-02-29T12:00:00', '2026-04-31T12:00:00', '2026-01-01', '2026-01-01T24:00:00',
    '2026-01-01T12:00:60', '2026-01-01T12:00:00Z[Europe/London]', '2026-01-01T12:00:00Z\n',
    '2026-01-01T12:00:00.1234567890Z', '2026-01-01T12:00:00+24:00', null, 0, {}])('retains strict ISO validation for candidate timestamp %j', value => {
    expect(() => parseCandidateZonedInstant(value, 'Europe/London')).toThrow(RangeError);
  });

  it('keeps nanosecond validation and containing-millisecond truncation on both sides of epoch', () => {
    expect(parseCandidateZonedInstant('1970-01-01T00:00:00.123999999Z', 'UTC')).toBe(123);
    expect(parseCandidateZonedInstant('1969-12-31T15:59:59.999999999-08:00', 'America/Los_Angeles')).toBe(-1);
    expect(formatCandidateZonedInstant(-1, 'America/Los_Angeles')).toBe('1969-12-31T15:59:59.999-08:00');
  });

  it.each([NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER, null, undefined, '0'])('rejects unrepresentable epoch milliseconds %j', value => {
    expect(() => formatCandidateZonedInstant(value, 'Europe/London')).toThrow(RangeError);
  });

  it('does not enable candidate zones in legacy protocol/provider parsing', () => {
    for (const zone of ['America/Los_Angeles', 'Europe/London', 'Pacific Standard Time', 'GMT Standard Time', 'Greenwich Standard Time']) {
      expect(() => parseInstant('2026-07-15T12:00:00Z', zone)).toThrow(RangeError);
    }
    expect(parseInstant('2026-09-14T09:00:00', 'SE Asia Standard Time')).toBe(1789351200000);
  });
});

describe('candidate named-zone half-open windows', () => {
  it.each([
    ['America/Los_Angeles', '2026-03-08T00:00:00', '2026-03-09T00:00:00', '2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z', 23, 46],
    ['America/Los_Angeles', '2026-11-01T00:00:00', '2026-11-02T00:00:00', '2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z', 25, 50],
    ['Europe/London', '2026-03-29T00:00:00', '2026-03-30T00:00:00', '2026-03-29T00:00:00.000Z', '2026-03-29T23:00:00.000Z', 23, 46],
    ['Europe/London', '2026-10-25T00:00:00', '2026-10-26T00:00:00', '2026-10-24T23:00:00.000Z', '2026-10-26T00:00:00.000Z', 25, 50],
  ])('preserves reported all-day busy duration in %s from %s to %s', (zone, start, end, expectedStart, expectedEnd, hours, slots) => {
    const window = createWindow(parseCandidateZonedInstant(start, zone), parseCandidateZonedInstant(end, zone), 30, limits);
    expect(utc(window.startMs)).toBe(expectedStart);
    expect(utc(window.endMs)).toBe(expectedEnd);
    expect(window.endMs - window.startMs).toBe(hours * 3600000);
    const grid = normalizeFreeBusyGrid(window, window, [{ startMs: window.startMs, endMs: window.endMs, status: 'busy' }]);
    expect(grid.merged).toBe('2'.repeat(slots));
    expect(grid.intervals).toEqual([{ startMs: window.startMs, endMs: window.endMs, status: 'busy' }]);
  });

  it('keeps a cross-midnight local event on the correct UTC day', () => {
    expect(utc(parseCandidateZonedInstant('2026-06-30T23:30:00', 'Europe/London'))).toBe('2026-06-30T22:30:00.000Z');
    expect(utc(parseCandidateZonedInstant('2026-07-01T00:30:00', 'Europe/London'))).toBe('2026-06-30T23:30:00.000Z');
  });

  it('keeps transition-ending queries half-open and includes the final partial UTC slot', () => {
    const startMs = parseCandidateZonedInstant('2026-03-08T01:30:00', 'America/Los_Angeles');
    const endMs = parseCandidateZonedInstant('2026-03-08T03:00:00', 'America/Los_Angeles');
    const window = createWindow(startMs, endMs, 20, limits);
    expect(endMs - startMs).toBe(1800000);
    expect(utc(endMs)).toBe('2026-03-08T10:00:00.000Z');
    expect(normalizeFreeBusyGrid(window, window, [{ startMs, endMs, status: 'busy' },
      { startMs: endMs, endMs: endMs + 60000, status: 'oof' }]).merged).toBe('22');
    expect(normalizeFreeBusyGrid(window, window, [{ startMs: endMs, endMs: endMs + 60000, status: 'busy' }]).merged).toBe('00');
  });
});

it.each(['UTC', 'Asia/Tokyo', 'America/New_York'])('candidate named-zone round trips ignore host TZ=%s', hostZone => {
  const script = `import { parseCandidateZonedInstant as parse, formatCandidateZonedInstant as format } from './src/time/instants.ts';
    const first = parse('2026-11-01T01:30:00-07:00', 'Pacific Standard Time');
    const second = parse('2026-10-25T01:30:00Z', 'GMT Standard Time');
    console.log(JSON.stringify([new Date(first).toISOString(), format(first, 'America/Los_Angeles'),
      new Date(second).toISOString(), format(second, 'Europe/London')]));`;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
    { encoding: 'utf8', env: { ...process.env, TZ: hostZone }, timeout: 10000 });
  expect(JSON.parse(output)).toEqual(['2026-11-01T08:30:00.000Z', '2026-11-01T01:30:00.000-07:00',
    '2026-10-25T01:30:00.000Z', '2026-10-25T01:30:00.000+00:00']);
});

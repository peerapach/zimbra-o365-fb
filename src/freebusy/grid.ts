import type { Slot, WindowUtc } from '../core/types.js';

export interface NormalizedGrid {
  readonly window: WindowUtc;
  readonly merged: string;
  readonly intervals: readonly Slot[];
}

interface Span {
  readonly startMs: number;
  readonly endMs: number;
}

const MAX_DATE_MS = 8640000000000000;
const MAX_GRID_SLOTS = 17568;
const MAX_INPUT_INTERVALS = 20000;
const statuses = ['free', 'tentative', 'busy', 'oof', 'unknown'] as const;
const priority: Readonly<Record<Slot['status'], number>> = Object.freeze({
  free: 0, tentative: 1, busy: 2, oof: 3, unknown: 4,
});
const digits: Readonly<Record<Slot['status'], string>> = Object.freeze({
  free: '0', tentative: '1', busy: '2', oof: '3', unknown: '4',
});

function invalid(): never {
  throw new TypeError('Invalid availability data');
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function epoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= MAX_DATE_MS;
}

function span(value: unknown): Span {
  const item = object(value);
  const startMs = item.startMs;
  const endMs = item.endMs;
  if (!epoch(startMs) || !epoch(endMs) || endMs <= startMs || !Number.isSafeInteger(endMs - startMs)) {
    return invalid();
  }
  return { startMs, endMs };
}

function windowUtc(value: unknown): WindowUtc {
  const item = object(value);
  const { startMs, endMs } = item;
  const rawIntervalMinutes = item.intervalMinutes;
  if (typeof rawIntervalMinutes !== 'number') return invalid();
  const intervalMinutes = rawIntervalMinutes;
  const intervalMs = intervalMinutes * 60000;
  const duration = typeof startMs === 'number' && typeof endMs === 'number' ? endMs - startMs : NaN;
  const count = Math.ceil(duration / intervalMs);
  if (!epoch(startMs) || !epoch(endMs) || endMs <= startMs
    || !Number.isSafeInteger(duration) || !Number.isSafeInteger(intervalMinutes) || intervalMinutes <= 0
    || !Number.isSafeInteger(intervalMs) || count < 1 || count > MAX_GRID_SLOTS) return invalid();
  return Object.freeze({ startMs, endMs, intervalMinutes });
}

function spans(value: unknown): readonly Span[] {
  const values = Array.isArray(value) ? value : [value];
  if (values.length > MAX_INPUT_INTERVALS) return invalid();
  return values.map((entry: unknown) => {
    const item = object(entry);
    if (!Array.isArray(value) && 'intervalMinutes' in item) {
      const minutes = item.intervalMinutes;
      if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes)
        || minutes <= 0 || !Number.isSafeInteger(minutes * 60000)) return invalid();
    }
    return span(item);
  });
}

function slots(value: unknown): readonly Slot[] {
  if (!Array.isArray(value) || value.length > MAX_INPUT_INTERVALS) return invalid();
  return value.map((entry: unknown) => {
    const item = object(entry);
    const range = span(item);
    const status = item.status;
    if (typeof status !== 'string' || !statuses.includes(status as Slot['status'])) return invalid();
    return Object.freeze({ ...range, status: status as Slot['status'] });
  });
}

function clip(range: Span, window: WindowUtc): Span | undefined {
  const startMs = Math.max(range.startMs, window.startMs);
  const endMs = Math.min(range.endMs, window.endMs);
  return startMs < endMs ? { startMs, endMs } : undefined;
}

function mergeCoverage(ranges: readonly Span[], window: WindowUtc): readonly Span[] {
  const clipped = ranges.map(range => clip(range, window)).filter((range): range is Span => range !== undefined)
    .sort((left, right) => left.startMs - right.startMs);
  const merged: Span[] = [];
  for (const range of clipped) {
    const previous = merged.at(-1);
    if (previous && range.startMs <= previous.endMs) {
      merged[merged.length - 1] = { startMs: previous.startMs, endMs: Math.max(previous.endMs, range.endMs) };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function append(intervals: Slot[], startMs: number, endMs: number, status: Slot['status']): void {
  const previous = intervals.at(-1);
  if (previous?.status === status && previous.endMs === startMs) {
    intervals[intervals.length - 1] = Object.freeze({ ...previous, endMs });
  } else {
    intervals.push(Object.freeze({ startMs, endMs, status }));
  }
}

export function normalizeFreeBusyGrid(windowValue: unknown, coverageValue: unknown, intervalsValue: unknown): NormalizedGrid {
  const window = windowUtc(windowValue);
  const coverage = mergeCoverage(spans(coverageValue), window);
  const clippedSlots = slots(intervalsValue).map(item => {
    const range = clip(item, window);
    return range ? { ...range, status: item.status } : undefined;
  }).filter((item): item is Slot => item !== undefined);
  const boundaries = new Set<number>([window.startMs, window.endMs]);
  const changes = new Map<number, { readonly add: Slot['status'][]; readonly remove: Slot['status'][] }>();
  const event = (at: number) => {
    let value = changes.get(at);
    if (!value) {
      value = { add: [], remove: [] };
      changes.set(at, value);
    }
    return value;
  };
  for (const range of coverage) {
    boundaries.add(range.startMs);
    boundaries.add(range.endMs);
  }
  for (const item of clippedSlots) {
    boundaries.add(item.startMs);
    boundaries.add(item.endMs);
    event(item.startMs).add.push(item.status);
    event(item.endMs).remove.push(item.status);
  }
  const points = [...boundaries].sort((left, right) => left - right);
  const active: Record<Slot['status'], number> = { free: 0, tentative: 0, busy: 0, oof: 0, unknown: 0 };
  const normalized: Slot[] = [];
  let coverageIndex = 0;
  for (let index = 0; index < points.length - 1; index++) {
    const startMs = points[index]!;
    const endMs = points[index + 1]!;
    for (const status of changes.get(startMs)?.remove ?? []) active[status]--;
    for (const status of changes.get(startMs)?.add ?? []) active[status]++;
    while (coverageIndex < coverage.length && coverage[coverageIndex]!.endMs <= startMs) coverageIndex++;
    const covered = coverageIndex < coverage.length
      && coverage[coverageIndex]!.startMs <= startMs && coverage[coverageIndex]!.endMs >= endMs;
    let status: Slot['status'] = covered ? 'free' : 'unknown';
    for (const candidate of statuses) {
      if (active[candidate] > 0 && priority[candidate] > priority[status]) status = candidate;
    }
    append(normalized, startMs, endMs, status);
  }
  const intervalMs = window.intervalMinutes * 60000;
  let intervalIndex = 0;
  let merged = '';
  for (let startMs = window.startMs; startMs < window.endMs; startMs += intervalMs) {
    const endMs = Math.min(window.endMs, startMs + intervalMs);
    while (normalized[intervalIndex]!.endMs <= startMs) intervalIndex++;
    let worst: Slot['status'] = 'free';
    for (let index = intervalIndex; index < normalized.length && normalized[index]!.startMs < endMs; index++) {
      const candidate = normalized[index]!.status;
      if (priority[candidate] > priority[worst]) worst = candidate;
    }
    merged += digits[worst];
  }
  return Object.freeze({ window, merged, intervals: Object.freeze(normalized) });
}

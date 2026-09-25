import type { Target, TargetResult, WindowUtc } from '../core/types.js';
import { normalizeFreeBusyGrid } from '../freebusy/grid.js';
import { parseInstant } from '../time/instants.js';

const MAX_DATE_MS = 8640000000000000;
const MAX_SCHEDULE_ITEMS = 20000;
const minute = 60000;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError();
  return value as Record<string, unknown>;
}

function instant(value: unknown): number {
  const item = object(value);
  if (item.timeZone !== 'UTC' && item.timeZone !== 'Etc/UTC') throw new RangeError();
  return parseInstant(item.dateTime, item.timeZone);
}

function availabilityStatus(value: string): 'free' | 'tentative' | 'busy' | 'oof' | 'unknown' {
  switch (value) {
    case 'free': case 'workingElsewhere': return 'free';
    case 'tentative': return 'tentative';
    case 'busy': return 'busy';
    case 'oof': return 'oof';
    default: return 'unknown';
  }
}

export function normalizeGraph(payload: unknown, target: Target, window: WindowUtc, nowMs: number): TargetResult {
  const failure = (reason: 'invalid-response' | 'not-authorized' = 'invalid-response'): TargetResult =>
    ({ kind: 'error', targetId: target.entryId, reason });
  if (target.provider !== 'graph') return failure('not-authorized');
  try {
    if (!Number.isSafeInteger(nowMs) || Math.abs(nowMs) > MAX_DATE_MS
      || typeof target.canonicalSmtp !== 'string' || !target.canonicalSmtp || target.canonicalSmtp !== target.canonicalSmtp.trim()) throw new TypeError();
    const response = object(payload);
    if (!Array.isArray(response.value) || response.value.length !== 1) throw new TypeError();
    const schedule = object(response.value[0]);
    const scheduleId = schedule.scheduleId;
    if (typeof scheduleId !== 'string' || scheduleId.length > 320 || scheduleId !== scheduleId.trim()
      || scheduleId.toLowerCase() !== target.canonicalSmtp.toLowerCase() || Object.hasOwn(schedule, 'error')) throw new TypeError();
    if (typeof schedule.availabilityView !== 'string' || !Array.isArray(schedule.scheduleItems)
      || schedule.scheduleItems.length > MAX_SCHEDULE_ITEMS) throw new TypeError();
    const intervals = schedule.scheduleItems.map((raw: unknown) => {
      const item = object(raw);
      if (typeof item.status !== 'string' || !item.status || item.status.length > 64) throw new TypeError();
      const startMs = instant(item.start);
      const endMs = instant(item.end);
      if (endMs <= startMs) throw new RangeError();
      return { startMs, endMs, status: availabilityStatus(item.status) };
    });
    const known = intervals.filter(item => item.status !== 'unknown');
    const expectedView = normalizeFreeBusyGrid(window, window, known).merged;
    const slotCount = Math.ceil((window.endMs - window.startMs) / (window.intervalMinutes * minute));
    if (!Number.isSafeInteger(slotCount) || schedule.availabilityView.length !== slotCount
      || !/^[0-3]+$/.test(schedule.availabilityView) || schedule.availabilityView !== expectedView) throw new TypeError();
    const normalized = normalizeFreeBusyGrid(window, window, intervals);
    return Object.freeze({ kind: 'ok', targetId: target.entryId, coverage: normalized.window,
      slots: normalized.intervals, observedAtMs: nowMs });
  } catch {
    return failure();
  }
}

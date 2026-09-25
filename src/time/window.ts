import type { WindowUtc } from '../core/types.js';

export interface WindowLimits {
  readonly minIntervalMinutes: number;
  readonly maxIntervalMinutes: number;
  readonly maxRangeDays: number;
  readonly maxGridSlotsPerTarget: number;
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Preserve [startMs, endMs) exactly; limits come from validated configuration. */
export function createWindow(startMs: unknown, endMs: unknown, intervalMinutes: unknown, limits: WindowLimits): WindowUtc {
  const { minIntervalMinutes, maxIntervalMinutes, maxRangeDays, maxGridSlotsPerTarget } = limits;
  const bounds = [minIntervalMinutes, maxIntervalMinutes, maxRangeDays, maxGridSlotsPerTarget];
  const maxRangeMs = maxRangeDays * 86400000;
  if (bounds.some(value => !safeInteger(value) || value <= 0)
      || minIntervalMinutes > maxIntervalMinutes
      || !safeInteger(maxIntervalMinutes * 60000) || !safeInteger(maxRangeMs)) {
    throw new RangeError('Invalid window limits');
  }
  if (!safeInteger(startMs) || !safeInteger(endMs) || !safeInteger(intervalMinutes)
      || endMs <= startMs || intervalMinutes < minIntervalMinutes || intervalMinutes > maxIntervalMinutes) {
    throw new RangeError('Invalid window');
  }
  const durationMs = endMs - startMs;
  const intervalMs = intervalMinutes * 60000;
  const slotCount = Math.ceil(durationMs / intervalMs);
  if (!safeInteger(durationMs) || durationMs > maxRangeMs || slotCount > maxGridSlotsPerTarget) {
    throw new RangeError('Window exceeds limits');
  }
  return Object.freeze({ startMs, endMs, intervalMinutes });
}

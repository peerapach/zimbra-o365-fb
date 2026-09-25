import { readFileSync } from 'node:fs';
import type { Failure, Slot, TargetResult, WindowUtc } from '../src/core/types.js';
import { normalizeFreeBusyGrid } from '../src/freebusy/grid.js';

export const SYNTHETIC_EMAIL = 'bob@zfb.example.invalid';
const window = Object.freeze({ startMs: 1789351200000, endMs: 1789365600000, intervalMinutes: 30 });
const fixture: unknown = JSON.parse(readFileSync(new URL('../fixtures/golden/timeline.json', import.meta.url), 'utf8'));

function goldenSlots(): readonly Slot[] {
  if (typeof fixture !== 'object' || fixture === null || !('slots' in fixture)
    || !Array.isArray(fixture.slots) || fixture.slots.length !== 5
    || !('expectedMerged' in fixture) || fixture.expectedMerged !== '02133000') {
    throw new Error('Invalid lab fixture');
  }
  const slots = fixture.slots as unknown;
  const grid = normalizeFreeBusyGrid(window, window, slots);
  if (grid.merged !== '02133000' || grid.intervals.length !== 5) throw new Error('Invalid lab fixture');
  return grid.intervals;
}

const slots = goldenSlots();
export type ProbeScenario = 'success' | 'not-authorized' | 'not-found' | 'timeout' | 'backend-unavailable';

/** A lab result exists only for the reviewed identity and exact golden window. */
export function fixedProbeResult(address: string, requested: WindowUtc, scenario: ProbeScenario): TargetResult {
  const targetId = 'synthetic-pilot';
  const error = (reason: Failure): TargetResult => Object.freeze({ kind: 'error', targetId, reason });
  if (address.toLowerCase() !== SYNTHETIC_EMAIL) return error('not-found');
  if (requested.startMs !== window.startMs || requested.endMs !== window.endMs
    || requested.intervalMinutes !== window.intervalMinutes) return error('invalid-response');
  if (scenario !== 'success') return error(scenario);
  return Object.freeze({ kind: 'ok', targetId, coverage: window, slots, observedAtMs: window.startMs });
}

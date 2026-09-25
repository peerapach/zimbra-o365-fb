import type { Failure, Slot, Status, TargetResult, WindowUtc } from '../core/types.js';

const statuses: readonly Status[] = ['free', 'tentative', 'busy', 'oof', 'unknown'];
const failures: readonly Failure[] = ['not-authorized', 'not-found', 'timeout', 'throttled',
  'backend-unavailable', 'invalid-response', 'unsupported-timezone'];

/** targetId is the authorized directory handle, never a provider-supplied identity. */
export function resultFailure(targetId: string, reason: Failure): TargetResult {
  return Object.freeze({ kind: 'error', targetId, reason });
}

function invalid(): never { throw new TypeError('Invalid normalized result'); }

function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
  return descriptor.value as unknown;
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return own(value, key);
}

function epoch(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > 8640000000000000) invalid();
  return value;
}

function readWindow(value: unknown): WindowUtc {
  const startMs = epoch(field(value, 'startMs'));
  const endMs = epoch(field(value, 'endMs'));
  const intervalMinutes = field(value, 'intervalMinutes');
  if (endMs <= startMs || !Number.isSafeInteger(endMs - startMs) || typeof intervalMinutes !== 'number'
    || !Number.isSafeInteger(intervalMinutes) || intervalMinutes <= 0 || !Number.isSafeInteger(intervalMinutes * 60000)
    || Math.ceil((endMs - startMs) / (intervalMinutes * 60000)) > 17568) invalid();
  return Object.freeze({ startMs, endMs, intervalMinutes });
}

function readSlots(value: unknown, coverage: WindowUtc): readonly Slot[] {
  if (!Array.isArray(value)) invalid();
  const length = own(value, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 20000) invalid();
  const slots: Slot[] = [];
  for (let index = 0; index < length; index++) {
    const item = own(value, String(index));
    const startMs = epoch(field(item, 'startMs'));
    const endMs = epoch(field(item, 'endMs'));
    const status = field(item, 'status');
    if (endMs <= startMs || startMs < coverage.startMs || endMs > coverage.endMs
      || typeof status !== 'string' || !statuses.includes(status as Status)) invalid();
    slots.push(Object.freeze({ startMs, endMs, status: status as Status }));
  }
  return Object.freeze(slots);
}

/** Copy only validated availability fields; no metadata getters or provider references escape. */
export function sanitizeTargetResult(value: unknown, targetId: string, requestWindow: WindowUtc): TargetResult {
  try {
    const kind = field(value, 'kind');
    if (field(value, 'targetId') !== targetId) invalid();
    if (kind === 'error') {
      const reason = field(value, 'reason');
      if (typeof reason !== 'string' || !failures.includes(reason as Failure)) invalid();
      return resultFailure(targetId, reason as Failure);
    }
    if (kind !== 'ok') invalid();
    const requested = readWindow(requestWindow);
    const coverage = readWindow(field(value, 'coverage'));
    if (coverage.startMs < requested.startMs || coverage.endMs > requested.endMs
      || coverage.intervalMinutes !== requested.intervalMinutes) invalid();
    const observedAtMs = epoch(field(value, 'observedAtMs'));
    const slots = readSlots(field(value, 'slots'), coverage);
    return Object.freeze({ kind: 'ok', targetId, coverage, slots, observedAtMs });
  } catch {
    // Malformed required fields, hostile descriptors and invalid times never become partial success.
    return resultFailure(targetId, 'invalid-response');
  }
}

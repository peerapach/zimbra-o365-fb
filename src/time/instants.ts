import { Temporal } from '@js-temporal/polyfill';
import { resolveCandidateZone } from './zones.js';

// Resolved fixed profiles only. Protocol wire rules require separate approval.
export type FixedOffset = '+00:00' | '+07:00';
const fixedOffsets: Readonly<Record<string, FixedOffset>> = Object.freeze({
  UTC: '+00:00',
  'Etc/UTC': '+00:00',
  'Asia/Bangkok': '+07:00',
  'SE Asia Standard Time': '+07:00',
});
const timestamp = /^(\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?)(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;

export function resolveFixedOffset(context: unknown): FixedOffset {
  if (typeof context !== 'string' || !Object.hasOwn(fixedOffsets, context)) throw new RangeError('Unsupported timezone');
  return fixedOffsets[context]!;
}

/** Fixed policy offsets deliberately do not use historical IANA Bangkok rules. */
export function formatFixedOffsetInstant(milliseconds: number, offset: FixedOffset): string {
  if (!Number.isSafeInteger(milliseconds) || (offset !== '+00:00' && offset !== '+07:00')) throw new RangeError('Invalid fixed timestamp');
  return Temporal.Instant.fromEpochMilliseconds(milliseconds).toZonedDateTimeISO(offset)
    .toString({ fractionalSecondDigits: 3, timeZoneName: 'never', calendarName: 'never' });
}

/** Parse a strict ISO date-time, using only an explicitly supplied fixed profile. */
export function parseInstant(value: unknown, context?: unknown): number {
  let zoneOffset: string | undefined;
  if (context !== undefined) zoneOffset = resolveFixedOffset(context);
  if (typeof value !== 'string' || value.length > 35) throw new RangeError('Invalid timestamp');
  const match = timestamp.exec(value);
  if (!match || match[0] !== value) throw new RangeError('Invalid timestamp');
  const local = match[1]!;
  const explicitOffset = match[2] === 'Z' ? '+00:00' : match[2];
  // -00:00 means an unknown offset; it must not silently become UTC.
  if (explicitOffset === '-00:00' || (!explicitOffset && !zoneOffset)) {
    throw new RangeError('Missing or unknown timezone');
  }
  if (explicitOffset && zoneOffset && explicitOffset !== zoneOffset) {
    throw new RangeError('Contradictory timezone');
  }
  try {
    const instant = explicitOffset
      ? Temporal.Instant.from(value)
      : Temporal.PlainDateTime.from(local, { overflow: 'reject' })
        .toZonedDateTime(zoneOffset!, { disambiguation: 'reject' }).toInstant();
    // Temporal validates the full nanosecond value first. Keep the containing
    // millisecond (including before 1970), discarding sub-millisecond precision.
    const milliseconds = instant.epochMilliseconds;
    if (!Number.isSafeInteger(milliseconds)) throw new RangeError('Invalid timestamp');
    return milliseconds;
  } catch {
    throw new RangeError('Invalid timestamp');
  }
}

/** Candidate API is separate from the deployed fixed-profile parser. */
export function parseCandidateZonedInstant(value: unknown, context: unknown): number {
  const zone = resolveCandidateZone(context);
  if (typeof value !== 'string' || value.length > 35) throw new RangeError('Invalid timestamp');
  const match = timestamp.exec(value);
  if (!match || match[0] !== value || match[2] === '-00:00') throw new RangeError('Invalid timestamp');
  try {
    const local = Temporal.PlainDateTime.from(match[1]!, { overflow: 'reject' });
    const offset = match[2] === 'Z' ? '+00:00' : match[2];
    let instant: Temporal.Instant;
    if (offset) {
      instant = Temporal.Instant.from(value);
      const zoned = instant.toZonedDateTimeISO(zone);
      // The offset must describe this local time in the selected zone, including folds.
      if (zoned.offset !== offset || !zoned.toPlainDateTime().equals(local)) throw new RangeError();
    } else {
      const zoned = local.toZonedDateTime(zone, { disambiguation: 'reject' });
      // Historical second offsets cannot be emitted by the supported wire grammar.
      if (!/^[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(zoned.offset)) throw new RangeError();
      instant = zoned.toInstant();
    }
    const milliseconds = instant.epochMilliseconds;
    if (!Number.isSafeInteger(milliseconds)) throw new RangeError();
    return milliseconds;
  } catch { throw new RangeError('Invalid candidate timestamp'); }
}

/** Output an explicit offset only when the narrow timestamp profile can round trip it. */
export function formatCandidateZonedInstant(milliseconds: unknown, context: unknown): string {
  const zone = resolveCandidateZone(context);
  if (typeof milliseconds !== 'number' || !Number.isSafeInteger(milliseconds)) throw new RangeError('Invalid timestamp');
  try {
    const value = Temporal.Instant.fromEpochMilliseconds(milliseconds).toZonedDateTimeISO(zone)
      .toString({ fractionalSecondDigits: 3, timeZoneName: 'never', calendarName: 'never' });
    // Reject extended years/historical second offsets outside the fixed ISO wire grammar.
    if (parseCandidateZonedInstant(value, zone) !== milliseconds) throw new RangeError();
    return value;
  } catch { throw new RangeError('Invalid candidate timestamp'); }
}

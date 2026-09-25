import { Temporal } from '@js-temporal/polyfill';
import { checkAttributes, container, TYPES } from '../ews/operation.js';
import type { XmlNode } from '../xml/parse.js';
import { requiredChild } from '../xml/select.js';
import { resolveCandidateZone } from './zones.js';

type Rule = readonly [number, string, number, number, string];
type Transition = Readonly<{ atMs: number; fromOffset: string; toOffset: string }>;
interface Candidate {
  id: string;
  zone: string;
  signature: string;
  initialOffset: string;
  transitions: readonly Transition[];
}
const blocked = Object.freeze({ kind: 'error', reason: 'unsupported-timezone', code: 'BLOCKED_PROTOCOL' } as const);
const instant = (value: string) => Temporal.Instant.from(value).epochMilliseconds;
const coverageStart = instant('2026-01-01T00:00:00Z');
const coverageEnd = instant('2027-01-01T00:00:00Z');
const fixed: Rule = [0, '00:00:00', 1, 1, 'Sunday'];
const signature = (bias: number, standard: Rule, daylight: Rule) => JSON.stringify([bias, standard, daylight]);
const transition = (at: string, fromOffset: string, toOffset: string): Transition =>
  Object.freeze({ atMs: instant(at), fromOffset, toOffset });

// Synthetic, independently specified 2026 vectors. These do not approve any live client.
const candidates: readonly Candidate[] = [
  { id: 'synthetic-utc-2026', zone: 'Etc/UTC', signature: signature(0, fixed, fixed), initialOffset: '+00:00', transitions: [] },
  { id: 'synthetic-bangkok-2026', zone: 'Asia/Bangkok', signature: signature(-420, fixed, fixed), initialOffset: '+07:00', transitions: [] },
  { id: 'synthetic-pacific-2026', zone: 'America/Los_Angeles',
    signature: signature(480, [0, '02:00:00', 1, 11, 'Sunday'], [-60, '02:00:00', 2, 3, 'Sunday']),
    initialOffset: '-08:00', transitions: [
      transition('2026-03-08T10:00:00Z', '-08:00', '-07:00'),
      transition('2026-11-01T09:00:00Z', '-07:00', '-08:00'),
    ] },
  { id: 'synthetic-london-2026', zone: 'Europe/London',
    signature: signature(0, [0, '02:00:00', 5, 10, 'Sunday'], [-60, '01:00:00', 5, 3, 'Sunday']),
    initialOffset: '+00:00', transitions: [
      transition('2026-03-29T01:00:00Z', '+00:00', '+01:00'),
      transition('2026-10-25T01:00:00Z', '+01:00', '+00:00'),
    ] },
];

function unsupported(): never { throw new RangeError('Unsupported candidate legacy timezone'); }

function scalar(parent: XmlNode, name: string): string {
  const node = requiredChild(parent, TYPES, name);
  checkAttributes(node);
  if (node.children.length) unsupported();
  return node.text.trim();
}

function integer(parent: XmlNode, name: string): number {
  const value = scalar(parent, name);
  if (!/^[+-]?\d{1,4}$/.test(value)) unsupported();
  return Number(value);
}

function rule(parent: XmlNode, name: string): Rule {
  const node = requiredChild(parent, TYPES, name);
  checkAttributes(node);
  container(node, ['Bias', 'Time', 'DayOrder', 'Month', 'DayOfWeek']);
  return [integer(node, 'Bias'), scalar(node, 'Time'), integer(node, 'DayOrder'), integer(node, 'Month'), scalar(node, 'DayOfWeek')];
}

function identify(body: XmlNode): Candidate {
  if (body.uri !== TYPES || body.local !== 'TimeZone') unsupported();
  checkAttributes(body);
  container(body, ['Bias', 'StandardTime', 'DaylightTime']);
  const value = signature(integer(body, 'Bias'), rule(body, 'StandardTime'), rule(body, 'DaylightTime'));
  const candidate = candidates.find(profile => profile.signature === value);
  if (!candidate) unsupported();
  return candidate;
}

function requestedRange(value: unknown): { startMs: number; endMs: number; startOffset?: unknown; endOffset?: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) unsupported();
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some(key => !['startMs', 'endMs', 'startOffset', 'endOffset'].includes(key))
    || !Object.hasOwn(fields, 'startMs') || !Object.hasOwn(fields, 'endMs')) unsupported();
  const { startMs, endMs } = fields;
  if (typeof startMs !== 'number' || typeof endMs !== 'number' || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)
    || startMs < coverageStart || endMs > coverageEnd || endMs <= startMs || endMs - startMs > 61 * 86_400_000) unsupported();
  return { startMs, endMs,
    ...(Object.hasOwn(fields, 'startOffset') ? { startOffset: fields.startOffset } : {}),
    ...(Object.hasOwn(fields, 'endOffset') ? { endOffset: fields.endOffset } : {}) };
}

function checkExplicit(value: unknown, expected: string): void {
  if (typeof value !== 'string' || (value !== 'Z' && !/^[+-]\d{2}:\d{2}$/.test(value))
    || value === '-00:00' || (value === 'Z' ? '+00:00' : value) !== expected) unsupported();
}

const zoned = (atMs: number, zone: string) => Temporal.Instant.fromEpochMilliseconds(atMs).toZonedDateTimeISO(zone);
function expectedOffset(profile: Candidate, atMs: number): string {
  let offset = profile.initialOffset;
  for (const change of profile.transitions) if (change.atMs <= atMs) offset = change.toOffset;
  return offset;
}

/** Input must come from the bounded XML parser. No deployed profile or EWS route is enabled here. */
export function validateLegacyProfile(body: XmlNode, context: unknown, range: unknown) {
  try {
    const profile = identify(body);
    // Greenwich is recognized only together with the complete reviewed zero-bias body.
    const zone = context === 'Greenwich Standard Time' && profile.zone === 'Etc/UTC' ? 'Etc/UTC' : resolveCandidateZone(context);
    if (zone !== profile.zone) unsupported();
    const request = requestedRange(range);
    const start = zoned(request.startMs, zone);
    const end = zoned(request.endMs, zone);
    if (start.offset !== expectedOffset(profile, request.startMs) || end.offset !== expectedOffset(profile, request.endMs)) unsupported();
    if (Object.hasOwn(request, 'startOffset')) checkExplicit(request.startOffset, start.offset);
    if (Object.hasOwn(request, 'endOffset')) checkExplicit(request.endOffset, end.offset);
    const expected = profile.transitions.filter(change => change.atMs > request.startMs && change.atMs <= request.endMs);
    const transitions: Transition[] = [];
    let next = start.getTimeZoneTransition('next');
    while (next && next.epochMilliseconds <= request.endMs) {
      const wanted = expected[transitions.length];
      if (!wanted || next.epochMilliseconds !== wanted.atMs || next.offset !== wanted.toOffset
        || zoned(next.epochMilliseconds - 1, zone).offset !== wanted.fromOffset) unsupported();
      transitions.push(wanted);
      next = next.getTimeZoneTransition('next');
    }
    if (transitions.length !== expected.length) unsupported();
    return Object.freeze({ kind: 'ok', profileId: profile.id, zone, status: 'candidate-not-live-verified', productionApproved: false,
      startOffset: start.offset, endOffset: end.offset, transitions: Object.freeze(transitions) } as const);
  } catch {
    // XML/schema/Temporal failures all remain non-disclosing compatibility failures, never free time.
    return blocked;
  }
}

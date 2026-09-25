import { createCB } from 'xmlbuilder2';
import type { XMLBuilderCB } from 'xmlbuilder2/lib/interfaces.js';
import type { Slot, WindowUtc } from '../core/types.js';
import { normalizeFreeBusyGrid, type NormalizedGrid } from '../freebusy/grid.js';
import { mapEwsFailure } from './errors.js';
import type { AvailabilityInput } from './request.js';
import { formatFixedOffsetInstant, type FixedOffset } from '../time/instants.js';

const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const MESSAGES = 'http://schemas.microsoft.com/exchange/services/2006/messages';
const TYPES = 'http://schemas.microsoft.com/exchange/services/2006/types';
const MAX_TARGETS = 100;
const MAX_RESPONSE_BYTES = 8_388_608;
type View = AvailabilityInput['requestedView'];
export interface ResponseOptions {
  readonly requestedView?: View;
  readonly maxResponseBytes?: number;
  readonly responseOffset?: FixedOffset;
  /** Trusted route-owned cancellation/deadline check; never supplied by XML. */
  readonly checkActive?: () => void;
}
// A strict lower bound: nonempty event fields always need these tags, plus their text.
const EVENT_MARKUP_BYTES = '<t:CalendarEvent><t:StartTime></t:StartTime><t:EndTime></t:EndTime><t:BusyType></t:BusyType></t:CalendarEvent>'.length;
function oversized(): never { throw new RangeError('Availability response exceeds byte limit'); }
const busyType: Readonly<Record<Slot['status'], string>> = Object.freeze({
  free: 'Free', tentative: 'Tentative', busy: 'Busy', oof: 'OOF', unknown: 'NoData',
});

function record(value: unknown): Record<string, unknown> | undefined {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function appendError(response: XMLBuilderCB, reason: unknown): void {
  const failure = mapEwsFailure(reason);
  response.ele(MESSAGES, 'm:ResponseMessage', { ResponseClass: 'Error' })
    .ele(MESSAGES, 'm:ResponseCode').txt(failure.responseCode).up().up();
  response.ele(MESSAGES, 'm:FreeBusyView').ele(TYPES, 't:FreeBusyViewType').txt('None').up().up();
}

function appendSuccess(response: XMLBuilderCB, grid: NormalizedGrid, requestedView: View, offset: FixedOffset): void {
  response.ele(MESSAGES, 'm:ResponseMessage', { ResponseClass: 'Success' })
    .ele(MESSAGES, 'm:ResponseCode').txt('NoError').up().up();
  response.ele(MESSAGES, 'm:FreeBusyView').ele(TYPES, 't:FreeBusyViewType')
    .txt(requestedView === 'DetailedMerged' ? 'FreeBusyMerged' : requestedView).up();
  if (requestedView !== 'None' && requestedView !== 'FreeBusy') response.ele(TYPES, 't:MergedFreeBusy').txt(grid.merged).up();
  if (requestedView !== 'None' && requestedView !== 'MergedOnly') {
    response.ele(TYPES, 't:CalendarEventArray');
    for (const interval of grid.intervals) {
      if (interval.status === 'free') continue;
      response.ele(TYPES, 't:CalendarEvent')
        .ele(TYPES, 't:StartTime').txt(formatFixedOffsetInstant(interval.startMs, offset)).up()
        .ele(TYPES, 't:EndTime').txt(formatFixedOffsetInstant(interval.endMs, offset)).up()
        .ele(TYPES, 't:BusyType').txt(busyType[interval.status]).up().up();
    }
    response.up();
  }
  response.up();
}

type ClassifiedResult =
  | { readonly kind: 'ok'; readonly grid: NormalizedGrid }
  | { readonly kind: 'error'; readonly reason: unknown };

function invalidResult(): ClassifiedResult {
  return { kind: 'error', reason: 'invalid-response' };
}

function classifyResult(window: WindowUtc, value: unknown): ClassifiedResult {
  const result = record(value);
  if (!result) return invalidResult();
  let kind: unknown;
  try {
    kind = result.kind;
  } catch {
    return invalidResult();
  }
  if (kind === 'error') {
    try {
      return { kind: 'error', reason: result.reason };
    } catch {
      return invalidResult();
    }
  }
  if (kind !== 'ok') return invalidResult();

  let targetId: unknown;
  let observedAtMs: unknown;
  let coverage: unknown;
  let slots: unknown;
  try {
    targetId = result.targetId;
    observedAtMs = result.observedAtMs;
    coverage = result.coverage;
    slots = result.slots;
  } catch {
    return invalidResult();
  }
  if (typeof targetId !== 'string' || !targetId
    || typeof observedAtMs !== 'number' || !Number.isSafeInteger(observedAtMs)) return invalidResult();
  try {
    return { kind: 'ok', grid: normalizeFreeBusyGrid(window, coverage, slots) };
  } catch {
    return invalidResult();
  }
}

function classifyIndex(results: readonly unknown[], index: number, window: WindowUtc,
  cache: Map<object, ClassifiedResult>, view: View): ClassifiedResult {
  let value: unknown;
  try {
    value = results[index];
  } catch {
    return invalidResult();
  }
  const key = typeof value === 'object' && value !== null ? value : undefined;
  // Request-local validated snapshots only; target IDs are not cache/authority keys here.
  const cached = key && cache.get(key);
  if (cached) return cached;
  let result = classifyResult(window, value);
  if (result.kind === 'ok' && (view === 'None' || view === 'MergedOnly')) {
    result = { kind: 'ok', grid: { ...result.grid, merged: view === 'None' ? '' : result.grid.merged, intervals: [] } };
  }
  if (key) cache.set(key, result);
  return result;
}

function appendResult(array: XMLBuilderCB, result: ClassifiedResult, view: View, offset: FixedOffset): void {
  array.ele(MESSAGES, 'm:FreeBusyResponse');
  if (result.kind === 'ok') appendSuccess(array, result.grid, view, offset);
  else appendError(array, result.reason);
  array.up();
}

function invalidResults(): never {
  throw new TypeError('Invalid availability results');
}

/** Compose one fixed-shape SOAP document while preserving the input result order. */
export function encodeAvailabilityResponse(windowValue: unknown, resultsValue: unknown, options: ResponseOptions = {}): string {
  options.checkActive?.();
  const view = options.requestedView ?? 'FreeBusyMerged';
  const limit = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const offset = options.responseOffset ?? '+00:00';
  if (!['None', 'MergedOnly', 'FreeBusy', 'FreeBusyMerged', 'DetailedMerged'].includes(view)
    || (offset !== '+00:00' && offset !== '+07:00')
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESPONSE_BYTES) throw new TypeError('Invalid response options');
  let results: unknown[];
  let targetCount: number;
  try {
    if (!Array.isArray(resultsValue)) return invalidResults();
    results = resultsValue;
    targetCount = results.length;
  } catch {
    return invalidResults();
  }
  if (!Number.isSafeInteger(targetCount) || targetCount < 1 || targetCount > MAX_TARGETS) return invalidResults();
  const window = normalizeFreeBusyGrid(windowValue, [], []).window;
  const cache = new Map<object, ClassifiedResult>();
  const classified: ClassifiedResult[] = [];
  let minimumBytes = 0;
  for (let index = 0; index < targetCount; index++) {
    options.checkActive?.();
    const result = classifyIndex(results, index, window, cache, view);
    options.checkActive?.();
    if (result.kind === 'ok') {
      if (view !== 'None' && view !== 'FreeBusy') minimumBytes += result.grid.merged.length;
      for (const interval of result.grid.intervals) if (interval.status !== 'free') minimumBytes += EVENT_MARKUP_BYTES;
    }
    if (minimumBytes > limit) oversized();
    classified.push(result);
  }
  const chunks: string[] = [];
  let pending = '';
  let bytes = 0;
  // Callback mode retains no full XML DOM. Check every UTF-8 chunk before retaining it.
  const document = createCB({ prettyPrint: false, wellFormed: true, data: (chunk: string) => {
    options.checkActive?.();
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > limit) oversized();
    pending += chunk;
    if (pending.length >= 65_536) { chunks.push(pending); pending = ''; }
  } });
  document.dec({ version: '1.0', encoding: 'UTF-8' }).ele(SOAP, 's:Envelope', {
    'xmlns:s': SOAP, 'xmlns:m': MESSAGES, 'xmlns:t': TYPES,
  }).ele(SOAP, 's:Body').ele(MESSAGES, 'm:GetUserAvailabilityResponse').ele(MESSAGES, 'm:FreeBusyResponseArray');
  for (const result of classified) appendResult(document, result, view, offset);
  document.end();
  chunks.push(pending);
  const body = chunks.join('');
  options.checkActive?.();
  return body;
}

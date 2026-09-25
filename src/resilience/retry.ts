import type { CallContext, Clock, HttpResponse } from '../core/types.js';
import { abortable, TransportError } from '../http/outbound.js';
import { parseXmlBounded } from '../xml/parse.js';
import { requiredChild } from '../xml/select.js';

type RetryClock = Pick<Clock, 'monoMs' | 'wallMs'>;
const transient = new Set([429, 502, 503, 504]);
const graphTransientCodes = new Set(['TooManyRequests', 'serviceNotAvailable']);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function transientGraphError(data: unknown, status: number): boolean {
  if (!record(data) || Object.keys(data).length !== 1 || !record(data.error)) return false;
  const error = data.error;
  if (typeof error.code !== 'string' || !graphTransientCodes.has(error.code) || typeof error.message !== 'string') return false;
  // Details can carry independent per-item failures; do not mask them with a generic retry.
  if ('details' in error && (!Array.isArray(error.details) || error.details.length !== 0)) return false;
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if ('innerError' in current && 'innererror' in current) return false;
    if (!('innerError' in current) && !('innererror' in current)) return true;
    const inner = current.innerError ?? current.innererror;
    if (!record(inner)) return false;
    if ('code' in inner && (typeof inner.code !== 'string'
      || (!graphTransientCodes.has(inner.code) && inner.code !== String(status)))) return false;
    current = inner;
  }
  return false;
}

function transientBody(response: HttpResponse, protocol: 'graph' | 'zimbra'): boolean {
  try {
    if (!(response.body instanceof Uint8Array) || response.body.byteLength > 4194304) return false;
    if (response.body.byteLength === 0) return true; // Empty load-balancer failures are valid retry candidates.
    if (protocol === 'graph') {
      const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
      return transientGraphError(data, response.status);
    }
    const root = parseXmlBounded(response.body, { maxRequestBytes: 4194304, maxXmlDepth: 32, maxXmlNodes: 10000,
      maxAttributesPerElement: 32, maxXmlTextNodeChars: 16384 });
    const soap = 'http://schemas.xmlsoap.org/soap/envelope/';
    if (root.uri !== soap || root.local !== 'Envelope') return false;
    const body = requiredChild(root, soap, 'Body');
    // SOAP faults, including verified expiry, belong to the existing session policy, not generic retry.
    return body.children.length === 1 && body.children[0]?.uri === 'urn:zimbraMail' && body.children[0].local === 'GetFreeBusyResponse';
  } catch { return false; }
}

function remaining(ctx: CallContext, clock: RetryClock): number {
  const left = ctx.deadlineMonoMs - clock.monoMs();
  if (ctx.signal.aborted || !Number.isFinite(left) || left <= 0) throw new TransportError('timeout');
  return left;
}

function retryDelay(response: HttpResponse, clock: RetryClock): number | undefined {
  const header = response.headers['retry-after'] ?? response.headers['Retry-After'];
  if (header === undefined) return 100;
  if (typeof header !== 'string' || header.length > 64) return undefined;
  if (/^\d+$/.test(header)) {
    const ms = Number(header) * 1000;
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  // Accept the unambiguous IMF-fixdate form; other/invalid forms fail closed.
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)) return undefined;
  const at = Date.parse(header);
  const wall = clock.wallMs();
  return Number.isSafeInteger(at) && Number.isSafeInteger(wall) && new Date(at).toUTCString() === header
    ? Math.max(0, at - wall) : undefined;
}

async function attempt(ctx: CallContext, clock: RetryClock, operation: (signal: AbortSignal) => Promise<HttpResponse>): Promise<HttpResponse> {
  const ms = Math.min(3000, remaining(ctx, clock));
  const ends = clock.monoMs() + ms;
  const controller = new AbortController();
  const signal = AbortSignal.any([ctx.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await abortable(operation(signal), signal);
    remaining({ signal, deadlineMonoMs: ends }, clock);
    return response;
  } finally { clearTimeout(timer); }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new TransportError('timeout')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** One owner per logical availability lookup, including Zimbra's separate verified-expiry replay.
 * CallContext already excludes the response reserve; token/queue time must not reset it. */
export function availabilityRetry(original: CallContext, clock: RetryClock, protocol: 'graph' | 'zimbra') {
  let used = false;
  return async (ctx: CallContext, operation: (signal: AbortSignal) => Promise<HttpResponse>): Promise<HttpResponse> => {
    const effective = { signal: AbortSignal.any([original.signal, ctx.signal]), deadlineMonoMs: Math.min(original.deadlineMonoMs, ctx.deadlineMonoMs) };
    for (let attemptNumber = 0; attemptNumber < 2; attemptNumber++) {
      let response: HttpResponse | undefined;
      let failure: TransportError | undefined;
      try { response = await attempt(effective, clock, operation); }
      catch (error) {
        if (!(error instanceof TransportError) || !error.retryable || used) throw error;
        failure = error;
      }
      if (!response && !failure) throw new TransportError('invalid-response');
      if (response && (!transient.has(response.status) || used || !transientBody(response, protocol))) return response;
      const delay = response ? retryDelay(response, clock) : 100;
      const finish = () => { if (response) return response; throw failure!; };
      if (delay === undefined || delay >= remaining(effective, clock)) return finish();
      used = true;
      const notBefore = clock.monoMs() + delay;
      await sleep(delay, effective.signal);
      remaining(effective, clock);
      // A stalled/backward injected clock is never justification for an early retry.
      if (clock.monoMs() < notBefore) return finish();
    }
    throw new TransportError('backend-unavailable');
  };
}

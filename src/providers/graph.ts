import type { AvailabilityProvider, CallContext, Failure, HttpTransport, Target, TargetResult, TokenSource, WindowUtc } from '../core/types.js';
import { abortable, TransportError } from '../http/outbound.js';
import { GraphTokenError } from './graph-token.js';
import { normalizeGraph } from './graph-map.js';
import { availabilityRetry } from '../resilience/retry.js';
import { isUtf8MediaType } from '../http/content-type.js';

interface GraphProviderOptions {
  readonly transport: HttpTransport;
  readonly tokenSource: TokenSource;
  readonly wallMs: () => number;
  readonly monoMs?: () => number;
}

const graphBase = 'https://graph.microsoft.com/v1.0';
const maxResponseBytes = 4194304;
const maxDateMs = 8640000000000000;
const objectId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function error(target: Target, reason: Failure): TargetResult {
  return { kind: 'error', targetId: target.entryId, reason };
}

function utcDateTime(value: number): string {
  if (!Number.isSafeInteger(value) || Math.abs(value) > maxDateMs) throw new RangeError();
  return new Date(value).toISOString().replace(/Z$/, '').replace(/\.000$/, '');
}

function providerFailure(cause: unknown): Failure {
  if (cause instanceof TransportError) {
    if (cause.code === 'timeout') return 'timeout';
    if (cause.code === 'invalid-response' || cause.code === 'destination') return 'invalid-response';
    return 'backend-unavailable';
  }
  if (cause instanceof GraphTokenError) return cause.code === 'timeout' ? 'timeout' : 'backend-unavailable';
  return 'backend-unavailable';
}

function httpFailure(status: number): Failure {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) return 'invalid-response';
  if (status === 401 || status === 403) return 'not-authorized';
  if (status === 408) return 'timeout';
  if (status === 429) return 'throttled';
  if (status >= 500) return 'backend-unavailable';
  return 'invalid-response';
}

export function createGraphProvider(options: GraphProviderOptions): AvailabilityProvider {
  const clock = { wallMs: options.wallMs, monoMs: options.monoMs ?? (() => performance.now()) };
  return {
    kind: 'graph',
    async lookup(target: Target, window: WindowUtc, ctx: CallContext): Promise<TargetResult> {
      if (target.provider !== 'graph') return error(target, 'not-authorized');
      if (ctx.signal.aborted || !Number.isFinite(ctx.deadlineMonoMs) || clock.monoMs() >= ctx.deadlineMonoMs) return error(target, 'timeout');
      const mailbox = target.graphObjectId ?? target.canonicalSmtp;
      if (!mailbox || mailbox.length > 320 || /[\x00-\x20\x7f]/.test(mailbox)
        || (target.graphObjectId !== undefined && !objectId.test(target.graphObjectId))) return error(target, 'invalid-response');
      let body: string;
      try {
        body = JSON.stringify({
          schedules: [target.canonicalSmtp],
          startTime: { dateTime: utcDateTime(window.startMs), timeZone: 'UTC' },
          endTime: { dateTime: utcDateTime(window.endMs), timeZone: 'UTC' },
          availabilityViewInterval: window.intervalMinutes,
        });
      } catch {
        return error(target, 'invalid-response');
      }
      try {
        const token = await abortable(options.tokenSource.getToken(ctx), ctx.signal);
        if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token) || token.length > 32768) return error(target, 'backend-unavailable');
        const response = await availabilityRetry(ctx, clock, 'graph')(ctx, signal => options.transport.request({
          url: `${graphBase}/users/${encodeURIComponent(mailbox)}/calendar/getSchedule`,
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
          body, signal, maxResponseBytes,
        }));
        if (response.status !== 200) return error(target, httpFailure(response.status));
        const contentType = response.headers['content-type'] ?? response.headers['Content-Type'] ?? '';
        if (!isUtf8MediaType(contentType, 'application/json', true)) return error(target, 'invalid-response');
        if (!(response.body instanceof Uint8Array) || response.body.byteLength > maxResponseBytes) return error(target, 'invalid-response');
        let payload: unknown;
        try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)) as unknown; }
        catch { return error(target, 'invalid-response'); }
        return normalizeGraph(payload, target, window, options.wallMs());
      } catch (cause) {
        return error(target, providerFailure(cause));
      }
    },
  };
}

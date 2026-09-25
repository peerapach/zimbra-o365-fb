import type { HttpTransport } from '../core/types.js';
import type { createMetrics } from '../observability/metrics.js';

export class TransportError extends Error {
  constructor(readonly code: 'destination' | 'invalid-response' | 'timeout' | 'backend-unavailable', readonly retryable = false) {
    super('Outbound request failed');
  }
}

function transientNetwork(error: unknown): boolean {
  if (!(error instanceof TypeError) || !error.cause || typeof error.cause !== 'object' || !('code' in error.cause)) return false;
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(error.cause.code));
}

// Race even injected dependencies that fail to honor cancellation; never expose abort reasons.
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new TransportError('timeout'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

interface OutboundOptions {
  readonly graphTargets: readonly string[];
  readonly zimbraSoapUrl?: string;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
  readonly telemetry?: { monoMs(): number; provider: ReturnType<typeof createMetrics>['provider'] };
}

// Constructor inputs are administrator-owned configuration, never request/XML fields.
export function createOutboundTransport(options: OutboundOptions, fetcher: typeof fetch = fetch): HttpTransport {
  const destinations = new Set<string>();
  const { maxResponseBytes, timeoutMs, zimbraSoapUrl } = options;
  const validBound = (n: number, max: number) => Number.isSafeInteger(n) && n > 0 && n <= max;
  try {
    if (!validBound(maxResponseBytes, 4194304) || !validBound(timeoutMs, 3000)) throw new Error();
    for (const target of options.graphTargets) {
      if (!target || target.length > 320 || /[\x00-\x20\x7f]/.test(target) || target === '.' || target === '..') throw new Error();
      destinations.add(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(target)}/calendar/getSchedule`);
    }
    if (zimbraSoapUrl !== undefined) {
      const u = new URL(zimbraSoapUrl);
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/service/soap' || u.href !== zimbraSoapUrl) throw new Error();
      destinations.add(zimbraSoapUrl);
    }
  } catch { throw new TransportError('destination'); }
  return { async request(input) {
    if (input.method !== 'POST' || !destinations.has(input.url)) throw new TransportError('destination');
    if (!validBound(input.maxResponseBytes, maxResponseBytes)) throw new TransportError('invalid-response');
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let started: number | undefined;
    let outcome = 'backend-unavailable';
    try {
      if (signal.aborted) throw new TransportError('timeout');
      const headers = new Headers(input.headers);
      for (const name of headers.keys()) {
        if (!['authorization', 'content-type', 'accept', 'soapaction'].includes(name)) throw new TransportError('destination');
      }
      headers.set('accept-encoding', 'identity');
      started = options.telemetry?.monoMs();
      const response = await abortable(fetcher(input.url, { method: 'POST', headers, body: input.body, redirect: 'error', signal }), signal);
      reader = response.body?.getReader();
      const length = response.headers.get('content-length');
      const encoding = response.headers.get('content-encoding');
      const contentType = response.headers.get('content-type') ?? '';
      const media = input.url === zimbraSoapUrl ? '(?:text/xml|application/(?:soap\\+xml|xml))' : 'application/json';
      if (response.redirected || (response.status >= 300 && response.status < 400)
        || (encoding !== null && encoding.toLowerCase() !== 'identity')
        || (length !== null && (!/^\d+$/.test(length) || Number(length) > input.maxResponseBytes))) {
        throw new TransportError('invalid-response');
      }
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (reader) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > input.maxResponseBytes) throw new TransportError('invalid-response');
        if (chunk.value.byteLength) chunks.push(chunk.value);
      }
      if (length !== null && Number(length) !== received) throw new TransportError('invalid-response');
      if (!new RegExp(`^${media}(?:\\s*;\\s*charset=(?:utf-8|"utf-8"))?\\s*$`, 'i').test(contentType)
        && !(received === 0 && [429, 502, 503, 504].includes(response.status))) throw new TransportError('invalid-response');
      const body = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      try { new TextDecoder('utf-8', { fatal: true }).decode(body); }
      catch { throw new TransportError('invalid-response'); }
      outcome = response.status >= 200 && response.status < 300 ? 'http-2xx'
        : response.status >= 400 && response.status < 500 ? 'http-4xx'
          : response.status >= 500 && response.status < 600 ? 'http-5xx' : 'http-other';
      return { status: response.status, headers: Object.fromEntries(response.headers), body };
    } catch (error) {
      const failure = error instanceof TransportError ? error : signal.aborted ? new TransportError('timeout')
        : new TransportError('backend-unavailable', transientNetwork(error));
      outcome = failure.code;
      controller.abort();
      if (reader) {
        // Cancellation failure is mapped, not logged with upstream details.
        try { await abortable(reader.cancel(), signal); }
        catch { throw failure; }
      }
      throw failure;
    } finally {
      clearTimeout(timer);
      reader?.releaseLock();
      if (started !== undefined && options.telemetry) {
        options.telemetry.provider(input.url === zimbraSoapUrl ? 'zimbra' : 'graph', outcome, options.telemetry.monoMs() - started);
      }
    }
  } };
}

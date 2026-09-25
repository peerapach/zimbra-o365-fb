import { isAbsolute } from 'node:path';
import { ClientCertificateCredential } from '@azure/identity';
import type { AccessToken, ClientCertificateCredentialOptions, TokenCredential } from '@azure/identity';
import type { Clock, TokenSource } from '../core/types.js';
import type { ValidatedConfig } from '../config/validate.js';
import { abortable, TransportError } from '../http/outbound.js';

export class GraphTokenError extends Error {
  constructor(readonly code: 'token-unavailable' | 'timeout') { super('Graph token unavailable'); }
}
type CredentialFactory = (tenantId: string, clientId: string, certificate: { certificatePath: string }, options: ClientCertificateCredentialOptions) => TokenCredential;
interface Flight {
  readonly controller: AbortController;
  promise: Promise<string>;
  subscribers: number;
}

// MSAL's certificate flow does not propagate getToken's abortSignal to its HTTP client.
// Each credential therefore owns an immutable refresh signal, including delayed SDK work.
function certificateHttpClient(tenant: string, signal: AbortSignal, fetcher: typeof fetch): NonNullable<ClientCertificateCredentialOptions['httpClient']> {
  const authority = `https://login.microsoftonline.com/${tenant.toLowerCase()}`;
  const tokenUrl = `${authority}/oauth2/v2.0/token`;
  const metadataUrl = `${authority}/v2.0/.well-known/openid-configuration`;
  return { async sendRequest(request) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (signal.aborted) throw new GraphTokenError('timeout');
      // Pinned MSAL appends one correlation UUID. Validate it, then use the fixed URL.
      const query = request.url.slice(tokenUrl.length);
      const tokenRequest = request.method === 'POST' && request.url.startsWith(tokenUrl)
        && (query === '' || /^\?client-request-id=[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(query));
      if (!tokenRequest && !(request.method === 'GET' && request.url === metadataUrl)) throw new GraphTokenError('token-unavailable');
      if (tokenRequest && (typeof request.body !== 'string' || Buffer.byteLength(request.body) > 262144)) throw new GraphTokenError('token-unavailable');
      const headers = new Headers(request.headers.toJSON());
      if (headers.has('host')) throw new GraphTokenError('token-unavailable');
      headers.set('accept-encoding', 'identity');
      request.abortSignal = signal;
      request.timeout = 3000;
      const response = await abortable(fetcher(tokenRequest ? tokenUrl : metadataUrl, {
        method: request.method, headers, ...(tokenRequest ? { body: request.body as string } : {}), redirect: 'error', signal,
      }), signal);
      reader = response.body?.getReader();
      const length = response.headers.get('content-length');
      const encoding = response.headers.get('content-encoding');
      if (response.redirected || (response.status >= 300 && response.status < 400)
        || (encoding !== null && encoding.toLowerCase() !== 'identity')
        || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(response.headers.get('content-type') ?? '')
        || (length !== null && (!/^\d+$/.test(length) || Number(length) > 4194304))) throw new GraphTokenError('token-unavailable');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (reader) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4194304) throw new GraphTokenError('token-unavailable');
        if (chunk.value.byteLength) chunks.push(chunk.value);
      }
      if (length !== null && Number(length) !== bytes) throw new GraphTokenError('token-unavailable');
      const bodyAsText = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
      const responseHeaders = new Headers(response.headers);
      return { request, status: response.status, bodyAsText, headers: {
        get: name => responseHeaders.get(name) ?? undefined, has: name => responseHeaders.has(name),
        set: (name, value) => responseHeaders.set(name, String(value)), delete: name => responseHeaders.delete(name),
        toJSON: () => Object.fromEntries(responseHeaders), [Symbol.iterator]: () => responseHeaders.entries(),
      } };
    } catch {
      const failure = new GraphTokenError(signal.aborted ? 'timeout' : 'token-unavailable');
      if (reader) {
        try { await abortable(reader.cancel(), signal); }
        catch { throw failure; }
      }
      throw failure;
    } finally { reader?.releaseLock(); }
  } };
}

export function createGraphTokenSource(
  config: ValidatedConfig['graph'],
  clock: Pick<Clock, 'wallMs' | 'monoMs'>,
  credentialFactory: CredentialFactory = (tenant, client, certificate, options) => new ClientCertificateCredential(tenant, client, certificate, options),
  fetcher: typeof fetch = fetch,
): TokenSource {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  try {
    if (config.cloud !== 'public' || config.baseUrl !== 'https://graph.microsoft.com/v1.0'
      || !uuid.test(config.tenantId) || !uuid.test(config.clientId)
      || !isAbsolute(config.certificateFile) || /[\x00-\x1f\x7f]/.test(config.certificateFile)) throw new Error();
  } catch { throw new GraphTokenError('token-unavailable'); }
  const { tenantId, clientId, certificateFile } = config;
  let cached: { access: AccessToken; refreshMonoMs: number } | undefined;
  let flight: Flight | undefined;
  const marginMs = 60000;
  function startRefresh(): Flight {
    const active: Flight = { controller: new AbortController(), subscribers: 0, promise: Promise.resolve('') };
    const timer = setTimeout(() => active.controller.abort(), 3000);
    active.promise = (async () => {
      try {
        const credential = credentialFactory(tenantId, clientId, { certificatePath: certificateFile }, {
          authorityHost: 'https://login.microsoftonline.com', disableInstanceDiscovery: true,
          additionallyAllowedTenants: [], retryOptions: { maxRetries: 0 }, redirectOptions: { maxRetries: 0 },
          loggingOptions: { allowLoggingAccountIdentifiers: false, enableUnsafeSupportLogging: false },
          httpClient: certificateHttpClient(tenantId, active.controller.signal, fetcher),
        });
        const access: unknown = await abortable(credential.getToken('https://graph.microsoft.com/.default', { abortSignal: active.controller.signal }), active.controller.signal);
        const wall = clock.wallMs();
        const mono = clock.monoMs();
        if (active.controller.signal.aborted) throw new GraphTokenError('timeout');
        if (!access || typeof access !== 'object' || !('token' in access) || typeof access.token !== 'string'
          || !/^[A-Za-z0-9._~+/-]+=*$/.test(access.token) || access.token.length > 32768
          || !('expiresOnTimestamp' in access) || typeof access.expiresOnTimestamp !== 'number'
          || !Number.isSafeInteger(access.expiresOnTimestamp) || !Number.isFinite(wall) || !Number.isFinite(mono)
          || access.expiresOnTimestamp <= wall + marginMs) throw new GraphTokenError('token-unavailable');
        cached = { access: { token: access.token, expiresOnTimestamp: access.expiresOnTimestamp }, refreshMonoMs: mono + access.expiresOnTimestamp - wall - marginMs };
        return access.token;
      } catch (error) {
        throw new GraphTokenError((error instanceof TransportError || error instanceof GraphTokenError) && error.code === 'timeout' ? 'timeout' : 'token-unavailable');
      } finally {
        clearTimeout(timer);
        if (flight === active) flight = undefined;
      }
    })();
    return active;
  }
  return { async getToken(ctx) {
    const remaining = ctx.deadlineMonoMs - clock.monoMs();
    if (ctx.signal.aborted || !Number.isFinite(remaining) || remaining <= 0) throw new GraphTokenError('timeout');
    if (cached && clock.wallMs() + marginMs < cached.access.expiresOnTimestamp && clock.monoMs() < cached.refreshMonoMs) return cached.access.token;
    cached = undefined;
    const active = flight ??= startRefresh();
    active.subscribers++;
    const controller = new AbortController();
    const signal = AbortSignal.any([ctx.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, 2147483647));
    try { return await abortable(active.promise, signal); }
    catch (error) { throw new GraphTokenError((error instanceof TransportError || error instanceof GraphTokenError) && error.code === 'timeout' ? 'timeout' : 'token-unavailable'); }
    finally {
      clearTimeout(timer);
      active.subscribers--;
      if (active.subscribers === 0) {
        active.controller.abort();
        if (flight === active) flight = undefined;
      }
    }
  } };
}

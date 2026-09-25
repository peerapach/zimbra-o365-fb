import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOutboundTransport } from '../../src/http/outbound.js';
import { createGraphTokenSource } from '../../src/providers/graph-token.js';
import { ClientCertificateCredential } from '@azure/identity';
import type { AccessToken, TokenCredential, ClientCertificateCredentialOptions } from '@azure/identity';
import { generateKeyPairSync } from 'node:crypto';

const url = 'https://graph.microsoft.com/v1.0/users/a%2Bb%40example.test/calendar/getSchedule';
const options = { graphTargets: ['a+b@example.test'], maxResponseBytes: 1024, timeoutMs: 3000 };
const input = () => ({ url, method: 'POST' as const, headers: { authorization: 'Bearer synthetic' }, body: '{}', signal: new AbortController().signal, maxResponseBytes: 1024 });
const json = (body = '{}') => new Response(body, { headers: { 'content-type': 'application/json' } });

afterEach(() => vi.useRealTimers());
describe('fixed outbound transport', () => {
  it('sends an encoded configured target and returns bounded bytes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json());
    const result = await createOutboundTransport(options, fetcher).request(input());
    expect(result).toMatchObject({ status: 200, body: new TextEncoder().encode('{}') });
    expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'POST', redirect: 'error', body: '{}' }));
    const headers = fetcher.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer synthetic');
    expect(headers.get('accept-encoding')).toBe('identity');
  });
  it.each([
    'https://outlook.office365.com/EWS/Exchange.asmx',
    'https://graph.microsoft.com/v1.0/me/calendar/getSchedule',
    'https://graph.microsoft.com/v1.0/users/a%2Bb%40example.test/events',
    'https://graph.microsoft.com/v1.0/users/other/calendar/getSchedule',
    `${url}?override=1`, `${url}#fragment`, url.replace('graph.microsoft.com', 'evil.test'),
    url.replace('/a%2Bb%40example.test/', '/a+b@example.test/'),
  ])('refuses a non-approved URL: %s', async forbidden => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createOutboundTransport(options, fetcher).request({ ...input(), url: forbidden })).rejects.toMatchObject({ code: 'destination' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{ method: 'GET' }, { headers: { Host: 'evil.test' } }, { maxResponseBytes: 0 }, { maxResponseBytes: 1025 }])('refuses request overrides %j', async override => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createOutboundTransport(options, fetcher).request({ ...input(), ...override } as ReturnType<typeof input>)).rejects.toHaveProperty('code');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['http://zimbra.test/service/soap', 'https://zimbra.test/service/admin/soap', 'https://user:pass@zimbra.test/service/soap', 'https://zimbra.test/service/soap?x=1'])('validates fixed Zimbra config %s', zimbraSoapUrl => {
    expect(() => createOutboundTransport({ ...options, zimbraSoapUrl })).toThrow();
  });
  it.each([{ graphTargets: ['..'] }, { graphTargets: ['bad\r\nidentity'] }, { maxResponseBytes: 0 }, { maxResponseBytes: 4194305 }, { timeoutMs: 0 }, { timeoutMs: 3001 }])('rejects unsafe transport configuration %j', override => {
    expect(() => createOutboundTransport({ ...options, ...override })).toThrow();
  });
  it('captures configured destinations so later config mutation cannot redirect requests', async () => {
    const graphTargets = ['a+b@example.test'];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json());
    const transport = createOutboundTransport({ ...options, graphTargets }, fetcher);
    graphTargets.push('attacker@example.test');
    await expect(transport.request({ ...input(), url: 'https://graph.microsoft.com/v1.0/users/attacker%40example.test/calendar/getSchedule' })).rejects.toHaveProperty('code', 'destination');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects declared oversize before reading the body', async () => {
    const pull = vi.fn();
    const response = new Response(new ReadableStream({ pull }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json', 'content-length': '1025' } });
    await expect(createOutboundTransport(options, vi.fn<typeof fetch>().mockResolvedValue(response)).request(input())).rejects.toHaveProperty('code', 'invalid-response');
    expect(pull).not.toHaveBeenCalled();
  });
  it('retains upstream status and retry headers without retrying or interpreting provider content', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"limited"}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2' } }));
    const result = await createOutboundTransport(options, fetcher).request(input());
    expect(result.status).toBe(429);
    expect(result.headers['retry-after']).toBe('2');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('accepts only the configured Zimbra user SOAP endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<Envelope/>', { headers: { 'content-type': 'text/xml; charset=utf-8' } }));
    const transport = createOutboundTransport({ ...options, zimbraSoapUrl: 'https://zimbra.test:8443/service/soap' }, fetcher);
    expect((await transport.request({ ...input(), url: 'https://zimbra.test:8443/service/soap' })).status).toBe(200);
    await expect(transport.request({ ...input(), url: 'https://zimbra.test/service/soap' })).rejects.toHaveProperty('code', 'destination');
  });
  it.each([
    new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1025' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': 'NaN' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1' } }),
    new Response('{}', { headers: { 'content-type': 'application/json; charset=utf-16' } }),
    new Response('<html/>', { headers: { 'content-type': 'text/html' } }),
    new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } }),
  ])('rejects redirects, unsafe encoding, lengths and malformed content', async response => {
    await expect(createOutboundTransport(options, vi.fn<typeof fetch>().mockResolvedValue(response)).request(input())).rejects.toHaveProperty('code', 'invalid-response');
  });
  it('counts streamed bytes before retaining an oversized chunk', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(700)); c.enqueue(new Uint8Array(700)); }, cancel }), { headers: { 'content-type': 'application/json' } });
    await expect(createOutboundTransport(options, vi.fn<typeof fetch>().mockResolvedValue(response)).request(input())).rejects.toHaveProperty('code', 'invalid-response');
    expect(cancel).toHaveBeenCalled();
  });
  it('sanitizes fetch errors and never retries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('SENSITIVE-TOKEN'));
    await expect(createOutboundTransport(options, fetcher).request(input())).rejects.toMatchObject({ code: 'backend-unavailable', message: 'Outbound request failed' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('cancels before fetch and while awaiting an uncooperative fetch', async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const transport = createOutboundTransport(options, fetcher);
    const pending = transport.request({ ...input(), signal: abort.signal });
    abort.abort('SENSITIVE');
    await expect(pending).rejects.toHaveProperty('code', 'timeout');
    await expect(transport.request({ ...input(), signal: abort.signal })).rejects.toHaveProperty('code', 'timeout');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds a stalled body under its own timeout', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } });
    const pending = createOutboundTransport(options, vi.fn<typeof fetch>().mockResolvedValue(response)).request(input());
    const assertion = expect(pending).rejects.toHaveProperty('code', 'timeout');
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(cancel).toHaveBeenCalled();
  });
});

const tokenConfig = { tenantId: '11111111-1111-1111-1111-111111111111', clientId: '22222222-2222-2222-2222-222222222222', certificateFile: '/run/secrets/app.pem', cloud: 'public', baseUrl: 'https://graph.microsoft.com/v1.0' };
const clock = { wallMs: () => 100000, monoMs: () => 1000 };
const ctx = () => ({ signal: new AbortController().signal, deadlineMonoMs: 4000 });
const token = { token: 'synthetic-token', expiresOnTimestamp: 400000 };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('certificate Graph token source', () => {
  it('constructs only an explicit certificate credential with fixed tenant, authority and scope', async () => {
    const getToken = vi.fn<TokenCredential['getToken']>().mockResolvedValue(token);
    const factory = vi.fn(() => ({ getToken }));
    const source = createGraphTokenSource(tokenConfig, clock, factory);
    expect(await source.getToken(ctx())).toBe('synthetic-token');
    expect(factory).toHaveBeenCalledWith(tokenConfig.tenantId, tokenConfig.clientId, { certificatePath: '/run/secrets/app.pem' }, expect.objectContaining({ authorityHost: 'https://login.microsoftonline.com', disableInstanceDiscovery: true, retryOptions: { maxRetries: 0 } }));
    expect(getToken).toHaveBeenCalledWith('https://graph.microsoft.com/.default', expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    expect(await source.getToken(ctx())).toBe('synthetic-token');
    expect(getToken).toHaveBeenCalledTimes(1);
  });
  it.each([{ tenantId: 'common' }, { tenantId: 'evil/path' }, { clientId: '' }, { certificateFile: 'relative.pem' }, { cloud: 'china' }, { baseUrl: 'https://evil.test' }])('rejects token config %j before credential creation', override => {
    const factory = vi.fn();
    expect(() => createGraphTokenSource({ ...tokenConfig, ...override }, clock, factory)).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
  it.each([null, { token: '', expiresOnTimestamp: 400000 }, { token: 'secret\r\n', expiresOnTimestamp: 400000 }, { token: 'secret', expiresOnTimestamp: 100000 }, { token: 'secret', expiresOnTimestamp: 159999 }, { token: 'secret', expiresOnTimestamp: Infinity }])('fails closed for invalid or stale token', async value => {
    const source = createGraphTokenSource(tokenConfig, clock, () => ({ getToken: async () => value as AccessToken }));
    await expect(source.getToken(ctx())).rejects.toMatchObject({ code: 'token-unavailable', message: 'Graph token unavailable' });
  });
  it('coalesces refresh and keeps cancellation isolated between subscribers', async () => {
    const pending = deferred<AccessToken>();
    const getToken = vi.fn<TokenCredential['getToken']>().mockReturnValue(pending.promise);
    const source = createGraphTokenSource(tokenConfig, clock, () => ({ getToken }));
    const abort = new AbortController();
    const first = source.getToken({ ...ctx(), signal: abort.signal });
    const second = source.getToken(ctx());
    abort.abort('secret');
    await expect(first).rejects.toHaveProperty('code', 'timeout');
    expect(getToken.mock.calls[0]?.[1]?.abortSignal?.aborted).toBe(false);
    pending.resolve(token);
    expect(await second).toBe('synthetic-token');
    expect(getToken).toHaveBeenCalledTimes(1);
  });
  it('clears failed refresh without retries or leaking credential errors', async () => {
    const getToken = vi.fn<TokenCredential['getToken']>().mockRejectedValueOnce(new Error('SECRET')).mockResolvedValue(token);
    const source = createGraphTokenSource(tokenConfig, clock, () => ({ getToken }));
    await expect(source.getToken(ctx())).rejects.toMatchObject({ code: 'token-unavailable', message: 'Graph token unavailable' });
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(await source.getToken(ctx())).toBe('synthetic-token');
  });
  it('sanitizes certificate constructor errors and oversized token values', async () => {
    await expect(createGraphTokenSource(tokenConfig, clock, () => { throw new Error('PRIVATE KEY'); }).getToken(ctx())).rejects.toThrow('Graph token unavailable');
    const source = createGraphTokenSource(tokenConfig, clock, () => ({ getToken: async () => ({ ...token, token: 'a'.repeat(32769) }) }));
    await expect(source.getToken(ctx())).rejects.toHaveProperty('code', 'token-unavailable');
  });
  it('refreshes at the conservative wall-clock boundary', async () => {
    let wall = 100000;
    const getToken = vi.fn<TokenCredential['getToken']>().mockResolvedValueOnce(token).mockResolvedValue({ token: 'replacement', expiresOnTimestamp: 700000 });
    const source = createGraphTokenSource(tokenConfig, { wallMs: () => wall, monoMs: () => 1000 }, () => ({ getToken }));
    expect(await source.getToken(ctx())).toBe('synthetic-token');
    wall = 340000;
    expect(await source.getToken(ctx())).toBe('replacement');
    expect(getToken).toHaveBeenCalledTimes(2);
  });
  it('expires cache using monotonic time even when wall time goes backwards', async () => {
    let mono = 1000;
    const getToken = vi.fn<TokenCredential['getToken']>().mockResolvedValueOnce(token).mockRejectedValue(new Error('secret'));
    const source = createGraphTokenSource(tokenConfig, { wallMs: () => 100000, monoMs: () => mono }, () => ({ getToken }));
    await source.getToken(ctx());
    mono = 241000;
    await expect(source.getToken({ ...ctx(), deadlineMonoMs: 244000 })).rejects.toHaveProperty('code', 'token-unavailable');
    expect(getToken).toHaveBeenCalledTimes(2);
  });
  it('bounds refresh and per-caller deadlines even for a stalled credential', async () => {
    vi.useFakeTimers();
    const getToken = vi.fn<TokenCredential['getToken']>().mockImplementation(() => new Promise(() => {}));
    const source = createGraphTokenSource(tokenConfig, clock, () => ({ getToken }));
    const first = source.getToken({ ...ctx(), deadlineMonoMs: 1010 });
    const second = source.getToken({ ...ctx(), deadlineMonoMs: 10000 });
    const a = expect(first).rejects.toHaveProperty('code', 'timeout');
    await vi.advanceTimersByTimeAsync(10);
    await a;
    expect(getToken.mock.calls[0]?.[1]?.abortSignal?.aborted).toBe(false);
    const b = expect(second).rejects.toHaveProperty('code', 'timeout');
    await vi.advanceTimersByTimeAsync(2990);
    await b;
    expect(getToken.mock.calls[0]?.[1]?.abortSignal?.aborted).toBe(true);
  });
  it('does not begin work for aborted or expired callers and cancels abandoned refresh', async () => {
    const getToken = vi.fn<TokenCredential['getToken']>().mockImplementation(() => new Promise(() => {}));
    const source = createGraphTokenSource(tokenConfig, clock, () => ({ getToken }));
    await expect(source.getToken({ ...ctx(), deadlineMonoMs: 1000 })).rejects.toHaveProperty('code', 'timeout');
    const abort = new AbortController();
    const pending = source.getToken({ ...ctx(), signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toHaveProperty('code', 'timeout');
    expect(getToken.mock.calls[0]?.[1]?.abortSignal?.aborted).toBe(true);
    await expect(source.getToken({ ...ctx(), signal: abort.signal })).rejects.toHaveProperty('code', 'timeout');
    expect(getToken).toHaveBeenCalledTimes(1);
  });
});

// Real pinned SDK certificate/MSAL/pipeline; only the network and ephemeral key are synthetic.
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
const certificate = `${key}\n-----BEGIN CERTIFICATE-----\nZmFrZS1wdWJsaWMtY2VydA==\n-----END CERTIFICATE-----\n`;
const tokenUrl = `https://login.microsoftonline.com/${tokenConfig.tenantId}/oauth2/v2.0/token`;
const sdkResponse = () => json(JSON.stringify({ token_type: 'Bearer', access_token: 'synthetic-sdk-token', expires_in: 3600 }));
const sdkClock = { wallMs: () => Date.now(), monoMs: () => 1000 };
function realSdkSource(fetcher: typeof fetch, rewriteUrl?: string) {
  return createGraphTokenSource(tokenConfig, sdkClock, (tenant, client, _path, options) => {
    // Before the fix this models the SDK's unbounded default HTTP boundary. After the
    // fix the production httpClient is used unchanged, through the real SDK pipeline.
    const fallback: NonNullable<ClientCertificateCredentialOptions['httpClient']> = { async sendRequest(request) {
      const response = await fetcher(request.url, { method: request.method, body: request.body as string, signal: request.abortSignal as AbortSignal });
      for (const [name] of request.headers) request.headers.delete(name);
      for (const [name, value] of response.headers) request.headers.set(name, value);
      return { request, status: response.status, headers: request.headers, bodyAsText: await response.text() };
    } };
    const httpClient = options.httpClient ?? fallback;
    return new ClientCertificateCredential(tenant, client, { certificate }, { ...options,
      httpClient: rewriteUrl ? { sendRequest: request => httpClient.sendRequest({ ...request, url: rewriteUrl }) } : httpClient,
    });
  }, fetcher);
}

describe('real certificate SDK HTTP boundary', () => {
  it.each([
    'https://login.microsoftonline.com/unapproved-path',
    'https://evil.test/oauth2/v2.0/token',
    tokenUrl.replace(tokenConfig.tenantId, 'common'),
    `${tokenUrl}?unexpected=true`, `${tokenUrl}/../token`, `${tokenUrl}#fragment`,
  ])('rejects unapproved SDK destinations before network activity: %s', async rewriteUrl => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => sdkResponse());
    await expect(realSdkSource(fetcher, rewriteUrl).getToken(ctx())).rejects.toHaveProperty('code', 'token-unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('actually aborts the SDK network operation on shared refresh timeout', async () => {
    vi.useFakeTimers();
    const entered = deferred<AbortSignal>();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      entered.resolve(init!.signal as AbortSignal);
      return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });
    const result = realSdkSource(fetcher).getToken({ ...ctx(), deadlineMonoMs: 10000 }).catch(error => error);
    const signal = await entered.promise;
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toHaveProperty('code', 'timeout');
    expect(signal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not follow a same-origin token redirect in the SDK pipeline', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: 'https://login.microsoftonline.com/unapproved-path' } })).mockImplementation(async () => sdkResponse());
    await expect(realSdkSource(fetcher).getToken(ctx())).rejects.toHaveProperty('code', 'token-unavailable');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('cancels a stalled SDK response body on timeout', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const entered = deferred<AbortSignal>();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      entered.resolve(init!.signal as AbortSignal);
      return new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } });
    });
    const result = realSdkSource(fetcher).getToken({ ...ctx(), deadlineMonoMs: 10000 }).catch(error => error);
    const signal = await entered.promise;
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toHaveProperty('code', 'timeout');
    expect(signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('isolates SDK HTTP cancellation between subscribers', async () => {
    const entered = deferred<AbortSignal>();
    const response = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => { entered.resolve(init!.signal as AbortSignal); return response.promise; });
    const source = realSdkSource(fetcher);
    const abort = new AbortController();
    const first = source.getToken({ ...ctx(), signal: abort.signal }).catch(error => error);
    const second = source.getToken(ctx());
    const signal = await entered.promise;
    abort.abort();
    expect(await first).toHaveProperty('code', 'timeout');
    expect(signal.aborted).toBe(false);
    response.resolve(sdkResponse());
    expect(await second).toBe('synthetic-sdk-token');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not allow delayed abandoned SDK work to use a later refresh signal', async () => {
    const resume = deferred<void>();
    let delayed: Promise<AccessToken | null> | undefined;
    let count = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => sdkResponse());
    const source = createGraphTokenSource(tokenConfig, sdkClock, (tenant, client, _path, options) => {
      const credential = new ClientCertificateCredential(tenant, client, { certificate }, options);
      if (++count !== 1) return credential;
      return { getToken: (scopes, tokenOptions) => delayed = resume.promise.then(() => credential.getToken(scopes, tokenOptions)) };
    }, fetcher);
    const abort = new AbortController();
    const first = source.getToken({ ...ctx(), signal: abort.signal }).catch(error => error);
    abort.abort();
    expect(await first).toHaveProperty('code', 'timeout');
    expect(await source.getToken(ctx())).toBe('synthetic-sdk-token');
    resume.resolve();
    expect((await Promise.allSettled([delayed]))[0]?.status).toBe('rejected');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds the SDK response stream and cancels an oversize body', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4194305)); c.enqueue(new Uint8Array([0])); c.close(); }, cancel }), { headers: { 'content-type': 'application/json' } }));
    await expect(realSdkSource(fetcher).getToken(ctx())).rejects.toHaveProperty('code', 'token-unavailable');
    expect(cancel).toHaveBeenCalled();
  });
  it('retains the real certificate SDK flow for the exact token endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => sdkResponse());
    expect(await realSdkSource(fetcher).getToken(ctx())).toBe('synthetic-sdk-token');
    expect(fetcher).toHaveBeenCalledWith(tokenUrl, expect.objectContaining({ method: 'POST', redirect: 'error' }));
    const body = fetcher.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe('string');
    const params = new URLSearchParams(body as string);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('scope')).toBe('https://graph.microsoft.com/.default');
    expect(params.get('client_assertion')?.split('.')).toHaveLength(3);
  });
});

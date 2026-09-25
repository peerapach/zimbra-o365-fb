import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallContext, HttpResponse, HttpTransport, Target, WindowUtc } from '../../src/core/types.js';
import { createGraphProvider } from '../../src/providers/graph.js';
import { createZimbraProvider } from '../../src/providers/zimbra.js';
import { createZimbraSession } from '../../src/providers/zimbra-auth.js';
import { createOutboundTransport, TransportError } from '../../src/http/outbound.js';
import { createFreeBusyService } from '../../src/freebusy/service.js';
import { loadDirectory } from '../../src/directory/load.js';

const target: Target = { entryId: 'alice', provider: 'graph', canonicalSmtp: 'alice@tenant.example.invalid' };
const ztarget: Target = { entryId: 'bob', provider: 'zimbra', canonicalSmtp: 'bob@example.invalid' };
const window: WindowUtc = { startMs: 1789351200000, endMs: 1789365600000, intervalMinutes: 30 };
const soapUrl = 'https://mail.example.invalid/service/soap';
const graphBody = readFileSync('fixtures/graph/success.json');
const zimbraBody = readFileSync('fixtures/zimbra/success.xml');
const http = (status = 200, headers: Record<string, string> = {}, body = status === 200 ? graphBody
  : Buffer.from(JSON.stringify({ error: { code: status === 429 ? 'TooManyRequests' : 'serviceNotAvailable', message: 'Synthetic transient' } }))): HttpResponse =>
  ({ status, headers: { 'content-type': 'application/json', ...headers }, body });
const soap = (body: string, status = 200): HttpResponse => http(status, { 'content-type': 'text/xml' }, Buffer.from(body));
const envelope = (body: string) => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${body}</s:Body></s:Envelope>`;
const expired = soap(envelope('<s:Fault><faultcode>s:Client</faultcode><faultstring>SECRET</faultstring><detail><Error xmlns="urn:zimbra"><Code>service.AUTH_EXPIRED</Code></Error></detail></s:Fault>'));
const auth = soap(envelope('<AuthResponse xmlns="urn:zimbraAccount"><authToken>synthetic-token</authToken><lifetime>3600000</lifetime></AuthResponse>'));
function setup() {
  let epoch = 1_000_000;
  const clock = { monoMs: () => epoch + Date.now(), wallMs: () => 1789351200000 + Date.now() };
  const request = vi.fn<HttpTransport['request']>().mockResolvedValue(http());
  const getToken = vi.fn(async () => 'synthetic-token');
  const provider = createGraphProvider({ transport: { request }, tokenSource: { getToken }, wallMs: clock.wallMs, monoMs: clock.monoMs });
  return { provider, request, getToken, clock, setMono: (n: number) => { epoch = n - Date.now(); },
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    ctx: (duration = 7750, signal = new AbortController().signal): CallContext => ({ signal, deadlineMonoMs: clock.monoMs() + duration }) };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(0); });
afterEach(() => vi.useRealTimers());

describe('W22 provider-owned availability retry budget', () => {
  it.each([429, 502, 503, 504])('retries one transient HTTP %s availability read and returns real normalized success', async status => {
    const app = setup(); app.request.mockResolvedValueOnce(http(status));
    const pending = app.provider.lookup(target, window, app.ctx());
    await app.advance(100);
    expect(await pending).toMatchObject({ kind: 'ok', targetId: 'alice' });
    expect(app.request).toHaveBeenCalledTimes(2);
    expect(app.getToken).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops after the single extra attempt even when the provider keeps failing', async () => {
    const app = setup(); app.request.mockResolvedValue(http(503));
    const pending = app.provider.lookup(target, window, app.ctx()); await app.advance(100);
    expect(await pending).toMatchObject({ kind: 'error', reason: 'backend-unavailable' });
    expect(app.request).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 401, 403, 404, 408, 500, 501])('does not generically retry HTTP %s', async status => {
    const app = setup(); app.request.mockResolvedValue(http(status));
    expect(await app.provider.lookup(target, window, app.ctx())).toMatchObject({ kind: 'error' });
    expect(app.request).toHaveBeenCalledTimes(1);
  });

  it.each(['2', 'Mon, 14 Sep 2026 02:00:02 GMT'])('honors Retry-After %s without early retry', async retryAfter => {
    const app = setup(); app.request.mockResolvedValueOnce(http(429, { 'retry-after': retryAfter }));
    const pending = app.provider.lookup(target, window, app.ctx()); await app.advance(0);
    await app.advance(1999); expect(app.request).toHaveBeenCalledTimes(1);
    await app.advance(1); expect(await pending).toMatchObject({ kind: 'ok' });
    expect(app.request).toHaveBeenCalledTimes(2);
  });

  it.each(['8', '99999999999999999999', '-1', '1.2', 'nonsense', 'Mon, 14 Sep 2026 02:00:08 GMT', '2, 3'])
    ('refuses unfulfillable or malformed Retry-After %s instead of retrying early', async retryAfter => {
      const app = setup(); app.request.mockResolvedValue(http(429, { 'retry-after': retryAfter }));
      expect(await app.provider.lookup(target, window, app.ctx())).toMatchObject({ kind: 'error', reason: 'throttled' });
      expect(app.request).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    });

  it('counts token acquisition and queued elapsed time against the original deadline', async () => {
    const app = setup(); const ctx = app.ctx(1000);
    app.getToken.mockImplementation(async () => { app.setMono(ctx.deadlineMonoMs - 50); return 'synthetic-token'; });
    app.request.mockResolvedValue(http(503));
    expect(await app.provider.lookup(target, window, ctx)).toMatchObject({ kind: 'error' });
    expect(app.request).toHaveBeenCalledTimes(1);
    app.setMono(ctx.deadlineMonoMs);
    expect(await app.provider.lookup(target, window, ctx)).toMatchObject({ kind: 'error', reason: 'timeout' });
    expect(app.request).toHaveBeenCalledTimes(1);
  });

  it('does not begin availability HTTP after token acquisition exhausts the budget', async () => {
    const app = setup(); const ctx = app.ctx();
    app.getToken.mockImplementation(async () => { app.setMono(ctx.deadlineMonoMs); return 'synthetic-token'; });
    expect(await app.provider.lookup(target, window, ctx)).toMatchObject({ reason: 'timeout' });
    expect(app.request).not.toHaveBeenCalled();
  });

  it('caps an uncooperative availability attempt at three seconds and aborts its signal', async () => {
    const app = setup(); app.request.mockImplementation(() => new Promise(() => {}));
    const pending = app.provider.lookup(target, window, app.ctx()); await app.advance(0); await app.advance(3000);
    expect(await pending).toMatchObject({ reason: 'timeout' });
    expect(app.request.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(app.request).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('caps body reading at the smaller remaining caller budget', async () => {
    const app = setup(); const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ pull() {} }),
      { headers: { 'content-type': 'application/json' } }));
    const transport = createOutboundTransport({ graphTargets: [target.canonicalSmtp], timeoutMs: 3000, maxResponseBytes: 4194304 }, fetcher);
    const provider = createGraphProvider({ transport, tokenSource: { getToken: app.getToken }, wallMs: app.clock.wallMs, monoMs: app.clock.monoMs });
    const pending = provider.lookup(target, window, app.ctx(50)); await app.advance(0); await app.advance(50);
    expect(await pending).toMatchObject({ reason: 'timeout' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels retry sleep without performing another request or retaining timers', async () => {
    const app = setup(); const controller = new AbortController(); app.request.mockResolvedValue(http(429, { 'retry-after': '2' }));
    const pending = app.provider.lookup(target, window, app.ctx(7750, controller.signal)); await app.advance(0);
    controller.abort(); expect(await pending).toMatchObject({ reason: 'timeout' });
    expect(app.request).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects completion after the monotonic deadline even if its timer has not run', async () => {
    const app = setup(); const ctx = app.ctx(50);
    app.request.mockImplementation(async () => { app.setMono(ctx.deadlineMonoMs); return http(); });
    expect(await app.provider.lookup(target, window, ctx)).toMatchObject({ reason: 'timeout' });
  });

  it.each([new TransportError('invalid-response'), new TransportError('destination'), new Error('SECRET'),
    new TransportError('timeout')])('does not retry malformed/unsafe/unknown transport failures %#', async failure => {
    const app = setup(); app.request.mockRejectedValue(failure);
    const result = await app.provider.lookup(target, window, app.ctx());
    expect(result.kind).toBe('error'); expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(app.request).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null])('rejects absent runtime transport result %# without entering a retry loop', async response => {
    const app = setup(); const controller = new AbortController();
    app.request.mockResolvedValue(response as unknown as HttpResponse);
    const pending = app.provider.lookup(target, window, app.ctx(7750, controller.signal));
    await app.advance(200); controller.abort();
    expect(await pending).toMatchObject({ reason: 'invalid-response' });
    expect(app.request).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['ECONNRESET', 'EAI_AGAIN'])('retries only classified safe transient network cause %s', async code => {
    const app = setup(); const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('SECRET', { cause: { code } }))
      .mockResolvedValue(new Response(graphBody, { headers: { 'content-type': 'application/json' } }));
    const transport = createOutboundTransport({ graphTargets: [target.canonicalSmtp], timeoutMs: 3000, maxResponseBytes: 4194304 }, fetcher);
    const provider = createGraphProvider({ transport, tokenSource: { getToken: app.getToken }, wallMs: app.clock.wallMs, monoMs: app.clock.monoMs });
    const pending = provider.lookup(target, window, app.ctx()); await app.advance(100);
    expect(await pending).toMatchObject({ kind: 'ok' }); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry TLS certificate failures or malformed successful provider content', async () => {
    const app = setup(); const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('SECRET', { cause: { code: 'CERT_HAS_EXPIRED' } }));
    const transport = createOutboundTransport({ graphTargets: [target.canonicalSmtp], timeoutMs: 3000, maxResponseBytes: 4194304 }, fetcher);
    const provider = createGraphProvider({ transport, tokenSource: { getToken: app.getToken }, wallMs: app.clock.wallMs, monoMs: app.clock.monoMs });
    expect((await provider.lookup(target, window, app.ctx())).kind).toBe('error'); expect(fetcher).toHaveBeenCalledTimes(1);
    app.request.mockResolvedValue(http(200, {}, Buffer.from('{bad')));
    expect(await app.provider.lookup(target, window, app.ctx())).toMatchObject({ reason: 'invalid-response' });
    expect(app.request).toHaveBeenCalledTimes(1);
  });

  it.each(['transient-first', 'expiry-first'])('shares one transient allowance across verified Zimbra expiry: %s', async ordering => {
    const app = setup(); const authentication = vi.fn<HttpTransport['request']>().mockResolvedValue(auth);
    const session = createZimbraSession({ soapUrl, account: 'service@example.invalid', passwordFile: '/run/secrets/password' },
      { request: authentication }, app.clock, async () => 'synthetic-password');
    const request = vi.fn<HttpTransport['request']>()
      .mockResolvedValueOnce(ordering === 'transient-first' ? soap(zimbraBody.toString(), 503) : expired)
      .mockResolvedValueOnce(ordering === 'transient-first' ? expired : soap(zimbraBody.toString(), 503))
      .mockResolvedValueOnce(soap(zimbraBody.toString(), 503)).mockResolvedValue(soap(zimbraBody.toString()));
    const provider = createZimbraProvider({ soapUrl, session, transport: { request }, clock: app.clock, approvedTargets: [ztarget] });
    const pending = provider.lookup(ztarget, window, app.ctx()); await app.advance(100);
    expect(await pending).toMatchObject({ reason: 'backend-unavailable' });
    expect(request).toHaveBeenCalledTimes(3); expect(authentication).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never generically retries Zimbra authentication HTTP failures', async () => {
    const app = setup(); const authentication = vi.fn<HttpTransport['request']>().mockResolvedValue(soap('', 503));
    const session = createZimbraSession({ soapUrl, account: 'service@example.invalid', passwordFile: '/run/secrets/password' },
      { request: authentication }, app.clock, async () => 'synthetic-password');
    const provider = createZimbraProvider({ soapUrl, session, transport: { request: app.request }, clock: app.clock, approvedTargets: [ztarget] });
    expect((await provider.lookup(ztarget, window, app.ctx())).kind).toBe('error');
    expect(authentication).toHaveBeenCalledTimes(1); expect(app.request).not.toHaveBeenCalled();
  });

  it('leaves a SOAP auth-expiry fault on HTTP 503 to verified renewal instead of generic retry', async () => {
    const app = setup(); const authentication = vi.fn<HttpTransport['request']>().mockResolvedValue(auth);
    const session = createZimbraSession({ soapUrl, account: 'service@example.invalid', passwordFile: '/run/secrets/password' },
      { request: authentication }, app.clock, async () => 'synthetic-password');
    const request = vi.fn<HttpTransport['request']>().mockResolvedValueOnce({ ...expired, status: 503 }).mockResolvedValue(soap(zimbraBody.toString()));
    const provider = createZimbraProvider({ soapUrl, session, transport: { request }, clock: app.clock, approvedTargets: [ztarget] });
    const pending = provider.lookup(ztarget, window, app.ctx()); await app.advance(100);
    expect(await pending).toMatchObject({ kind: 'ok' });
    expect(authentication).toHaveBeenCalledTimes(2); expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not generically retry nonempty malformed Zimbra XML on HTTP 503', async () => {
    const app = setup(); const authentication = vi.fn<HttpTransport['request']>().mockResolvedValue(auth);
    const session = createZimbraSession({ soapUrl, account: 'service@example.invalid', passwordFile: '/run/secrets/password' },
      { request: authentication }, app.clock, async () => 'synthetic-password');
    const request = vi.fn<HttpTransport['request']>().mockResolvedValue(soap('<', 503));
    const provider = createZimbraProvider({ soapUrl, session, transport: { request }, clock: app.clock, approvedTargets: [ztarget] });
    const pending = provider.lookup(ztarget, window, app.ctx()); await app.advance(100);
    expect(await pending).toMatchObject({ reason: 'invalid-response' }); expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['{bad', '{"error":{"code":"5006"}}', '{"error":{"code":"InvalidAuthenticationToken"}}'])
    ('does not hide malformed/overflow/auth details in transient Graph payload %s', async body => {
      const app = setup(); app.request.mockResolvedValue(http(503, {}, Buffer.from(body)));
      const pending = app.provider.lookup(target, window, app.ctx()); await app.advance(100);
      expect((await pending).kind).toBe('error'); expect(app.request).toHaveBeenCalledTimes(1);
    });

  it.each(['ErrorInvalidRequest', 'ErrorItemNotFound', 'Forbidden', { nested: 'serviceNotAvailable' }, 'UnknownError'])
    ('does not retry nontransient or malformed Graph error code %j', async code => {
      const app = setup();
      app.request.mockResolvedValue(http(503, {}, Buffer.from(JSON.stringify({ error: { code, message: 'Synthetic error' } }))));
      const pending = app.provider.lookup(target, window, app.ctx()); await app.advance(100);
      expect((await pending).kind).toBe('error'); expect(app.request).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

  it.each([{}, { value: [] }, { error: null }, { error: [] },
    { error: { code: 'serviceNotAvailable' } }, { error: { code: 'serviceNotAvailable', message: {} } },
    { error: { code: 'serviceNotAvailable', message: '', innerError: { code: 'Forbidden' } } },
    { error: { code: 'serviceNotAvailable', message: '', innerError: [] } },
    { error: { code: 'serviceNotAvailable', message: '', details: [{ code: 'Forbidden' }] } },
    { error: { code: 'serviceNotAvailable', message: '' }, value: [] }])
    ('rejects unsupported or malformed Graph error envelopes %#', async body => {
      const app = setup(); app.request.mockResolvedValue(http(503, {}, Buffer.from(JSON.stringify(body))));
      const pending = app.provider.lookup(target, window, app.ctx()); await app.advance(100);
      expect((await pending).kind).toBe('error'); expect(app.request).toHaveBeenCalledTimes(1);
    });

  it('accepts documented throttling metadata without using diagnostic message text', async () => {
    const app = setup(); app.request.mockResolvedValueOnce(http(429, { 'retry-after': '1' }, Buffer.from(JSON.stringify({
      error: { code: 'TooManyRequests', message: 'Opaque diagnostic', innerError: { code: '429', 'request-id': 'synthetic' } },
    }))));
    const pending = app.provider.lookup(target, window, app.ctx()); await app.advance(999);
    expect(app.request).toHaveBeenCalledTimes(1); await app.advance(1);
    expect((await pending).kind).toBe('ok'); expect(app.request).toHaveBeenCalledTimes(2);
  });

  it('retries an empty transient load-balancer response without requiring a JSON content type', async () => {
    const app = setup(); const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(graphBody, { headers: { 'content-type': 'application/json' } }));
    const transport = createOutboundTransport({ graphTargets: [target.canonicalSmtp], timeoutMs: 3000, maxResponseBytes: 4194304 }, fetcher);
    const provider = createGraphProvider({ transport, tokenSource: { getToken: app.getToken }, wallMs: app.clock.wallMs, monoMs: app.clock.monoMs });
    const pending = provider.lookup(target, window, app.ctx()); await app.advance(100);
    expect(await pending).toMatchObject({ kind: 'ok' }); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retains another target success when one target times out within the response-reserved service budget', async () => {
    const app = setup();
    const principal = { id: 'p', username: 'p', surface: 'zimbra-inbound' as const, allowedProvider: 'graph' as const };
    const directory = loadDirectory({ schemaVersion: 1, entries: ['alice', 'slow'].map(id => ({ id, provider: 'graph',
      canonicalSmtp: `${id}@tenant.example.invalid`, aliases: [], enabled: true, allowedPrincipals: ['p'] })) }, [principal], 'retry-test');
    app.request.mockImplementation(input => input.url.includes('slow') ? new Promise(() => {}) : Promise.resolve(http()));
    const service = createFreeBusyService(directory, { graph: app.provider, zimbra: { kind: 'zimbra', lookup: async () => { throw new Error(); } } },
      { monoMs: app.clock.monoMs });
    const pending = service(principal, 'zimbra-inbound', ['alice@tenant.example.invalid', 'slow@tenant.example.invalid', 'alice@tenant.example.invalid'], window, app.ctx());
    await app.advance(0); await app.advance(3000);
    expect((await pending).map(result => result.kind)).toEqual(['ok', 'error', 'ok']);
    expect(app.clock.monoMs()).toBeLessThan(1_000_000 + 8000 - 250);
    expect(vi.getTimerCount()).toBe(0);
  });
});

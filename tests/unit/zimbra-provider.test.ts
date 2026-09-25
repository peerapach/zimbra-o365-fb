import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallContext, HttpResponse, HttpTransport, Target, WindowUtc } from '../../src/core/types.js';
import { normalizeZimbra } from '../../src/providers/zimbra-map.js';
import { createZimbraProvider } from '../../src/providers/zimbra.js';
import { createZimbraSession } from '../../src/providers/zimbra-auth.js';
import { parseXmlBounded } from '../../src/xml/parse.js';
import { requiredChild } from '../../src/xml/select.js';

const success = readFileSync(new URL('../../fixtures/zimbra/success.xml', import.meta.url), 'utf8');
const noData = readFileSync(new URL('../../fixtures/zimbra/no-data.xml', import.meta.url), 'utf8');
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const MAIL = 'urn:zimbraMail';
const config = { soapUrl: 'https://mail.example.invalid/service/soap', account: 'service@example.invalid', passwordFile: '/run/secrets/zimbra-password' };
const base = 1789351200000;
const minute = 60000;
const window: WindowUtc = { startMs: base, endMs: base + 240 * minute, intervalMinutes: 30 };
const target: Target = { entryId: 'bob-entry', provider: 'zimbra', canonicalSmtp: 'bob@example.invalid' };
const nowMs = 1790000000000;
const normalize = (xml: string) => normalizeZimbra(parseXmlBounded(Buffer.from(xml)), target, window, nowMs);
const span = (startMs: number, endMs: number, status: string) => ({ startMs, endMs, status });
const wrap = (body: string) => `<s:Envelope xmlns:s="${SOAP}"><s:Body>${body}</s:Body></s:Envelope>`;
const user = (intervals: string, attributes = '') => wrap(`<GetFreeBusyResponse xmlns="${MAIL}"><usr id="bob@example.invalid" ${attributes}>${intervals}</usr></GetFreeBusyResponse>`);
const auth = (token = 'TOKEN-canary') => wrap(`<AuthResponse xmlns="urn:zimbraAccount"><authToken>${token}</authToken><lifetime>3600000</lifetime></AuthResponse>`);
const fault = (code: string) => wrap(`<s:Fault><faultcode>s:Client</faultcode><faultstring>SECRET-detail</faultstring><detail><Error xmlns="urn:zimbra"><Code>${code}</Code></Error></detail></s:Fault>`);
const response = (xml: string, status = 200): HttpResponse => ({ status, headers: { 'content-type': 'text/xml; charset=utf-8' }, body: Buffer.from(xml) });
const context = (signal = new AbortController().signal, deadlineMonoMs = 4000): CallContext => ({ signal, deadlineMonoMs });
function harness(xml = success, approvedTargets: readonly Target[] = [target]) {
  let mono = 0;
  const clock = { wallMs: () => nowMs, monoMs: () => mono };
  const request = vi.fn<HttpTransport['request']>().mockResolvedValue(response(xml));
  const authRequest = vi.fn<HttpTransport['request']>().mockResolvedValue(response(auth()));
  const session = createZimbraSession(config, { request: authRequest }, clock, async () => 'PASSWORD-canary');
  const options = { soapUrl: config.soapUrl, approvedTargets, session, transport: { request }, clock };
  return { provider: createZimbraProvider(options), request, authRequest, options, advance: (ms: number) => { mono += ms; } };
}
afterEach(() => vi.useRealTimers());

describe('Zimbra fixture candidate normalization', () => {
  it('maps explicit f/b/t/u spans including wire u as OOF', () => {
    expect(normalize(success)).toEqual({ kind: 'ok', targetId: 'bob-entry', coverage: window, observedAtMs: nowMs,
      slots: [span(base, base + 30 * minute, 'free'), span(base + 30 * minute, base + 60 * minute, 'busy'),
        span(base + 60 * minute, base + 90 * minute, 'tentative'), span(base + 90 * minute, base + 150 * minute, 'oof'),
        span(base + 150 * minute, base + 240 * minute, 'free')],
    });
  });

  it.each([['no-data', noData], ['empty user', user('')]])('keeps %s unknown without live A05 proof', (_label, xml) => {
    expect(normalize(xml)).toMatchObject({ kind: 'ok', slots: [span(base, window.endMs, 'unknown')] });
  });

  it('keeps gaps and overlapping no-data unknown while retaining explicit busy/free spans', () => {
    const xml = user(`<b s="${base + 30 * minute}" e="${base + 60 * minute}"/><f s="${base + 60 * minute}" e="${window.endMs}"/><n s="${base + 90 * minute}" e="${base + 150 * minute}"/>`);
    expect(normalize(xml)).toMatchObject({ kind: 'ok', slots: [span(base, base + 30 * minute, 'unknown'),
      span(base + 30 * minute, base + 60 * minute, 'busy'), span(base + 60 * minute, base + 90 * minute, 'free'),
      span(base + 90 * minute, base + 150 * minute, 'unknown'), span(base + 150 * minute, window.endMs, 'free')] });
  });

  it('accepts explicit full free coverage and drops detail attributes', () => {
    expect(normalize(user(`<f s="${base}" e="${window.endMs}" subject="SECRET-subject" location="SECRET-location" eventId="SECRET-event"/>`)))
      .toEqual({ kind: 'ok', targetId: target.entryId, coverage: window, observedAtMs: nowMs, slots: [span(base, window.endMs, 'free')] });
  });

  it.each(['false', '0'])('rejects denied permission %s even with explicit free intervals', permission => {
    expect(normalize(user(`<f s="${base}" e="${window.endMs}"/>`, `hasPermission="${permission}"`)))
      .toMatchObject({ kind: 'error', reason: 'not-authorized' });
  });

  it.each([
    ['missing user', wrap(`<GetFreeBusyResponse xmlns="${MAIL}"/>`)],
    ['duplicate user', success.replace('</usr>', '</usr><usr id="bob@example.invalid"/>')],
    ['unrelated user', success.replace('bob@example.invalid', 'other@example.invalid')],
    ['wrong namespace', success.replace(MAIL, 'urn:forged')],
    ['forged interval', user(`<f xmlns="urn:forged" s="${base}" e="${window.endMs}"/>`)],
    ['unknown wire tag', user(`<o s="${base}" e="${window.endMs}"/>`)],
    ['unrelated child', user('<details/>')],
    ['mixed text', user('SECRET-text')],
    ['nested interval', user(`<f s="${base}" e="${window.endMs}"><detail/></f>`)],
    ['missing start', user(`<f e="${window.endMs}"/>`)],
    ['bad number', user(`<f s="1e12" e="${window.endMs}"/>`)],
    ['unsafe number', user(`<f s="9007199254740992" e="${window.endMs}"/>`)],
    ['zero interval', user(`<f s="${base}" e="${base}"/>`)],
    ['reversed interval', user(`<f s="${window.endMs}" e="${base}"/>`)],
    ['out of window', user(`<f s="${base - 1}" e="${window.endMs}"/>`)],
    ['forged attribute', user(`<f xmlns:x="urn:forged" x:s="${base}" e="${window.endMs}"/>`)],
    ['unknown permission', user('', 'hasPermission="maybe"')],
    ['forged permission', user('', 'xmlns:x="urn:forged" x:hasPermission="false"')],
    ['duplicate Body', success.replace('</soap:Envelope>', '<soap:Body/></soap:Envelope>')],
    ['extra body response', success.replace('</soap:Body>', '<extra/></soap:Body>')],
    ['required header', success.replace('<soap:Body>', '<soap:Header><x xmlns="urn:foreign" soap:mustUnderstand="1"/></soap:Header><soap:Body>')],
  ])('fails closed on %s', (_label, xml) => {
    expect(normalize(xml)).toEqual({ kind: 'error', targetId: target.entryId, reason: 'invalid-response' });
  });

  it('uses namespace identities independently of prefixes', () => {
    expect(normalize(success.replaceAll('soap:', 'alternate:').replace('xmlns:soap', 'xmlns:alternate'))).toEqual(normalize(success));
  });

  it('returns a typed failure for SOAP Fault and sanitizes its text', () => {
    const result = normalize(fault('service.PERM_DENIED'));
    expect(result.kind).toBe('error');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});

describe('Zimbra fixed local-user SOAP provider', () => {
  it('sends one GetFreeBusy POST with the token only in SOAP context', async () => {
    const { provider, request, authRequest } = harness();
    expect(await provider.lookup(target, window, context())).toEqual(normalize(success));
    expect(authRequest).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    const input = request.mock.calls[0]![0];
    expect(input).toMatchObject({ url: config.soapUrl, method: 'POST', maxResponseBytes: 4194304,
      headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '""' } });
    expect(JSON.stringify(input.headers)).not.toContain('TOKEN');
    expect(input.body).not.toContain('PASSWORD');
    const root = parseXmlBounded(Buffer.from(input.body));
    const soapContext = requiredChild(requiredChild(root, SOAP, 'Header'), 'urn:zimbra', 'context');
    expect(soapContext.children).toHaveLength(1);
    expect(requiredChild(soapContext, 'urn:zimbra', 'authToken').text).toBe('TOKEN-canary');
    const operation = requiredChild(requiredChild(root, SOAP, 'Body'), MAIL, 'GetFreeBusyRequest');
    expect(operation.attributes.filter(a => a.uri === '')).toEqual([
      { uri: '', local: 's', value: '1789351200000' }, { uri: '', local: 'e', value: '1789365600000' },
      { uri: '', local: 'name', value: 'bob@example.invalid' },
    ]);
    expect(operation.children).toEqual([]);
    expect(input.body.split('TOKEN-canary')).toHaveLength(2);
  });

  it.each([{ ...target, provider: 'graph' as const }, { ...target, entryId: 'unknown-entry' },
    { ...target, canonicalSmtp: 'external@elsewhere.invalid' }])('rejects an unapproved target before auth or I/O %#', async supplied => {
    const { provider, request, authRequest } = harness();
    expect(await provider.lookup(supplied, window, context())).toMatchObject({ kind: 'error', reason: 'not-authorized' });
    expect(request).not.toHaveBeenCalled();
    expect(authRequest).not.toHaveBeenCalled();
  });

  it('snapshots local targets so later mutation cannot authorize an external mailbox', async () => {
    const mutable = { ...target };
    const { provider, request, authRequest } = harness(success, [mutable]);
    mutable.canonicalSmtp = 'external@elsewhere.invalid';
    expect(await provider.lookup(mutable, window, context())).toMatchObject({ kind: 'error', reason: 'not-authorized' });
    expect(request).not.toHaveBeenCalled();
    expect(authRequest).not.toHaveBeenCalled();
  });

  it('escapes approved SMTP values with XML metacharacters as one request attribute', async () => {
    const special = { ...target, canonicalSmtp: 'b&b@example.invalid' };
    const { provider, request } = harness(success.replace('bob@example.invalid', 'b&amp;b@example.invalid'), [special]);
    expect(await provider.lookup(special, window, context())).toMatchObject({ kind: 'ok' });
    const root = parseXmlBounded(Buffer.from(request.mock.calls[0]![0].body));
    const operation = requiredChild(requiredChild(root, SOAP, 'Body'), MAIL, 'GetFreeBusyRequest');
    expect(operation.attributes).toContainEqual({ uri: '', local: 'name', value: 'b&b@example.invalid' });
    expect(operation.children).toHaveLength(0);
  });

  it.each([[target, { ...target, canonicalSmtp: 'other@example.invalid' }],
    [target, { ...target, entryId: 'other' }], [{ ...target, provider: 'graph' as const }],
    [{ ...target, canonicalSmtp: 'bob@example.invalid,external@elsewhere.invalid' }]])('rejects ambiguous or invalid approved targets %#', approved => {
    expect(() => harness(success, approved)).toThrow();
  });

  it.each(['http://mail.example.invalid/service/soap', 'https://mail.example.invalid:7071/service/soap',
    'https://mail.example.invalid/service/admin/soap', 'https://user:pass@mail.example.invalid/service/soap', `${config.soapUrl}?url=other`])('rejects unsafe configured endpoint %s', soapUrl => {
    const { options } = harness();
    expect(() => createZimbraProvider({ ...options, soapUrl })).toThrow();
  });

  it.each(['service.PERM_DENIED', 'account.NO_SUCH_ACCOUNT', 'service.AUTH_EXPIRED'])('fails closed on SOAP fault %s', async code => {
    const { provider, request } = harness(fault(code));
    const result = await provider.lookup(target, window, context());
    expect(result.kind).toBe('error');
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(request).toHaveBeenCalledTimes(code === 'service.AUTH_EXPIRED' ? 2 : 1);
  });

  it('uses W14 renewal once for verified expiry then maps the response', async () => {
    const { provider, request, authRequest } = harness();
    request.mockResolvedValueOnce(response(fault('service.AUTH_EXPIRED'), 500));
    authRequest.mockResolvedValueOnce(response(auth())).mockResolvedValue(response(auth('replacement')));
    expect(await provider.lookup(target, window, context())).toEqual(normalize(success));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![0].body).toContain('replacement');
    expect(authRequest).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['malformed XML', response('<')], ['DTD', response('<!DOCTYPE x><x/>')],
    ['oversize', response(' '.repeat(4194305))], ['depth', response(`${'<x>'.repeat(33)}${'</x>'.repeat(33)}`)],
    ['nodes', response(`<x>${'<y/>'.repeat(10000)}</x>`)],
    ['non-XML', { ...response(success), headers: { 'content-type': 'text/html' } }],
    ['HTTP redirect', response(success, 302)], ['HTTP failure', response(success, 503)],
  ])('fails closed for %s', async (_label, payload) => {
    const { provider, request } = harness();
    request.mockResolvedValue(payload);
    expect(await provider.lookup(target, window, context())).toMatchObject({ kind: 'error' });
  });

  it('rejects invalid windows and cancelled requests before acquiring tokens', async () => {
    const { provider, request, authRequest } = harness();
    expect(await provider.lookup(target, { ...window, endMs: base }, context())).toMatchObject({ kind: 'error', reason: 'invalid-response' });
    expect(await provider.lookup(target, window, context(AbortSignal.abort()))).toMatchObject({ kind: 'error', reason: 'timeout' });
    expect(authRequest).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('bounds an uncooperative transport by the caller deadline', async () => {
    vi.useFakeTimers();
    const { provider, request } = harness();
    request.mockReturnValue(new Promise(() => {}));
    const pending = provider.lookup(target, window, context(undefined, 25));
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toMatchObject({ kind: 'error', reason: 'timeout' });
    expect(request.mock.calls[0]![0].signal.aborted).toBe(true);
  });

  it('rechecks the deadline after mapper processing', async () => {
    const { provider, options, request, advance } = harness();
    request.mockImplementation(async () => {
      options.clock.wallMs = () => { advance(4001); return nowMs; };
      return response(success);
    });
    expect(await provider.lookup(target, window, context())).toMatchObject({ kind: 'error', reason: 'timeout' });
  });

  it('sanitizes dependency errors without retrying arbitrary failures', async () => {
    const { provider, request } = harness();
    request.mockRejectedValue(new Error('SECRET-transport'));
    expect(await provider.lookup(target, window, context())).toEqual({ kind: 'error', targetId: target.entryId, reason: 'backend-unavailable' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

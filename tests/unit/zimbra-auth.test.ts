import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallContext, HttpResponse, HttpTransport } from '../../src/core/types.js';
import { createZimbraSession } from '../../src/providers/zimbra-auth.js';
import { parseXmlBounded } from '../../src/xml/parse.js';
import { requiredChild } from '../../src/xml/select.js';

const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const ACCOUNT = 'urn:zimbraAccount';
const config = { soapUrl: 'https://mail.example.invalid/service/soap', account: 'service@example.invalid', passwordFile: '/run/secrets/zimbra-password' };
const password = 'PASSWORD<&canary';
const token = 'TOKEN-canary';
const wrap = (body: string) => `<s:Envelope xmlns:s="${SOAP}"><s:Body>${body}</s:Body></s:Envelope>`;
const auth = (value = token, lifetime = '3600000') => wrap(`<AuthResponse xmlns="${ACCOUNT}"><authToken>${value}</authToken><lifetime>${lifetime}</lifetime></AuthResponse>`);
const fault = (code: string, namespace = 'urn:zimbra') => wrap(`<s:Fault><faultcode>s:Client</faultcode><faultstring>PRIVATE</faultstring><detail><Error xmlns="${namespace}"><Code>${code}</Code></Error></detail></s:Fault>`);
const response = (xml: string, status = 200): HttpResponse => ({ status, headers: { 'content-type': 'text/xml; charset=utf-8' }, body: Buffer.from(xml) });
const ctx = (signal = new AbortController().signal, deadlineMonoMs = 8000): CallContext => ({ signal, deadlineMonoMs });
function setup() {
  let mono = 0;
  const request = vi.fn<HttpTransport['request']>().mockResolvedValue(response(auth()));
  const readSecret = vi.fn(async () => password);
  const clock = { monoMs: () => mono, wallMs: () => 1700000000000 + mono };
  const session = createZimbraSession(config, { request }, clock, readSecret);
  return { session, request, readSecret, clock, advance: (ms: number) => { mono += ms; } };
}
afterEach(() => vi.useRealTimers());

describe('Zimbra normal-account authentication (synthetic protocol candidate)', () => {
  it('builds escaped account authentication at the fixed user endpoint and caches the token', async () => {
    const { session, request, readSecret } = setup();
    expect(await session.getToken(ctx())).toBe(token);
    expect(await session.getToken(ctx())).toBe(token);
    expect(request).toHaveBeenCalledTimes(1);
    expect(readSecret).toHaveBeenCalledWith(config.passwordFile);
    const input = request.mock.calls[0]![0];
    expect(input.url).toBe(config.soapUrl);
    expect(input.method).toBe('POST');
    expect(input.headers).not.toHaveProperty('authorization');
    const root = parseXmlBounded(Buffer.from(input.body));
    const operation = requiredChild(requiredChild(root, SOAP, 'Body'), ACCOUNT, 'AuthRequest');
    const account = requiredChild(operation, ACCOUNT, 'account');
    expect(account.text).toBe(config.account);
    expect(account.attributes).toContainEqual({ uri: '', local: 'by', value: 'name' });
    expect(requiredChild(operation, ACCOUNT, 'password').text).toBe(password);
    expect(input.body).not.toContain('admin');
    expect(input.body).not.toContain(token);
  });

  it.each(['http://mail.example.invalid/service/soap', 'https://mail.example.invalid:7071/service/soap', 'https://mail.example.invalid/service/admin/soap', 'https://user:pass@mail.example.invalid/service/soap', `${config.soapUrl}?override=1`])('rejects an unsafe endpoint %s', soapUrl => {
    expect(() => createZimbraSession({ ...config, soapUrl }, { request: vi.fn() }, { monoMs: () => 0, wallMs: () => 0 })).toThrow('Zimbra session unavailable');
  });

  it('renews using lifetime and the injected monotonic clock with a renewal margin', async () => {
    const { session, request, advance } = setup();
    request.mockResolvedValueOnce(response(auth(token, '10000'))).mockResolvedValue(response(auth('renewed')));
    expect(await session.getToken(ctx())).toBe(token);
    advance(8999);
    expect(await session.getToken(ctx(undefined, 20000))).toBe(token);
    advance(1);
    expect(await session.getToken(ctx(undefined, 20000))).toBe('renewed');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not extend token lifetime by the authentication round-trip time', async () => {
    const { session, request, advance } = setup();
    request.mockImplementation(async () => { advance(2000); return response(auth(token, '1000')); });
    await expect(session.getToken(ctx())).rejects.toHaveProperty('code', 'auth-expired');
  });

  it('does not expose session secrets through serialization', async () => {
    const { session } = setup();
    await session.getToken(ctx());
    expect(JSON.stringify(session)).toBe('{}');
  });

  it('rejects a refresh result when the caller deadline passes before timer callbacks run', async () => {
    const { session, request, advance } = setup();
    request.mockImplementation(async () => { advance(11); return response(auth()); });
    await expect(session.getToken(ctx(undefined, 10))).rejects.toHaveProperty('code', 'timeout');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rechecks the caller deadline immediately before returning a cached token', async () => {
    const { session, clock, advance, request } = setup();
    await session.getToken(ctx());
    const wallMs = clock.wallMs;
    clock.wallMs = () => { advance(11); return wallMs(); };
    await expect(session.getToken(ctx(undefined, 10))).rejects.toHaveProperty('code', 'timeout');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent renewals while cancellation affects only its subscriber', async () => {
    const { session, request } = setup();
    let resolve!: (value: HttpResponse) => void;
    request.mockReturnValue(new Promise(value => { resolve = value; }));
    const controller = new AbortController();
    const first = session.getToken(ctx(controller.signal));
    const rejected = expect(first).rejects.toHaveProperty('code', 'timeout');
    const second = session.getToken(ctx());
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    controller.abort('PRIVATE');
    await rejected;
    expect(request.mock.calls[0]![0].signal.aborted).toBe(false);
    resolve(response(auth()));
    expect(await second).toBe(token);
  });

  it('cancels orphaned work and never caches its late token', async () => {
    const { session, request } = setup();
    let resolve!: (value: HttpResponse) => void;
    request.mockReturnValueOnce(new Promise(value => { resolve = value; }));
    const controller = new AbortController();
    const first = session.getToken(ctx(controller.signal));
    const rejected = expect(first).rejects.toHaveProperty('code', 'timeout');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(request.mock.calls[0]![0].signal.aborted).toBe(true);
    resolve(response(auth('late-token')));
    expect(await session.getToken(ctx())).toBe(token);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('bounds uncooperative secret loading by the caller deadline', async () => {
    vi.useFakeTimers();
    const { session, request, readSecret } = setup();
    readSecret.mockReturnValue(new Promise(() => {}));
    const pending = expect(session.getToken(ctx(undefined, 25))).rejects.toHaveProperty('code', 'timeout');
    await vi.advanceTimersByTimeAsync(25);
    await pending;
    expect(request).not.toHaveBeenCalled();
  });

  it('bounds shared authentication to one 3-second attempt', async () => {
    vi.useFakeTimers();
    const { session, request } = setup();
    request.mockReturnValue(new Promise(() => {}));
    const pending = expect(session.getToken(ctx())).rejects.toHaveProperty('code', 'timeout');
    await vi.advanceTimersByTimeAsync(3000);
    await pending;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects a shared refresh that exceeds its own deadline before timer callbacks run', async () => {
    const { session, request, advance } = setup();
    request.mockImplementation(async () => { advance(3001); return response(auth()); });
    await expect(session.getToken(ctx())).rejects.toHaveProperty('code', 'timeout');
  });

  it('does not authenticate after slow secret loading exceeds the shared deadline', async () => {
    const { session, request, readSecret, advance } = setup();
    readSecret.mockImplementation(async () => { advance(3001); return password; });
    await expect(session.getToken(ctx())).rejects.toHaveProperty('code', 'timeout');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([0, NaN, Infinity])('rejects invalid or elapsed deadline %s before reading a secret', async deadline => {
    const { session, request, readSecret } = setup();
    await expect(session.getToken(ctx(undefined, deadline))).rejects.toHaveProperty('code', 'timeout');
    expect(readSecret).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    auth('', '3600000'), auth(token, '0'), auth(token, '-1'), auth(token, '1e6'), auth(token, '9007199254740992'),
    auth('x'.repeat(16385)), auth().replace('<lifetime>', `<authToken>${token}</authToken><lifetime>`),
    auth().replace('urn:zimbraAccount', 'urn:forged'), auth().replace('<authToken>', '<authToken><nested/>'),
    `<s:Envelope xmlns:s="${SOAP}"><s:Body/><s:Body/></s:Envelope>`, '<!DOCTYPE r [<!ENTITY x "PRIVATE">]><r>&x;</r>',
    'x'.repeat(262145), auth().replace('<s:Body>', '<s:Header><x xmlns="urn:unknown" s:mustUnderstand="1"/></s:Header><s:Body>'),
  ])('rejects malformed authentication payload %# without exposing secrets', async xml => {
    const { session, request } = setup();
    request.mockResolvedValue(response(xml));
    await expect(session.getToken(ctx())).rejects.toMatchObject({ code: 'invalid-response', message: 'Zimbra session unavailable' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['account.AUTH_FAILED', 'account.ACCOUNT_INACTIVE', 'service.AUTH_EXPIRED'])('does not retry failed authentication %s', async code => {
    const { session, request } = setup();
    request.mockResolvedValue(response(fault(code), 500));
    await expect(session.getToken(ctx())).rejects.toHaveProperty('code', code === 'service.AUTH_EXPIRED' ? 'auth-expired' : 'credentials-denied');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('sanitizes injected secret and transport failures', async () => {
    const { session, readSecret, request } = setup();
    readSecret.mockRejectedValueOnce(new Error(password));
    await expect(session.getToken(ctx())).rejects.toMatchObject({ message: 'Zimbra session unavailable', code: 'backend-unavailable' });
    request.mockRejectedValueOnce(new Error(token));
    await expect(session.getToken(ctx())).rejects.toMatchObject({ message: 'Zimbra session unavailable', code: 'backend-unavailable' });
  });

  it('renews once after verified expiry and retries the operation with the replacement token', async () => {
    const { session, request } = setup();
    request.mockResolvedValueOnce(response(auth())).mockResolvedValue(response(auth('replacement')));
    const success = response(wrap('<GetFreeBusyResponse xmlns="urn:zimbraMail"/>'));
    const operation = vi.fn().mockResolvedValueOnce(response(fault('service.AUTH_EXPIRED'), 500)).mockResolvedValue(success);
    expect(await session.withToken(ctx(), operation)).toBe(success);
    expect(operation.mock.calls.map(call => call[0])).toEqual([token, 'replacement']);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('stops after one expiry retry', async () => {
    const { session, request } = setup();
    const operation = vi.fn().mockResolvedValue(response(fault('service.AUTH_EXPIRED'), 500));
    await expect(session.withToken(ctx(), operation)).rejects.toHaveProperty('code', 'auth-expired');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent confirmed-expiry refreshes', async () => {
    const { session, request } = setup();
    await session.getToken(ctx());
    request.mockResolvedValue(response(auth('replacement')));
    const success = response(wrap('<GetFreeBusyResponse xmlns="urn:zimbraMail"/>'));
    const operation = vi.fn(async (access: string) => access === token ? response(fault('service.AUTH_EXPIRED'), 500) : success);
    const results = await Promise.all([session.withToken(ctx(), operation), session.withToken(ctx(), operation)]);
    expect(results).toEqual([success, success]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it('does not reauthenticate after the caller deadline elapses on an expiry fault', async () => {
    const { session, request, advance } = setup();
    const operation = vi.fn(async () => { advance(8000); return response(fault('service.AUTH_EXPIRED'), 500); });
    await expect(session.withToken(ctx(), operation)).rejects.toHaveProperty('code', 'timeout');
    expect(request).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('sanitizes operation errors without reauthentication', async () => {
    const { session, request } = setup();
    const operation = vi.fn(async () => { throw new Error(token); });
    await expect(session.withToken(ctx(), operation)).rejects.toMatchObject({ code: 'backend-unavailable', message: 'Zimbra session unavailable' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    fault('service.AUTH_REQUIRED'), fault('account.AUTH_FAILED'), fault('service.AUTH_EXPIRED', 'urn:forged'),
    fault('service.AUTH_EXPIRED').replace('</Code>', '</Code><Code>service.AUTH_EXPIRED</Code>'),
  ])('never refreshes an unverified or non-expiry fault %#', async xml => {
    const { session, request } = setup();
    const operation = vi.fn().mockResolvedValue(response(xml, 500));
    await expect(session.withToken(ctx(), operation)).rejects.toHaveProperty('message', 'Zimbra session unavailable');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps the caller deadline during an uncooperative operation', async () => {
    vi.useFakeTimers();
    const { session, request } = setup();
    const operation = vi.fn().mockReturnValue(new Promise(() => {}));
    const pending = expect(session.withToken(ctx(undefined, 25), operation)).rejects.toHaveProperty('code', 'timeout');
    await vi.advanceTimersByTimeAsync(25);
    await pending;
    expect(operation.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects operation success after the deadline even before timer callbacks run', async () => {
    const { session, advance, request } = setup();
    const operation = vi.fn(async () => {
      advance(11);
      return response(wrap('<GetFreeBusyResponse xmlns="urn:zimbraMail"/>'));
    });
    await expect(session.withToken(ctx(undefined, 10), operation)).rejects.toHaveProperty('code', 'timeout');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rechecks the deadline after parsing and before returning operation success', async () => {
    const { session, advance } = setup();
    const operation = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'text/xml; charset=utf-8' },
      get body() { advance(11); return Buffer.from(wrap('<GetFreeBusyResponse xmlns="urn:zimbraMail"/>')); },
    }));
    await expect(session.withToken(ctx(undefined, 10), operation)).rejects.toHaveProperty('code', 'timeout');
  });
});

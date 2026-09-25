import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { create } from 'xmlbuilder2';
import type { CallContext, Clock, HttpResponse, HttpTransport, TokenSource } from '../core/types.js';
import type { ValidatedConfig } from '../config/validate.js';
import { abortable, TransportError } from '../http/outbound.js';
import { parseXmlBounded, type XmlNode } from '../xml/parse.js';
import { optionalChild, requiredChild } from '../xml/select.js';

const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const ACCOUNT = 'urn:zimbraAccount';
type ErrorCode = 'credentials-denied' | 'auth-expired' | 'invalid-response' | 'timeout' | 'backend-unavailable';
export class ZimbraAuthError extends Error {
  constructor(readonly code: ErrorCode) { super('Zimbra session unavailable'); }
}
export interface ZimbraSession extends TokenSource {
  /** Trusted W15 callback: send token only in SOAP context to its fixed user SOAP URL. */
  withToken(ctx: CallContext, operation: (token: string, ctx: CallContext) => Promise<HttpResponse>): Promise<HttpResponse>;
}
interface Flight {
  readonly controller: AbortController;
  promise: Promise<string>;
  subscribers: number;
}
function sanitized(error: unknown): ZimbraAuthError {
  if (error instanceof ZimbraAuthError) return new ZimbraAuthError(error.code);
  if (error instanceof TransportError && (error.code === 'timeout' || error.code === 'invalid-response')) return new ZimbraAuthError(error.code);
  return new ZimbraAuthError('backend-unavailable');
}
async function readMountedSecret(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new ZimbraAuthError('backend-unavailable');
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new ZimbraAuthError('backend-unavailable');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally { await file.close(); }
}
function operationNode(response: HttpResponse, maxBytes: number): XmlNode {
  try {
    if (!/^\s*(?:text\/xml|application\/(?:soap\+xml|xml))(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(response.headers['content-type'] ?? '')) throw new Error();
    const root = parseXmlBounded(response.body, { maxRequestBytes: maxBytes, maxXmlDepth: 32, maxXmlNodes: 10000, maxAttributesPerElement: 32, maxXmlTextNodeChars: 16384 });
    if (root.uri !== SOAP || root.local !== 'Envelope' || root.text.trim()) throw new Error();
    const body = requiredChild(root, SOAP, 'Body');
    const header = optionalChild(root, SOAP, 'Header');
    if (root.children.length !== (header ? 2 : 1) || body.children.length !== 1 || body.text.trim()) throw new Error();
    if (header?.children.some(node => node.attributes.some(a => a.uri === SOAP && a.local === 'mustUnderstand' && a.value !== '0' && a.value !== 'false'))) throw new Error();
    return body.children[0]!;
  } catch { throw new ZimbraAuthError('invalid-response'); }
}
function faultCode(node: XmlNode): string | undefined {
  if (node.uri !== SOAP || node.local !== 'Fault') return undefined;
  try {
    requiredChild(node, '', 'faultcode');
    requiredChild(node, '', 'faultstring');
    const code = requiredChild(requiredChild(requiredChild(node, '', 'detail'), 'urn:zimbra', 'Error'), 'urn:zimbra', 'Code');
    if (code.children.length || !code.text) throw new Error();
    return code.text;
  } catch { throw new ZimbraAuthError('invalid-response'); }
}
function faultFailure(code: string): ZimbraAuthError {
  return new ZimbraAuthError(code === 'service.AUTH_EXPIRED' ? 'auth-expired'
    : ['account.AUTH_FAILED', 'account.ACCOUNT_INACTIVE', 'account.ACCOUNT_LOCKED'].includes(code) ? 'credentials-denied' : 'backend-unavailable');
}

export function createZimbraSession(
  config: ValidatedConfig['zimbra'], transport: HttpTransport, clock: Pick<Clock, 'wallMs' | 'monoMs'>,
  readSecret: (path: string) => Promise<string> = readMountedSecret,
): ZimbraSession {
  let soapUrl: string, account: string, passwordFile: string;
  try {
    ({ soapUrl, account, passwordFile } = config);
    const url = new URL(soapUrl);
    if (url.protocol !== 'https:' || url.port === '7071' || url.pathname !== '/service/soap'
      || url.username || url.password || url.search || url.hash || url.href !== soapUrl
      || !account || account.length > 320 || /[\x00-\x20\x7f]/.test(account)
      || !isAbsolute(passwordFile) || /[\x00-\x1f\x7f]/.test(passwordFile)) throw new Error();
  } catch { throw new ZimbraAuthError('backend-unavailable'); }
  let cached: { token: string; expiresWallMs: number; refreshMonoMs: number } | undefined;
  let flight: Flight | undefined;
  function remaining(ctx: CallContext): number {
    const ms = ctx.deadlineMonoMs - clock.monoMs();
    if (ctx.signal.aborted || !Number.isFinite(ms) || ms <= 0) throw new ZimbraAuthError('timeout');
    return ms;
  }
  function startRefresh(): Flight {
    const active: Flight = { controller: new AbortController(), subscribers: 0, promise: Promise.resolve('') };
    const signal = active.controller.signal;
    const refreshContext = { signal, deadlineMonoMs: clock.monoMs() + 3000 };
    const timer = setTimeout(() => active.controller.abort(), 3000);
    active.promise = (async () => {
      try {
        const password: unknown = await abortable(readSecret(passwordFile), signal);
        remaining(refreshContext);
        if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 4096 || /[\x00-\x1f\x7f]/.test(password)) throw new ZimbraAuthError('backend-unavailable');
        const document = create({ version: '1.0', encoding: 'UTF-8' });
        const request = document.ele('s:Envelope', { 'xmlns:s': SOAP }).ele('s:Body').ele('AuthRequest', { xmlns: ACCOUNT });
        request.ele('account', { by: 'name' }).txt(account);
        request.ele('password').txt(password);
        remaining(refreshContext);
        const wall = clock.wallMs(), mono = clock.monoMs();
        const response = await abortable(transport.request({ url: soapUrl, method: 'POST',
          headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '""' },
          body: document.end({ prettyPrint: false }), signal, maxResponseBytes: 262144 }), signal);
        remaining(refreshContext);
        const node = operationNode(response, 262144);
        const code = faultCode(node);
        if (code) throw faultFailure(code);
        if (response.status !== 200 || node.uri !== ACCOUNT || node.local !== 'AuthResponse') throw new ZimbraAuthError('invalid-response');
        let token: XmlNode, lifetime: XmlNode;
        try { token = requiredChild(node, ACCOUNT, 'authToken'); lifetime = requiredChild(node, ACCOUNT, 'lifetime'); }
        catch { throw new ZimbraAuthError('invalid-response'); }
        const duration = Number(lifetime.text);
        if (token.children.length || lifetime.children.length || !/^[A-Za-z0-9._~+/-]+=*$/.test(token.text)
          || !/^\d+$/.test(lifetime.text) || !Number.isSafeInteger(duration) || duration <= 0 || duration > 2147483647
          || !Number.isSafeInteger(wall + duration) || !Number.isFinite(mono + duration)) throw new ZimbraAuthError('invalid-response');
        remaining(refreshContext);
        const margin = Math.min(1000, duration / 10);
        if (clock.wallMs() >= wall + duration - margin || clock.monoMs() >= mono + duration - margin) throw new ZimbraAuthError('auth-expired');
        remaining(refreshContext);
        cached = { token: token.text, expiresWallMs: wall + duration - margin, refreshMonoMs: mono + duration - margin };
        return token.text;
      } catch (error) { throw sanitized(error); }
      finally { clearTimeout(timer); if (flight === active) flight = undefined; }
    })();
    return active;
  }
  const session: ZimbraSession = {
    async getToken(ctx) {
      const ms = remaining(ctx);
      if (cached && clock.wallMs() < cached.expiresWallMs && clock.monoMs() < cached.refreshMonoMs) {
        remaining(ctx);
        return cached.token;
      }
      cached = undefined;
      const active = flight ??= startRefresh();
      active.subscribers++;
      const controller = new AbortController();
      const signal = AbortSignal.any([ctx.signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(), Math.min(ms, 2147483647));
      try {
        const token = await abortable(active.promise, signal);
        remaining({ signal, deadlineMonoMs: ctx.deadlineMonoMs });
        return token;
      }
      catch (error) { throw sanitized(error); }
      finally {
        clearTimeout(timer);
        if (--active.subscribers === 0) {
          active.controller.abort();
          if (flight === active) flight = undefined;
        }
      }
    },
    async withToken(ctx, operation) {
      const controller = new AbortController();
      const signal = AbortSignal.any([ctx.signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(), Math.min(remaining(ctx), 2147483647));
      const bounded = { signal, deadlineMonoMs: ctx.deadlineMonoMs };
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const token = await session.getToken(bounded);
          remaining(bounded);
          const response = await abortable(operation(token, bounded), signal);
          remaining(bounded);
          const code = faultCode(operationNode(response, 4194304));
          remaining(bounded);
          if (!code) return response;
          if (code !== 'service.AUTH_EXPIRED') throw faultFailure(code);
          if (cached?.token === token) cached = undefined;
          if (attempt === 1) throw faultFailure(code);
        }
        throw new ZimbraAuthError('auth-expired');
      } catch (error) { throw sanitized(error); }
      finally { clearTimeout(timer); controller.abort(); }
    },
  };
  return session;
}

import { create } from 'xmlbuilder2';
import type { AvailabilityProvider, Clock, Failure, HttpTransport, Target } from '../core/types.js';
import { normalizeFreeBusyGrid } from '../freebusy/grid.js';
import { TransportError } from '../http/outbound.js';
import { parseXmlBounded } from '../xml/parse.js';
import { ZimbraAuthError, type ZimbraSession } from './zimbra-auth.js';
import { normalizeZimbra } from './zimbra-map.js';
import { availabilityRetry } from '../resilience/retry.js';

interface ZimbraProviderOptions {
  readonly soapUrl: string;
  readonly approvedTargets: readonly Target[];
  readonly session: ZimbraSession;
  readonly transport: HttpTransport;
  readonly clock: Pick<Clock, 'wallMs' | 'monoMs'>;
}

const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const maxResponseBytes = 4194304;

function dependencyFailure(cause: unknown): Failure {
  if (cause instanceof ZimbraAuthError || cause instanceof TransportError) {
    if (cause.code === 'timeout' || cause.code === 'invalid-response') return cause.code;
    if (cause.code === 'credentials-denied') return 'not-authorized';
  }
  return 'backend-unavailable';
}

export function createZimbraProvider(options: ZimbraProviderOptions): AvailabilityProvider {
  const { soapUrl, session, transport, clock } = options;
  const approved = new Map<string, string>();
  const addresses = new Set<string>();
  try {
    const url = new URL(soapUrl);
    if (url.protocol !== 'https:' || url.port === '7071' || url.pathname !== '/service/soap'
      || url.username || url.password || url.search || url.hash || url.href !== soapUrl) throw new TypeError();
    for (const item of options.approvedTargets) {
      const smtp = item.canonicalSmtp.toLowerCase();
      if (item.provider !== 'zimbra' || !item.entryId || approved.has(item.entryId) || addresses.has(smtp)
        || item.graphObjectId !== undefined || smtp.length > 320
        || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z0-9]+$/.test(smtp)) throw new TypeError();
      approved.set(item.entryId, item.canonicalSmtp);
      addresses.add(smtp);
    }
  } catch { throw new TypeError('Invalid Zimbra provider configuration'); }
  return { kind: 'zimbra', async lookup(target, window, ctx) {
    const failure = (reason: Failure) => ({ kind: 'error' as const, targetId: target.entryId, reason });
    const canonicalSmtp = approved.get(target.entryId);
    if (target.provider !== 'zimbra' || canonicalSmtp === undefined || target.canonicalSmtp !== canonicalSmtp
      || target.graphObjectId !== undefined) return failure('not-authorized');
    const expired = () => ctx.signal.aborted || !Number.isFinite(ctx.deadlineMonoMs) || clock.monoMs() >= ctx.deadlineMonoMs;
    if (expired()) return failure('timeout');
    try { normalizeFreeBusyGrid(window, [], []); }
    catch { return failure('invalid-response'); }
    let response;
    const retry = availabilityRetry(ctx, clock, 'zimbra');
    try {
      response = await session.withToken(ctx, (token, bounded) => {
        const document = create({ version: '1.0', encoding: 'UTF-8' });
        const envelope = document.ele('s:Envelope', { 'xmlns:s': SOAP });
        envelope.ele('s:Header').ele('context', { xmlns: 'urn:zimbra' }).ele('authToken').txt(token);
        envelope.ele('s:Body').ele('GetFreeBusyRequest', { xmlns: 'urn:zimbraMail', s: window.startMs, e: window.endMs, name: canonicalSmtp });
        return retry(bounded, signal => transport.request({ url: soapUrl, method: 'POST',
          headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '""' },
          body: document.end({ prettyPrint: false }), signal, maxResponseBytes }));
      });
    } catch (cause) { return failure(dependencyFailure(cause)); }
    if (expired()) return failure('timeout');
    if (response.status !== 200) return failure(response.status === 401 || response.status === 403 ? 'not-authorized'
      : response.status === 429 ? 'throttled' : response.status >= 500 && response.status <= 599 ? 'backend-unavailable' : 'invalid-response');
    try {
      if (!/^(?:text\/xml|application\/(?:soap\+xml|xml))(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(response.headers['content-type'] ?? '')) return failure('invalid-response');
      const tree = parseXmlBounded(response.body, { maxRequestBytes: maxResponseBytes, maxXmlDepth: 32,
        maxXmlNodes: 10000, maxAttributesPerElement: 32, maxXmlTextNodeChars: 16384 });
      const result = normalizeZimbra(tree, target, window, clock.wallMs());
      return expired() ? failure('timeout') : result;
    } catch { return failure('invalid-response'); }
  } };
}

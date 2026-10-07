import type { Status, Target, TargetResult, WindowUtc } from '../core/types.js';
import { normalizeFreeBusyGrid } from '../freebusy/grid.js';
import type { XmlNode } from '../xml/parse.js';
import { optionalChild, requiredChild } from '../xml/select.js';

const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const MAIL = 'urn:zimbraMail';
const statuses: Readonly<Record<string, Status>> = Object.freeze({ f: 'free', b: 'busy', t: 'tentative', u: 'oof', n: 'unknown' });

function attribute(node: XmlNode, name: string): string | undefined {
  const matches = node.attributes.filter(item => item.local === name);
  if (matches.length > 1 || matches.some(item => item.uri !== '')) throw new TypeError();
  return matches[0]?.value;
}

function permission(node: XmlNode): boolean {
  const value = attribute(node, 'hasPermission');
  if (value === undefined || value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new TypeError();
}

function instant(node: XmlNode, name: string): number {
  const value = attribute(node, name);
  if (value === undefined || !/^-?\d+$/.test(value)) throw new TypeError();
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || Math.abs(ms) > 8640000000000000) throw new RangeError();
  return ms;
}

/** The tree must come from parseXmlBounded; explicit intervals alone prove coverage until A05. */
export function normalizeZimbra(tree: XmlNode, target: Target, window: WindowUtc, nowMs: number): TargetResult {
  const failure = (reason: 'invalid-response' | 'not-authorized' | 'backend-unavailable' = 'invalid-response'): TargetResult =>
    ({ kind: 'error', targetId: target.entryId, reason });
  if (target.provider !== 'zimbra') return failure('not-authorized');
  try {
    if (!Number.isSafeInteger(nowMs) || Math.abs(nowMs) > 8640000000000000
      || !target.canonicalSmtp || target.canonicalSmtp !== target.canonicalSmtp.trim()
      || tree.uri !== SOAP || tree.local !== 'Envelope' || tree.text.trim()) throw new TypeError();
    const body = requiredChild(tree, SOAP, 'Body');
    const header = optionalChild(tree, SOAP, 'Header');
    if (tree.children.length !== (header ? 2 : 1) || body.children.length !== 1 || body.text.trim()
      || header?.text.trim() || header?.children.some(node => node.attributes.some(item =>
        item.uri === SOAP && item.local === 'mustUnderstand' && item.value !== '0' && item.value !== 'false'))) throw new TypeError();
    const response = body.children[0]!;
    if (response.uri === SOAP && response.local === 'Fault') return failure('backend-unavailable');
    if (response.uri !== MAIL || response.local !== 'GetFreeBusyResponse' || response.text.trim()
      || response.children.length !== 1) throw new TypeError();
    const user = requiredChild(response, MAIL, 'usr');
    const identity = attribute(user, 'id');
    if (identity === undefined || identity.toLowerCase() !== target.canonicalSmtp.toLowerCase() || user.text.trim()) throw new TypeError();
    if (!permission(response) || !permission(user)) return failure('not-authorized');
    // Zimbra sets hasPermission="false" on the interval element (ToXML.encodeFreeBusy), e.g. the
    // <n/> produced for an EWS ErrorNoFreeBusyAccess; it never appears on usr or the response.
    let denied = false;
    const intervals = user.children.map(node => {
      if (node.uri !== MAIL || !Object.hasOwn(statuses, node.local) || node.children.length || node.text.trim()) throw new TypeError();
      if (!permission(node)) denied = true;
      const startMs = instant(node, 's');
      const endMs = instant(node, 'e');
      if (endMs <= startMs || startMs < window.startMs || endMs > window.endMs) throw new RangeError();
      return { startMs, endMs, status: statuses[node.local]! };
    });
    if (denied) return failure('not-authorized');
    const normalized = normalizeFreeBusyGrid(window, intervals, intervals);
    return Object.freeze({ kind: 'ok', targetId: target.entryId, coverage: normalized.window,
      slots: normalized.intervals, observedAtMs: nowMs });
  } catch { return failure(); }
}

import type { Principal } from '../security/principals.js';
import { parseXmlBounded, type XmlNode } from '../xml/parse.js';
import { decodePoxRequest } from './request.js';
import { encodePoxSettings } from './response.js';

export interface AutodiscoverResponse {
  readonly status: 200 | 404;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
export type XmlParser = (bytes: Uint8Array) => XmlNode;

const rejected: AutodiscoverResponse = Object.freeze({ status: 404,
  headers: Object.freeze({ 'content-type': 'text/plain; charset=utf-8' }), body: 'Request rejected' });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function authenticatedPrincipal(value: unknown): value is Principal {
  try {
    return record(value) && Object.isFrozen(value) && typeof value.id === 'string' && value.id.length > 0
      && typeof value.username === 'string' && value.username.length > 0
      && value.surface === 'm365-inbound' && value.allowedProvider === 'zimbra';
  } catch {
    return false;
  }
}

function mappedIdentity(entries: unknown, principalId: string, email: string): boolean {
  if (!Array.isArray(entries) || !Object.isFrozen(entries)) return false;
  return entries.some((value: unknown) => {
    if (!record(value) || !Object.isFrozen(value) || value.provider !== 'zimbra' || value.enabled !== true
      || !Array.isArray(value.allowedPrincipals) || !Object.isFrozen(value.allowedPrincipals)
      || !value.allowedPrincipals.includes(principalId) || typeof value.canonicalSmtp !== 'string'
      || !Array.isArray(value.aliases) || !Object.isFrozen(value.aliases)) return false;
    return value.canonicalSmtp === email || value.aliases.includes(email);
  });
}

/** Authentication and mapping checks precede bounded XML parsing and response generation. */
export function routeAutodiscover(input: unknown, parser: XmlParser = parseXmlBounded): AutodiscoverResponse {
  if (!record(input) || !authenticatedPrincipal(input.principal) || !(input.body instanceof Uint8Array)) return rejected;
  const response = encodePoxSettings(input.advertisedOrigin, input.profile);
  if (response === undefined || !Array.isArray(input.entries)) return rejected;
  let tree: XmlNode;
  try {
    tree = parser(input.body);
  } catch {
    return rejected;
  }
  const request = decodePoxRequest(tree);
  if (!request || !mappedIdentity(input.entries, input.principal.id, request.email)) return rejected;
  return Object.freeze({ status: 200, headers: Object.freeze({ 'content-type': 'text/xml; charset=utf-8' }), body: response });
}

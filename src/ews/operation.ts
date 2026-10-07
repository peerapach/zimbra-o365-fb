import type { XmlNode } from '../xml/parse.js';
import { optionalChild, requiredChild } from '../xml/select.js';

export const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
export const MESSAGES = 'http://schemas.microsoft.com/exchange/services/2006/messages';
export const TYPES = 'http://schemas.microsoft.com/exchange/services/2006/types';
const action = `${MESSAGES}/GetUserAvailability`;

export function invalidRequest(): never {
  throw new Error('Invalid availability request');
}

/** Namespace declarations are parser metadata; every semantic attribute is allowlisted. */
export function checkAttributes(node: XmlNode, allowed: Readonly<Record<string, readonly string[]>> = {}): void {
  for (const attribute of node.attributes) {
    if (attribute.uri === 'http://www.w3.org/2000/xmlns/') continue;
    const key = `${attribute.uri}#${attribute.local}`;
    if (!Object.hasOwn(allowed, key) || !allowed[key]!.includes(attribute.value)) invalidRequest();
  }
}

export function container(node: XmlNode, names: readonly string[], uri = TYPES): void {
  if (node.text.trim() || node.children.some(child => child.uri !== uri || !names.includes(child.local))) invalidRequest();
}

/** The optional Header must precede exactly one Body containing exactly one allowed operation. */
export function availabilityOperation(tree: XmlNode, soapAction?: string): { operation: XmlNode; header?: XmlNode } {
  if (soapAction !== undefined && soapAction !== action && soapAction !== `"${action}"`) invalidRequest();
  if (tree.uri !== SOAP || tree.local !== 'Envelope') invalidRequest();
  checkAttributes(tree);
  container(tree, ['Header', 'Body'], SOAP);
  const header = optionalChild(tree, SOAP, 'Header');
  const body = requiredChild(tree, SOAP, 'Body');
  if (header && tree.children[0] !== header) invalidRequest();
  checkAttributes(body);
  container(body, ['GetUserAvailabilityRequest'], MESSAGES);
  const operation = requiredChild(body, MESSAGES, 'GetUserAvailabilityRequest');
  checkAttributes(operation);
  if (operation.text.trim() || operation.children.some(child =>
    !(child.uri === MESSAGES && child.local === 'MailboxDataArray')
    && !(child.uri === TYPES && (child.local === 'FreeBusyViewOptions' || child.local === 'TimeZone')))) invalidRequest();
  return { operation, ...(header ? { header } : {}) };
}

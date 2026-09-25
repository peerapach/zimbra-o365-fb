import type { XmlNode } from '../xml/parse.js';

export const POX_REQUEST_NS = 'http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006';
export const POX_RESPONSE_SCHEMA = 'http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export interface PoxRequest { readonly email: string }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function node(value: unknown): value is XmlNode {
  if (!record(value) || typeof value.uri !== 'string' || typeof value.local !== 'string'
    || typeof value.text !== 'string' || !Array.isArray(value.attributes) || !Array.isArray(value.children)) return false;
  return value.attributes.every((attribute: unknown) => record(attribute)
    && typeof attribute.uri === 'string' && typeof attribute.local === 'string'
    && typeof attribute.value === 'string' && attribute.uri === XMLNS_NS);
}

function whitespace(value: string): boolean {
  return /^[\t\n\r ]*$/.test(value);
}

function element(value: unknown, local: string, structural: boolean): value is XmlNode {
  return node(value) && value.uri === POX_REQUEST_NS && value.local === local
    && (structural ? whitespace(value.text) : value.children.length === 0);
}

function smtp(value: string): string | undefined {
  if (value.length > 254 || value !== value.trim()) return undefined;
  const match = /^([a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/i.exec(value);
  if (!match || match[1]!.length > 64) return undefined;
  return value.toLowerCase();
}

/** Decode only the bounded XML tree for the exact POX Autodiscover request. */
export function decodePoxRequest(value: unknown): PoxRequest | undefined {
  if (!element(value, 'Autodiscover', true) || value.children.length !== 1) return undefined;
  const request = value.children[0];
  if (!element(request, 'Request', true) || request.children.length !== 2) return undefined;
  const [email, schema] = request.children;
  if (!element(email, 'EMailAddress', false) || !element(schema, 'AcceptableResponseSchema', false)
    || !whitespace(value.text) || !whitespace(request.text) || schema.text !== POX_RESPONSE_SCHEMA) return undefined;
  const normalized = smtp(email.text);
  return normalized === undefined ? undefined : Object.freeze({ email: normalized });
}

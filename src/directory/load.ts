import { createHash } from 'node:crypto';
import type { Principal } from '../security/principals.js';
import { createDirectoryResolver, normalizeAddress, type DirectoryEntry } from './resolve.js';

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid directory');
}

function object(input: unknown, required: readonly string[], optional: readonly string[] = []) {
  requireValid(input !== null && typeof input === 'object' && !Array.isArray(input));
  const value = input as Record<string, unknown>;
  requireValid(required.every(key => Object.hasOwn(value, key)));
  requireValid(Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
  return value;
}

function text(input: unknown): string {
  requireValid(typeof input === 'string' && input.length > 0 && input === input.trim() && !/[\x00-\x1f\x7f]/.test(input));
  return input;
}

function unique(value: string, seen: Set<string>): string {
  requireValid(!seen.has(value));
  seen.add(value);
  return value;
}

/** Load admin-managed JSON data; no network/directory synchronization occurs here. */
export function loadDirectory(input: unknown, principals: readonly Principal[], policyRevision: unknown) {
  const revision = text(policyRevision);
  const data = object(input, ['schemaVersion', 'entries']);
  requireValid(data.schemaVersion === 1 && Array.isArray(data.entries) && Array.isArray(principals));
  const principalIds = new Set<string>();
  const usernames = new Set<string>();
  const registered = principals.map(p => {
    requireValid(p !== null && typeof p === 'object');
    requireValid((p.surface === 'm365-inbound' && p.allowedProvider === 'zimbra')
      || (p.surface === 'zimbra-inbound' && p.allowedProvider === 'graph'));
    return Object.freeze({ id: unique(text(p.id), principalIds), username: unique(text(p.username), usernames),
      surface: p.surface, allowedProvider: p.allowedProvider });
  });
  const entryIds = new Set<string>();
  const addresses = new Set<string>();
  const address = (value: unknown) => {
    const normalized = normalizeAddress(value);
    requireValid(normalized !== undefined);
    return unique(normalized, addresses);
  };
  const entries: DirectoryEntry[] = data.entries.map((item: unknown) => {
    const e = object(item, ['id', 'provider', 'canonicalSmtp', 'aliases', 'allowedPrincipals', 'enabled'], ['graphObjectId']);
    requireValid(e.provider === 'graph' || e.provider === 'zimbra');
    requireValid(typeof e.enabled === 'boolean' && Array.isArray(e.aliases) && Array.isArray(e.allowedPrincipals));
    requireValid(!Object.hasOwn(e, 'graphObjectId') || (e.provider === 'graph' && typeof e.graphObjectId === 'string'));
    const grants = new Set<string>();
    return Object.freeze({
      id: unique(text(e.id), entryIds), provider: e.provider, canonicalSmtp: address(e.canonicalSmtp),
      aliases: Object.freeze(e.aliases.map(address)), enabled: e.enabled,
      allowedPrincipals: Object.freeze(e.allowedPrincipals.map((value: unknown) => {
        const id = unique(text(value), grants);
        requireValid(registered.some(p => p.id === id && p.allowedProvider === e.provider));
        return id;
      })),
      ...(e.graphObjectId === undefined ? {} : { graphObjectId: text(e.graphObjectId) }),
    });
  });
  // A grant/routing change invalidates the namespace even if an operator reuses a revision.
  // Deployment revision also covers external policy/credential changes absent from this JSON.
  const configVersion = createHash('sha256').update(JSON.stringify({ schemaVersion: 1, revision, registered, entries })).digest('hex');
  return createDirectoryResolver(entries, registered, configVersion);
}

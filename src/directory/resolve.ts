import type { ValidatedConfig } from '../config/validate.js';
import type { Target } from '../core/types.js';
import type { Principal } from '../security/principals.js';

export type DirectoryEntry = ValidatedConfig['directory']['entries'][number];
export type ResolvedTarget = Target & { readonly configVersion: string };

/** ASCII dot-atoms only; preserve plus tags/dots and never infer an alias/domain. */
export function normalizeAddress(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[^\x21-\x7e]/.test(value)) return undefined;
  const normalized = value.toLowerCase();
  return /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized)
    ? normalized : undefined;
}

/** Internal construction from the loader's validated, copied entries and principals. */
export function createDirectoryResolver(entries: readonly DirectoryEntry[], principals: readonly Principal[], configVersion: string) {
  const identities = new Map<string, DirectoryEntry>();
  for (const entry of entries) {
    for (const address of [entry.canonicalSmtp, ...entry.aliases]) identities.set(address, entry);
  }
  const registered = new Map(principals.map(p => [p.id, p]));

  /** principal is authenticated upstream; surface is listener-owned, never a request header. */
  function resolveTarget(principal: unknown, surface: unknown, address: unknown): ResolvedTarget | undefined {
    if (!principal || typeof principal !== 'object' || (surface !== 'm365-inbound' && surface !== 'zimbra-inbound')) return undefined;
    const candidate = principal as Partial<Principal>;
    const expected = typeof candidate.id === 'string' ? registered.get(candidate.id) : undefined;
    const provider = surface === 'm365-inbound' ? 'zimbra' : 'graph';
    if (!expected || candidate.username !== expected.username || candidate.surface !== surface
      || expected.surface !== surface || candidate.allowedProvider !== provider || expected.allowedProvider !== provider) return undefined;
    const normalized = normalizeAddress(address);
    const entry = normalized === undefined ? undefined : identities.get(normalized);
    // Unknown and denied both produce absence, with no canonical identity or diagnostic leakage.
    if (!entry || !entry.enabled || entry.provider !== provider || !entry.allowedPrincipals.includes(expected.id)) return undefined;
    return Object.freeze({ entryId: entry.id, provider: entry.provider, canonicalSmtp: entry.canonicalSmtp, configVersion,
      ...(entry.graphObjectId === undefined ? {} : { graphObjectId: entry.graphObjectId }) });
  }

  return Object.freeze({ configVersion, resolveTarget,
    withAuthorizedTarget<T>(principal: unknown, surface: unknown, address: unknown, next: (target: ResolvedTarget) => T): T | undefined {
      const target = resolveTarget(principal, surface, address);
      return target === undefined ? undefined : next(target);
    },
  });
}

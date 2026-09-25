import { isIP } from 'node:net';
import type { ValidatedConfig } from '../config/validate.js';

interface Bucket { credit: number; at: number; fullAt: number }

/** Both namespaces share a hard memory cap; only fully refilled entries are evictable. */
export function createRateControls(limits: ValidatedConfig['limits'], monoMs: () => number) {
  const buckets = new Map<string, Bucket>();
  let highWater = -Infinity;
  function take(namespace: string, key: string, burst: number, perMinute: number): boolean {
    const time = monoMs();
    if (!Number.isFinite(time) || typeof key !== 'string' || key.length < 1 || key.length > 256) return false;
    const now = Math.max(highWater, time);
    highWater = now;
    const id = `${namespace}:${key}`;
    let bucket = buckets.get(id);
    if (!bucket) {
      if (buckets.size >= limits.maxRateLimitKeys) {
        for (const [oldKey, old] of buckets) if (old.fullAt <= now) buckets.delete(oldKey);
      }
      if (buckets.size >= limits.maxRateLimitKeys) return false;
      bucket = { credit: burst * 60_000, at: now, fullAt: now };
      buckets.set(id, bucket);
    }
    // Integer-scaled credit avoids fractional-token rounding at exact refill boundaries.
    bucket.credit = Math.min(burst * 60_000, bucket.credit + (now - bucket.at) * perMinute);
    bucket.at = now;
    const allowed = bucket.credit >= 60_000;
    if (allowed) bucket.credit -= 60_000;
    bucket.fullAt = now + (burst * 60_000 - bucket.credit) / perMinute;
    return allowed;
  }
  return Object.freeze({
    preAuth: (source: string) => take('source', source, limits.unauthenticatedBurstPerSource, limits.unauthenticatedRatePerMinutePerSource),
    postAuth: (principalId: string) => take('principal', principalId, limits.authenticatedBurstPerPrincipal, limits.authenticatedRatePerMinutePerPrincipal),
  });
}

function ip(value: unknown): string {
  if (typeof value !== 'string' || value.length > 45 || value.includes('%') || !isIP(value)) throw new Error('Invalid source');
  return isIP(value) === 6 ? new URL(`http://[${value}]`).hostname.slice(1, -1) : value;
}

/** Trust exact IPs only, no CIDRs/wildcards; caller supplies the raw socket peer. */
export function createSourceResolver(trustedProxies: unknown) {
  if (!Array.isArray(trustedProxies) || trustedProxies.length > 32) throw new Error('Invalid source');
  const trusted = new Set(trustedProxies.map(ip));
  if (trusted.size !== trustedProxies.length) throw new Error('Invalid source');
  return (peer: unknown, forwarded: unknown): string => {
    let source = ip(peer);
    if (!trusted.has(source) || forwarded === undefined) return source;
    if (typeof forwarded !== 'string' || forwarded.length > 1024 || /[\x00-\x1f\x7f]/.test(forwarded)) throw new Error('Invalid source');
    const parts = forwarded.split(',');
    if (parts.length > 16) throw new Error('Invalid source');
    const chain = parts.map(part => ip(part.trim()));
    for (let index = chain.length - 1; index >= 0 && trusted.has(source); index--) source = chain[index]!;
    return source;
  };
}

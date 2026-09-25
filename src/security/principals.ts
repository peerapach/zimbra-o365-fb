import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import type { ValidatedConfig } from '../config/validate.js';

export type Principal = Readonly<Pick<ValidatedConfig['principals'][number], 'id' | 'surface' | 'username' | 'allowedProvider'>>;
type Credential = { principal: Principal; digests: readonly Buffer[] };

/** Reader must return owned bytes, enforce maxBytes while reading, and reject symlinks/aliases. */
export function loadPrincipals(config: ValidatedConfig, read: (path: string, maxBytes: number) => unknown) {
  const credentials = new Map<string, Credential>();
  const seenDigests = new Set<string>();
  const dummy = Buffer.alloc(32);
  try {
    const paths = new Set([resolve(config.graph.certificateFile), resolve(config.zimbra.passwordFile)]);
    // Validate the complete path set before reading any credential.
    for (const p of config.principals) {
      const path = resolve(p.secretFile);
      if (paths.has(path) || Buffer.byteLength(p.username) > 128 || /[:\x00-\x1f\x7f]/.test(p.username)) {
        throw new Error('Invalid credentials');
      }
      paths.add(path);
    }
    for (const p of config.principals) {
      const bytes = read(p.secretFile, 130);
      if (!(bytes instanceof Uint8Array)) throw new Error('Invalid credentials');
      let digests: Buffer[];
      try {
        if (bytes.byteLength > 130) throw new Error('Invalid credentials');
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (!/^[0-9a-f]{64}(?:\n[0-9a-f]{64})?\n?$/.test(text)) throw new Error('Invalid credentials');
        const entries = text.trimEnd().split('\n');
        if (new Set(entries).size !== entries.length) throw new Error('Invalid credentials');
        if (entries.some(entry => seenDigests.has(entry))) throw new Error('Invalid credentials');
        for (const entry of entries) seenDigests.add(entry);
        digests = entries.map(entry => Buffer.from(entry, 'hex'));
      } finally {
        bytes.fill(0);
      }
      const { id, surface, username, allowedProvider } = p;
      credentials.set(username, { principal: Object.freeze({ id, surface, username, allowedProvider }), digests });
    }
  } catch {
    for (const entry of credentials.values()) for (const digest of entry.digests) digest.fill(0);
    throw new Error('Invalid credentials');
  }
  return Object.freeze({
    verify(username: string, digest: Uint8Array): Principal | undefined {
      const entry = credentials.get(username);
      const candidate = digest.byteLength === 32 ? digest : dummy;
      // Always two fixed-size comparisons: both rotation slots, including unknown users.
      const first = timingSafeEqual(candidate, entry?.digests[0] ?? dummy);
      const second = timingSafeEqual(candidate, entry?.digests[1] ?? entry?.digests[0] ?? dummy);
      return digest.byteLength === 32 && (first || second) ? entry?.principal : undefined;
    },
  });
}

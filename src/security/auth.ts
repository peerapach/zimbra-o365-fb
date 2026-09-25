import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import type { loadPrincipals, Principal } from './principals.js';

export const AUTH_FAILURE = Object.freeze({ ok: false, status: 401, challenge: 'Basic realm="freebusy", charset="UTF-8"', error: 'Unauthorized' } as const);
/** surface and secureTransport are listener-owned metadata, never HTTP header values. */
export interface AuthInput { readonly surface: unknown; readonly authorization: unknown; readonly secureTransport: boolean }

export function authenticate(registry: ReturnType<typeof loadPrincipals>, input: AuthInput): Principal | undefined {
  const { authorization, surface } = input;
  if (input.secureTransport !== true || (surface !== 'm365-inbound' && surface !== 'zimbra-inbound')
    || typeof authorization !== 'string' || authorization.length > 862) return undefined;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  if (!match) return undefined;
  const encoded = match[1]!;
  const decoded = Buffer.from(encoded, 'base64');
  let digest: Buffer | undefined;
  try {
    if (decoded.toString('base64') !== encoded) return undefined;
    // Keep decoded secret as bytes for hashing; strings cannot be reliably erased.
    const colon = decoded.indexOf(58);
    if (colon < 1 || colon > 128 || decoded.length - colon - 1 < 32 || decoded.length - colon - 1 > 512) return undefined;
    if (!isUtf8(decoded) || decoded.some(byte => byte < 32 || byte === 127)) return undefined;
    const username = decoded.subarray(0, colon).toString('utf8');
    digest = createHash('sha256').update(decoded.subarray(colon + 1)).digest();
    const principal = registry.verify(username, digest);
    const provider = surface === 'm365-inbound' ? 'zimbra' : 'graph';
    return principal?.surface === surface && principal.allowedProvider === provider ? principal : undefined;
  } catch {
    return undefined;
  } finally {
    decoded.fill(0);
    digest?.fill(0);
  }
}

export function withAuthentication<T>(registry: ReturnType<typeof loadPrincipals>, input: AuthInput, next: (principal: Principal) => T): T | typeof AUTH_FAILURE {
  const principal = authenticate(registry, input);
  return principal ? next(principal) : AUTH_FAILURE;
}

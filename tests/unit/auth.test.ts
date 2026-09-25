import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../../src/config/validate.js';
import { loadPrincipals } from '../../src/security/principals.js';
import { authenticate, AUTH_FAILURE, withAuthentication } from '../../src/security/auth.js';
import { createRateControls, createSourceResolver } from '../../src/security/rate-limit.js';

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

// Synthetic secrets only. Removing digest verification/rotation, surface checks,
// strict parsing, cap enforcement or trust checks breaks the respective cases.
const current = 'SYNTHETIC-new-2T8xY9mQ4kL7vR6pC3aZ';
const old = 'SYNTHETIC-old-9R7pC2mL4xV8aT6kY3qZ';
const privateSecret = 'SYNTHETIC-private-4K8pY2nC6aV9qR3xT';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const basic = (username = 'exo-interop', password = current) => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const input = () => JSON.parse(readFileSync('config/example.json', 'utf8')) as Record<string, unknown>;
const limits: unknown = JSON.parse(readFileSync('contracts/limits.json', 'utf8'));
const config = (value: unknown = input()) => validateConfig(value, { schemaVersion: 1, entries: [] }, limits, () => true);
const registry = (publicFile = `${sha(current)}\n${sha(old)}\n`) => loadPrincipals(config(), path => Buffer.from(path.endsWith('exo-interop') ? publicFile : sha(privateSecret)));
const request = (authorization: unknown = basic(), surface: unknown = 'm365-inbound', secureTransport = true) => ({ authorization, surface, secureTransport });
afterEach(() => vi.restoreAllMocks());

describe('dedicated principal credentials', () => {
  it('accepts current and overlap secrets and revokes old credentials on registry replacement', () => {
    const first = registry();
    expect(authenticate(first, request(basic()))?.id).toBe('pilot-exo');
    expect(authenticate(first, request(basic('exo-interop', old)))?.id).toBe('pilot-exo');
    const reloaded = registry(sha(current));
    expect(authenticate(reloaded, request(basic('exo-interop', old)))).toBeUndefined();
    expect(authenticate(reloaded, request(basic()))?.id).toBe('pilot-exo');
  });

  it.each(['', current, 'f'.repeat(63), 'g'.repeat(64), 'A'.repeat(64), `${sha(current)}\r\n`, `${sha(current)}\n\n`, `${sha(current)}\n${sha(current)}`, `${sha(current)}\n${sha(old)}\n${sha(privateSecret)}`, 'x'.repeat(131)])('rejects malformed, plaintext, duplicate or oversized digest files %#', file => {
    expect(() => registry(file)).toThrow(/^Invalid credentials$/);
  });

  it.each([null, {}, 'f'.repeat(64), Buffer.from([0xff])])('rejects non-byte or non-ASCII credential input %#', bytes => {
    expect(() => loadPrincipals(config(), () => bytes)).toThrow(/^Invalid credentials$/);
  });

  it('requests bounded reads, clears owned file bytes and sanitizes read errors', () => {
    const buffers: Buffer[] = [];
    loadPrincipals(config(), (path, maxBytes) => {
      expect(maxBytes).toBe(130);
      const bytes = Buffer.from(sha(path.endsWith('exo-interop') ? current : privateSecret));
      buffers.push(bytes);
      return bytes;
    });
    expect(buffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    expect(() => loadPrincipals(config(), () => { throw new Error('/secret/path CREDENTIAL-CANARY'); })).toThrow(/^Invalid credentials$/);
  });

  it('rejects a digest reused across principals even when file paths differ', () => {
    expect(() => loadPrincipals(config(), () => Buffer.from(sha(current)))).toThrow(/^Invalid credentials$/);
  });

  it.each(['/run/secrets/zimbra-interop', '/run/secrets/graph-certificate.pem', '/run/secrets/zimbra-password', '/run/secrets/../secrets/zimbra-interop'])('rejects reused principal/provider credential paths before any read %s', path => {
    const value = input();
    const principals = value.principals as Array<Record<string, unknown>>;
    principals[0]!.secretFile = path;
    const read = vi.fn(() => Buffer.from(sha(current)));
    expect(() => loadPrincipals(config(value), read)).toThrow(/^Invalid credentials$/);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['bad:name', 'x'.repeat(129)])('rejects usernames the bounded Basic protocol cannot represent %#', username => {
    const value = input();
    (value.principals as Array<Record<string, unknown>>)[0]!.username = username;
    expect(() => loadPrincipals(config(value), () => Buffer.from(sha(current)))).toThrow(/^Invalid credentials$/);
  });

  it('exposes only immutable principal fields and registry methods', () => {
    const loaded = registry();
    const principal = authenticate(loaded, request());
    expect(principal).toEqual({ id: 'pilot-exo', surface: 'm365-inbound', username: 'exo-interop', allowedProvider: 'zimbra' });
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Reflect.set(principal!, 'allowedProvider', 'graph')).toBe(false);
    expect(JSON.stringify(loaded)).toBe('{}');
    expect(JSON.stringify(principal)).not.toContain('/run/secrets');
    expect(JSON.stringify(principal)).not.toContain(sha(current));
  });
});

describe('strict Basic surface guard', () => {
  it('routes each authenticated listener to its fixed provider and invokes the continuation once', () => {
    const next = vi.fn(principal => principal.allowedProvider);
    expect(withAuthentication(registry(), request(), next)).toBe('zimbra');
    expect(withAuthentication(registry(), request(basic('zimbra-interop', privateSecret), 'zimbra-inbound'), next)).toBe('graph');
    expect(next).toHaveBeenCalledTimes(2);
  });

  it.each([
    undefined, null, [], '', 'Bearer CREDENTIAL-CANARY', 'Cookie x=y', 'Basic', 'Basic ',
    'Basic ****', 'Basic Zm9v', 'Basic Zm9vOmJhcg==', 'Basic Zm9vOmJhch==',
    `${basic()}\r\n`, `${basic()}\n`, ` ${basic()}`, basic().replace('Basic ', 'Basic  '),
    basic().replace('Basic ', 'Basic\t'), `${basic()}, ${basic()}`, basic().replace(/=+$/, ''),
    basic('exo-interop', ''), basic('exo-interop', 'x'.repeat(31)), basic('exo-interop', 'x'.repeat(513)),
    basic('', current), basic('x'.repeat(129), current), basic('exo\u0000-interop'),
    basic('exo-interop', `${current}\u0000`), basic('exo-interop', `${current}\n`),
    `Basic ${Buffer.concat([Buffer.from('exo-interop:'), Buffer.from([0xff]), Buffer.from(current)]).toString('base64')}`,
    'Basic ' + 'A'.repeat(2000), basic('unknown', current), basic('exo-interop', privateSecret),
  ])('never invokes XML/provider continuation for invalid header %#', authorization => {
    const next = vi.fn();
    const actual = withAuthentication(registry(), { ...request(), authorization }, next);
    expect(actual).toBe(AUTH_FAILURE);
    expect(next).not.toHaveBeenCalled();
    expect(Object.isFrozen(actual)).toBe(true);
    expect(JSON.stringify(actual)).not.toContain('CREDENTIAL-CANARY');
  });

  it.each(['zimbra-inbound', 'management', 'm365-inbound ', undefined, {}])('rejects otherwise valid credentials on wrong/unknown surface %#', surface => {
    const next = vi.fn();
    expect(withAuthentication(registry(), { ...request(), surface }, next)).toBe(AUTH_FAILURE);
    expect(next).not.toHaveBeenCalled();
  });

  it('requires trusted secure transport metadata and never logs credentials', () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    const next = vi.fn();
    expect(withAuthentication(registry(), request(basic(), 'm365-inbound', false), next)).toBe(AUTH_FAILURE);
    expect(withAuthentication(registry(), request('Bearer CREDENTIAL-CANARY'), next)).toBe(AUTH_FAILURE);
    expect(next).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('allows a colon in the secret and canonical UTF-8 username without stripping BOM', () => {
    const value = input();
    (value.principals as Array<Record<string, unknown>>)[0]!.username = 'ผู้ใช้';
    const password = `${current}:additional`;
    const loaded = loadPrincipals(config(value), path => Buffer.from(sha(path.endsWith('exo-interop') ? password : privateSecret)));
    expect(authenticate(loaded, request(basic('ผู้ใช้', password)))?.id).toBe('pilot-exo');
    expect(authenticate(loaded, request(basic('\uFEFFผู้ใช้', password)))).toBeUndefined();
  });

  it.each([32, 512])('accepts an independently stored secret at the %i-byte bound', size => {
    const password = 'x'.repeat(size);
    expect(authenticate(registry(sha(password)), request(basic('exo-interop', password)))?.id).toBe('pilot-exo');
  });

  it.each(['x'.repeat(31), 'x'.repeat(513), `${current}\u0000`, `${current}\n`])('rejects disallowed secret syntax even when its stored digest matches %#', password => {
    expect(authenticate(registry(sha(password)), request(basic('exo-interop', password)))).toBeUndefined();
  });

  it('rejects invalid UTF-8 even if the digest of its raw secret bytes matches', () => {
    const secret = Buffer.concat([Buffer.from(current), Buffer.from([0xff])]);
    const loaded = registry(createHash('sha256').update(secret).digest('hex'));
    const header = `Basic ${Buffer.concat([Buffer.from('exo-interop:'), secret]).toString('base64')}`;
    expect(authenticate(loaded, request(header))).toBeUndefined();
  });

  it('compares two 32-byte slots for current, old, wrong, unknown and single-digest users and erases transient digests', () => {
    const loaded = registry();
    for (const header of [basic(), basic('exo-interop', old), basic('exo-interop', privateSecret), basic('unknown', current)]) {
      vi.mocked(timingSafeEqual).mockClear();
      authenticate(loaded, request(header));
      const calls = vi.mocked(timingSafeEqual).mock.calls;
      expect(calls).toHaveLength(2);
      for (const [candidate, expected] of calls) {
        expect(candidate.byteLength).toBe(32);
        expect(expected.byteLength).toBe(32);
        expect(new Uint8Array(candidate.buffer, candidate.byteOffset, candidate.byteLength).every(byte => byte === 0)).toBe(true);
      }
    }
    const single = registry(sha(current));
    vi.mocked(timingSafeEqual).mockClear();
    expect(authenticate(single, request())?.id).toBe('pilot-exo');
    expect(vi.mocked(timingSafeEqual).mock.calls).toHaveLength(2);
  });

  it('supports the complete 128-byte username plus 512-byte secret header boundary', () => {
    const value = input();
    (value.principals as Array<Record<string, unknown>>)[0]!.username = 'u'.repeat(128);
    const password = 'x'.repeat(512);
    const loaded = loadPrincipals(config(value), path => Buffer.from(sha(path.endsWith('exo-interop') ? password : privateSecret)));
    expect(authenticate(loaded, request(basic('u'.repeat(128), password)))?.id).toBe('pilot-exo');
  });

  it('accepts case-insensitive Basic scheme and rejects noncanonical base64 pad bits', () => {
    expect(authenticate(registry(), request(basic().replace('Basic', 'bAsIc')))?.id).toBe('pilot-exo');
    const header = basic('exo-interop', `${current}x`);
    expect(header.endsWith('=')).toBe(true);
    const index = header.length - (header.endsWith('==') ? 3 : 2);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const changed = header.slice(0, index) + alphabet[alphabet.indexOf(header[index]!) + 1]! + header.slice(index + 1);
    expect(withAuthentication(registry(sha(`${current}x`)), request(changed), vi.fn())).toBe(AUTH_FAILURE);
  });
});

describe('bounded source and principal token buckets', () => {
  it('uses independent exact bursts and continuous per-minute refill without clock regression credit', () => {
    let now = 0;
    const rates = createRateControls(config().limits, () => now);
    for (let i = 0; i < 20; i++) expect(rates.preAuth('192.0.2.1')).toBe(true);
    expect(rates.preAuth('192.0.2.1')).toBe(false);
    for (let i = 0; i < 40; i++) expect(rates.postAuth('192.0.2.1')).toBe(true);
    expect(rates.postAuth('192.0.2.1')).toBe(false);
    now = 99;
    expect(rates.postAuth('192.0.2.1')).toBe(false);
    now = 100;
    expect(rates.postAuth('192.0.2.1')).toBe(true);
    now = 499;
    expect(rates.preAuth('192.0.2.1')).toBe(false);
    now = 500;
    expect(rates.preAuth('192.0.2.1')).toBe(true);
    now = 0;
    expect(rates.preAuth('192.0.2.1')).toBe(false);
    now = 999;
    expect(rates.preAuth('192.0.2.1')).toBe(false);
    now = 1000;
    expect(rates.preAuth('192.0.2.1')).toBe(true);
    now = 60_000;
    for (let i = 0; i < 20; i++) expect(rates.preAuth('192.0.2.1')).toBe(true);
    expect(rates.preAuth('192.0.2.1')).toBe(false);
  });

  it('rejects new keys at the shared hard cap without evicting consumed active buckets', () => {
    let now = 0;
    const rates = createRateControls(config().limits, () => now);
    for (let i = 0; i < 4999; i++) expect(rates.preAuth(`source-${i}`)).toBe(true);
    expect(rates.postAuth('principal')).toBe(true);
    expect(rates.preAuth('overflow')).toBe(false);
    expect(rates.postAuth('overflow')).toBe(false);
    for (let i = 1; i < 20; i++) expect(rates.preAuth('source-0')).toBe(true);
    expect(rates.preAuth('source-0')).toBe(false);
    now = 10_000;
    expect(rates.preAuth('new-source')).toBe(true);
  });

  it('denies invalid keys or nonfinite clock values without allocating state or creating credit', () => {
    let now = 0;
    const rates = createRateControls(config().limits, () => now);
    expect(rates.preAuth('')).toBe(false);
    expect(rates.preAuth('x'.repeat(257))).toBe(false);
    for (let i = 0; i < 20; i++) rates.preAuth('source');
    now = NaN;
    expect(rates.preAuth('source')).toBe(false);
    now = Infinity;
    expect(rates.preAuth('new')).toBe(false);
    now = 0;
    expect(rates.preAuth('source')).toBe(false);
  });
});

describe('trusted proxy source resolution', () => {
  it('ignores arbitrary forwarded headers from untrusted raw peers', () => {
    const resolve = createSourceResolver(['10.0.0.1']);
    expect(resolve('192.0.2.8', '198.51.100.9')).toBe('192.0.2.8');
    expect(resolve('192.0.2.8', ['bad', 'header'])).toBe('192.0.2.8');
    expect(resolve('192.0.2.8', 'x'.repeat(5000))).toBe('192.0.2.8');
  });

  it('strips only known hops from the right, never attacker-supplied leftmost identity', () => {
    const resolve = createSourceResolver(['10.0.0.1', '10.0.0.2', '2001:db8::1']);
    expect(resolve('10.0.0.1', '198.51.100.66, 192.0.2.8, 10.0.0.2')).toBe('192.0.2.8');
    expect(resolve('10.0.0.1', undefined)).toBe('10.0.0.1');
    expect(resolve('10.0.0.1', '10.0.0.2')).toBe('10.0.0.2');
    expect(resolve('2001:db8::1', '2001:0DB8:0:0:0:0:0:8')).toBe('2001:db8::8');
    expect(resolve('::ffff:192.0.2.8', undefined)).toBe('::ffff:c000:208');
  });

  it.each(['', 'unknown', '192.0.2.8:80', '[2001:db8::8]', 'fe80::1%eth0', '192.0.2.8,,10.0.0.2', '192.0.2.8\r\n', 'x'.repeat(1025), Array(17).fill('192.0.2.8').join(','), ['192.0.2.8']])('rejects malformed/overlong trusted proxy chains %#', header => {
    expect(() => createSourceResolver(['10.0.0.1'])('10.0.0.1', header)).toThrow(/^Invalid source$/);
  });

  it.each([undefined, null, {}, ['*'], ['10.0.0.0/8'], ['10.0.0.1:80'], ['fe80::1%eth0'], ['10.0.0.1', '10.0.0.1'], Array(33).fill('10.0.0.1')])('rejects unsafe trust configuration %#', trust => {
    expect(() => createSourceResolver(trust)).toThrow(/^Invalid source$/);
  });

  it.each([undefined, '', 'peer.example', '127.0.0.1:3000', 'fe80::1%eth0'])('rejects invalid raw socket address %#', peer => {
    expect(() => createSourceResolver([])(peer, '192.0.2.1')).toThrow(/^Invalid source$/);
  });
});

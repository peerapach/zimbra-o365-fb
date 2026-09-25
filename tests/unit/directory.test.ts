import { describe, expect, it, vi } from 'vitest';
import { loadDirectory } from '../../src/directory/load.js';
import type { Principal } from '../../src/security/principals.js';

const exo: Principal = Object.freeze({ id: 'exo', username: 'exo-user', surface: 'm365-inbound', allowedProvider: 'zimbra' });
const zimbra: Principal = Object.freeze({ id: 'zimbra', username: 'zimbra-user', surface: 'zimbra-inbound', allowedProvider: 'graph' });
const other: Principal = Object.freeze({ ...exo, id: 'other', username: 'other-user' });
const principals = [exo, zimbra, other];
const fixture = () => ({ schemaVersion: 1, entries: [
  { id: 'bob', provider: 'zimbra', canonicalSmtp: 'Bob@Example.Invalid', aliases: ['Bob@Zfb.Example.Invalid'], allowedPrincipals: ['exo'], enabled: true },
  { id: 'alice', provider: 'graph', canonicalSmtp: 'Alice@Example.Invalid', aliases: ['Alice+Availability@Example.Invalid'], allowedPrincipals: ['zimbra'], enabled: true, graphObjectId: '00000000-0000-0000-0000-000000000001' },
] });
const load = (input: unknown = fixture(), revision: unknown = 'policy-1') => loadDirectory(input, principals, revision);

describe('reviewed static directory', () => {
  it('resolves explicit aliases in a shared domain to their canonical provider identities', () => {
    const directory = load();
    expect(directory.resolveTarget(exo, 'm365-inbound', 'BOB@ZFB.EXAMPLE.INVALID')).toEqual({
      entryId: 'bob', provider: 'zimbra', canonicalSmtp: 'bob@example.invalid', configVersion: directory.configVersion,
    });
    expect(directory.resolveTarget(zimbra, 'zimbra-inbound', 'ALICE+AVAILABILITY@EXAMPLE.INVALID')).toEqual({
      entryId: 'alice', provider: 'graph', canonicalSmtp: 'alice@example.invalid',
      graphObjectId: '00000000-0000-0000-0000-000000000001', configVersion: directory.configVersion,
    });
  });

  it.each(['bob@example.invalid', 'BoB@Example.Invalid', 'bob@zfb.example.invalid'])('uses one canonical identity for %s', address => {
    expect(load().resolveTarget(exo, 'm365-inbound', address)?.entryId).toBe('bob');
  });

  it.each(['bob+tag@example.invalid', 'b.ob@example.invalid', 'missing@example.invalid', ' bob@example.invalid',
    'bob@example.invalid\n', 'bob@EXAMPLE.INVALID.', 'böb@example.invalid', 'boK@example.invalid',
    'bob@ｅxample.invalid', 'https://bob@example.invalid', 'bob@example.invalid/path', '', null, {}, 1])(
    'rejects malformed or unmapped input without guessing %j', address => {
      expect(load().resolveTarget(exo, 'm365-inbound', address)).toBeUndefined();
    },
  );

  it('rejects Unicode before case folding can turn it into a mapped ASCII identity', () => {
    const input = fixture();
    input.entries[0]!.aliases = ['bok@example.invalid'];
    const directory = load(input);
    expect(directory.resolveTarget(exo, 'm365-inbound', 'boK@example.invalid')).toBeUndefined();
    expect(directory.resolveTarget(exo, 'm365-inbound', 'BOK@example.invalid')?.entryId).toBe('bob');
  });

  it.each([
    (d: ReturnType<typeof fixture>) => { d.entries[1]!.canonicalSmtp = 'BOB@EXAMPLE.INVALID'; },
    (d: ReturnType<typeof fixture>) => { d.entries[1]!.aliases = ['BOB@ZFB.EXAMPLE.INVALID']; },
    (d: ReturnType<typeof fixture>) => { d.entries[1]!.aliases = ['BOB@EXAMPLE.INVALID']; },
    (d: ReturnType<typeof fixture>) => { d.entries[0]!.aliases.push('BOB@ZFB.EXAMPLE.INVALID'); },
    (d: ReturnType<typeof fixture>) => { d.entries[0]!.aliases.push('BOB@EXAMPLE.INVALID'); },
    (d: ReturnType<typeof fixture>) => { d.entries[1]!.id = 'bob'; },
    (d: ReturnType<typeof fixture>) => { d.entries[1]!.enabled = false; d.entries[1]!.aliases = ['bob@example.invalid']; },
    (d: ReturnType<typeof fixture>) => { d.entries[0]!.allowedPrincipals = ['zimbra']; },
    (d: ReturnType<typeof fixture>) => { d.entries[0]!.allowedPrincipals = ['missing']; },
    (d: ReturnType<typeof fixture>) => { d.entries[0]!.allowedPrincipals = ['exo', 'exo']; },
    (d: ReturnType<typeof fixture>) => { d.entries[0]!.canonicalSmtp = 'boK@example.invalid'; },
    (d: ReturnType<typeof fixture>) => { d.entries[0]!.aliases = ['boK@example.invalid']; },
    (d: ReturnType<typeof fixture>) => { d.entries[0]!.canonicalSmtp = 'bob..smith@example.invalid'; },
    (d: ReturnType<typeof fixture>) => { d.entries[0]!.graphObjectId = 'graph-id'; },
  ])('rejects ambiguous or invalid startup mapping %#', mutate => {
    const input = fixture();
    mutate(input);
    expect(() => load(input)).toThrow(/^Invalid directory$/);
  });

  it.each([null, [], {}, { schemaVersion: 2, entries: [] }, { schemaVersion: 1, entries: [null] },
    { schemaVersion: 1, entries: [], unexpected: 'sensitive' }])('rejects malformed unknown directory %j', input => {
      expect(() => load(input)).toThrow(/^Invalid directory$/);
    });

  it.each(['id', 'provider', 'canonicalSmtp', 'aliases', 'allowedPrincipals', 'enabled'])('requires entry field %s', key => {
    const input = fixture();
    Reflect.deleteProperty(input.entries[0]!, key);
    expect(() => load(input)).toThrow(/^Invalid directory$/);
  });

  it('copies entries and grants so source mutation cannot change authorization', () => {
    const input = fixture();
    const mutablePrincipals = principals.map(p => ({ ...p }));
    const directory = loadDirectory(input, mutablePrincipals, 'policy-1');
    input.entries[0]!.allowedPrincipals.push('other');
    input.entries[0]!.canonicalSmtp = 'attacker@example.invalid';
    mutablePrincipals[0]!.username = 'attacker';
    const result = directory.resolveTarget(exo, 'm365-inbound', 'bob@example.invalid');
    expect(result?.canonicalSmtp).toBe('bob@example.invalid');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(directory)).toBe(true);
    expect(directory.resolveTarget(other, 'm365-inbound', 'bob@example.invalid')).toBeUndefined();
  });
});

describe('authorization before downstream work', () => {
  it.each([
    [other, 'm365-inbound', 'bob@example.invalid'],
    [other, 'm365-inbound', 'missing@example.invalid'],
    [exo, 'zimbra-inbound', 'bob@example.invalid'],
    [zimbra, 'm365-inbound', 'alice@example.invalid'],
    [exo, 'm365-inbound', 'alice@example.invalid'],
    [zimbra, 'zimbra-inbound', 'bob@example.invalid'],
    [{ ...exo, allowedProvider: 'graph' }, 'm365-inbound', 'bob@example.invalid'],
    [{ ...exo, username: 'attacker' }, 'm365-inbound', 'bob@example.invalid'],
    [{ ...exo, id: 'missing' }, 'm365-inbound', 'bob@example.invalid'],
    [undefined, 'm365-inbound', 'bob@example.invalid'],
    [exo, 'management', 'bob@example.invalid'],
  ])('returns the same absence without touching a warm cache/provider %#', (principal, surface, address) => {
    const directory = load();
    const cache = new Map([['bob', 'cached-private-availability']]);
    const lookup = vi.fn(target => cache.get(target.entryId) ?? 'provider-result');
    expect(directory.withAuthorizedTarget(principal, surface, address, lookup)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('does not authorize disabled entries or entries with no grants', () => {
    for (const mode of ['disabled', 'ungranted']) {
      const input = fixture();
      if (mode === 'disabled') input.entries[0]!.enabled = false;
      else input.entries[0]!.allowedPrincipals = [];
      const lookup = vi.fn();
      expect(load(input).withAuthorizedTarget(exo, 'm365-inbound', 'bob@example.invalid', lookup)).toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
    }
  });

  it('passes only a frozen canonical target to authorized downstream work and preserves requested order/duplicates', () => {
    const directory = load();
    const addresses = ['bob@zfb.example.invalid', 'missing@example.invalid', 'BOB@EXAMPLE.INVALID'];
    const received: unknown[] = [];
    const results = addresses.map(address => directory.withAuthorizedTarget(exo, 'm365-inbound', address, target => {
      received.push(target);
      return target.canonicalSmtp;
    }));
    expect(results).toEqual(['bob@example.invalid', undefined, 'bob@example.invalid']);
    expect(received).toEqual([{
      entryId: 'bob', provider: 'zimbra', canonicalSmtp: 'bob@example.invalid', configVersion: directory.configVersion,
    }, {
      entryId: 'bob', provider: 'zimbra', canonicalSmtp: 'bob@example.invalid', configVersion: directory.configVersion,
    }]);
  });

  it('propagates downstream failures instead of turning them into availability', () => {
    expect(() => load().withAuthorizedTarget(exo, 'm365-inbound', 'bob@example.invalid', () => {
      throw new Error('backend unavailable');
    })).toThrow('backend unavailable');
  });
});

describe('configuration and policy cache isolation', () => {
  it('produces stable versions and changes versions when authorization/routing changes', () => {
    const version = load().configVersion;
    expect(version).toMatch(/^[a-f0-9]{64}$/);
    expect(load().configVersion).toBe(version);
    expect(load(fixture(), 'policy-2').configVersion).not.toBe(version);
    for (const mutate of [
      (d: ReturnType<typeof fixture>) => { d.entries[0]!.allowedPrincipals = []; },
      (d: ReturnType<typeof fixture>) => { d.entries[0]!.enabled = false; },
      (d: ReturnType<typeof fixture>) => { d.entries[0]!.aliases.push('another@example.invalid'); },
      (d: ReturnType<typeof fixture>) => { d.entries[0]!.canonicalSmtp = 'another@example.invalid'; },
      (d: ReturnType<typeof fixture>) => { d.entries[1]!.graphObjectId = '00000000-0000-0000-0000-000000000002'; },
    ]) {
      const input = fixture();
      mutate(input);
      expect(load(input).configVersion).not.toBe(version);
    }
    expect(loadDirectory(fixture(), [...principals, { ...exo, id: 'new', username: 'new' }], 'policy-1').configVersion).not.toBe(version);
  });

  it.each(['', ' ', ' policy ', null, 1, 'policy\nsecret'])('requires an explicit valid policy revision %j', revision => {
    expect(() => load(fixture(), revision)).toThrow(/^Invalid directory$/);
  });

  it.each([
    [...principals, exo],
    [exo, { ...zimbra, allowedProvider: 'zimbra' }],
    [exo, { ...zimbra, username: exo.username }],
  ].map(input => [input]))('rejects ambiguous principal registrations %#', input => {
    expect(() => loadDirectory(fixture(), input, 'policy-1')).toThrow(/^Invalid directory$/);
  });
});

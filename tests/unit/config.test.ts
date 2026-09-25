import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/load.js';
import { validateConfig } from '../../src/config/validate.js';

const limits: unknown = JSON.parse(readFileSync('contracts/limits.json', 'utf8'));
const exists = () => true;
const fixture = () => ({
  schemaVersion: 1,
  environment: 'lab',
  liveAccessEnabled: false,
  public: { bind: '127.0.0.1', port: 8080, advertisedOrigin: 'https://fb.example.invalid' },
  private: { bind: '127.0.0.1', port: 8081 },
  management: { bind: '127.0.0.1', port: 8082 },
  graph: {
    cloud: 'public', baseUrl: 'https://graph.microsoft.com/v1.0',
    tenantId: 'REPLACE_WITH_APPROVED_TENANT_ID', clientId: 'REPLACE_WITH_APPROVED_APP_ID',
    certificateFile: '/run/secrets/graph-certificate.pem',
  },
  zimbra: {
    soapUrl: 'https://mail.example.invalid/service/soap',
    account: 'freebusy-service@example.invalid', passwordFile: '/run/secrets/zimbra-password',
  },
  principals: [
    { id: 'exo', surface: 'm365-inbound', username: 'exo-interop', secretFile: '/run/secrets/exo', allowedProvider: 'zimbra' },
    { id: 'zimbra', surface: 'zimbra-inbound', username: 'zimbra-interop', secretFile: '/run/secrets/zimbra', allowedProvider: 'graph' },
  ],
  directoryFile: 'directory.json', limitsFile: 'limits.json', protocolProfilesFile: 'profiles.json',
});
const directory = () => ({
  schemaVersion: 1,
  entries: [
    { id: 'bob', provider: 'zimbra', canonicalSmtp: 'bob@example.org', aliases: ['bob@alias.example.org'], allowedPrincipals: ['exo'], enabled: true },
    { id: 'alice', provider: 'graph', canonicalSmtp: 'alice@example.org', aliases: [], allowedPrincipals: ['zimbra'], enabled: true },
  ],
});
const production = () => {
  const config = fixture();
  config.environment = 'production';
  config.liveAccessEnabled = true;
  config.public.advertisedOrigin = 'https://fb.example.org';
  config.graph.tenantId = '83bf3931-c871-4bc6-ad65-45a9102b64f0';
  config.graph.clientId = '67a12cd1-844a-4e62-aecf-985e0d7dfb03';
  config.zimbra.soapUrl = 'https://mail.example.org/service/soap';
  config.zimbra.account = 'freebusy-service@example.org';
  return config;
};
const validate = (config: unknown = fixture(), entries: unknown = directory(), policy: unknown = limits) =>
  validateConfig(config, entries, policy, exists);

describe('fail-closed configuration', () => {
  it('accepts explicit inert lab configuration and preserves fixed routing', () => {
    const config = validate();
    expect(config.environment).toBe('lab');
    expect(config.liveAccessEnabled).toBe(false);
    expect(config.principals.map(p => [p.surface, p.allowedProvider])).toEqual([
      ['m365-inbound', 'zimbra'], ['zimbra-inbound', 'graph'],
    ]);
  });

  it('accepts explicit production configuration with validated file references', () => {
    const config = validate(production());
    expect(config.graph.certificateFile).toBe('/run/secrets/graph-certificate.pem');
    expect(config.liveAccessEnabled).toBe(true);
  });

  it.each([null, [], {}, true, 'config'])('rejects malformed config %j', config => {
    expect(() => validate(config)).toThrow(/Invalid configuration/);
  });

  it.each(Object.keys(fixture()))('requires config field %s', key => {
    const config: Record<string, unknown> = fixture();
    delete config[key];
    expect(() => validate(config)).toThrow(/Invalid configuration/);
  });

  it.each([
    (c: ReturnType<typeof fixture>) => { c.environment = 'prod'; },
    (c: ReturnType<typeof fixture>) => { c.environment = 'production'; },
    (c: ReturnType<typeof fixture>) => { c.liveAccessEnabled = true; },
    (c: ReturnType<typeof fixture>) => { c.public.bind = '0.0.0.0'; },
    (c: ReturnType<typeof fixture>) => { c.management.bind = '10.1.1.1'; },
    (c: ReturnType<typeof fixture>) => { c.graph.baseUrl = 'https://outlook.office365.com/EWS/Exchange.asmx'; },
    (c: ReturnType<typeof fixture>) => { c.graph.cloud = 'unrecognized'; },
    (c: ReturnType<typeof fixture>) => { c.zimbra.soapUrl = 'http://mail.example.invalid/service/soap'; },
    (c: ReturnType<typeof fixture>) => { c.zimbra.soapUrl = 'https://user:password@mail.example.invalid/service/soap'; },
    (c: ReturnType<typeof fixture>) => { c.zimbra.soapUrl += '?url=https://other.invalid'; },
    (c: ReturnType<typeof fixture>) => { c.zimbra.soapUrl = 'https://mail.example.invalid/other'; },
    (c: ReturnType<typeof fixture>) => { c.public.advertisedOrigin += '/path'; },
    (c: ReturnType<typeof fixture>) => { c.private.port = c.public.port; },
    (c: ReturnType<typeof fixture>) => { c.principals[0]!.allowedProvider = 'graph'; },
    (c: ReturnType<typeof fixture>) => { c.principals[1]!.allowedProvider = 'zimbra'; },
    (c: ReturnType<typeof fixture>) => { c.principals[0]!.surface = 'management'; },
    (c: ReturnType<typeof fixture>) => { c.principals[1]!.id = 'exo'; },
    (c: ReturnType<typeof fixture>) => { c.principals = []; },
  ])('rejects unsafe lab configuration case %#', mutate => {
    const config = fixture();
    mutate(config);
    expect(() => validate(config)).toThrow(/Invalid configuration/);
  });

  it.each([-1, 0, 65536, 1.5, NaN, Infinity, '8080', null])('rejects invalid port %s', port => {
    const config = fixture();
    expect(() => validate({ ...config, private: { ...config.private, port } })).toThrow(/Invalid configuration/);
  });

  it.each([
    (c: ReturnType<typeof fixture>) => { c.graph.tenantId = 'REPLACE_WITH_APPROVED_TENANT_ID'; },
    (c: ReturnType<typeof fixture>) => { c.graph.clientId = '00000000-0000-0000-0000-000000000001'; },
    (c: ReturnType<typeof fixture>) => { c.public.advertisedOrigin = 'https://fb.EXAMPLE.INVALID.'; },
    (c: ReturnType<typeof fixture>) => { c.zimbra.soapUrl = 'https://mail.invalid/service/soap'; },
    (c: ReturnType<typeof fixture>) => { c.zimbra.account = 'service@example.invalid'; },
    (c: ReturnType<typeof fixture>) => { c.public.advertisedOrigin = 'http://fb.example.org'; },
    (c: ReturnType<typeof fixture>) => { c.zimbra.soapUrl = 'http://mail.example.org/service/soap'; },
    (c: ReturnType<typeof fixture>) => { c.graph.baseUrl = 'http://graph.microsoft.com/v1.0'; },
    (c: ReturnType<typeof fixture>) => { c.public.bind = '0.0.0.0'; },
  ])('rejects unsafe production configuration case %#', mutate => {
    const config = production();
    mutate(config);
    expect(() => validate(config)).toThrow(/Invalid configuration/);
  });

  it.each(['/run/secrets/graph-certificate.pem', '/run/secrets/zimbra-password', '/run/secrets/exo', '/run/secrets/zimbra'])('rejects missing secret file %s', missing => {
    expect(() => validateConfig(production(), directory(), limits, path => path !== missing)).toThrow(/Invalid configuration/);
  });

  it.each([
    (d: ReturnType<typeof directory>) => { d.entries[1]!.canonicalSmtp = 'BOB@EXAMPLE.ORG'; },
    (d: ReturnType<typeof directory>) => { d.entries[1]!.aliases = ['BOB@ALIAS.EXAMPLE.ORG']; },
    (d: ReturnType<typeof directory>) => { d.entries[1]!.aliases = ['BOB@EXAMPLE.ORG']; },
    (d: ReturnType<typeof directory>) => { d.entries[0]!.aliases.push('BOB@EXAMPLE.ORG'); },
    (d: ReturnType<typeof directory>) => { d.entries[1]!.id = 'bob'; },
    (d: ReturnType<typeof directory>) => { d.entries[0]!.allowedPrincipals = ['zimbra']; },
    (d: ReturnType<typeof directory>) => { d.entries[0]!.allowedPrincipals = ['missing']; },
    (d: ReturnType<typeof directory>) => { d.entries[0]!.provider = 'fake'; },
    (d: ReturnType<typeof directory>) => { d.entries[0]!.canonicalSmtp = 'no-address'; },
  ])('rejects ambiguous or invalid identity mapping case %#', mutate => {
    const entries = directory();
    mutate(entries);
    expect(() => validate(fixture(), entries)).toThrow(/Invalid configuration/);
  });

  it('rejects .invalid production directory identities', () => {
    const entries = directory();
    entries.entries[0]!.aliases = ['bob@example.invalid'];
    expect(() => validate(production(), entries)).toThrow(/Invalid configuration/);
  });

  describe.each(['.bob@example.org', 'bob.@example.org', 'bo..b@example.org'])('malformed local part in %s', address => {
    it('rejects a canonical SMTP address', () => {
      const entries = directory();
      entries.entries[0]!.canonicalSmtp = address;
      expect(() => validate(production(), entries)).toThrow(/Invalid configuration/);
    });

    it('rejects an SMTP alias', () => {
      const entries = directory();
      entries.entries[0]!.aliases = [address];
      expect(() => validate(production(), entries)).toThrow(/Invalid configuration/);
    });

    it('rejects the Zimbra service account', () => {
      const config = production();
      config.zimbra.account = address;
      expect(() => validate(config)).toThrow(/Invalid configuration/);
    });
  });

  it('accepts nonempty dot-separated atoms in every SMTP field', () => {
    const input = production();
    const entries = directory();
    input.zimbra.account = 'Freebusy.Service+Pilot@example.org';
    entries.entries[0]!.canonicalSmtp = 'Bob.Smith@example.org';
    entries.entries[0]!.aliases = ['Bob.Alias+Pilot@example.org'];
    const config = validate(input, entries);
    expect(config.zimbra.account).toBe('freebusy.service+pilot@example.org');
    expect(config.directory.entries[0]!.canonicalSmtp).toBe('bob.smith@example.org');
    expect(config.directory.entries[0]!.aliases).toEqual(['bob.alias+pilot@example.org']);
  });

  it.each([null, {}, [], { schemaVersion: 1 }, { schemaVersion: 1, entries: [null] }])('rejects malformed directory %j', entries => {
    expect(() => validate(fixture(), entries)).toThrow(/Invalid configuration/);
  });

  it.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, '262144', 262145])('rejects invalid or changed policy limit %s', maxRequestBytes => {
    expect(() => validate(fixture(), directory(), { ...(limits as object), maxRequestBytes })).toThrow(/Invalid configuration/);
  });

  it('requires every frozen policy field and rejects extra ones', () => {
    for (const key of Object.keys(limits as object)) {
      const policy = { ...(limits as Record<string, unknown>) };
      delete policy[key];
      expect(() => validate(fixture(), directory(), policy)).toThrow(/Invalid configuration/);
    }
    expect(() => validate(fixture(), directory(), { ...(limits as object), futureLimit: 1 })).toThrow(/Invalid configuration/);
  });

  it('rejects undeclared properties instead of exporting inline secrets', () => {
    const config = production();
    expect(() => validate({ ...config, graph: { ...config.graph, clientSecret: 'unexpected' } })).toThrow(/Invalid configuration/);
    expect(() => validate({ ...config, secret: 'unexpected' })).toThrow(/Invalid configuration/);
  });

  it('does not expose untrusted values in validation errors', () => {
    const config = production();
    config.graph.baseUrl = 'https://user:do-not-log@graph.microsoft.com/v1.0';
    expect(() => validate(config)).toThrow(/^Invalid configuration$/);
  });

  it('copies and freezes routing, directory, and limits against later mutation', () => {
    const input = fixture();
    const entries = directory();
    const config = validate(input, entries);
    input.principals[0]!.allowedProvider = 'graph';
    entries.entries[0]!.allowedPrincipals.push('zimbra');
    expect(config.principals[0]!.allowedProvider).toBe('zimbra');
    expect(config.directory.entries[0]!.allowedPrincipals).toEqual(['exo']);
    expect(() => Reflect.set(config.principals[0]!, 'allowedProvider', 'graph')).not.toThrow();
    expect(Reflect.set(config.principals[0]!, 'allowedProvider', 'graph')).toBe(false);
    expect(Object.isFrozen(config.principals)).toBe(true);
    expect(Object.isFrozen(config.directory.entries[0]!.aliases)).toBe(true);
    expect(Object.isFrozen(config.limits)).toBe(true);
    expect(Object.isFrozen(config.graph)).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe('configuration file loading', () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });
  const files = () => {
    const folder = mkdtempSync(join(tmpdir(), 'freebusy-config-'));
    folders.push(folder);
    const secret = join(folder, 'secret');
    writeFileSync(secret, '');
    const config = fixture();
    config.graph.certificateFile = secret;
    config.zimbra.passwordFile = secret;
    for (const principal of config.principals) principal.secretFile = secret;
    writeFileSync(join(folder, 'config.json'), JSON.stringify(config));
    writeFileSync(join(folder, 'directory.json'), JSON.stringify(directory()));
    writeFileSync(join(folder, 'limits.json'), JSON.stringify(limits));
    return { folder, config, path: join(folder, 'config.json') };
  };

  it('loads unknown JSON and resolves data files relative to the config file', () => {
    const { path } = files();
    expect(loadConfig(path).directory.entries[0]!.canonicalSmtp).toBe('bob@example.org');
  });

  it.each(['config.json', 'directory.json', 'limits.json', 'secret'])('rejects a missing required file %s', file => {
    const { folder, path } = files();
    rmSync(join(folder, file));
    expect(() => loadConfig(path)).toThrow(/^Invalid configuration$/);
  });

  it.each(['config.json', 'directory.json', 'limits.json'])('rejects malformed JSON in %s without leaking text', file => {
    const { folder, path } = files();
    writeFileSync(join(folder, file), '{do-not-log');
    expect(() => loadConfig(path)).toThrow(/^Invalid configuration$/);
  });

  it('rejects a directory used as a secret file', () => {
    const { folder, config, path } = files();
    config.graph.certificateFile = folder;
    writeFileSync(path, JSON.stringify(config));
    expect(() => loadConfig(path)).toThrow(/^Invalid configuration$/);
  });
});

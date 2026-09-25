import { isAbsolute } from 'node:path';

// Frozen policy: changing these values requires controller approval.
const policy = Object.freeze({
  contractVersion: 1,
  kind: 'proposed-initial-policy-not-benchmark',
  maxRequestBytes: 262144,
  maxXmlDepth: 32,
  maxXmlNodes: 10000,
  maxAttributesPerElement: 32,
  maxXmlTextNodeChars: 16384,
  maxTargetsPerRequest: 100,
  maxRangeDays: 61,
  minIntervalMinutes: 5,
  maxIntervalMinutes: 1440,
  maxGridSlotsPerTarget: 17568,
  maxUpstreamResponseBytes: 4194304,
  maxResponseBytes: 8388608,
  totalRequestDeadlineMs: 8000,
  providerAttemptTimeoutMs: 3000,
  responseReserveMs: 250,
  maxTransientRetries: 1,
  graphConcurrentCallsPerInstance: 4,
  zimbraConcurrentCallsPerInstance: 4,
  maxActiveRequestsPerInstance: 32,
  maxQueuedProviderJobsPerInstance: 128,
  cacheTtlMs: 30000,
  cacheMaxEntries: 5000,
  cacheMaxEstimatedBytes: 33554432,
  shutdownGraceMs: 10000,
  initialPilotConcurrentRequests: 20,
  initialPilotTypicalTargetCount: 20,
  maxHeaderBytes: 16384,
  bodyReceiveTimeoutMs: 5000,
  keepAliveTimeoutMs: 5000,
  unauthenticatedRatePerMinutePerSource: 120,
  unauthenticatedBurstPerSource: 20,
  authenticatedRatePerMinutePerPrincipal: 600,
  authenticatedBurstPerPrincipal: 40,
  maxRateLimitKeys: 5000,
});
const routing = Object.freeze({ 'm365-inbound': 'zimbra', 'zimbra-inbound': 'graph' } as const);

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid configuration');
}
function object(value: unknown, required: string, optional = ''): Record<string, unknown> {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value));
  const result = value as Record<string, unknown>;
  requireValid(required.split(' ').every(key => Object.hasOwn(result, key)));
  requireValid(Object.keys(result).every(key => `${required} ${optional}`.split(' ').includes(key)));
  return result;
}
function text(value: unknown): string {
  requireValid(typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value));
  return value;
}
function array<T>(value: unknown, parse: (item: unknown) => T): readonly T[] {
  requireValid(Array.isArray(value));
  return Object.freeze(value.map(parse));
}
function unique(value: string, seen: Set<string>): string {
  requireValid(!seen.has(value));
  seen.add(value);
  return value;
}

export function validateConfig(input: unknown, directoryInput: unknown, limitsInput: unknown, secretFileExists: (path: string) => boolean) {
  const c = object(input, 'schemaVersion environment liveAccessEnabled public private management graph zimbra principals directoryFile limitsFile protocolProfilesFile');
  requireValid(c.schemaVersion === 1 && (c.environment === 'lab' || c.environment === 'production'));
  const production = c.environment === 'production';
  requireValid(c.liveAccessEnabled === production);
  const id = (value: unknown) => {
    const result = text(value);
    requireValid(!production || !/replace|placeholder|change.?me/i.test(result));
    return result;
  };
  const uuid = (value: unknown) => {
    const result = id(value);
    requireValid(!production || (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result) && !/^00000000-0000-/.test(result)));
    return result;
  };
  const liveHost = (host: string) => requireValid(!production || !/(^|\.)invalid\.?$/i.test(host));
  const smtp = (value: unknown) => {
    const result = text(value).toLowerCase();
    requireValid(/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(result));
    liveHost(result.split('@')[1]!);
    return result;
  };
  const url = (value: unknown, path: string) => {
    const result = text(value);
    let parsed: URL;
    try { parsed = new URL(result); } catch { throw new Error('Invalid configuration'); }
    requireValid(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === path);
    liveHost(parsed.hostname);
    return parsed.href;
  };
  const secret = (value: unknown) => {
    const path = text(value);
    requireValid(isAbsolute(path) && secretFileExists(path) === true);
    return path;
  };
  const ports = new Set<number>();
  const listener = (value: unknown, advertised = false) => {
    const l = object(value, advertised ? 'bind port advertisedOrigin' : 'bind port');
    requireValid(l.bind === '127.0.0.1' || l.bind === '::1');
    requireValid(typeof l.port === 'number' && Number.isSafeInteger(l.port) && l.port >= 1 && l.port <= 65535 && !ports.has(l.port));
    ports.add(l.port);
    return Object.freeze({ bind: l.bind, port: l.port });
  };
  const publicInput = object(c.public, 'bind port advertisedOrigin');
  const publicListener = Object.freeze({ ...listener(c.public, true), advertisedOrigin: url(publicInput.advertisedOrigin, '/') });
  const privateListener = listener(c.private);
  const management = listener(c.management);
  const g = object(c.graph, 'cloud baseUrl tenantId clientId certificateFile');
  requireValid(g.cloud === 'public' && g.baseUrl === 'https://graph.microsoft.com/v1.0');
  const graph = Object.freeze({ cloud: g.cloud, baseUrl: g.baseUrl, tenantId: uuid(g.tenantId), clientId: uuid(g.clientId), certificateFile: secret(g.certificateFile) });
  const z = object(c.zimbra, 'soapUrl account passwordFile');
  const zimbra = Object.freeze({ soapUrl: url(z.soapUrl, '/service/soap'), account: smtp(z.account), passwordFile: secret(z.passwordFile) });
  const principalIds = new Set<string>();
  const usernames = new Set<string>();
  const principals = array(c.principals, item => {
    const p = object(item, 'id surface username secretFile allowedProvider');
    const surface = p.surface;
    requireValid(surface === 'm365-inbound' || surface === 'zimbra-inbound');
    const allowedProvider = routing[surface];
    requireValid(p.allowedProvider === allowedProvider);
    return Object.freeze({ id: unique(id(p.id), principalIds), surface, username: unique(text(p.username), usernames), secretFile: secret(p.secretFile), allowedProvider });
  });
  requireValid(Object.keys(routing).every(surface => principals.some(p => p.surface === surface)));
  const d = object(directoryInput, 'schemaVersion entries');
  requireValid(d.schemaVersion === 1);
  const entryIds = new Set<string>();
  const addresses = new Set<string>();
  const entries = array(d.entries, item => {
    const e = object(item, 'id provider canonicalSmtp aliases allowedPrincipals enabled', 'graphObjectId');
    const provider = e.provider;
    requireValid(provider === 'graph' || provider === 'zimbra');
    requireValid(typeof e.enabled === 'boolean' && (provider === 'graph' || e.graphObjectId === undefined));
    const canonicalSmtp = unique(smtp(e.canonicalSmtp), addresses);
    const aliases = array(e.aliases, alias => unique(smtp(alias), addresses));
    const grants = new Set<string>();
    const allowedPrincipals = array(e.allowedPrincipals, value => {
      const principalId = unique(text(value), grants);
      requireValid(principals.some(p => p.id === principalId && p.allowedProvider === provider));
      return principalId;
    });
    return Object.freeze({ id: unique(id(e.id), entryIds), provider, canonicalSmtp, aliases, allowedPrincipals, enabled: e.enabled,
      ...(e.graphObjectId === undefined ? {} : { graphObjectId: uuid(e.graphObjectId) }) });
  });
  const limits = object(limitsInput, Object.keys(policy).join(' '));
  for (const [key, value] of Object.entries(policy)) {
    requireValid(limits[key] === value && (typeof value !== 'number' || Number.isSafeInteger(limits[key])));
  }
  return Object.freeze({ schemaVersion: 1, environment: c.environment, liveAccessEnabled: c.liveAccessEnabled,
    public: publicListener, private: privateListener, management, graph, zimbra, principals,
    directoryFile: text(c.directoryFile), limitsFile: text(c.limitsFile), protocolProfilesFile: text(c.protocolProfilesFile),
    directory: Object.freeze({ schemaVersion: 1, entries }), limits: policy, routing });
}

export type ValidatedConfig = ReturnType<typeof validateConfig>;

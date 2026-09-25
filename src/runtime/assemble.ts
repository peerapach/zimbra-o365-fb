import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ClientCertificateCredential } from '@azure/identity';
import { encodePoxSettings } from '../autodiscover/response.js';
import { validateConfig } from '../config/validate.js';
import type { Clock } from '../core/types.js';
import { createOutboundTransport } from '../http/outbound.js';
import type { SurfaceListener } from '../http/listeners.js';
import { startGateway } from '../main.js';
import { createGraphTokenSource } from '../providers/graph-token.js';
import { createGraphProvider } from '../providers/graph.js';
import { createZimbraSession } from '../providers/zimbra-auth.js';
import { createZimbraProvider } from '../providers/zimbra.js';
import { loadPrincipals } from '../security/principals.js';
import { createMetrics } from '../observability/metrics.js';

export interface RuntimeOptions {
  readonly ingressApproved: boolean;
  readonly fetcher?: typeof fetch;
  readonly clock?: Pick<Clock, 'wallMs' | 'monoMs'>;
  readonly listen?: (app: SurfaceListener, address: { host: string; port: number }) => Promise<unknown>;
}

function requireValid(value: unknown): asserts value {
  if (!value) throw new Error('Gateway runtime unavailable');
}

/** Direct mounts only: no path spelling aliases, parent symlinks or hard links. */
function secretStat(path: string) {
  requireValid(isAbsolute(path) && path === resolve(path) && !/[\x00-\x1f\x7f]/.test(path));
  const components = path.split('/').filter(Boolean);
  let current = '';
  for (const component of components) {
    current += `/${component}`;
    const stat = lstatSync(current);
    requireValid(!stat.isSymbolicLink() && (current === path || stat.isDirectory()));
  }
  const stat = lstatSync(path);
  requireValid(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o177) === 0 && stat.uid === process.getuid?.());
  return stat;
}

/** Read at most maxBytes + 1, including short reads; caller owns returned bytes. */
function readBounded(path: string, maxBytes: number, secret = false): Buffer {
  const expected = secret ? secretStat(path) : undefined;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const scratch = Buffer.alloc(maxBytes + 1);
  try {
    const stat = fstatSync(fd);
    requireValid(stat.isFile() && stat.size <= maxBytes);
    if (expected) {
      requireValid(stat.dev === expected.dev && stat.ino === expected.ino && stat.nlink === 1
        && (stat.mode & 0o177) === 0 && stat.uid === process.getuid?.());
      const after = secretStat(path);
      requireValid(after.dev === stat.dev && after.ino === stat.ino);
    }
    let count = 0;
    while (count < scratch.length) {
      const read = readSync(fd, scratch, count, scratch.length - count, null);
      if (!read) break;
      count += read;
    }
    requireValid(count <= maxBytes);
    return Buffer.from(scratch.subarray(0, count));
  } finally { scratch.fill(0); closeSync(fd); }
}

function textFile(path: string, maxBytes: number, secret = false): string {
  const bytes = readBounded(path, maxBytes, secret);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  finally { bytes.fill(0); }
}
function record(value: unknown): Record<string, unknown> {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function json(path: string): unknown {
  return JSON.parse(textFile(path, 262144)) as unknown;
}
function validateProfile(profile: unknown, origin: string): void {
  requireValid(encodePoxSettings(origin, profile) !== undefined);
  const ews = record(record(profile).ews);
  requireValid(ews.soapVersion === '1.1' && ews.responsePolicy === 'FreeBusyMerged-without-private-details'
    && ews.gateEvidence === null && Array.isArray(ews.acceptedViews)
    && JSON.stringify(ews.acceptedViews) === JSON.stringify(['MergedOnly', 'FreeBusy', 'FreeBusyMerged', 'Detailed', 'DetailedMerged']));
}

export async function startConfiguredGateway(path: string, options: RuntimeOptions): ReturnType<typeof startGateway> {
  try {
    requireValid(options.ingressApproved === true && isAbsolute(path));
    const input = record(json(path));
    const reference = (name: string): string => {
      const value = input[name];
      requireValid(typeof value === 'string' && value.length > 0);
      return resolve(dirname(path), value);
    };
    const directoryInput = json(reference('directoryFile'));
    const limitsInput = json(reference('limitsFile'));
    const protocolProfile = json(reference('protocolProfilesFile'));
    // All credential files are checked with the direct bounded reader below.
    const config = validateConfig(input, directoryInput, limitsInput, () => true);
    requireValid(config.liveAccessEnabled || (options.fetcher !== undefined && options.fetcher !== globalThis.fetch));
    validateProfile(protocolProfile, config.public.advertisedOrigin);
    const paths = [config.graph.certificateFile, config.zimbra.passwordFile, ...config.principals.map(p => p.secretFile)];
    requireValid(new Set(paths).size === paths.length);
    const certificate = textFile(config.graph.certificateFile, 65536, true);
    const x509 = new X509Certificate(certificate);
    const publicKey = createPublicKey(createPrivateKey(certificate)).export({ format: 'der', type: 'spki' });
    requireValid(x509.publicKey.export({ format: 'der', type: 'spki' }).equals(publicKey));
    const readPassword = (): string => {
      const password = textFile(config.zimbra.passwordFile, 4096, true);
      requireValid(password.length > 0 && !/[\x00-\x1f\x7f]/.test(password));
      return password;
    };
    readPassword();
    const registry = loadPrincipals(config, (file, cap) => readBounded(file, cap, true));
    const clock = options.clock ?? { wallMs: Date.now, monoMs: () => performance.now() };
    const fetcher = options.fetcher ?? globalThis.fetch;
    const entries = config.directory.entries.filter(entry => entry.enabled);
    const metrics = createMetrics();
    const transport = createOutboundTransport({ graphTargets: entries.filter(entry => entry.provider === 'graph')
      .map(entry => entry.graphObjectId ?? entry.canonicalSmtp), zimbraSoapUrl: config.zimbra.soapUrl,
    maxResponseBytes: config.limits.maxUpstreamResponseBytes, timeoutMs: config.limits.providerAttemptTimeoutMs,
    telemetry: { monoMs: () => clock.monoMs(), provider: metrics.provider } }, fetcher);
    const tokenSource = createGraphTokenSource(config.graph, clock, (tenant, client, _path, credentialOptions) =>
      new ClientCertificateCredential(tenant, client, { certificate }, credentialOptions), fetcher);
    const session = createZimbraSession(config.zimbra, transport, clock, async () => readPassword());
    const providers = {
      graph: createGraphProvider({ transport, tokenSource, wallMs: () => clock.wallMs(), monoMs: () => clock.monoMs() }),
      zimbra: createZimbraProvider({ soapUrl: config.zimbra.soapUrl, transport, session, clock,
        approvedTargets: entries.filter(entry => entry.provider === 'zimbra').map(entry => ({
          entryId: entry.id, provider: entry.provider, canonicalSmtp: entry.canonicalSmtp,
        })) }),
    };
    const policyRevision = createHash('sha256').update(JSON.stringify([input, directoryInput, limitsInput, protocolProfile])).digest('hex');
    return await startGateway(path, { load: () => config, metrics, ...(options.listen ? { listen: options.listen } : {}),
      runtime: { registry, providers, monoMs: () => clock.monoMs(), secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true },
        policyRevision, protocolProfile, directoryInput } });
  } catch { throw new Error('Gateway runtime unavailable'); }
}

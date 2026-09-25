import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { AvailabilityProvider, Provider, TargetResult, WindowUtc } from '../src/core/types.js';
import { loadDirectory } from '../src/directory/load.js';
import { createFreeBusyService } from '../src/freebusy/service.js';
import { validateConfig } from '../src/config/validate.js';
import { startGateway } from '../src/main.js';
import { loadPrincipals } from '../src/security/principals.js';

const window = Object.freeze({ startMs: 1789351200000, endMs: 1789354800000, intervalMinutes: 30 });
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
export const LAB_SECRET = 'W30-synthetic-only-password-00000000';
function labOnly() {
  if (process.env.NODE_ENV === 'production') throw new Error('Load lab forbidden in production');
}

export function summarizeOutcomes(results: readonly TargetResult[], requested: WindowUtc) {
  const outcomes = { useful: 0, unknown: 0, errors: 0 };
  for (const result of results) {
    if (result.kind === 'error') outcomes.errors++;
    else if (result.coverage.startMs !== requested.startMs || result.coverage.endMs !== requested.endMs ||
      result.coverage.intervalMinutes !== requested.intervalMinutes || result.slots.some(slot => slot.status === 'unknown')) outcomes.unknown++;
    else outcomes.useful++;
  }
  return outcomes;
}

function harness(provider: Provider, delayMs: number) {
  labOnly();
  if (!['graph', 'zimbra'].includes(provider) || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 100) throw new Error('Invalid load bounds');
  const principal = { id: 'lab', username: 'lab', allowedProvider: provider,
    surface: provider === 'graph' ? 'zimbra-inbound' as const : 'm365-inbound' as const };
  const addresses = Array.from({ length: 400 }, (_, index) => `target${index}@example.invalid`);
  const directory = loadDirectory({ schemaVersion: 1, entries: addresses.map((canonicalSmtp, index) =>
    ({ id: `target${index}`, provider, canonicalSmtp, aliases: [], enabled: true, allowedPrincipals: ['lab'] })) }, [principal], 'W30');
  const state = { providerCalls: 0, peakActive: 0, peakQueued: 0, finalActive: 0, finalQueued: 0,
    peakRssBytes: process.memoryUsage().rss, cache: { hit: 0, miss: 0, coalesced: 0, rejected: 0 } };
  const lookup: AvailabilityProvider['lookup'] = async (target, coverage, ctx) => {
    state.providerCalls++;
    await delay(delayMs, undefined, { signal: ctx.signal });
    return { kind: 'ok', targetId: target.entryId, coverage, slots: [], observedAtMs: coverage.startMs };
  };
  const service = createFreeBusyService(directory, { graph: { kind: 'graph', lookup }, zimbra: { kind: 'zimbra', lookup } }, {
    telemetry: {
      cache: (_provider, outcome) => { if (typeof outcome === 'string' && Object.hasOwn(state.cache, outcome)) state.cache[outcome as keyof typeof state.cache]++; },
      queue: (backend, active, queued) => {
        if (backend !== provider) return;
        state.finalActive = active; state.finalQueued = queued;
        state.peakActive = Math.max(state.peakActive, active); state.peakQueued = Math.max(state.peakQueued, queued);
        state.peakRssBytes = Math.max(state.peakRssBytes, process.memoryUsage().rss);
      }, breaker: () => {},
    },
  });
  const run = (pattern: 'shared' | 'disjoint', requests = 20) => Promise.all(Array.from({ length: requests }, async (_, index) => {
    const started = performance.now();
    const offset = pattern === 'shared' ? 0 : index * 20;
    const results = await service(principal, principal.surface, addresses.slice(offset, offset + 20), window,
      { signal: new AbortController().signal, deadlineMonoMs: started + 7750 });
    return { results, durationMs: performance.now() - started };
  }));
  return { state, run };
}

export async function runLoad(options: { provider: Provider; pattern: 'shared' | 'disjoint'; warm?: boolean; delayMs?: number; requests?: number }) {
  const count = options.requests ?? 20;
  if (!['shared', 'disjoint'].includes(options.pattern) || !Number.isSafeInteger(count) || count < 1 || count > 20 ||
    (options.warm && options.pattern !== 'shared')) throw new Error('Invalid load pattern');
  const fixture = harness(options.provider, options.delayMs ?? 5);
  if (options.warm) {
    await fixture.run(options.pattern, count);
    fixture.state.providerCalls = 0;
    fixture.state.peakActive = 0; fixture.state.peakQueued = 0;
    for (const key of ['hit', 'miss', 'coalesced', 'rejected'] as const) fixture.state.cache[key] = 0;
  }
  const started = performance.now();
  const requests = await fixture.run(options.pattern, count);
  const durationMs = performance.now() - started;
  const durations = requests.map(request => request.durationMs).sort((a, b) => a - b);
  const percentile = (fraction: number) => durations[Math.ceil(durations.length * fraction) - 1]!;
  const results = requests.flatMap(request => request.results);
  const errors: Record<string, number> = {};
  for (const result of results) if (result.kind === 'error') errors[result.reason] = (errors[result.reason] ?? 0) + 1;
  const state = fixture.state;
  const targets = summarizeOutcomes(results, window);
  const expectedUseful = options.pattern === 'shared' ? count * 20 : Math.min(count * 20, 127);
  const expectedCalls = options.warm ? 0 : options.pattern === 'shared' ? 20 : expectedUseful;
  if (targets.useful !== expectedUseful || targets.unknown !== 0 || targets.errors !== count * 20 - expectedUseful ||
    Object.keys(errors).some(reason => reason !== 'throttled') || percentile(0.99) >= 7750) throw new Error('Useful availability/deadline acceptance failed');
  if (state.peakActive > 4 || state.peakQueued > 128 || state.finalActive !== 0 || state.finalQueued !== 0 || state.providerCalls !== expectedCalls) {
    throw new Error('Concurrency, retry-work or queue-leak acceptance failed');
  }
  return { provider: options.provider, pattern: options.pattern, warm: options.warm ?? false, delayMs: options.delayMs ?? 5,
    scope: 'service-only-fixture' as const, requests: count, targets, errors,
    usefulRequests: requests.filter(request => summarizeOutcomes(request.results, window).useful === 20).length,
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) }, durationMs,
    providerCallsPerSecond: state.providerCalls / (durationMs / 1000), cacheHitRatio: state.cache.hit / (count * 20),
    upstreamSocketConnections: null, ...state };
}

async function memorySoak() {
  if (!global.gc) throw new Error('Memory acceptance requires node --expose-gc');
  const fixture = harness('graph', 0);
  for (let round = 0; round < 5; round++) await fixture.run('shared');
  await delay(0);
  global.gc();
  const baseline = process.memoryUsage();
  const retainedHeapBytes: number[] = [];
  let peakRssBytes = baseline.rss;
  for (let round = 0; round < 40; round++) {
    await fixture.run('shared');
    await delay(0);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    if ((round + 1) % 10 === 0) { global.gc(); retainedHeapBytes.push(process.memoryUsage().heapUsed); }
  }
  const growthBytes = retainedHeapBytes.at(-1)! - baseline.heapUsed;
  const diagnosticBudgetBytes = 8 * 1024 * 1024;
  if (growthBytes > diagnosticBudgetBytes || fixture.state.finalActive !== 0 || fixture.state.finalQueued !== 0 || fixture.state.providerCalls !== 20) {
    throw new Error('Fixed-working-set memory/work/queue acceptance failed');
  }
  return { scope: 'service-only-fixed-20-target-working-set', warmupRounds: 5, measuredRounds: 40, requestsPerRound: 20,
    targetsPerRequest: 20, baselineHeapBytes: baseline.heapUsed, retainedHeapBytes, growthBytes, diagnosticBudgetBytes, peakRssBytes,
    providerCalls: fixture.state.providerCalls, finalActive: fixture.state.finalActive, finalQueued: fixture.state.finalQueued };
}

async function worker() {
  labOnly();
  if (!process.send) throw new Error('Fixture worker requires IPC parent');
  const directoryInput = json('config/directory.example.json');
  const config = validateConfig(json('config/example.json'), directoryInput, json('contracts/limits.json'), () => true);
  const registry = loadPrincipals(config, path => Buffer.from(createHash('sha256').update(path.endsWith('exo-interop') ? LAB_SECRET : `${LAB_SECRET}-private`).digest('hex')));
  let held = false;
  const lookup: AvailabilityProvider['lookup'] = async (target, coverage, ctx) => {
    process.send?.({ kind: 'provider-started' });
    if (held) await delay(7000, undefined, { signal: ctx.signal });
    return { kind: 'ok', targetId: target.entryId, coverage, slots: [], observedAtMs: coverage.startMs };
  };
  const app = await startGateway('/synthetic/config', { load: () => config, logDestination: { write: () => {} },
    listen: listener => listener.listen({ host: '127.0.0.1', port: 0 }), runtime: { registry, directoryInput,
      providers: { graph: { kind: 'graph', lookup }, zimbra: { kind: 'zimbra', lookup } }, monoMs: () => performance.now(),
      policyRevision: 'W30-child-fixture', secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true },
      protocolProfile: json('config/protocol-profiles.example.json') } });
  process.on('message', (message: unknown) => {
    if (message === 'hold') { held = true; process.send?.({ kind: 'holding' }); }
    else if (message === 'connections') {
      app.public.server.getConnections((error, count) => {
        if (error) { process.exitCode = 1; process.disconnect(); }
        else process.send?.({ kind: 'connections', count });
      });
    }
  });
  process.once('disconnect', () => { void app.shutdown().catch(() => { process.exitCode = 1; }); });
  const address = app.public.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  process.send({ kind: 'ready', port: address.port });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    labOnly();
    if (process.argv[2] === '--worker') await worker();
    else if (process.argv[2] === '--measure') {
      const runs = [];
      for (const provider of ['graph', 'zimbra'] as const) {
        runs.push(await runLoad({ provider, pattern: 'shared' }));
        runs.push(await runLoad({ provider, pattern: 'shared', warm: true }));
        runs.push(await runLoad({ provider, pattern: 'disjoint' }));
        runs.push(await runLoad({ provider, pattern: 'shared', delayMs: 100 }));
        runs.push(await runLoad({ provider, pattern: 'disjoint', requests: 6 }));
      }
      const hashes = Object.fromEntries(['contracts/limits.json', 'package-lock.json', 'tools/load-lab.ts', 'tests/integration/fault-recovery.test.ts', 'config/example.json',
        'config/directory.example.json', 'config/protocol-profiles.example.json', 'fixtures/ews/request.xml'].map(path =>
        [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
      process.stdout.write(JSON.stringify({ kind: 'offline-fixture-load', approved: false,
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), hashes,
        environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
        measuredAt: new Date().toISOString(), runs, memory: await memorySoak() }, null, 2) + '\n');
    } else throw new Error('Usage: load-lab.ts --measure | --worker');
  } catch {
    process.stderr.write('Offline load lab failed; no accepted report generated\n');
    process.exitCode = 1;
  }
}

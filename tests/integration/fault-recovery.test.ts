import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Target, TargetResult } from '../../src/core/types.js';
import { createOutboundTransport } from '../../src/http/outbound.js';
import { createGraphProvider } from '../../src/providers/graph.js';
import { createGraphTokenSource } from '../../src/providers/graph-token.js';
import { createBulkhead } from '../../src/resilience/bulkhead.js';
import { createCircuitBreaker } from '../../src/resilience/breaker.js';
import { LAB_SECRET, runLoad, summarizeOutcomes } from '../../tools/load-lab.js';

const window = { startMs: 1789351200000, endMs: 1789354800000, intervalMinutes: 30 };
const success: TargetResult = { kind: 'ok', targetId: 'synthetic', coverage: window, slots: [], observedAtMs: window.startMs };
const children: ChildProcess[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve()); child.kill('SIGKILL');
  })));
});

describe('offline load evidence', () => {
  it('does not count HTTP-like success with incomplete or unknown coverage as useful', () => {
    expect(summarizeOutcomes([
      success,
      { ...success, coverage: { ...window, endMs: window.endMs - 1800000 } },
      { ...success, slots: [{ startMs: window.startMs, endMs: window.endMs, status: 'unknown' }] },
      { kind: 'error', targetId: 'synthetic', reason: 'throttled' },
    ], window)).toEqual({ useful: 1, unknown: 2, errors: 1 });
  });

  it.each(['graph', 'zimbra'] as const)('coalesces cold shared load and serves warm %s load without provider work', async provider => {
    const cold = await runLoad({ provider, pattern: 'shared' });
    expect(cold.targets).toEqual({ useful: 400, unknown: 0, errors: 0 });
    expect(cold.usefulRequests).toBe(20);
    expect(cold.providerCalls).toBe(20);
    expect(cold.cache).toEqual({ hit: 0, miss: 20, coalesced: 380, rejected: 0 });
    expect(cold.peakActive).toBe(4);
    expect(cold.finalActive + cold.finalQueued).toBe(0);
    const warm = await runLoad({ provider, pattern: 'shared', warm: true });
    expect(warm.providerCalls).toBe(0);
    expect(warm.cache.hit).toBe(400);
    expect(warm.targets.useful).toBe(400);
  });

  it.each(['graph', 'zimbra'] as const)('reports disjoint %s overload honestly and drains the admitted work', async provider => {
    const result = await runLoad({ provider, pattern: 'disjoint' });
    expect(result.targets).toEqual({ useful: 127, unknown: 0, errors: 273 });
    expect(result.providerCalls).toBe(127);
    expect(result.errors).toEqual({ throttled: 273 });
    expect(result.peakQueued).toBe(123);
    expect(result.peakActive).toBe(4);
    expect(result.finalActive + result.finalQueued).toBe(0);
    expect(result.latencyMs.p50).toBeGreaterThanOrEqual(0);
    expect(result.latencyMs.p99).toBeGreaterThanOrEqual(result.latencyMs.p95);
  });

  it.each(['graph', 'zimbra'] as const)('measures reduced six-request cold-disjoint %s workload without throttling', async provider => {
    const result = await runLoad({ provider, pattern: 'disjoint', requests: 6 });
    expect(result.targets).toEqual({ useful: 120, unknown: 0, errors: 0 });
    expect(result.usefulRequests).toBe(6); expect(result.providerCalls).toBe(120);
    expect(result.peakQueued).toBe(116); expect(result.finalActive + result.finalQueued).toBe(0);
  });

  it('rejects production execution and unbounded fixture delays', async () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'tools/load-lab.ts', '--measure'],
      { env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8', timeout: 5000 });
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    await expect(runLoad({ provider: 'graph', pattern: 'shared', delayMs: 101 })).rejects.toThrow('Invalid load bounds');
  });

  it('measures a bounded fixed-working-set soak after warmup/cleanup, not cold allocation growth', () => {
    const child = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', 'tools/load-lab.ts', '--measure'],
      { env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
    expect(child.status, child.stderr).toBe(0);
    const report = JSON.parse(child.stdout) as { runs: Array<{ targets: { useful: number }; latencyMs: { p99: number } }>;
      memory: { growthBytes: number; diagnosticBudgetBytes: number; finalActive: number; finalQueued: number; providerCalls: number; retainedHeapBytes: number[] } };
    expect(report.runs).toHaveLength(10);
    expect(report.runs[0]!.targets.useful).toBe(400);
    expect(report.runs[2]!.targets.useful).toBe(127);
    expect(report.runs.every(run => run.latencyMs.p99 < 7750)).toBe(true);
    expect(report.memory.growthBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(report.memory.diagnosticBudgetBytes).toBe(8 * 1024 * 1024);
    expect(report.memory.retainedHeapBytes).toHaveLength(4);
    expect(report.memory.providerCalls).toBe(20);
    expect(report.memory.finalActive + report.memory.finalQueued).toBe(0);
  }, 25000);
});

describe('real retry/token/queue boundaries with synthetic external responses', () => {
  it('aborts stalled external HTTP at the attempt budget and recovers without a timeout retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const target: Target = { entryId: 'stall', provider: 'graph', canonicalSmtp: 'stall@example.invalid' };
    let calls = 0; let aborts = 0; let stalled = true;
    const transport = createOutboundTransport({ graphTargets: [target.canonicalSmtp], maxResponseBytes: 4194304, timeoutMs: 3000 }, async (_url, input) => {
      calls++;
      if (!stalled) return Response.json({ value: [{ scheduleId: target.canonicalSmtp, availabilityView: '00', scheduleItems: [] }] });
      input?.signal?.addEventListener('abort', () => { aborts++; }, { once: true });
      return new Promise<Response>(() => {});
    });
    const provider = createGraphProvider({ transport, tokenSource: { getToken: async () => 'synthetic-token' }, wallMs: () => Date.now(), monoMs: () => Date.now() });
    const run = () => provider.lookup(target, window, { signal: new AbortController().signal, deadlineMonoMs: Date.now() + 7750 });
    const pending = run(); await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toMatchObject({ kind: 'error', reason: 'timeout' });
    expect({ calls, aborts }).toEqual({ calls: 1, aborts: 1 }); expect(vi.getTimerCount()).toBe(0);
    stalled = false;
    expect(summarizeOutcomes([await run()], window).useful).toBe(1);
    expect(calls).toBe(2); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['recover', 'persistent', 'too-long'] as const)('bounds real HTTP429 retries under %s and recovers without leaked work', async mode => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const attempts = new Map<string, number>();
    let faulty = true;
    const targets: Target[] = Array.from({ length: 20 }, (_, n) =>
      ({ entryId: String(n), provider: 'graph', canonicalSmtp: `target${n}@example.invalid` }));
    const transport = createOutboundTransport({ graphTargets: targets.map(target => target.canonicalSmtp), maxResponseBytes: 4194304, timeoutMs: 3000 }, async (url, init) => {
      expect(init?.method).toBe('POST');
      expect(String(url)).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\/users\/target\d+%40example\.invalid\/calendar\/getSchedule$/);
      const mailbox = decodeURIComponent(new URL(String(url)).pathname.split('/')[3]!);
      const count = (attempts.get(mailbox) ?? 0) + 1; attempts.set(mailbox, count);
      if (faulty && (mode !== 'recover' || count === 1)) return Response.json({ error: { code: 'TooManyRequests', message: 'synthetic throttling' } },
        { status: 429, headers: { 'retry-after': mode === 'too-long' ? '9' : '0' } });
      return Response.json({ value: [{ scheduleId: mailbox, availabilityView: '00', scheduleItems: [] }] });
    });
    const provider = createGraphProvider({ transport, tokenSource: { getToken: async () => 'synthetic-token' }, wallMs: () => Date.now(), monoMs: () => Date.now() });
    let active = 0; let queued = 0; let peak = 0;
    const schedule = createBulkhead(() => Date.now(), (_provider, a, q) => { active = a; queued = q; peak = Math.max(peak, a); });
    const run = () => Promise.all(targets.map(target => schedule('graph', target.entryId,
      { signal: new AbortController().signal, deadlineMonoMs: Date.now() + 7750 }, ctx => provider.lookup(target, window, ctx))));
    const pending = run(); await vi.runAllTimersAsync();
    const results = await pending;
    expect(attempts.size).toBe(20);
    expect([...attempts.values()]).toEqual(Array(20).fill(mode === 'too-long' ? 1 : 2));
    expect(summarizeOutcomes(results, window)).toEqual(mode === 'recover' ? { useful: 20, errors: 0, unknown: 0 } : { useful: 0, errors: 20, unknown: 0 });
    expect(peak).toBe(4); expect(active + queued).toBe(0); expect(vi.getTimerCount()).toBe(0);
    faulty = false; attempts.clear();
    const recovered = run(); await vi.runAllTimersAsync();
    expect(summarizeOutcomes(await recovered, window).useful).toBe(20);
    expect([...attempts.values()]).toEqual(Array(20).fill(1));
    expect(active + queued).toBe(0);
  });

  it('coalesces a 40-caller Graph token refresh after expiry while canceled subscribers do not poison survivors', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let acquisitions = 0;
    const clock = { wallMs: () => Date.now(), monoMs: () => Date.now() };
    const source = createGraphTokenSource({ cloud: 'public', baseUrl: 'https://graph.microsoft.com/v1.0',
      tenantId: '00000000-0000-0000-0000-000000000001', clientId: '00000000-0000-0000-0000-000000000002', certificateFile: '/synthetic/certificate.pem' },
    clock, () => ({ getToken: async () => {
      acquisitions++; await new Promise(resolve => setTimeout(resolve, 50));
      return { token: `synthetic-${acquisitions}`, expiresOnTimestamp: Date.now() + 120000 };
    } }));
    const run = (signal = new AbortController().signal) => source.getToken({ signal, deadlineMonoMs: Date.now() + 7750 });
    const initial = Promise.all(Array.from({ length: 40 }, () => run())); await vi.advanceTimersByTimeAsync(50);
    expect(new Set(await initial)).toEqual(new Set(['synthetic-1'])); expect(acquisitions).toBe(1);
    await vi.advanceTimersByTimeAsync(61000);
    const canceled = new AbortController();
    const refresh = Promise.allSettled(Array.from({ length: 40 }, (_, index) => run(index < 10 ? canceled.signal : undefined)));
    canceled.abort(); await vi.advanceTimersByTimeAsync(50);
    const settled = await refresh;
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(30);
    expect(settled.filter(result => result.status === 'rejected')).toHaveLength(10);
    expect(settled.filter(result => result.status === 'fulfilled').map(result => result.value)).toEqual(Array(30).fill('synthetic-2'));
    expect(acquisitions).toBe(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a full component queue and admits fresh work without retry storms or retained timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let active = 0; let queued = 0; let calls = 0;
    const schedule = createBulkhead(() => Date.now(), (provider, a, q) => { if (provider === 'graph') { active = a; queued = q; } });
    const cancel = new AbortController();
    const context = { signal: cancel.signal, deadlineMonoMs: Date.now() + 7750 };
    const pending = Array.from({ length: 132 }, (_, index) => schedule('graph', String(index), context, () => { calls++; return new Promise(() => {}); }));
    await vi.advanceTimersByTimeAsync(0);
    expect({ active, queued, calls }).toEqual({ active: 4, queued: 128, calls: 4 });
    expect(await schedule('graph', 'overflow', context, async () => success)).toMatchObject({ reason: 'throttled' });
    cancel.abort(); expect((await Promise.all(pending)).every(result => result.kind === 'error' && result.reason === 'timeout')).toBe(true);
    expect(active + queued).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(await schedule('graph', 'recovered', { signal: new AbortController().signal, deadlineMonoMs: Date.now() + 7750 }, async () => success)).toEqual(success);
    expect(active + queued).toBe(0); expect(calls).toBe(4);
  });

  it('isolates the other provider during a breaker outage and closes only after a successful cooldown probe', async () => {
    let now = 0; let calls = 0;
    const states: string[] = [];
    const circuit = createCircuitBreaker(() => now, (provider, state) => { if (provider === 'graph') states.push(String(state)); });
    const ctx = () => ({ signal: new AbortController().signal, deadlineMonoMs: now + 7750 });
    const failure = async (): Promise<TargetResult> => { calls++; return { kind: 'error', targetId: 'synthetic', reason: 'backend-unavailable' }; };
    for (let n = 0; n < 5; n++) await circuit('graph', 'synthetic', ctx(), failure);
    await circuit('graph', 'synthetic', ctx(), failure); expect(calls).toBe(5);
    expect(await circuit('zimbra', 'synthetic', ctx(), async () => success)).toEqual(success);
    now = 30000;
    expect(await circuit('graph', 'synthetic', ctx(), async () => success)).toEqual(success);
    expect(states.slice(-3)).toEqual(['open', 'half-open', 'closed']);
  });
});

function message(child: ChildProcess, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', failed); child.off('error', failed); };
    const failed = () => { cleanup(); reject(new Error('Fixture child exited before expected evidence')); };
    const receive = (value: unknown) => {
      if (value && typeof value === 'object' && 'kind' in value && value.kind === kind) { cleanup(); resolve(value as Record<string, unknown>); }
    };
    const timer = setTimeout(failed, 5000);
    child.on('message', receive); child.once('exit', failed); child.once('error', failed);
  });
}
async function childGateway() {
  const child = fork(resolve('tools/load-lab.ts'), ['--worker'], { execArgv: ['--import', 'tsx'],
    env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child); child.stdout?.resume(); child.stderr?.resume();
  const ready = await message(child, 'ready');
  if (typeof ready.port !== 'number') throw new Error('Missing loopback port');
  return { child, port: ready.port };
}
function send(port: number) {
  return new Promise<{ status: number; body: string }>(resolve => {
    const client = request({ host: '127.0.0.1', port, method: 'POST', path: '/EWS/Exchange.asmx', agent: false,
      headers: { 'content-type': 'text/xml', authorization: `Basic ${Buffer.from(`exo-interop:${LAB_SECRET}`).toString('base64')}` } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += String(chunk); });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      response.on('aborted', () => resolve({ status: 0, body: '' }));
    });
    client.setTimeout(5000, () => client.destroy()); client.once('error', () => resolve({ status: 0, body: '' }));
    client.end(readFileSync('fixtures/ews/request.xml'));
  });
}

it('kills an actual fixture gateway process in flight while the separately running survivor still answers', async () => {
  const [victim, survivor] = await Promise.all([childGateway(), childGateway()]);
  const holding = message(victim.child, 'holding'); victim.child.send('hold'); await holding;
  const started = message(victim.child, 'provider-started'); const interrupted = send(victim.port); await started;
  const occupied = message(victim.child, 'connections'); victim.child.send('connections');
  const victimPublicConnectionsBeforeKill = (await occupied).count; expect(victimPublicConnectionsBeforeKill).toBe(1);
  const before = await send(survivor.port); expect(before.status).toBe(200); expect(before.body).toContain('NoError');
  const killed = new Promise<NodeJS.Signals | null>(resolve => victim.child.once('exit', (_code, signal) => resolve(signal)));
  const killAt = performance.now(); expect(victim.child.kill('SIGKILL')).toBe(true); expect(await killed).toBe('SIGKILL');
  expect(await interrupted).toEqual({ status: 0, body: '' });
  const after = await send(survivor.port); const recoveryMs = performance.now() - killAt;
  expect(after.status).toBe(200); expect(after.body).toContain('NoError'); expect(after.body).not.toContain('ErrorFreeBusy');
  const connections = message(survivor.child, 'connections'); survivor.child.send('connections');
  expect((await connections).count).toBe(0);
  process.stdout.write(JSON.stringify({ fixtureProcessKill: true, interruptedRequests: 1, survivorUsefulRequests: 2, recoveryMs,
    victimPublicConnectionsBeforeKill, survivingPublicConnectionsAfterCleanup: 0 }) + '\n');
}, 15000);

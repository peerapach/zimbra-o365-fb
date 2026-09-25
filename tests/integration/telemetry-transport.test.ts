import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOutboundTransport } from '../../src/http/outbound.js';
import { createMetrics } from '../../src/observability/metrics.js';
import { startConfiguredGateway } from '../../src/runtime/assemble.js';

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof startConfiguredGateway>>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.shutdown()));
  for (const path of roots.splice(0)) rmSync(path, { recursive: true });
  vi.useRealTimers();
});
const graph = 'https://graph.microsoft.com/v1.0/users/target/calendar/getSchedule';
const zimbra = 'https://mail.example.invalid/service/soap';
const secret = 'SENTINEL-TOKEN-email@example.invalid';
const input = (url = graph, signal = new AbortController().signal) => ({ url, method: 'POST' as const, signal,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: secret, maxResponseBytes: 1024 });
function setup(fetcher: typeof fetch, targets = ['target']) {
  let now = 0;
  const metrics = createMetrics();
  const transport = createOutboundTransport({ graphTargets: targets, zimbraSoapUrl: zimbra, maxResponseBytes: 1024, timeoutMs: 3000,
    telemetry: { monoMs: () => now, provider: metrics.provider } }, fetcher);
  return { transport, metrics, advance: (ms: number) => { now += ms; }, text: async () => (await metrics.render('management'))!.body };
}

describe('actual transport attempt telemetry', () => {
  it.each([[200, 'http-2xx'], [403, 'http-4xx'], [429, 'http-4xx'], [503, 'http-5xx']] as const)('records HTTP %s without declaring useful availability and includes body duration', async (status, category) => {
    const state = setup(async () => {
      state.advance(10);
      return new Response(new ReadableStream({ pull(controller) { state.advance(15); controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } }),
        { status, headers: { 'content-type': 'application/json' } });
    });
    expect((await state.transport.request(input())).status).toBe(status);
    const text = await state.text();
    expect(text).toContain(`freebusy_provider_attempts_total{provider="graph",outcome="${category}"} 1`);
    expect(text).toContain('freebusy_provider_duration_seconds_sum{provider="graph"} 0.025');
    expect(text).not.toContain('outcome="useful"');
    expect(text).not.toContain(secret);
  });

  it.each(['redirect', 'malformed', 'network'])('records %s as one bounded failure category', async scenario => {
    const state = setup(async () => {
      state.advance(40);
      if (scenario === 'network') throw new TypeError(secret);
      return scenario === 'redirect' ? new Response(null, { status: 302 }) : new Response('bad', { headers: { 'content-type': 'text/html' } });
    });
    await expect(state.transport.request(input())).rejects.toThrow('Outbound request failed');
    const text = await state.text();
    expect(text).toContain(`freebusy_provider_attempts_total{provider="graph",outcome="${scenario === 'network' ? 'backend-unavailable' : 'invalid-response'}"} 1`);
    expect(text).toContain('freebusy_provider_duration_seconds_count{provider="graph"} 1');
    expect(text).not.toContain(secret);
  });

  it('records timeout once even if the injected fetch settles late', async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const state = setup(() => new Promise(done => { resolve = done; }));
    const operation = state.transport.request(input());
    const failed = expect(operation).rejects.toMatchObject({ code: 'timeout' });
    state.advance(3000); await vi.advanceTimersByTimeAsync(3000); await failed;
    resolve(Response.json({})); await Promise.resolve();
    expect(await state.text()).toContain('freebusy_provider_attempts_total{provider="graph",outcome="timeout"} 1');
    expect(await state.text()).toContain('freebusy_provider_duration_seconds_sum{provider="graph"} 3');
  });

  it('records one timeout through a stalled body and cancellation that never settles', async () => {
    vi.useFakeTimers();
    const state = setup(async () => new Response(new ReadableStream({
      pull: () => new Promise(() => {}), cancel: () => new Promise(() => {}),
    }), { headers: { 'content-type': 'application/json' } }));
    const operation = state.transport.request(input());
    const failed = expect(operation).rejects.toMatchObject({ code: 'timeout' });
    await Promise.resolve(); state.advance(3000);
    await vi.advanceTimersByTimeAsync(3000); await failed;
    expect(await state.text()).toContain('freebusy_provider_attempts_total{provider="graph",outcome="timeout"} 1');
    expect(await state.text()).toContain('freebusy_provider_duration_seconds_count{provider="graph"} 1');
  });

  it('does not count blocked destinations, methods, headers, limits or pre-aborted requests as backend attempts', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
    const state = setup(fetcher);
    const aborted = new AbortController(); aborted.abort();
    for (const request of [input('https://attacker.invalid/'), { ...input(), method: 'GET' },
      { ...input(), headers: { cookie: secret } }, { ...input(), maxResponseBytes: 1025 }, input(graph, aborted.signal)]) {
      await expect(state.transport.request(request as ReturnType<typeof input>)).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(await state.text()).not.toContain('freebusy_provider_attempts_total{');
  });

  it('uses bounded provider/status series across many authorized target identities', async () => {
    const targets = Array.from({ length: 100 }, (_, n) => `email${n}@example.invalid`);
    const state = setup(async () => Response.json({}), targets);
    for (const target of targets) await state.transport.request(input(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(target)}/calendar/getSchedule`));
    const text = await state.text();
    expect(text.split('\n').filter(line => line.startsWith('freebusy_provider_attempts_total{'))).toEqual([
      'freebusy_provider_attempts_total{provider="graph",outcome="http-2xx"} 100',
    ]);
    expect(text).not.toMatch(/email\d|example\.invalid|SENTINEL/);
  });
});

function files() {
  const root = mkdtempSync(join(tmpdir(), 'freebusy-W25a-')); roots.push(root);
  const key = join(root, 'key.pem'); const cert = join(root, 'cert.pem');
  execFileSync('openssl', ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-days', '1', '-subj', '/CN=Synthetic W25a Never Deploy'], { stdio: 'ignore' });
  const raw = JSON.parse(readFileSync('config/example.json', 'utf8')) as {
    graph: { tenantId: string; clientId: string; certificateFile: string };
    zimbra: { passwordFile: string }; principals: Array<{ secretFile: string }>;
    directoryFile: string; limitsFile: string; protocolProfilesFile: string;
  };
  raw.graph.tenantId = '11111111-1111-1111-1111-111111111111';
  raw.graph.clientId = '22222222-2222-2222-2222-222222222222';
  raw.graph.certificateFile = key;
  writeFileSync(key, `${readFileSync(key, 'utf8')}\n${readFileSync(cert, 'utf8')}`, { mode: 0o600 });
  raw.zimbra.passwordFile = join(root, 'zimbra-password');
  writeFileSync(raw.zimbra.passwordFile, secret, { mode: 0o600 });
  for (const [n, principal] of raw.principals.entries()) {
    principal.secretFile = join(root, `principal${n}`);
    writeFileSync(principal.secretFile, createHash('sha256').update(`${secret}-${n}`).digest('hex'), { mode: 0o600 });
  }
  for (const [key, source, name] of [['directoryFile', 'config/directory.example.json', 'directory.json'],
    ['limitsFile', 'contracts/limits.json', 'limits.json'], ['protocolProfilesFile', 'config/protocol-profiles.example.json', 'profiles.json']] as const) {
    raw[key] = name; writeFileSync(join(root, name), readFileSync(source), { mode: 0o600 });
  }
  const path = join(root, 'gateway.json'); writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
  return path;
}

it('shares configured runtime metrics: actual retry attempts, Zimbra auth, no OAuth or probe attempts, HTTP200 Unknown stays unknown', async () => {
  const path = files();
  const trace: string[] = [];
  let graphCalls = 0;
  let now = 0;
  const fetcher: typeof fetch = async (url, init) => {
    expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error');
    trace.push(String(url)); now += 25;
    if (String(url).startsWith('https://login.microsoftonline.com/')) return Response.json({ token_type: 'Bearer', access_token: 'synthetic-token', expires_in: 3600 });
    if (String(url).startsWith('https://graph.microsoft.com/')) {
      if (++graphCalls === 1) return new Response(null, { status: 503, headers: { 'retry-after': '0' } });
      return Response.json({ value: [{ scheduleId: 'alice@tenant.example.invalid', error: { responseCode: 'ErrorAccessDenied', message: secret } }] });
    }
    if (url === zimbra) {
      if (String(init?.body).includes('AuthRequest')) return new Response('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><AuthResponse xmlns="urn:zimbraAccount"><authToken>synthetic-zimbra-token</authToken><lifetime>3600000</lifetime></AuthResponse></s:Body></s:Envelope>', { headers: { 'content-type': 'text/xml' } });
      return new Response(readFileSync('fixtures/zimbra/success.xml'), { headers: { 'content-type': 'text/xml' } });
    }
    throw new Error('Unexpected synthetic destination');
  };
  const app = await startConfiguredGateway(path, { ingressApproved: true, fetcher, listen: async () => {},
    clock: { monoMs: () => now, wallMs: Date.now } });
  apps.push(app);
  const fixture = readFileSync('fixtures/ews/request.xml', 'utf8');
  for (const [side, user, n, email] of [['private', 'zimbra-interop', 1, 'alice@company.example.invalid'],
    ['public', 'exo-interop', 0, 'bob@zfb.example.invalid']] as const) {
    const response = await app[side].inject({ method: 'POST', url: '/EWS/Exchange.asmx',
      headers: { 'content-type': 'text/xml', authorization: `Basic ${Buffer.from(`${user}:${secret}-${n}`).toString('base64')}` },
      payload: fixture.replace('bob@zfb.example.invalid', email) });
    expect(response.statusCode).toBe(200);
  }
  for (const url of ['/healthz', '/readyz', '/metrics']) expect((await app.management.inject(url)).statusCode).toBe(200);
  const text = (await app.management.inject('/metrics')).body;
  expect(trace).toHaveLength(5);
  expect(trace.filter(url => url.startsWith('https://login.microsoftonline.com/'))).toHaveLength(1);
  expect(text).toContain('freebusy_provider_attempts_total{provider="graph",outcome="http-5xx"} 1');
  expect(text).toContain('freebusy_provider_attempts_total{provider="graph",outcome="http-2xx"} 1');
  expect(text).toContain('freebusy_provider_attempts_total{provider="zimbra",outcome="http-2xx"} 2');
  expect(text).toContain('freebusy_provider_duration_seconds_sum{provider="graph"} 0.05');
  expect(text).toContain('freebusy_requests_total{surface="zimbra-inbound",outcome="unknown"} 1');
  expect(text).not.toContain('freebusy_requests_total{surface="zimbra-inbound",outcome="useful"}');
  expect(text).not.toMatch(/SENTINEL|alice@|bob@|synthetic-token|microsoftonline/);
});

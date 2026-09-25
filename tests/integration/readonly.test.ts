import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/validate.js';
import { createOutboundTransport } from '../../src/http/outbound.js';
import { startGateway } from '../../src/main.js';
import { createGraphProvider } from '../../src/providers/graph.js';
import { createZimbraProvider } from '../../src/providers/zimbra.js';
import { createZimbraSession } from '../../src/providers/zimbra-auth.js';
import { loadPrincipals } from '../../src/security/principals.js';
import { parseXmlBounded } from '../../src/xml/parse.js';
import { requiredChild } from '../../src/xml/select.js';

const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const M = 'http://schemas.microsoft.com/exchange/services/2006/messages';
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const config = validateConfig(json('config/example.json'), json('config/directory.example.json'), json('contracts/limits.json'), () => true);
const graphTarget = config.directory.entries.find(entry => entry.provider === 'graph')!;
const graphUrl = `https://graph.microsoft.com/v1.0/users/${graphTarget.graphObjectId}/calendar/getSchedule`;
const fixture = readFileSync('fixtures/ews/request.xml', 'utf8');
const apps: Array<Awaited<ReturnType<typeof startGateway>>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.shutdown())); });
type Scenario = 'success' | 'denied' | 'retry' | 'semantic-error' | 'expired' | 'malformed' | 'all-free' | 'no-data';
interface Trace { url: string; method: string | undefined; redirect: RequestRedirect | undefined; body: string }
const soap = (body: string) => `<s:Envelope xmlns:s="${SOAP}"><s:Body>${body}</s:Body></s:Envelope>`;
const xmlResponse = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/xml' } });

async function setup(scenario: Scenario) {
  const trace: Trace[] = [];
  let attempts = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const entry = { url: String(url), method: init?.method, redirect: init?.redirect, body: String(init?.body) };
    trace.push(entry);
    if (entry.url === config.zimbra.soapUrl) {
      const operation = requiredChild(parseXmlBounded(Buffer.from(entry.body)), SOAP, 'Body').children[0]!;
      if (operation.uri === 'urn:zimbraAccount' && operation.local === 'AuthRequest') {
        return xmlResponse(soap('<AuthResponse xmlns="urn:zimbraAccount"><authToken>synthetic-token</authToken><lifetime>3600000</lifetime></AuthResponse>'));
      }
    }
    attempts++;
    if (scenario === 'retry' && attempts === 1) return new Response(null, { status: 503, headers: { 'retry-after': '0' } });
    const graph = entry.url === graphUrl;
    if (scenario === 'denied') return graph ? Response.json({}, { status: 403 }) : xmlResponse(readFileSync('fixtures/zimbra/success.xml', 'utf8'), 403);
    if (scenario === 'malformed') return graph ? new Response('{', { headers: { 'content-type': 'application/json' } }) : xmlResponse('<broken');
    if (scenario === 'all-free' || scenario === 'no-data') {
      if (graph) return Response.json({ value: [{ scheduleId: graphTarget.canonicalSmtp, availabilityView: '00000000',
        scheduleItems: scenario === 'all-free' ? [] : [{ status: 'unknown',
          start: { dateTime: '2026-09-14T02:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-09-14T06:00:00', timeZone: 'UTC' } }] }] });
      return xmlResponse(scenario === 'no-data' ? readFileSync('fixtures/zimbra/no-data.xml', 'utf8')
        : soap('<GetFreeBusyResponse xmlns="urn:zimbraMail"><usr id="bob@example.invalid"><f s="1789351200000" e="1789365600000"/></usr></GetFreeBusyResponse>'));
    }
    if (scenario === 'expired' && attempts === 1) return xmlResponse(soap('<s:Fault><faultcode>s:Client</faultcode><faultstring>expired</faultstring><detail><Error xmlns="urn:zimbra"><Code>service.AUTH_EXPIRED</Code></Error></detail></s:Fault>'), 500);
    if (graph) return Response.json(json(scenario === 'semantic-error' ? 'fixtures/graph/error.json' : 'fixtures/graph/success.json'));
    return xmlResponse(readFileSync('fixtures/zimbra/success.xml', 'utf8'));
  };
  const transport = createOutboundTransport({ graphTargets: [graphTarget.graphObjectId!], zimbraSoapUrl: config.zimbra.soapUrl,
    maxResponseBytes: 4194304, timeoutMs: 3000 }, fetcher);
  const clock = { wallMs: () => 1789351200000, monoMs: () => performance.now() };
  const session = createZimbraSession(config.zimbra, transport, clock, async () => 'synthetic-password');
  const secret = 'W26-readonly-synthetic-secret-000000';
  const registry = loadPrincipals(config, path => Buffer.from(createHash('sha256').update(path.endsWith('exo-interop') ? secret : `${secret}-private`).digest('hex')));
  const app = await startGateway('/synthetic/config', { load: () => config, listen: async () => {}, logDestination: { write: () => {} },
    runtime: { registry, directoryInput: json('config/directory.example.json'), monoMs: clock.monoMs,
      secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true }, policyRevision: 'W26-readonly', protocolProfile: json('config/protocol-profiles.example.json'),
      providers: {
        graph: createGraphProvider({ transport, tokenSource: { getToken: async () => 'synthetic-graph-token' }, ...clock }),
        zimbra: createZimbraProvider({ soapUrl: config.zimbra.soapUrl, transport, session, clock,
          approvedTargets: config.directory.entries.filter(entry => entry.provider === 'zimbra').map(entry => ({ entryId: entry.id, provider: entry.provider, canonicalSmtp: entry.canonicalSmtp })) }),
      } } });
  apps.push(app);
  return { trace, send: (side: 'public' | 'private', body = fixture, action?: string) => app[side].inject({ method: 'POST', url: '/EWS/Exchange.asmx',
    headers: { 'content-type': 'text/xml', authorization: `Basic ${Buffer.from(side === 'public' ? `exo-interop:${secret}` : `zimbra-interop:${secret}-private`).toString('base64')}`,
      ...(action === undefined ? {} : { soapaction: action }) }, payload: side === 'private' ? body.replaceAll('bob@zfb.example.invalid', 'alice@company.example.invalid') : body }) };
}

function assertReadOnly(trace: Trace[], side: 'public' | 'private', expected: string[]) {
  // Assert outside the fetch callback: adapters sanitize thrown errors, including assertion errors.
  expect(trace.map(entry => entry.url)).toEqual(expected.map(() => side === 'private' ? graphUrl : config.zimbra.soapUrl));
  expect(trace.map(entry => entry.method)).toEqual(expected.map(() => 'POST'));
  expect(trace.map(entry => entry.redirect)).toEqual(expected.map(() => 'error'));
  const operations = trace.map(entry => {
    if (side === 'private') {
      expect(JSON.parse(entry.body)).toEqual({ schedules: ['alice@tenant.example.invalid'],
        startTime: { dateTime: '2026-09-14T02:00:00', timeZone: 'UTC' }, endTime: { dateTime: '2026-09-14T06:00:00', timeZone: 'UTC' }, availabilityViewInterval: 30 });
      return 'getSchedule';
    }
    const body = requiredChild(parseXmlBounded(Buffer.from(entry.body)), SOAP, 'Body');
    expect(body.children).toHaveLength(1);
    const operation = body.children[0]!;
    expect([['urn:zimbraAccount', 'AuthRequest'], ['urn:zimbraMail', 'GetFreeBusyRequest']]).toContainEqual([operation.uri, operation.local]);
    if (operation.local === 'GetFreeBusyRequest') expect(operation.attributes).toEqual(expect.arrayContaining([
      { uri: '', local: 'name', value: 'bob@example.invalid' }, { uri: '', local: 's', value: '1789351200000' }, { uri: '', local: 'e', value: '1789365600000' },
    ]));
    return operation.local;
  });
  expect(operations).toEqual(expected);
}

describe.each(['public', 'private'] as const)('W26 read-only outbound traces from %s listener', side => {
  it.each(['success', 'denied', 'retry', 'malformed'] as const)('allows only exact read/session operations for %s', async scenario => {
    const app = await setup(scenario); const response = await app.send(side);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(scenario === 'denied' ? 'ErrorNoFreeBusyAccess' : scenario === 'malformed' ? 'ErrorInternalServerError' : '02133000');
    const reads = scenario === 'retry' ? 2 : 1;
    assertReadOnly(app.trace, side, side === 'private' ? Array<string>(reads).fill('getSchedule') : ['AuthRequest', ...Array<string>(reads).fill('GetFreeBusyRequest')]);
  });

  it.each(['GetFolder', 'CreateItem', 'UpdateItem', 'DeleteItem', 'FindItem', 'Subscribe', 'SyncFolderItems'])('rejects %s without any outbound request', async operation => {
    const app = await setup('success');
    const response = await app.send(side, soap(`<m:${operation} xmlns:m="${M}"/>`));
    expect(response.statusCode).toBe(500); expect(response.body).toContain('s:Client');
    expect(app.trace).toEqual([]);
  });

  it.each([['all-free', '00000000'], ['no-data', '44444444']] as const)('preserves %s through real adapters without event details', async (scenario, merged) => {
    const app = await setup(scenario); const response = await app.send(side);
    expect(response.statusCode).toBe(200); expect(response.body).toContain(`>${merged}<`);
    expect(response.body).not.toMatch(/CalendarEventDetails|Subject|Location/);
    if (scenario === 'all-free') expect(response.body).not.toContain('<t:CalendarEvent>');
    else expect(response.body).toContain('NoData');
    assertReadOnly(app.trace, side, side === 'private' ? ['getSchedule'] : ['AuthRequest', 'GetFreeBusyRequest']);
  });

  it.each(['missing@example.invalid', 'cross-provider'])('denies %s before any transport work', async address => {
    const app = await setup('success');
    const target = address === 'cross-provider' ? side === 'public' ? 'alice@company.example.invalid' : 'bob@example.invalid' : address;
    const response = await app.send(side, fixture.replace('bob@zfb.example.invalid', target));
    expect(response.statusCode).toBe(200); expect(response.body).toContain('ErrorNoFreeBusyAccess');
    expect(response.body).not.toContain('MergedFreeBusy>'); expect(app.trace).toEqual([]);
  });

  it('rejects conflicting SOAPAction without outbound work', async () => {
    const app = await setup('success'); const response = await app.send(side, fixture, `"${M}/CreateItem"`);
    expect(response.statusCode).toBe(500); expect(app.trace).toEqual([]);
  });
});

it('keeps Graph HTTP200 semantic failure non-free without retry or cloud EWS fallback', async () => {
  const app = await setup('semantic-error'); const response = await app.send('private');
  expect(response.statusCode).toBe(200); expect(response.body).toContain('ErrorInternalServerError');
  expect(response.body).not.toContain('MergedFreeBusy>'); assertReadOnly(app.trace, 'private', ['getSchedule']);
});

it('renews an expired Zimbra session once using only user AuthRequest and read replay', async () => {
  const app = await setup('expired'); const response = await app.send('public');
  expect(response.statusCode).toBe(200); expect(response.body).toContain('02133000');
  assertReadOnly(app.trace, 'public', ['AuthRequest', 'GetFreeBusyRequest', 'AuthRequest', 'GetFreeBusyRequest']);
});

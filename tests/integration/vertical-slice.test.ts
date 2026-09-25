import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { create } from 'xmlbuilder2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../../src/config/validate.js';
import type { AvailabilityProvider, CallContext, Target, TargetResult, WindowUtc } from '../../src/core/types.js';
import { startGateway } from '../../src/main.js';
import type { SurfaceListener } from '../../src/http/listeners.js';
import { loadPrincipals } from '../../src/security/principals.js';
import { parseXmlBounded, type XmlNode } from '../../src/xml/parse.js';
import { childrenNamed, requiredChild } from '../../src/xml/select.js';
import { createGraphProvider } from '../../src/providers/graph.js';
import { createZimbraProvider } from '../../src/providers/zimbra.js';

const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const M = 'http://schemas.microsoft.com/exchange/services/2006/messages';
const T = 'http://schemas.microsoft.com/exchange/services/2006/types';
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const config = validateConfig(json('config/example.json'), json('config/directory.example.json'), json('contracts/limits.json'), () => true);
const password = 'synthetic-exo-secret-00000000000000';
const privatePassword = 'synthetic-zimbra-secret-00000000000';
const registry = loadPrincipals(config, path => Buffer.from(createHash('sha256')
  .update(path.endsWith('exo-interop') ? password : privatePassword).digest('hex')));
const apps: SurfaceListener[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(apps.splice(0).map(app => app.close())); });

function request(addresses: string[], view = 'DetailedMerged') {
  const doc = create({ version: '1.0' });
  const operation = doc.ele('s:Envelope', { 'xmlns:s': SOAP, 'xmlns:m': M, 'xmlns:t': T })
    .ele('s:Body').ele('m:GetUserAvailabilityRequest');
  const array = operation.ele('m:MailboxDataArray');
  for (const address of addresses) {
    const mailbox = array.ele('t:MailboxData');
    mailbox.ele('t:Email').ele('t:Address').txt(address);
    mailbox.ele('t:AttendeeType').txt('Required');
    mailbox.ele('t:ExcludeConflicts').txt('false');
  }
  const options = operation.ele('t:FreeBusyViewOptions');
  const window = options.ele('t:TimeWindow');
  window.ele('t:StartTime').txt('2026-09-14T02:00:00Z');
  window.ele('t:EndTime').txt('2026-09-14T03:00:00Z');
  options.ele('t:MergedFreeBusyIntervalInMinutes').txt('30');
  options.ele('t:RequestedView').txt(view);
  return doc.end();
}
function success(target: Target, window: WindowUtc, status: 'busy' | 'tentative'): TargetResult {
  return { kind: 'ok', targetId: target.entryId, coverage: window, observedAtMs: window.startMs,
    slots: [{ startMs: window.startMs, endMs: window.startMs + 1800000, status }] };
}
async function setup(options: { graph?: AvailabilityProvider['lookup']; zimbra?: AvailabilityProvider['lookup']; secure?: boolean;
  directoryInput?: unknown; rawDirectory?: unknown } = {}) {
  const graph = vi.fn(options.graph ?? (async (target: Target, window: WindowUtc) => success(target, window, 'busy')));
  const zimbra = vi.fn(options.zimbra ?? (async (target: Target, window: WindowUtc) => success(target, window, 'tentative')));
  const directoryInput = options.directoryInput ?? { schemaVersion: 1, entries: [...config.directory.entries,
    { id: 'second-zimbra', provider: 'zimbra', canonicalSmtp: 'second@example.invalid', aliases: [], allowedPrincipals: ['pilot-exo'], enabled: true }] };
  const listeners = await startGateway('/synthetic/config', {
    load: () => validateConfig(json('config/example.json'), directoryInput, json('contracts/limits.json'), () => true),
    listen: async () => {},
    runtime: { registry, providers: { graph: { kind: 'graph', lookup: graph }, zimbra: { kind: 'zimbra', lookup: zimbra } },
      monoMs: () => performance.now(), secureTransport: { 'm365-inbound': options.secure ?? true, 'zimbra-inbound': options.secure ?? true },
      policyRevision: 'offline-W17', protocolProfile: json('config/protocol-profiles.example.json'),
      directoryInput: options.rawDirectory ?? directoryInput },
  });
  apps.push(...Object.values(listeners));
  return { ...listeners, graph, zimbra };
}
function headers(privateSide = false) {
  return { 'content-type': 'text/xml', authorization: `Basic ${Buffer.from(privateSide
    ? `zimbra-interop:${privatePassword}` : `exo-interop:${password}`).toString('base64')}` };
}
async function send(app: SurfaceListener, addresses: string[], view = 'DetailedMerged') {
  return app.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: headers(app.surface === 'zimbra-inbound'), payload: request(addresses, view) });
}
function responses(body: string): XmlNode[] {
  const envelope = parseXmlBounded(Buffer.from(body));
  return childrenNamed(requiredChild(requiredChild(requiredChild(envelope, SOAP, 'Body'), M, 'GetUserAvailabilityResponse'), M, 'FreeBusyResponseArray'), M, 'FreeBusyResponse');
}
function result(node: XmlNode) {
  const view = requiredChild(node, M, 'FreeBusyView');
  return { code: requiredChild(requiredChild(node, M, 'ResponseMessage'), M, 'ResponseCode').text,
    view: requiredChild(view, T, 'FreeBusyViewType').text,
    merged: childrenNamed(view, T, 'MergedFreeBusy').map(n => n.text), events: childrenNamed(view, T, 'CalendarEventArray').length };
}

describe('W17 fixture-backed authenticated vertical slice (no live gate evidence)', () => {
  it.each(['canonicalSmtp', 'aliases'] as const)('rejects Unicode-folding %s in raw administrator directory before listening', async field => {
    const raw = structuredClone(json('config/directory.example.json')) as { entries: Array<{ canonicalSmtp: string; aliases: string[] }> };
    if (field === 'canonicalSmtp') raw.entries[0]!.canonicalSmtp = 'Kelly@example.invalid';
    else raw.entries[0]!.aliases = ['Kelly@example.invalid'];
    let rejected = false;
    try { await setup({ directoryInput: raw }); } catch { rejected = true; }
    expect(rejected).toBe(true);
  });

  it('rejects a raw-directory snapshot that differs from the validated routing snapshot', async () => {
    let rejected = false;
    try { await setup({ rawDirectory: { schemaVersion: 1, entries: [] } }); } catch { rejected = true; }
    expect(rejected).toBe(true);
  });

  it('routes both real listener surfaces, canonicalizes aliases and expands duplicate results in input order', async () => {
    const app = await setup();
    const publicResponse = await send(app.public, ['bob@zfb.example.invalid', 'missing@example.invalid', 'bob@example.invalid', 'alice@company.example.invalid']);
    expect(publicResponse.statusCode).toBe(200);
    expect(responses(publicResponse.body).map(result)).toEqual([
      { code: 'NoError', view: 'FreeBusyMerged', merged: ['10'], events: 1 },
      { code: 'ErrorNoFreeBusyAccess', view: 'None', merged: [], events: 0 },
      { code: 'NoError', view: 'FreeBusyMerged', merged: ['10'], events: 1 },
      { code: 'ErrorNoFreeBusyAccess', view: 'None', merged: [], events: 0 },
    ]);
    expect(app.zimbra).toHaveBeenCalledTimes(1);
    expect(app.zimbra.mock.calls[0]?.[0]).toMatchObject({ entryId: 'pilot-zimbra-bob', canonicalSmtp: 'bob@example.invalid' });
    expect(app.graph).not.toHaveBeenCalled();
    const privateResponse = await send(app.private, ['alice@company.example.invalid', 'bob@example.invalid', 'alice@tenant.example.invalid']);
    expect(privateResponse.statusCode).toBe(200);
    expect(responses(privateResponse.body).map(result).map(r => r.merged)).toEqual([['20'], [], ['20']]);
    expect(app.graph).toHaveBeenCalledTimes(1);
    expect(app.graph.mock.calls[0]?.[0]).toMatchObject({ canonicalSmtp: 'alice@tenant.example.invalid', graphObjectId: '00000000-0000-0000-0000-000000000001' });
    expect(publicResponse.body + privateResponse.body).not.toMatch(/CalendarEventDetails|Subject|Location|pilot-|canonicalSmtp/);
  });

  it.each(['None', 'MergedOnly', 'FreeBusy', 'FreeBusyMerged', 'DetailedMerged'])('honors requested %s shape without leaking event details', async view => {
    const app = await setup();
    const response = await send(app.public, ['bob@example.invalid'], view);
    expect(response.statusCode).toBe(200);
    expect(result(responses(response.body)[0]!)).toEqual({ code: 'NoError', view: view === 'DetailedMerged' ? 'FreeBusyMerged' : view,
      merged: ['FreeBusy', 'None'].includes(view) ? [] : ['10'], events: ['None', 'MergedOnly'].includes(view) ? 0 : 1 });
  });

  it('turns rejected provider work into errors for its duplicate entries only', async () => {
    const app = await setup({ zimbra: async (target, window) => {
      if (target.entryId === 'second-zimbra') return success(target, window, 'tentative');
      throw new Error('upstream secret');
    } });
    const failed = await send(app.public, ['bob@example.invalid', 'missing@example.invalid', 'second@example.invalid', 'bob@zfb.example.invalid']);
    expect(failed.statusCode).toBe(200);
    expect(responses(failed.body).map(result).map(r => r.code)).toEqual(['ErrorInternalServerError', 'ErrorNoFreeBusyAccess', 'NoError', 'ErrorInternalServerError']);
    expect(result(responses(failed.body)[2]!).merged).toEqual(['10']);
    expect(app.zimbra).toHaveBeenCalledTimes(2);
    expect(failed.body).not.toContain('upstream secret');
    expect(result(responses((await send(app.private, ['alice@company.example.invalid'])).body)[0]!).merged).toEqual(['20']);
  });

  it('rejects a provider result associated with a different target', async () => {
    const app = await setup({ zimbra: async (target, window) => ({ ...success(target, window, 'busy'), targetId: 'other' }) });
    const response = await send(app.public, ['bob@example.invalid']);
    expect(response.statusCode).toBe(200);
    expect(result(responses(response.body)[0]!).code).toBe('ErrorInternalServerError');
  });

  it('runs the real Graph and Zimbra adapters through listeners using only synthetic outbound responses', async () => {
    const clock = { wallMs: () => 1789351200000, monoMs: () => performance.now() };
    const graph = createGraphProvider({ wallMs: clock.wallMs, tokenSource: { getToken: async () => 'synthetic-token' },
      transport: { request: async input => {
        expect(input.url).toBe('https://graph.microsoft.com/v1.0/users/00000000-0000-0000-0000-000000000001/calendar/getSchedule');
        expect(JSON.parse(input.body).schedules).toEqual(['alice@tenant.example.invalid']);
        return { status: 200, headers: { 'content-type': 'application/json' }, body: readFileSync('fixtures/graph/success.json') };
      } } });
    const zimbra = createZimbraProvider({ soapUrl: config.zimbra.soapUrl, clock,
      approvedTargets: [{ entryId: 'pilot-zimbra-bob', provider: 'zimbra', canonicalSmtp: 'bob@example.invalid' }],
      session: { getToken: async () => 'synthetic-token', withToken: async (ctx, operation) => operation('synthetic-token', ctx) },
      transport: { request: async input => {
        expect(input.url).toBe('https://mail.example.invalid/service/soap');
        const operation = requiredChild(parseXmlBounded(Buffer.from(input.body)), SOAP, 'Body').children[0]!;
        expect(operation.uri).toBe('urn:zimbraMail');
        expect(operation.local).toBe('GetFreeBusyRequest');
        expect(operation.attributes.find(a => a.local === 'name')?.value).toBe('bob@example.invalid');
        return { status: 200, headers: { 'content-type': 'text/xml' }, body: readFileSync('fixtures/zimbra/success.xml') };
      } } });
    const app = await setup({ graph: graph.lookup, zimbra: zimbra.lookup });
    for (const [listener, address, merged] of [[app.public, 'bob@zfb.example.invalid', '02133000'],
      [app.private, 'alice@company.example.invalid', '02133000']] as const) {
      const response = await listener.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: headers(listener.surface === 'zimbra-inbound'),
        payload: request([address]).replace('2026-09-14T03:00:00Z', '2026-09-14T06:00:00Z') });
      expect(response.statusCode).toBe(200);
      expect(result(responses(response.body)[0]!).merged).toEqual([merged]);
      expect(response.body).not.toMatch(/DO_NOT_LEAK|CalendarEventDetails|synthetic-token/);
    }
  });

  it('serves fixed authenticated public Autodiscover settings and rejects unknown targets', async () => {
    const app = await setup();
    const payload = readFileSync('fixtures/autodiscover/request.xml', 'utf8');
    const response = await app.public.inject({ method: 'POST', url: '/autodiscover/autodiscover.xml', headers: headers(), payload });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('https://fb.example.invalid/EWS/Exchange.asmx');
    const unknown = await app.public.inject({ method: 'POST', url: '/autodiscover/autodiscover.xml', headers: headers(),
      payload: payload.replace('bob@zfb.example.invalid', 'missing@example.invalid') });
    expect(unknown.statusCode).toBe(404);
    const anonymous = await app.public.inject({ method: 'POST', url: '/autodiscover/autodiscover.xml', headers: { 'content-type': 'text/xml' }, payload });
    expect(anonymous.statusCode).toBe(401);
    expect(app.graph).not.toHaveBeenCalled();
    expect(app.zimbra).not.toHaveBeenCalled();
  });

  it('authenticates before XML parsing and ignores spoofed authority headers', async () => {
    const app = await setup();
    for (const supplied of [{ 'content-type': 'text/xml' }, headers(true)]) {
      const response = await app.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx',
        headers: { ...supplied, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'private.example.invalid' }, payload: '<broken-secret' });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toContain('Basic');
      expect(response.body).not.toContain('broken-secret');
    }
    expect(app.zimbra).not.toHaveBeenCalled();
    expect(app.graph).not.toHaveBeenCalled();
    const insecure = await setup({ secure: false });
    expect((await send(insecure.public, ['bob@example.invalid'])).statusCode).toBe(401);
  });

  it.each([
    { payload: '<broken-private-data', soapaction: undefined },
    { payload: request(['bob@example.invalid']).replaceAll('GetUserAvailabilityRequest', 'GetFolder'), soapaction: undefined },
    { payload: request(['bob@example.invalid']), soapaction: 'http://invalid/GetFolder' },
    { payload: '<!DOCTYPE a [<!ENTITY e "private-data">]><a>&e;</a>', soapaction: undefined },
  ])('returns sanitized Client faults for unsupported/malformed XML %#', async ({ payload, soapaction }) => {
    const app = await setup();
    const response = await app.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: { ...headers(), ...(soapaction ? { soapaction } : {}) }, payload });
    expect(response.statusCode).toBe(500);
    const fault = requiredChild(requiredChild(parseXmlBounded(Buffer.from(response.body)), SOAP, 'Body'), SOAP, 'Fault');
    expect(requiredChild(fault, '', 'faultcode').text).toBe('s:Client');
    expect(response.body).not.toMatch(/private-data|GetFolder/);
    expect(app.zimbra).not.toHaveBeenCalled();
  });

  it('retains transport body/media/method bounds and management isolation with hooks active', async () => {
    const app = await setup();
    expect((await app.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: headers(), payload: Buffer.alloc(262145) })).statusCode).toBe(413);
    expect((await app.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: { ...headers(), 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(415);
    expect((await app.public.inject('/EWS/Exchange.asmx')).statusCode).toBe(404);
    expect((await send(app.management, ['bob@example.invalid'])).statusCode).toBe(404);
    expect((await app.private.inject({ method: 'POST', url: '/autodiscover/autodiscover.xml', headers: headers(true), payload: '<x/>' })).statusCode).toBe(404);
    expect(app.zimbra).not.toHaveBeenCalled();
  });

  it('bounds a provider that never settles and returns target failure rather than free', async () => {
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    let context: CallContext | undefined;
    const app = await setup({ zimbra: async (_target, _window, ctx) => { context = ctx; started(); return new Promise<TargetResult>(() => {}); } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = send(app.public, ['bob@example.invalid']);
    await began;
    await vi.advanceTimersByTimeAsync(8000);
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(result(responses(response.body)[0]!).code).toBe('ErrorInternalServerError');
    expect(context?.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects production startup without explicit runtime dependencies before binding', async () => {
    const listen = vi.fn();
    await expect(startGateway('/production/config', { load: () => ({ ...config, environment: 'production', liveAccessEnabled: true }), listen }))
      .rejects.toThrow('Gateway runtime dependencies required');
    expect(listen).not.toHaveBeenCalled();
  });
});

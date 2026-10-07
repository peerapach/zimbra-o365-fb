import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../../src/config/validate.js';
import type { AvailabilityProvider } from '../../src/core/types.js';
import { startGateway } from '../../src/main.js';
import { normalizeGraph } from '../../src/providers/graph-map.js';
import { normalizeZimbra } from '../../src/providers/zimbra-map.js';
import { loadPrincipals } from '../../src/security/principals.js';
import { parseXmlBounded } from '../../src/xml/parse.js';
import { childrenNamed, requiredChild } from '../../src/xml/select.js';

const S = 'http://schemas.xmlsoap.org/soap/envelope/';
const M = 'http://schemas.microsoft.com/exchange/services/2006/messages';
const T = 'http://schemas.microsoft.com/exchange/services/2006/types';
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const config = validateConfig(json('config/example.json'), json('config/directory.example.json'), json('contracts/limits.json'), () => true);
const fixture = readFileSync('fixtures/ews/request.xml', 'utf8');
// Header context and body t:TimeZone must agree; +07 contexts also need the -420 body bias.
const withZone = (xml: string, zone: string) => {
  const out = xml.replace('Id="UTC"', `Id="${zone}"`);
  return zone === 'Asia/Bangkok' || zone === 'SE Asia Standard Time' ? out.replace('<t:TimeZone><t:Bias>0</t:Bias>', '<t:TimeZone><t:Bias>-420</t:Bias>') : out;
};
const withoutBodyZone = (xml: string) => xml.replace(/<t:TimeZone>[\s\S]*?<\/t:TimeZone>\s*/, '');
const apps: Array<Awaited<ReturnType<typeof startGateway>>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.shutdown())); });
function shape(body: string) {
  const response = requiredChild(requiredChild(requiredChild(parseXmlBounded(Buffer.from(body)), S, 'Body'), M, 'GetUserAvailabilityResponse'), M, 'FreeBusyResponseArray');
  return response.children.map(item => {
    const view = requiredChild(item, M, 'FreeBusyView');
    const events = childrenNamed(view, T, 'CalendarEventArray')[0]?.children ?? [];
    return { code: requiredChild(requiredChild(item, M, 'ResponseMessage'), M, 'ResponseCode').text,
      view: requiredChild(view, T, 'FreeBusyViewType').text,
      merged: childrenNamed(view, T, 'MergedFreeBusy').map(node => node.text),
      events: events.map(event => ({ start: Date.parse(requiredChild(event, T, 'StartTime').text),
        end: Date.parse(requiredChild(event, T, 'EndTime').text), status: requiredChild(event, T, 'BusyType').text,
        fields: event.children.map(node => [node.uri, node.local]) })) };
  });
}
function eventText(body: string) {
  const response = requiredChild(requiredChild(requiredChild(parseXmlBounded(Buffer.from(body)), S, 'Body'), M, 'GetUserAvailabilityResponse'), M, 'FreeBusyResponseArray');
  return response.children.flatMap(item => childrenNamed(requiredChild(item, M, 'FreeBusyView'), T, 'CalendarEventArray')
    .flatMap(array => array.children.map(event => [requiredChild(event, T, 'StartTime').text, requiredChild(event, T, 'EndTime').text])));
}
async function setup() {
  const secret = 'W26-contract-synthetic-secret-00000000';
  const registry = loadPrincipals(config, path => Buffer.from(createHash('sha256').update(path.endsWith('exo-interop') ? secret : `${secret}-private`).digest('hex')));
  const graph = vi.fn<AvailabilityProvider['lookup']>(async (target, window) => normalizeGraph(json('fixtures/graph/success.json'), target, window, window.startMs));
  const zimbra = vi.fn<AvailabilityProvider['lookup']>(async (target, window) => normalizeZimbra(parseXmlBounded(readFileSync('fixtures/zimbra/success.xml')), target, window, window.startMs));
  const app = await startGateway('/synthetic/config', { load: () => config, listen: async () => {}, logDestination: { write: () => {} },
    runtime: { registry, directoryInput: json('config/directory.example.json'), monoMs: () => performance.now(), policyRevision: 'W26-contract',
      protocolProfile: json('config/protocol-profiles.example.json'), secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true },
      providers: { graph: { kind: 'graph', lookup: graph }, zimbra: { kind: 'zimbra', lookup: zimbra } } } });
  apps.push(app);
  return { graph, zimbra, send: (side: 'public' | 'private', body = fixture, action?: string) => app[side].inject({ method: 'POST', url: '/EWS/Exchange.asmx',
    headers: { 'content-type': 'text/xml', authorization: `Basic ${Buffer.from(side === 'public' ? `exo-interop:${secret}` : `zimbra-interop:${secret}-private`).toString('base64')}`,
      ...(action === undefined ? {} : { soapaction: action }) }, payload: side === 'private' ? body.replaceAll('bob@zfb.example.invalid', 'alice@company.example.invalid') : body }) };
}

describe.each(['public', 'private'] as const)('W26 original EWS vector via %s listener (synthetic only)', side => {
  it.each(['Asia/Bangkok', 'SE Asia Standard Time'])('preserves exact fixed +07 event text for naive/explicit %s without splitting UTC cache work', async zone => {
    const app = await setup();
    const utc = await app.send(side);
    for (const suffix of ['', '+07:00']) {
      const body = withZone(fixture, zone).replace('02:00:00Z', `09:00:00${suffix}`).replace('06:00:00Z', `13:00:00${suffix}`);
      const response = await app.send(side, body);
      expect(response.statusCode).toBe(200);
      expect(shape(response.body)).toEqual(shape(utc.body));
      expect(eventText(response.body)).toEqual([
        ['2026-09-14T09:30:00.000+07:00', '2026-09-14T10:00:00.000+07:00'],
        ['2026-09-14T10:00:00.000+07:00', '2026-09-14T10:30:00.000+07:00'],
        ['2026-09-14T10:30:00.000+07:00', '2026-09-14T11:30:00.000+07:00'],
      ]);
      expect(response.body).not.toMatch(/DO_NOT_LEAK|CalendarEventDetails|Subject|Location|isPrivate|bob@|alice@/);
    }
    const provider = side === 'public' ? app.zimbra : app.graph;
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]![1]).toEqual({ startMs: 1789351200000, endMs: 1789365600000, intervalMinutes: 30 });
  });

  it.each(['UTC', 'Etc/UTC', 'absent-Z', 'absent-offset'])('retains exact UTC output for %s context', async zone => {
    const app = await setup();
    let body = zone.startsWith('absent')
      ? withoutBodyZone(fixture.replace('<t:TimeZoneContext><t:TimeZoneDefinition Id="UTC"/></t:TimeZoneContext>', ''))
      : withZone(fixture, zone);
    if (zone === 'absent-offset') body = body.replace('02:00:00Z', '09:00:00+07:00').replace('06:00:00Z', '13:00:00+07:00');
    const response = await app.send(side, body);
    expect(response.statusCode).toBe(200);
    expect(eventText(response.body)).toEqual([
      ['2026-09-14T02:30:00.000+00:00', '2026-09-14T03:00:00.000+00:00'],
      ['2026-09-14T03:00:00.000+00:00', '2026-09-14T03:30:00.000+00:00'],
      ['2026-09-14T03:30:00.000+00:00', '2026-09-14T04:30:00.000+00:00'],
    ]);
  });

  it.each(['None', 'MergedOnly', 'FreeBusy', 'FreeBusyMerged', 'DetailedMerged'])('preserves Bangkok %s view privacy and omission rules', async view => {
    const app = await setup();
    const body = withZone(fixture, 'Asia/Bangkok').replace('02:00:00Z', '09:00:00')
      .replace('06:00:00Z', '13:00:00').replace('DetailedMerged', view);
    const response = await app.send(side, body);
    expect(response.statusCode).toBe(200);
    expect(shape(response.body)[0]!.view).toBe(view === 'DetailedMerged' ? 'FreeBusyMerged' : view);
    const times = eventText(response.body);
    expect(times).toHaveLength(view === 'None' || view === 'MergedOnly' ? 0 : 3);
    expect(times.flat().every(text => text.endsWith('+07:00'))).toBe(true);
    expect(shape(response.body)[0]!.merged).toEqual(view === 'None' || view === 'FreeBusy' ? [] : ['02133000']);
    expect(response.body).not.toMatch(/DO_NOT_LEAK|CalendarEventDetails|Subject|Location|isPrivate|bob@|alice@/);
  });

  it('preserves duplicate order and error isolation for Bangkok response text', async () => {
    const app = await setup();
    const mailbox = fixture.slice(fixture.indexOf('<t:MailboxData>'), fixture.indexOf('</t:MailboxData>') + '</t:MailboxData>'.length);
    const body = withZone(fixture.replace(mailbox, mailbox + mailbox.replace('bob@zfb.example.invalid', 'missing@example.invalid') + mailbox)
      .replace('02:00:00Z', '09:00:00+07:00').replace('06:00:00Z', '13:00:00+07:00'), 'SE Asia Standard Time');
    const response = await app.send(side, body);
    const results = shape(response.body);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual(results[2]);
    expect(results[1]).toEqual({ code: 'ErrorNoFreeBusyAccess', view: 'None', merged: [], events: [] });
    const times = eventText(response.body);
    expect(times).toHaveLength(6);
    expect(times.slice(0, 3)).toEqual(times.slice(3));
    expect(times.flat().every(text => text.endsWith('+07:00'))).toBe(true);
  });
  it.each(['original', 'alternative-prefix', 'offset-equivalent'])('preserves original timeline and candidate response shape for %s', async variant => {
    const app = await setup();
    let body = fixture;
    if (variant === 'alternative-prefix') {
      for (const [from, to] of [['s', 'envelope'], ['m', 'messages'], ['t', 'types']]) {
        body = body.replaceAll(`<${from}:`, `<${to}:`).replaceAll(`</${from}:`, `</${to}:`).replace(`xmlns:${from}=`, `xmlns:${to}=`);
      }
    }
    if (variant === 'offset-equivalent') body = withZone(body.replace('02:00:00Z', '09:00:00+07:00').replace('06:00:00Z', '13:00:00+07:00'), 'SE Asia Standard Time');
    const response = await app.send(side, body, `"${M}/GetUserAvailability"`);
    expect(response.statusCode).toBe(200);
    expect(shape(response.body)).toEqual(shape(readFileSync('fixtures/ews/success.xml', 'utf8')));
    expect(response.body).not.toMatch(/DO_NOT_LEAK|CalendarEventDetails|Subject|Location|isPrivate|bob@|alice@/);
  });

  it.each([
    ['None', 'None', false, false], ['MergedOnly', 'MergedOnly', true, false],
    ['FreeBusy', 'FreeBusy', false, true], ['FreeBusyMerged', 'FreeBusyMerged', true, true],
    ['DetailedMerged', 'FreeBusyMerged', true, true],
  ] as const)('honors supported %s without private event details', async (view, responseView, merged, events) => {
    const app = await setup(); const response = await app.send(side, fixture.replace('DetailedMerged', view));
    expect(response.statusCode).toBe(200);
    const result = shape(response.body)[0]!;
    expect(result.code).toBe('NoError'); expect(result.view).toBe(responseView);
    expect(result.merged).toEqual(merged ? ['02133000'] : []);
    expect(result.events).toHaveLength(events ? 3 : 0);
    for (const event of result.events) expect(event.fields).toEqual([[T, 'StartTime'], [T, 'EndTime'], [T, 'BusyType']]);
  });

  it.each([
    ['wrong-namespace', fixture.replace(M, 'urn:untrusted')],
    ['unsupported-view', fixture.replace('DetailedMerged', 'Detailed')],
    ['unsupported-zone', withZone(fixture, 'Unknown Zone')],
    ['candidate-London', withZone(fixture, 'Europe/London')],
    ['candidate-Pacific', withZone(fixture, 'Pacific Standard Time')],
    ['candidate-Greenwich', withZone(fixture, 'Greenwich Standard Time')],
    ['legacy-timezone-incomplete', withoutBodyZone(fixture).replace('<m:MailboxDataArray>', '<t:TimeZone><t:Bias>0</t:Bias></t:TimeZone><m:MailboxDataArray>')],
    ['legacy-timezone-dst', fixture.replace('<t:DaylightTime><t:Bias>0</t:Bias>', '<t:DaylightTime><t:Bias>-60</t:Bias>')],
    ['legacy-timezone-conflict', fixture.replace('<t:TimeZone><t:Bias>0</t:Bias>', '<t:TimeZone><t:Bias>-420</t:Bias>')],
    ['legacy-timezone-unapproved-bias', fixture.replace('<t:TimeZone><t:Bias>0</t:Bias>', '<t:TimeZone><t:Bias>-540</t:Bias>')],
    ['legacy-timezone-misplaced', withoutBodyZone(fixture).replace('<t:FreeBusyViewOptions>', `${fixture.match(/<t:TimeZone>[\s\S]*?<\/t:TimeZone>/)![0]}<t:FreeBusyViewOptions>`)],
    ['non-smtp-routing', fixture.replace('<t:RoutingType>SMTP</t:RoutingType>', '<t:RoutingType>EX</t:RoutingType>')],
    ['invalid-interval', fixture.replace('>30<', '>0<')],
    ['reverse-window', fixture.replace('2026-09-14T06:00:00Z', '2026-09-14T01:00:00Z')],
    ['duplicate-view', fixture.replace('</t:RequestedView>', '</t:RequestedView><t:RequestedView>None</t:RequestedView>')],
    ['suggestions', fixture.replace('</m:GetUserAvailabilityRequest>', '<t:SuggestionsViewOptions/></m:GetUserAvailabilityRequest>')],
  ])('rejects %s before provider work', async (_name, body) => {
    const app = await setup(); const response = await app.send(side, body);
    expect(response.statusCode).toBe(500);
    expect(requiredChild(requiredChild(parseXmlBounded(Buffer.from(response.body)), S, 'Body'), S, 'Fault').children[0]?.text).toBe('s:Client');
    expect(app.graph).not.toHaveBeenCalled(); expect(app.zimbra).not.toHaveBeenCalled();
  });

  it('keeps unknown identities in the original non-enumerating failure shape', async () => {
    const app = await setup(); const response = await app.send(side, fixture.replace('bob@zfb.example.invalid', 'missing@example.invalid'));
    expect(response.statusCode).toBe(200);
    expect(shape(response.body)).toEqual(shape(readFileSync('fixtures/ews/error.xml', 'utf8')));
    expect(app.graph).not.toHaveBeenCalled(); expect(app.zimbra).not.toHaveBeenCalled();
  });
});

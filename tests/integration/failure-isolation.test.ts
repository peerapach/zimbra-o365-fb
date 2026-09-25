import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { create } from 'xmlbuilder2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../../src/config/validate.js';
import type { AvailabilityProvider, Target, WindowUtc } from '../../src/core/types.js';
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
const base = validateConfig(json('config/example.json'), json('config/directory.example.json'), json('contracts/limits.json'), () => true);
const apps: Array<Awaited<ReturnType<typeof startGateway>>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.shutdown())); });

function request(addresses: string[]) {
  const doc = create({ version: '1.0' });
  const operation = doc.ele('s:Envelope', { 'xmlns:s': S, 'xmlns:m': M, 'xmlns:t': T }).ele('s:Body').ele('m:GetUserAvailabilityRequest');
  const array = operation.ele('m:MailboxDataArray');
  for (const address of addresses) {
    const item = array.ele('t:MailboxData');
    item.ele('t:Email').ele('t:Address').txt(address);
    item.ele('t:AttendeeType').txt('Required'); item.ele('t:ExcludeConflicts').txt('false');
  }
  const options = operation.ele('t:FreeBusyViewOptions');
  const window = options.ele('t:TimeWindow');
  window.ele('t:StartTime').txt('2026-09-14T02:00:00Z'); window.ele('t:EndTime').txt('2026-09-14T06:00:00Z');
  options.ele('t:MergedFreeBusyIntervalInMinutes').txt('30'); options.ele('t:RequestedView').txt('DetailedMerged');
  return doc.end();
}
function shape(body: string) {
  const array = requiredChild(requiredChild(requiredChild(parseXmlBounded(Buffer.from(body)), S, 'Body'), M, 'GetUserAvailabilityResponse'), M, 'FreeBusyResponseArray');
  return array.children.map(item => {
    const view = requiredChild(item, M, 'FreeBusyView');
    return { code: requiredChild(requiredChild(item, M, 'ResponseMessage'), M, 'ResponseCode').text,
      view: requiredChild(view, T, 'FreeBusyViewType').text, merged: childrenNamed(view, T, 'MergedFreeBusy').map(node => node.text) };
  });
}
function normalized(target: Target, window: WindowUtc) {
  const partial = target.entryId.endsWith('-partial');
  const bad = target.entryId.endsWith('-bad');
  if (target.provider === 'graph') {
    if (!partial && !bad) return normalizeGraph(json('fixtures/graph/success.json'), target, window, window.startMs);
    const time = (dateTime: string) => ({ dateTime, timeZone: 'UTC' });
    return normalizeGraph({ value: [{ scheduleId: target.canonicalSmtp,
      ...(bad ? { error: { responseCode: '5006', message: 'DO_NOT_LEAK_GRAPH_ERROR' } } : {
        availabilityView: '20000000', scheduleItems: [
          { status: 'busy', start: time('2026-09-14T02:00:00'), end: time('2026-09-14T02:30:00'), subject: 'DO_NOT_LEAK_SUBJECT' },
          { status: 'unknown', start: time('2026-09-14T02:30:00'), end: time('2026-09-14T06:00:00'), location: 'DO_NOT_LEAK_LOCATION' },
        ],
      }) }] }, target, window, window.startMs);
  }
  if (!partial && !bad) return normalizeZimbra(parseXmlBounded(readFileSync('fixtures/zimbra/success.xml')), target, window, window.startMs);
  const doc = create().ele('s:Envelope', { 'xmlns:s': S });
  const body = doc.ele('s:Body');
  if (bad) body.ele('s:Fault').ele('faultstring').txt('DO_NOT_LEAK_ZIMBRA_ERROR');
  else body.ele('GetFreeBusyResponse', { xmlns: 'urn:zimbraMail' }).ele('usr', { id: target.canonicalSmtp })
    .ele('b', { s: window.startMs, e: window.startMs + 1800000, subject: 'DO_NOT_LEAK_SUBJECT', location: 'DO_NOT_LEAK_LOCATION' });
  return normalizeZimbra(parseXmlBounded(Buffer.from(doc.end())), target, window, window.startMs);
}
async function setup(overrides: Partial<Record<'graph' | 'zimbra', AvailabilityProvider['lookup']>> = {}) {
  const additions = base.directory.entries.flatMap(entry => ['bad', 'partial', 'denied'].map(name => ({
    id: `${entry.provider}-${name}`, provider: entry.provider, canonicalSmtp: `${entry.provider}-${name}@example.invalid`, aliases: [],
    allowedPrincipals: name === 'denied' ? [] : entry.allowedPrincipals, enabled: true,
  })));
  const directory = { schemaVersion: 1, entries: [...base.directory.entries, ...additions] };
  const config = validateConfig(json('config/example.json'), directory, json('contracts/limits.json'), () => true);
  const secret = 'W26-isolation-synthetic-secret-00000';
  const registry = loadPrincipals(config, path => Buffer.from(createHash('sha256').update(path.endsWith('exo-interop') ? secret : `${secret}-private`).digest('hex')));
  const graph = vi.fn<AvailabilityProvider['lookup']>(overrides.graph ?? (async (target, window) => normalized(target, window)));
  const zimbra = vi.fn<AvailabilityProvider['lookup']>(overrides.zimbra ?? (async (target, window) => normalized(target, window)));
  const logs: string[] = [];
  const app = await startGateway('/synthetic/config', { load: () => config, listen: async () => {}, logDestination: { write: text => { logs.push(text); } },
    runtime: { registry, directoryInput: directory, monoMs: () => performance.now(), policyRevision: 'W26-isolation',
      protocolProfile: json('config/protocol-profiles.example.json'), secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true },
      providers: { graph: { kind: 'graph', lookup: graph }, zimbra: { kind: 'zimbra', lookup: zimbra } } } });
  apps.push(app);
  return { app, graph, zimbra, logs, send: (side: 'public' | 'private', addresses: string[]) => app[side].inject({ method: 'POST', url: '/EWS/Exchange.asmx',
    headers: { 'content-type': 'text/xml', authorization: `Basic ${Buffer.from(side === 'public' ? `exo-interop:${secret}` : `zimbra-interop:${secret}-private`).toString('base64')}` }, payload: request(addresses) }) };
}
const ok = (merged: string) => ({ code: 'NoError', view: 'FreeBusyMerged', merged: [merged] });
const denied = { code: 'ErrorNoFreeBusyAccess', view: 'None', merged: [] };
const failed = { code: 'ErrorInternalServerError', view: 'None', merged: [] };

describe.each(['public', 'private'] as const)('W26 mixed target isolation on %s listener', side => {
  it('preserves order/duplicates, hides denied identities and keeps partial Unknown out of positive cache', async () => {
    const state = await setup();
    const provider = side === 'public' ? 'zimbra' : 'graph';
    const good = base.directory.entries.find(entry => entry.provider === provider)!;
    const other = base.directory.entries.find(entry => entry.provider !== provider)!;
    const addresses = [good.aliases[0]!, `${provider}-bad@example.invalid`, 'missing@example.invalid', other.canonicalSmtp,
      `${provider}-partial@example.invalid`, good.canonicalSmtp, `${provider}-denied@example.invalid`];
    for (let pass = 0; pass < 2; pass++) {
      const response = await state.send(side, addresses);
      expect(response.statusCode).toBe(200);
      expect(shape(response.body)).toEqual([ok('02133000'), failed, denied, denied, ok('24444444'), ok('02133000'), denied]);
      expect(response.body).not.toMatch(/DO_NOT_LEAK|CalendarEventDetails|Subject|Location|example\.invalid|pilot-/);
    }
    const ids = state[provider].mock.calls.map(call => call[0].entryId);
    expect(ids.filter(id => id === good.id)).toHaveLength(1);
    expect(ids.filter(id => id === `${provider}-bad`)).toHaveLength(2);
    expect(ids.filter(id => id === `${provider}-partial`)).toHaveLength(2);
    expect(ids).toHaveLength(5);
    expect(state[provider === 'graph' ? 'zimbra' : 'graph']).not.toHaveBeenCalled();
    const metrics = await state.app.management.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body + state.logs.join('')).not.toMatch(/DO_NOT_LEAK|example\.invalid|pilot-|synthetic-secret|canonicalSmtp/);
  });

  it('a stalled then failing backend does not delay or contaminate the opposite direction', async () => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let fail!: (cause: Error) => void;
    const stalled: AvailabilityProvider['lookup'] = async () => { entered(); return new Promise((_resolve, reject) => { fail = reject; }); };
    const provider = side === 'public' ? 'zimbra' : 'graph';
    const state = await setup({ [provider]: stalled });
    const good = base.directory.entries.find(entry => entry.provider === provider)!;
    const other = base.directory.entries.find(entry => entry.provider !== provider)!;
    const pending = state.send(side, [good.canonicalSmtp, good.aliases[0]!]);
    // Fastify injection is lazy; attach a promise handler to start the request.
    const completion = pending.then(response => response);
    await started;
    try {
      const healthy = await state.send(side === 'public' ? 'private' : 'public', [other.canonicalSmtp]);
      expect(healthy.statusCode).toBe(200); expect(shape(healthy.body)).toEqual([ok('02133000')]);
    } finally { fail(new Error('DO_NOT_LEAK_BACKEND_PASSWORD')); }
    const failedResponse = await completion;
    expect(shape(failedResponse.body)).toEqual([failed, failed]);
    expect(state[provider]).toHaveBeenCalledTimes(1);
    expect(failedResponse.body + state.logs.join('')).not.toContain('DO_NOT_LEAK');
  });
});

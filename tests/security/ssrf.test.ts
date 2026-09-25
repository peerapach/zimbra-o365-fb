import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import dns from 'node:dns';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../../src/config/validate.js';
import { createOutboundTransport } from '../../src/http/outbound.js';
import { startGateway } from '../../src/main.js';
import { loadPrincipals } from '../../src/security/principals.js';
import { parseXmlBounded } from '../../src/xml/parse.js';

const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const config = validateConfig(json('config/example.json'), json('config/directory.example.json'), json('contracts/limits.json'), () => true);
const fixture = readFileSync('fixtures/ews/request.xml', 'utf8');
const pox = readFileSync('fixtures/autodiscover/request.xml', 'utf8');
const apps: Array<Awaited<ReturnType<typeof startGateway>>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.shutdown())); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function listener() {
  const secret = 'W28_SSRF_SYNTHETIC_SECRET_00000000';
  const registry = loadPrincipals(config, path => Buffer.from(createHash('sha256').update(path.endsWith('exo-interop') ? secret : `${secret}-private`).digest('hex')));
  const lookup = vi.fn(async () => { throw new Error('Unexpected provider work'); });
  const app = await startGateway('/synthetic/config', { load: () => config, listen: async () => {}, logDestination: { write: () => {} },
    runtime: { registry, directoryInput: json('config/directory.example.json'), monoMs: () => 0, policyRevision: 'W28-ssrf',
      protocolProfile: json('config/protocol-profiles.example.json'), secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true },
      providers: { graph: { kind: 'graph', lookup }, zimbra: { kind: 'zimbra', lookup } } } });
  apps.push(app);
  return { lookup, send: (body: string, url = '/EWS/Exchange.asmx') => app.public.inject({ method: 'POST', url, payload: body,
    headers: { authorization: `Basic ${Buffer.from(`exo-interop:${secret}`).toString('base64')}`, 'content-type': 'text/xml',
      host: 'attacker.invalid', forwarded: 'host=attacker.invalid;proto=http', 'x-forwarded-host': 'attacker.invalid',
      'x-forwarded-proto': 'http', 'x-original-url': 'https://attacker.invalid/private', 'x-forwarded-for': '127.0.0.1' } }) };
}

describe('W28 fixed-origin policy under attacker-controlled ingress', () => {
  it('never advertises Host/forwarded/override values in successful POX', async () => {
    const state = await listener(); const response = await state.send(pox, '/autodiscover/autodiscover.xml');
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('https://fb.example.invalid/EWS/Exchange.asmx');
    expect(response.body).not.toContain('attacker.invalid'); expect(state.lookup).not.toHaveBeenCalled();
  });

  it.each(['bob@zfb.example.invalid.attacker.invalid', 'bob+admin@zfb.example.invalid', 'bob@zfb.example.invalid.',
    'https://attacker.invalid/EWS/Exchange.asmx', 'bob@127.0.0.1', 'bob@169.254.169.254', 'bob@zfb.example.invalid%2fattacker',
    'bob%0d%0aHost:attacker@zfb.example.invalid', 'bоb@zfb.example.invalid'])('does not infer a route from %s', async address => {
    const state = await listener(); const response = await state.send(fixture.replace('bob@zfb.example.invalid', address));
    expect([200, 500]).toContain(response.statusCode);
    expect(response.body).toMatch(/ErrorNoFreeBusyAccess|s:Client/);
    expect(response.body).not.toMatch(/MergedFreeBusy>|attacker\.invalid|169\.254/); expect(state.lookup).not.toHaveBeenCalled();
  });

  it.each([
    fixture.replace('</m:GetUserAvailabilityRequest>', '<m:BackendUrl>https://attacker.invalid</m:BackendUrl></m:GetUserAvailabilityRequest>'),
    fixture.replace('<s:Body>', '<s:Body xml:base="https://attacker.invalid/">'),
    fixture.replace('<s:Body>', '<s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="https://attacker.invalid/schema">'),
  ])('rejects XML endpoint/schema override %# before provider work', async body => {
    const state = await listener(); const response = await state.send(body);
    expect(response.statusCode).toBe(500); expect(response.body).toContain('s:Client'); expect(state.lookup).not.toHaveBeenCalled();
  });

  it('performs no file, DNS or ambient fetch for external entity and include payloads', () => {
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('Forbidden file lookup'); });
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(() => { throw new Error('Forbidden DNS lookup'); });
    const fetcher = vi.fn(() => { throw new Error('Forbidden network fetch'); }); vi.stubGlobal('fetch', fetcher);
    for (const body of ['<!DOCTYPE r SYSTEM "https://attacker.invalid/schema"><r/>',
      '<!DOCTYPE r [<!ENTITY e SYSTEM "file:///W28_PRIVATE_CANARY">]><r>&e;</r>',
      '<i:include xmlns:i="http://www.w3.org/2001/XInclude" href="https://attacker.invalid"/>']) {
      expect(() => parseXmlBounded(Buffer.from(body))).toThrow('Invalid XML');
    }
    expect(read).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});

const graph = 'https://graph.microsoft.com/v1.0/users/approved/calendar/getSchedule';
const soap = 'https://mail.example.invalid/service/soap';
const request = (url: string) => ({ url, method: 'POST' as const, headers: { 'content-type': 'application/json' },
  body: '{}', maxResponseBytes: 1024, signal: new AbortController().signal });
describe('W28 transport destination and redirect boundary', () => {
  it.each(['https://outlook.office365.com/EWS/Exchange.asmx', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd',
    'https://graph.microsoft.com.attacker.invalid/v1.0/users/approved/calendar/getSchedule', `${graph}?url=https://attacker.invalid`,
    `${graph}#ignored`, graph.replace('/approved/', '/unapproved/'), graph.replace('/getSchedule', '/events'),
    'https://mail.example.invalid:7071/service/admin/soap', `${soap}/../admin/soap`, 'https://user:pass@mail.example.invalid/service/soap'])
    ('rejects unapproved destination %s before fetch', async url => {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
      const transport = createOutboundTransport({ graphTargets: ['approved'], zimbraSoapUrl: soap, maxResponseBytes: 1024, timeoutMs: 3000 }, fetcher);
      await expect(transport.request(request(url))).rejects.toMatchObject({ code: 'destination' }); expect(fetcher).not.toHaveBeenCalled();
    });

  it.each([301, 302, 303, 307, 308])('never follows an HTTP%s response to a cloud EWS origin', async status => {
    const trace: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const fetcher: typeof fetch = async (url, init) => { trace.push({ url: String(url), redirect: init?.redirect });
      return new Response('{}', { status, headers: { 'content-type': 'application/json', location: 'https://outlook.office365.com/EWS/Exchange.asmx' } }); };
    const transport = createOutboundTransport({ graphTargets: ['approved'], maxResponseBytes: 1024, timeoutMs: 3000 }, fetcher);
    await expect(transport.request(request(graph))).rejects.toMatchObject({ code: 'invalid-response' });
    expect(trace).toEqual([{ url: graph, redirect: 'error' }]);
  });
});

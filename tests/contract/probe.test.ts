import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseXmlBounded, type XmlNode } from '../../src/xml/parse.js';
import { createLabProbe, validateLabConfig } from '../../tools/probe-server.js';

const request = readFileSync(new URL('../../fixtures/ews/request.xml', import.meta.url));
const pox = readFileSync(new URL('../../fixtures/autodiscover/request.xml', import.meta.url));
const golden: unknown = JSON.parse(readFileSync(new URL('../../fixtures/golden/timeline.json', import.meta.url), 'utf8'));
const secret = 'SYNTHETIC-probe-6Vf9Kw3mN2aR7qLp4xZt';
const config = {
  mode: 'lab', enabled: true, surface: 'm365-inbound', bind: '127.0.0.1', port: 8787,
  advertisedOrigin: 'https://probe.example.invalid/', syntheticEmail: 'bob@zfb.example.invalid',
  principalId: 'pilot', username: 'exo-pilot', secretSha256: createHash('sha256').update(secret).digest('hex'),
  scenario: 'success',
};
const authorization = `Basic ${Buffer.from(`exo-pilot:${secret}`).toString('base64')}`;
const action = 'http://schemas.microsoft.com/exchange/services/2006/messages/GetUserAvailability';
const responseNodes = (node: XmlNode, local: string): readonly XmlNode[] =>
  [node, ...node.children.flatMap(child => responseNodes(child, local))].filter(child => child.local === local);
const ews = (body: Uint8Array = request, changes: Record<string, unknown> = {}) => ({ method: 'POST', path: '/EWS/Exchange.asmx',
  authorization, contentType: 'text/xml; charset=utf-8', body, soapAction: action, ...changes });
const poxRequest = (changes: Record<string, unknown> = {}) => ({ method: 'POST', path: '/autodiscover/autodiscover.xml',
  authorization, contentType: 'text/xml', body: pox, ...changes });
const parseResponse = (xml: string) => parseXmlBounded(Buffer.from(xml));

describe('separate lab probe', () => {
  it('returns the frozen original timeline through request decode and response encode', async () => {
    const probe = createLabProbe(config);
    const response = probe.handle(ews());
    expect(response.status).toBe(200);
    const tree = parseResponse(response.body);
    const merged = responseNodes(tree, 'MergedFreeBusy').map(node => node.text);
    expect(merged).toEqual([(golden as { expectedMerged: string }).expectedMerged]);
    expect(merged).not.toEqual([(golden as { allFreeMerged: string }).allFreeMerged]);
    expect(responseNodes(tree, 'CalendarEvent').map(node => node.children.map(part => part.text))).toEqual([
      ['2026-09-14T02:30:00.000+00:00', '2026-09-14T03:00:00.000+00:00', 'Busy'],
      ['2026-09-14T03:00:00.000+00:00', '2026-09-14T03:30:00.000+00:00', 'Tentative'],
      ['2026-09-14T03:30:00.000+00:00', '2026-09-14T04:30:00.000+00:00', 'OOF'],
    ]);
    expect(responseNodes(tree, 'CalendarEventDetails')).toHaveLength(0);
  });

  it('preserves target order and duplicates, making unknown targets explicit errors', () => {
    const xml = request.toString();
    const mailbox = xml.slice(xml.indexOf('<t:MailboxData>'), xml.indexOf('</t:MailboxData>') + '</t:MailboxData>'.length);
    const mixed = xml.replace(mailbox, [mailbox, mailbox.replace('bob@zfb', 'unknown@zfb'), mailbox].join(''));
    const tree = parseResponse(createLabProbe(config).handle(ews(Buffer.from(mixed))).body);
    expect(responseNodes(tree, 'ResponseCode').map(node => node.text)).toEqual([
      'NoError', 'ErrorNoFreeBusyAccess', 'NoError',
    ]);
    expect(responseNodes(tree, 'MergedFreeBusy').map(node => node.text)).toEqual(['02133000', '02133000']);
    expect(responseNodes(tree, 'FreeBusyViewType').map(node => node.text)).toEqual([
      'FreeBusyMerged', 'None', 'FreeBusyMerged',
    ]);
  });

  it('fails the exact identity outside the frozen window and for explicit failure scenarios', () => {
    const wrongWindow = Buffer.from(request.toString().replace('2026-09-14T06:00:00Z', '2026-09-14T07:00:00Z'));
    const wrong = parseResponse(createLabProbe(config).handle(ews(wrongWindow)).body);
    expect(responseNodes(wrong, 'ResponseCode').map(node => node.text)).toEqual(['ErrorInternalServerError']);
    expect(responseNodes(wrong, 'MergedFreeBusy')).toHaveLength(0);
    for (const [scenario, code] of [['not-authorized', 'ErrorNoFreeBusyAccess'], ['not-found', 'ErrorNoFreeBusyAccess'],
      ['timeout', 'ErrorInternalServerError'], ['backend-unavailable', 'ErrorInternalServerError']] as const) {
      const tree = parseResponse(createLabProbe({ ...config, scenario }).handle(ews()).body);
      expect(responseNodes(tree, 'ResponseCode').map(node => node.text)).toEqual([code]);
      expect(responseNodes(tree, 'FreeBusyViewType').map(node => node.text)).toEqual(['None']);
      expect(responseNodes(tree, 'MergedFreeBusy')).toHaveLength(0);
    }
  });

  it('authenticates before XML parsing and rejects unauthorized or malformed requests generically', () => {
    const parser = vi.fn(parseXmlBounded);
    const probe = createLabProbe(config, undefined, parser);
    const denied = probe.handle(ews(Buffer.from('<bad'), { authorization: 'Basic bogus' }));
    expect(denied).toMatchObject({ status: 401, body: 'Unauthorized',
      headers: { 'www-authenticate': 'Basic realm="freebusy", charset="UTF-8"' } });
    expect(parser).not.toHaveBeenCalled();
    expect(probe.handle(ews(Buffer.from('<bad')))).toMatchObject({ status: 404, body: 'Request rejected' });
    expect(parser).toHaveBeenCalledTimes(1);
  });

  it('serves fixed EXPR POX settings only for the exact public synthetic target', () => {
    const probe = createLabProbe(config);
    const result = probe.handle(poxRequest({ host: 'evil.invalid', requestUrl: 'https://evil.invalid/' }));
    expect(result.status).toBe(200);
    expect(responseNodes(parseResponse(result.body), 'EwsUrl').map(node => node.text))
      .toEqual(['https://probe.example.invalid/EWS/Exchange.asmx']);
    expect(result.body).not.toContain('bob@zfb.example.invalid');
    expect(result.body).not.toContain('evil.invalid');
    const unknown = Buffer.from(pox.toString().replace('bob@zfb.example.invalid', 'other@zfb.example.invalid'));
    expect(probe.handle(poxRequest({ body: unknown }))).toMatchObject({ status: 404, body: 'Request rejected' });
    const privateProbe = createLabProbe({ ...config, surface: 'zimbra-inbound' });
    expect(privateProbe.handle(poxRequest())).toMatchObject({ status: 404 });
    const privateEws = parseResponse(privateProbe.handle(ews()).body);
    expect(responseNodes(privateEws, 'MergedFreeBusy').map(node => node.text)).toEqual(['02133000']);
  });

  it('rejects method, path, content and SOAP operation outside the query allowlist', () => {
    const probe = createLabProbe(config);
    for (const changed of [{ method: 'GET' }, { path: '/EWS/Exchange.asmx?x=1' },
      { path: '/other' }, { contentType: 'application/json' }, { soapAction: `${action}CreateItem` },
      { body: Buffer.alloc(262145) }]) {
      expect(probe.handle(ews(request, changed))).toMatchObject({ status: 404, body: 'Request rejected' });
    }
    const create = request.toString().replaceAll('GetUserAvailabilityRequest', 'CreateItem');
    expect(probe.handle(ews(Buffer.from(create)))).toMatchObject({ status: 404 });
    expect(probe.handle(null)).toMatchObject({ status: 404 });
  });

  it('requires a single explicit loopback lab identity and candidate HTTPS origin', () => {
    expect(validateLabConfig(config)).toMatchObject({ mode: 'lab', enabled: true, syntheticEmail: 'bob@zfb.example.invalid' });
    for (const changed of [{ mode: 'production' }, { enabled: false }, { bind: '0.0.0.0' },
      { syntheticEmail: 'alice@zfb.example.invalid' }, { advertisedOrigin: 'http://probe.example.invalid/' },
      { advertisedOrigin: 'https://probe.example.invalid/path' }, { secretSha256: secret },
      { scenario: 'free' }, { extraPrincipal: 'other' }]) {
      expect(() => createLabProbe({ ...config, ...changed })).toThrow('Invalid lab configuration');
    }
  });

  it('logs only generated correlation and sanitized operation/view/outcome metadata', () => {
    const events: unknown[] = [];
    const probe = createLabProbe(config, event => events.push(event));
    probe.handle(ews());
    probe.handle(ews(request, { authorization: 'Bearer CREDENTIAL-CANARY' }));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ operation: 'ews', view: 'DetailedMerged', timezone: null, outcome: 'ok' });
    expect(events[1]).toMatchObject({ operation: 'ews', view: null, timezone: null, outcome: 'error' });
    const serialized = JSON.stringify(events);
    for (const forbidden of [secret, authorization, 'bob@zfb.example.invalid', 'CREDENTIAL-CANARY',
      'CalendarEvent', '02133000']) expect(serialized).not.toContain(forbidden);
  });

  it('reports a port bind failure once with no raw exception or address', async () => {
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    const temporary = mkdtempSync(join(tmpdir(), 'w11-probe-'));
    const configPath = join(temporary, 'lab.json');
    try {
      writeFileSync(configPath, JSON.stringify({ ...config, port: address.port }));
      const child = spawnSync(process.execPath, ['--import', 'tsx',
        fileURLToPath(new URL('../../tools/probe-server.ts', import.meta.url)), configPath],
      { encoding: 'utf8', timeout: 10000 });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.stderr).toBe('Lab probe could not listen\n');
      expect(child.stdout).toBe('');
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
      rmSync(temporary, { recursive: true });
    }
  });

  it('starts the separate loopback executable and serves the golden SOAP response', async () => {
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const temporary = mkdtempSync(join(tmpdir(), 'w11-probe-'));
    const configPath = join(temporary, 'lab.json');
    writeFileSync(configPath, JSON.stringify({ ...config, port: address.port }));
    const child = spawn(process.execPath, ['--import', 'tsx',
      fileURLToPath(new URL('../../tools/probe-server.ts', import.meta.url)), configPath],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    try {
      let result: Response | undefined;
      for (let attempt = 0; attempt < 50 && !result; attempt++) {
        try {
          result = await fetch(`http://127.0.0.1:${address.port}/EWS/Exchange.asmx`, {
            method: 'POST', headers: { authorization, 'content-type': 'text/xml; charset=utf-8', soapaction: action },
            body: request, signal: AbortSignal.timeout(1000),
          });
        } catch {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      expect(result?.status).toBe(200);
      const tree = parseResponse(await result!.text());
      expect(responseNodes(tree, 'MergedFreeBusy').map(node => node.text)).toEqual(['02133000']);
      expect(stderr).toBe('');
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill('SIGTERM');
        await exited;
      }
      rmSync(temporary, { recursive: true });
    }
  });
});

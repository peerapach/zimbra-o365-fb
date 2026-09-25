import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { decodePoxRequest, POX_REQUEST_NS, POX_RESPONSE_SCHEMA } from '../../src/autodiscover/request.js';
import { encodePoxSettings, POX_RESPONSE_CONTENT_NS, POX_RESPONSE_ROOT_NS } from '../../src/autodiscover/response.js';
import { routeAutodiscover } from '../../src/autodiscover/route.js';
import type { ValidatedConfig } from '../../src/config/validate.js';
import type { Principal } from '../../src/security/principals.js';
import { parseXmlBounded, type XmlNode } from '../../src/xml/parse.js';

const fixture = readFileSync(new URL('../../fixtures/autodiscover/request.xml', import.meta.url), 'utf8');
const profile: unknown = JSON.parse(readFileSync(new URL('../../config/protocol-profiles.example.json', import.meta.url), 'utf8'));
type DirectoryEntry = ValidatedConfig['directory']['entries'][number];

function makePrincipal(changes: Partial<Principal> = {}): Principal {
  return Object.freeze({ id: 'pilot', surface: 'm365-inbound', username: 'exo-pilot', allowedProvider: 'zimbra', ...changes });
}

function makeEntry(address = 'bob@zfb.example.invalid'): DirectoryEntry {
  return Object.freeze({ id: 'bob', provider: 'zimbra', canonicalSmtp: address, aliases: Object.freeze([]),
    allowedPrincipals: Object.freeze(['pilot']), enabled: true });
}

function routeInput(changes: Record<string, unknown> = {}): unknown {
  return { principal: makePrincipal(), body: Buffer.from(fixture), advertisedOrigin: 'https://freebusy.example.org/',
    profile, entries: Object.freeze([makeEntry()]), ...changes };
}

const parse = (xml: string): XmlNode => parseXmlBounded(Buffer.from(xml, 'utf8'));

describe('POX Autodiscover request decoding', () => {
  it('decodes one approved request and normalizes its SMTP address', () => {
    expect(decodePoxRequest(parse(fixture.replace('bob@zfb.example.invalid', 'BOB@ZFB.EXAMPLE.INVALID'))))
      .toEqual({ email: 'bob@zfb.example.invalid' });
  });

  it('accepts alternate prefixes bound to the exact request namespace', () => {
    const prefixed = fixture.replace(`<Autodiscover xmlns="${POX_REQUEST_NS}">`, `<p:Autodiscover xmlns:p="${POX_REQUEST_NS}">`)
      .replace('</Autodiscover>', '</p:Autodiscover>')
      .replace('<Request>', '<p:Request>').replace('</Request>', '</p:Request>')
      .replace('<EMailAddress>', '<p:EMailAddress>').replace('</EMailAddress>', '</p:EMailAddress>')
      .replace('<AcceptableResponseSchema>', '<p:AcceptableResponseSchema>')
      .replace('</AcceptableResponseSchema>', '</p:AcceptableResponseSchema>');
    expect(decodePoxRequest(parse(prefixed))).toEqual({ email: 'bob@zfb.example.invalid' });
  });

  it.each([
    ['wrong namespace', fixture.replace(POX_REQUEST_NS, 'urn:wrong')],
    ['wrong Request namespace', fixture.replace('<Request>', '<r:Request xmlns:r="urn:wrong">')
      .replace('</Request>', '</r:Request>')],
    ['SOAP envelope', '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"/>'],
    ['unsupported response schema', fixture.replace(POX_RESPONSE_SCHEMA, 'urn:unsupported')],
    ['duplicate Request', fixture.replace('</Autodiscover>', '<Request/></Autodiscover>')],
    ['duplicate email', fixture.replace('</Request>', '<EMailAddress>other@example.invalid</EMailAddress></Request>')],
    ['nested email', fixture.replace('<EMailAddress>bob@zfb.example.invalid</EMailAddress>',
      '<Wrapper><EMailAddress>bob@zfb.example.invalid</EMailAddress></Wrapper>')],
    ['extra redirect element', fixture.replace('</Request>', '<RedirectUrl>https://evil.invalid/</RedirectUrl></Request>')],
    ['unexpected root attribute', fixture.replace('<Autodiscover ', '<Autodiscover mode="redirect" ')],
    ['unexpected request attribute', fixture.replace('<Request>', '<Request mode="redirect">')],
    ['misplaced request', fixture.replace('<Autodiscover', '<Wrapper><Autodiscover').replace('</Autodiscover>', '</Autodiscover></Wrapper>')],
  ])('rejects %s', (_name, xml) => {
    expect(decodePoxRequest(parse(xml))).toBeUndefined();
  });

  it.each(['a..b@example.invalid', '.a@example.invalid', 'a.@example.invalid', 'a@-example.invalid',
    'a@example..invalid', 'a b@example.invalid', 'a@localhost', 'a@例.invalid', `${'a'.repeat(65)}@example.invalid`])(
    'rejects malformed SMTP address %j', address => {
      expect(decodePoxRequest(parse(fixture.replace('bob@zfb.example.invalid', address)))).toBeUndefined();
    });
});

describe('static candidate EXPR POX response', () => {
  it('serializes exactly the reviewed settings fields with fixed namespaces', () => {
    const xml = encodePoxSettings('https://freebusy.example.org/', profile);
    expect(xml).toBeTypeOf('string');
    const root = parse(xml!);
    expect([root.uri, root.local]).toEqual([POX_RESPONSE_ROOT_NS, 'Autodiscover']);
    const response = root.children[0]!;
    expect([response.uri, response.local]).toEqual([POX_RESPONSE_CONTENT_NS, 'Response']);
    const account = response.children[0]!;
    expect(account.children.map(node => node.local)).toEqual(['AccountType', 'Action', 'Protocol']);
    expect(account.children.slice(0, 2).map(node => node.text)).toEqual(['email', 'settings']);
    const protocol = account.children[2]!;
    expect(protocol.children.map(node => node.local)).toEqual(['Type', 'ASUrl', 'EwsUrl']);
    expect(protocol.children.map(node => node.text)).toEqual([
      'EXPR', 'https://freebusy.example.org/EWS/Exchange.asmx', 'https://freebusy.example.org/EWS/Exchange.asmx',
    ]);
    expect(xml).not.toContain('bob@zfb.example.invalid');
  });

  it.each(['http://freebusy.example.org/', 'https://u:p@freebusy.example.org/',
    'https://freebusy.example.org/path', 'https://freebusy.example.org/?x=1', 'https://freebusy.example.org/#x',
    'https://freebusy.example.org/?', 'https://freebusy.example.org/#'])('rejects unsafe advertised origin %s', origin => {
    expect(encodePoxSettings(origin, profile)).toBeUndefined();
  });

  it('rejects a profile that is no longer candidate EXPR', () => {
    const altered = structuredClone(profile) as Record<string, unknown>;
    altered.productionApproved = true;
    expect(encodePoxSettings('https://freebusy.example.org/', altered)).toBeUndefined();
  });
});

describe('authenticated Autodiscover route adapter', () => {
  it('rejects before parsing unless the immutable principal is public and routes to Zimbra', () => {
    const parser = vi.fn(parseXmlBounded);
    const denied = routeAutodiscover(routeInput({ principal: makePrincipal({ surface: 'zimbra-inbound', allowedProvider: 'graph' }) }), parser);
    expect(parser).not.toHaveBeenCalled();
    const other = routeAutodiscover(routeInput({ principal: undefined }), parser);
    expect(denied).toEqual(other);
  });

  it('rejects mutable principals and unmapped SMTP identities with the same generic response', () => {
    const mutable = { id: 'pilot', surface: 'm365-inbound', username: 'exo-pilot', allowedProvider: 'zimbra' };
    const untrusted = routeAutodiscover(routeInput({ principal: mutable }));
    const unknown = routeAutodiscover(routeInput({ body: Buffer.from(fixture.replace('bob@zfb.example.invalid', 'unknown@zfb.example.invalid')) }));
    expect(untrusted).toEqual(unknown);
    expect(unknown).toMatchObject({ status: 404, body: 'Request rejected' });
  });

  it('does not reflect Host, request URL or XML values into advertised URLs', () => {
    const response = routeAutodiscover(routeInput({ host: 'evil.invalid', requestUrl: 'https://evil.invalid/redirect' }));
    expect(response.status).toBe(200);
    expect(response.body).toContain('https://freebusy.example.org/EWS/Exchange.asmx');
    expect(response.body).not.toContain('evil.invalid');
    expect(response.body).not.toContain('bob@zfb.example.invalid');
  });

  it('rejects XML destination injection without exposing injected content', () => {
    const body = Buffer.from(fixture.replace('</Request>', '<RedirectUrl>https://evil.invalid/</RedirectUrl></Request>'));
    const response = routeAutodiscover(routeInput({ body }));
    expect(response).toMatchObject({ status: 404, body: 'Request rejected' });
    expect(response.body).not.toContain('evil.invalid');
  });
});

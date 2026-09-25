import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ValidatedConfig } from '../../src/config/validate.js';
import { decodeAvailability } from '../../src/ews/request.js';
import { collectRawXml } from '../../src/http/raw-xml.js';
import { parseXmlBounded } from '../../src/xml/parse.js';

const limits = JSON.parse(readFileSync('contracts/limits.json', 'utf8')) as ValidatedConfig['limits'];
const fixture = readFileSync('fixtures/ews/request.xml', 'utf8');
const S = 'http://schemas.xmlsoap.org/soap/envelope/';
const cases: Array<[string, string | Buffer]> = [
  ['external file entity', '<!DOCTYPE r [<!ENTITY ex SYSTEM "file:///W28_PRIVATE_CANARY">]><r>&ex;</r>'],
  ['external network DTD', '<!DOCTYPE r SYSTEM "https://attacker.invalid/W28_DTD"><r/>'],
  ['bounded entity expansion bomb', '<!DOCTYPE r [<!ENTITY a "x"><!ENTITY b "&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;">]><r>&c;</r>'],
  ['XInclude', '<r xmlns:i="http://www.w3.org/2001/XInclude"><i:include href="file:///W28_PRIVATE_CANARY"/></r>'],
  ['external stylesheet', '<?xml-stylesheet href="https://attacker.invalid/W28_XSL"?><r/>'],
  ['UTF16 bytes', Buffer.from(fixture, 'utf16le')],
  ['UTF16 declaration', fixture.replace('UTF-8', 'UTF-16')],
  ['invalid UTF8 suffix', Buffer.concat([Buffer.from(fixture), Buffer.from([0xc0, 0xaf])])],
  ['second root after complete request', `${fixture}<W28_SECOND_ROOT/>`],
  ['truncated complete-looking body', fixture.replace('</s:Envelope>', '')],
  ['unknown entity', fixture.replace('bob@zfb.example.invalid', '&W28_ENTITY;')],
  ['namespace whitespace alias', fixture.replace(S, ` ${S}`)],
];

describe('W28 bounded XML rejection, never partial-tree success', () => {
  it.each(cases)('rejects %s with sanitized diagnostics', (_name, payload) => {
    expect(() => parseXmlBounded(Buffer.isBuffer(payload) ? payload : Buffer.from(payload), limits)).toThrowError(/^Invalid XML$/);
  });

  it.each([
    ['bytes', `<r>${'x'.repeat(limits.maxRequestBytes)}</r>`],
    ['depth', `${'<r>'.repeat(limits.maxXmlDepth + 1)}${'</r>'.repeat(limits.maxXmlDepth + 1)}`],
    ['nodes', `<r>${'<n/>'.repeat(limits.maxXmlNodes)}</r>`],
    ['attributes', `<r ${Array.from({ length: limits.maxAttributesPerElement + 1 }, (_, i) => `a${i}="x"`).join(' ')}/>`],
    ['combined text and CDATA', `<r>${'x'.repeat(limits.maxXmlTextNodeChars)}<![CDATA[y]]></r>`],
  ])('enforces the frozen %s bound', (_name, payload) => {
    expect(() => parseXmlBounded(Buffer.from(payload), limits)).toThrow('Invalid XML');
  });

  it.each([
    fixture.replace('</s:Body>', '</s:Body><s:Body/>'),
    fixture.replace('</m:MailboxDataArray>', '</m:MailboxDataArray><m:MailboxDataArray/>'),
    fixture.replace('</t:TimeWindow>', '</t:TimeWindow><t:TimeWindow/>'),
    fixture.replace('</t:Address>', '</t:Address><t:Address>W28_CANARY@example.invalid</t:Address>'),
    fixture.replace('<s:Header>', '<s:Header><t:ExchangeImpersonation s:mustUnderstand="1"/>'),
  ])('rejects valid XML with duplicate/privileged operation structure %#', body => {
    expect(() => decodeAvailability(parseXmlBounded(Buffer.from(body)), { limits })).toThrow();
  });

  it('accepts exact depth/text boundaries and rejects boundary+1 without relaxing policy', () => {
    const depth = `${'<r>'.repeat(limits.maxXmlDepth)}${'</r>'.repeat(limits.maxXmlDepth)}`;
    expect(parseXmlBounded(Buffer.from(depth), limits).local).toBe('r');
    expect(parseXmlBounded(Buffer.from(`<r>${'x'.repeat(limits.maxXmlTextNodeChars)}</r>`), limits).text).toHaveLength(limits.maxXmlTextNodeChars);
  });

  it.each([undefined, '1'])('counts actual oversized streamed bytes despite declared length %s', async declared => {
    const stream = new PassThrough(); const operation = collectRawXml(stream, declared, limits);
    const assertion = expect(operation).rejects.toMatchObject({ statusCode: 413 });
    stream.write(Buffer.alloc(limits.maxRequestBytes)); stream.write(Buffer.from('x'));
    await assertion;
    expect(stream.isPaused()).toBe(true); expect(stream.listenerCount('data')).toBe(0); stream.destroy();
  });

  it('bounds slow body lifetime and releases listeners on timeout', async () => {
    vi.useFakeTimers(); const stream = new PassThrough();
    try {
      const operation = collectRawXml(stream, undefined, limits);
      const assertion = expect(operation).rejects.toMatchObject({ statusCode: 408 });
      stream.write(Buffer.from('<r>'));
      await vi.advanceTimersByTimeAsync(limits.bodyReceiveTimeoutMs); await assertion;
      expect(stream.listenerCount('data')).toBe(0); expect(stream.isPaused()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { stream.destroy(); vi.useRealTimers(); }
  });
});

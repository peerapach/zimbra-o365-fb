import { TextDecoder } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { parseXmlBounded } from '../../src/xml/parse.js';
import { childrenNamed, optionalChild, requiredChild } from '../../src/xml/select.js';

const bytes = (xml: string) => Buffer.from(xml, 'utf8');
const limits = {
  maxRequestBytes: 262144, maxXmlDepth: 32, maxXmlNodes: 10000,
  maxAttributesPerElement: 32, maxXmlTextNodeChars: 16384,
};
const parse = (xml: string, changes = {}) => parseXmlBounded(bytes(xml), { ...limits, ...changes });

describe('bounded namespace-aware XML boundary', () => {
  it('retains expanded element and attribute names, direct text and ordered children', () => {
    const root = parse('<s:Envelope xmlns:s="urn:soap" xmlns:t="urn:types" id="1" t:id="2">before<t:Body>A<![CDATA[B]]>&amp;&#67;</t:Body>after</s:Envelope>');
    expect(root.uri).toBe('urn:soap');
    expect(root.local).toBe('Envelope');
    expect(root.text).toBe('beforeafter');
    expect(root.attributes).toContainEqual({ uri: '', local: 'id', value: '1' });
    expect(root.attributes).toContainEqual({ uri: 'urn:types', local: 'id', value: '2' });
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toMatchObject({ uri: 'urn:types', local: 'Body', text: 'AB&C' });
  });

  it('freezes the complete exposed tree against validation-to-use mutation', () => {
    const root = parse('<r a="b"><c/></r>');
    for (const value of [root, root.attributes, root.attributes[0], root.children, root.children[0]]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Reflect.set(root, 'local', 'forged')).toBe(false);
    expect(root.local).toBe('r');
  });

  it.each(['', '<?xml version="1.0"?>', '<?xml version="1.0" encoding="UTF-8"?>', '\uFEFF'])('accepts the XML 1.0 UTF-8 profile %j', declaration => {
    expect(parse(`${declaration}<r/>`).local).toBe('r');
  });

  it.each([
    '<!DOCTYPE r><r/>',
    '<!DOCTYPE r SYSTEM "file:///etc/passwd"><r/>',
    '<!DOCTYPE r [<!ENTITY x SYSTEM "https://example.invalid/private">]><r>&x;</r>',
    '<!DOCTYPE r [<!ENTITY a "xxxxxxxx"><!ENTITY b "&a;&a;&a;&a;">]><r>&b;</r>',
    '<r>&custom;</r>', '<r><?process private?></r>', '<?process?><r/>',
    '<?xml version="1.1"?><r/>', '<?xml version="1.0" encoding="UTF-16"?><r/>',
    '<?xml version="1.0" encoding="ISO-8859-1"?><r/>',
    '<r xmlns:x="http://www.w3.org/2001/XInclude"><x:include href="file:///private"/></r>',
    '<r><c></r>', '<r/><other/>', '<r>', '', '<r a="1" a="2"/>',
    '<r xmlns:a="urn:a" xmlns:b="urn:a" a:x="1" b:x="2"/>', '<unbound:r/>',
    '<r>\u0000</r>', '<r>&#0;</r>',
  ])('rejects unsafe or malformed XML with a sanitized error: %s', xml => {
    expect(() => parse(xml)).toThrow(new Error('Invalid XML'));
  });

  it.each([
    Buffer.from('<r/>', 'utf16le'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<r/>', 'utf16le')]),
    Buffer.from([0xfe, 0xff, 0, 60, 0, 114, 0, 47, 0, 62]),
    Buffer.concat([bytes('<r>'), Buffer.from([0xc0, 0xaf]), bytes('</r>')]),
    Buffer.concat([bytes('<r>'), Buffer.from([0xed, 0xa0, 0x80]), bytes('</r>')]),
  ])('rejects invalid UTF-8 and UTF-16 bytes %#', input => {
    expect(() => parseXmlBounded(input)).toThrow('Invalid XML');
  });

  it('checks byte length before decoding, including multibyte text', () => {
    const input = bytes('<r>é</r>');
    expect(parseXmlBounded(input, { ...limits, maxRequestBytes: 9 }).text).toBe('é');
    expect(() => parseXmlBounded(input, { ...limits, maxRequestBytes: 8 })).toThrow('Invalid XML');
    expect(() => parse(`<r>${'a'.repeat(262144)}</r>`)).toThrow('Invalid XML');
  });

  it('does not allocate decoded text for an oversized input', () => {
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    try {
      expect(() => parseXmlBounded(new Uint8Array(262145))).toThrow('Invalid XML');
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });

  it('accepts only a complete document and leaves no partial result after failure', () => {
    let result: unknown;
    expect(() => { result = parse('<r><valid/></r><broken>private'); }).toThrow('Invalid XML');
    expect(result).toBeUndefined();
    expect(parse('<clean/>').local).toBe('clean');
  });

  it('enforces depth at the exact boundary including self-closing leaves', () => {
    expect(parse('<a><b><c/></b></a>', { maxXmlDepth: 3 }).local).toBe('a');
    expect(() => parse('<a><b><c/></b></a>', { maxXmlDepth: 2 })).toThrow('Invalid XML');
    expect(() => parse(`${'<r>'.repeat(1000)}${'</r>'.repeat(1000)}`)).toThrow('Invalid XML');
  });

  it('counts sibling elements towards the node bound', () => {
    expect(parse('<r><a/><b/></r>', { maxXmlNodes: 3 }).children).toHaveLength(2);
    expect(() => parse('<r><a/><b/></r>', { maxXmlNodes: 2 })).toThrow('Invalid XML');
    expect(() => parse(`<r>${'<n/>'.repeat(10000)}</r>`)).toThrow('Invalid XML');
  });

  it('counts namespace declarations and ordinary attributes, resetting per element', () => {
    expect(parse('<r xmlns="urn:r" a="1"><c x="1" y="2"/></r>', { maxAttributesPerElement: 2 }).local).toBe('r');
    expect(() => parse('<r xmlns="urn:r" a="1"/>', { maxAttributesPerElement: 1 })).toThrow('Invalid XML');
  });

  it('bounds accumulated direct text across CDATA, comments, entities and children', () => {
    expect(parse('<r>A<![CDATA[B]]><!--split-->&#67;<c/>D</r>', { maxXmlTextNodeChars: 4 }).text).toBe('ABCD');
    expect(() => parse('<r>A<![CDATA[B]]><!--split-->&#67;<c/>D</r>', { maxXmlTextNodeChars: 3 })).toThrow('Invalid XML');
    expect(parse('<r>ab<c>cd</c></r>', { maxXmlTextNodeChars: 2 }).text).toBe('ab');
    expect(() => parse(`<r>${'x'.repeat(16385)}</r>`)).toThrow('Invalid XML');
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects unusable resource limits %s', value => {
    for (const key of Object.keys(limits)) expect(() => parse('<r/>', { [key]: value })).toThrow('Invalid XML');
  });
});

describe('namespace and direct-parent selectors', () => {
  it.each([
    ['surrounding spaces', ' http://schemas.xmlsoap.org/soap/envelope/ '],
    ['literal tabs and newlines', '\t\nhttp://schemas.xmlsoap.org/soap/envelope/\r\n'],
    ['trailing character-reference tab', 'http://schemas.xmlsoap.org/soap/envelope/&#x9;'],
    ['character-reference spaces', '&#32;http://schemas.xmlsoap.org/soap/envelope/&#32;'],
    ['literal NBSP', '\u00a0http://schemas.xmlsoap.org/soap/envelope/\u00a0'],
    ['character-reference NBSP', '&#xA0;http://schemas.xmlsoap.org/soap/envelope/&#xA0;'],
  ])('rejects namespace declarations with %s before URI normalization', (_name, uri) => {
    for (const xml of [
      `<r xmlns:s="${uri}"><s:Body/></r>`,
      `<r xmlns="${uri}"><Body/></r>`,
    ]) {
      expect.soft(() => parse(xml)).toThrow(new Error('Invalid XML'));
    }
  });

  it('preserves valid namespace rebinding, default undeclaration and ordinary attribute whitespace', () => {
    const root = parse('<r xmlns="urn:outer" xmlns:p="urn:old"><p:child xmlns:p="urn:new" xmlns:q="urn:attr" q:xmlns=" value " xmlnsOther=" other "><inner xmlns=""/></p:child></r>');
    const child = requiredChild(root, 'urn:new', 'child');
    expect(requiredChild(child, '', 'inner').local).toBe('inner');
    expect(child.attributes).toContainEqual({ uri: 'urn:attr', local: 'xmlns', value: ' value ' });
    expect(child.attributes).toContainEqual({ uri: '', local: 'xmlnsOther', value: ' other ' });
  });

  it('accepts alternate prefixes and default namespaces by expanded name', () => {
    for (const xml of ['<r xmlns:a="urn:t"><a:Body/></r>', '<r><Body xmlns="urn:t"/></r>']) {
      expect(requiredChild(parse(xml), 'urn:t', 'Body').local).toBe('Body');
    }
  });

  it('does not trust familiar prefixes, local-name case or descendants', () => {
    for (const xml of ['<r xmlns:t="urn:forged"><t:Body/></r>', '<r xmlns="urn:t"><body/></r>', '<r><nested><Body xmlns="urn:t"/></nested></r>']) {
      expect(() => requiredChild(parse(xml), 'urn:t', 'Body')).toThrow('Invalid XML structure');
    }
  });

  it('rejects duplicate required and optional singletons even with different prefixes', () => {
    const root = parse('<r xmlns:a="urn:t" xmlns:b="urn:t"><a:Body/><b:Body/></r>');
    expect(() => requiredChild(root, 'urn:t', 'Body')).toThrow('Invalid XML structure');
    expect(() => optionalChild(root, 'urn:t', 'Body')).toThrow('Invalid XML structure');
  });

  it('preserves order and duplicates for repeated children and distinguishes absent optional children', () => {
    const root = parse('<r xmlns="urn:t"><item>first</item><other/><item>second</item><item>first</item></r>');
    expect(childrenNamed(root, 'urn:t', 'item').map(node => node.text)).toEqual(['first', 'second', 'first']);
    expect(optionalChild(root, 'urn:t', 'missing')).toBeUndefined();
    expect(optionalChild(root, 'urn:t', 'other')?.local).toBe('other');
  });
});

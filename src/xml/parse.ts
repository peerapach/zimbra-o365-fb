import { TextDecoder } from 'node:util';
import { SaxesParser } from 'saxes';

export interface XmlAttribute {
  readonly uri: string;
  readonly local: string;
  readonly value: string;
}

export interface XmlNode {
  readonly uri: string;
  readonly local: string;
  readonly attributes: readonly XmlAttribute[];
  readonly children: readonly XmlNode[];
  readonly text: string;
}

export interface XmlLimits {
  readonly maxRequestBytes: number;
  readonly maxXmlDepth: number;
  readonly maxXmlNodes: number;
  readonly maxAttributesPerElement: number;
  readonly maxXmlTextNodeChars: number;
}

const defaultLimits: XmlLimits = Object.freeze({
  maxRequestBytes: 262144,
  maxXmlDepth: 32,
  maxXmlNodes: 10000,
  maxAttributesPerElement: 32,
  maxXmlTextNodeChars: 16384,
});

interface PendingNode {
  uri: string;
  local: string;
  attributes: readonly XmlAttribute[];
  children: XmlNode[];
  text: string;
}

function invalidXml(): never {
  throw new Error('Invalid XML');
}

/** No parser or partially built nodes escape until the whole document is valid. */
export function parseXmlBounded(bytes: Uint8Array, limits: XmlLimits = defaultLimits): XmlNode {
  try {
    for (const key of Object.keys(defaultLimits) as (keyof XmlLimits)[]) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) invalidXml();
    }
    // Byte cap precedes both UTF-8 decoding and parser allocation.
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > limits.maxRequestBytes) invalidXml();
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parser = new SaxesParser({ xmlns: true, defaultXMLVersion: '1.0', forceXMLVersion: true });
    const stack: PendingNode[] = [];
    let root: XmlNode | undefined;
    let nodes = 0;
    let attributes = 0;
    parser.on('error', invalidXml);
    parser.on('doctype', invalidXml);
    parser.on('processinginstruction', invalidXml);
    parser.on('xmldecl', declaration => {
      if (declaration.version !== '1.0'
        || (declaration.encoding !== undefined && declaration.encoding.toUpperCase() !== 'UTF-8')) invalidXml();
    });
    parser.on('opentagstart', () => {
      attributes = 0;
      if (++nodes > limits.maxXmlNodes || stack.length + 1 > limits.maxXmlDepth) invalidXml();
    });
    parser.on('attribute', attribute => {
      if (++attributes > limits.maxAttributesPerElement) invalidXml();
      // Saxes trims namespace values after this callback; reject identity-changing normalization.
      if ((attribute.name === 'xmlns' || attribute.prefix === 'xmlns')
        && attribute.value !== attribute.value.trim()) invalidXml();
    });
    parser.on('opentag', tag => {
      if (tag.uri === 'http://www.w3.org/2001/XInclude') invalidXml();
      stack.push({
        uri: tag.uri,
        local: tag.local,
        attributes: Object.freeze(Object.values(tag.attributes).map(attribute => Object.freeze({
          uri: attribute.uri, local: attribute.local, value: attribute.value,
        }))),
        children: [],
        text: '',
      });
    });
    const appendText = (text: string) => {
      const node = stack.at(-1);
      if (!node) return; // Saxes validates whitespace outside the single root.
      if (node.text.length + text.length > limits.maxXmlTextNodeChars) invalidXml();
      node.text += text;
    };
    parser.on('text', appendText);
    parser.on('cdata', appendText);
    parser.on('closetag', () => {
      const node = stack.pop();
      if (!node) return invalidXml();
      Object.freeze(node.children);
      const complete = Object.freeze(node);
      const parent = stack.at(-1);
      if (parent) parent.children.push(complete);
      else root = complete;
    });
    parser.write(xml).close();
    if (!root || stack.length) return invalidXml();
    return root;
  } catch {
    // Saxes/decoder errors can contain client XML; never expose their messages or cause.
    return invalidXml();
  }
}

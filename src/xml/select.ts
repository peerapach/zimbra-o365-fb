import type { XmlNode } from './parse.js';

/** Direct children only: a matching descendant cannot substitute for its parent. */
export function childrenNamed(parent: XmlNode, uri: string, local: string): readonly XmlNode[] {
  return Object.freeze(parent.children.filter(child => child.uri === uri && child.local === local));
}

export function optionalChild(parent: XmlNode, uri: string, local: string): XmlNode | undefined {
  const matches = childrenNamed(parent, uri, local);
  if (matches.length > 1) throw new Error('Invalid XML structure');
  return matches[0];
}

export function requiredChild(parent: XmlNode, uri: string, local: string): XmlNode {
  const child = optionalChild(parent, uri, local);
  if (!child) throw new Error('Invalid XML structure');
  return child;
}

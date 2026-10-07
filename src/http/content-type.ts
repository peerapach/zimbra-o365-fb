// Graph v1.0 returns e.g. `application/json;odata.metadata=minimal;odata.streaming=true;IEEE754Compatible=false;charset=utf-8`.
// Only these reviewed OData parameters are tolerated, each at most once; any charset must be UTF-8.
const odataParameters: Readonly<Record<string, RegExp>> = Object.freeze({
  'odata.metadata': /^(?:minimal|full|none)$/i,
  'odata.streaming': /^(?:true|false)$/i,
  ieee754compatible: /^(?:true|false)$/i,
});

/** `mediaPattern` is an anchored-by-caller regex source for the type/subtype, e.g. `application/json`. */
export function isUtf8MediaType(contentType: string, mediaPattern: string, allowOData = false): boolean {
  if (contentType.length > 512) return false;
  const [media = '', ...parameters] = contentType.split(';');
  if (!new RegExp(`^\\s*${mediaPattern}\\s*$`, 'i').test(media)) return false;
  const seen = new Set<string>();
  for (const parameter of parameters) {
    const match = /^\s*([A-Za-z0-9.]+)=("?)([A-Za-z0-9.-]+)\2\s*$/.exec(parameter);
    if (!match) return false;
    const name = match[1]!.toLowerCase();
    const value = match[3]!;
    if (seen.has(name)) return false;
    seen.add(name);
    if (name === 'charset') { if (value.toLowerCase() !== 'utf-8') return false; continue; }
    const allowed = allowOData ? odataParameters[name] : undefined;
    if (!allowed || !allowed.test(value)) return false;
  }
  return true;
}

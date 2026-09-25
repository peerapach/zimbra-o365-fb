import { create } from 'xmlbuilder2';

export const POX_RESPONSE_ROOT_NS = 'http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006';
export const POX_RESPONSE_CONTENT_NS = 'http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function candidate(value: unknown): boolean {
  if (!record(value) || value.schemaVersion !== 1 || value.status !== 'candidate-not-live-verified'
    || value.productionApproved !== false || !record(value.autodiscover)) return false;
  const settings = value.autodiscover;
  return settings.responseProtocol === 'EXPR' && settings.gateEvidence === null && Array.isArray(settings.fields)
    && settings.fields.length === 2 && settings.fields[0] === 'ASUrl' && settings.fields[1] === 'EwsUrl';
}

function fixedEwsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value !== value.trim() || /[?#\x00-\x20\x7f]/.test(value)) return undefined;
  try {
    const origin = new URL(value);
    if (origin.protocol !== 'https:' || !origin.hostname || origin.username || origin.password
      || origin.search || origin.hash || origin.pathname !== '/' || origin.href !== value) return undefined;
    return new URL('/EWS/Exchange.asmx', origin).href;
  } catch {
    return undefined;
  }
}

/** Emit the fixed synthetic candidate response; request data is not an input. */
export function encodePoxSettings(advertisedOrigin: unknown, profile: unknown): string | undefined {
  const endpoint = fixedEwsUrl(advertisedOrigin);
  if (!endpoint || !candidate(profile)) return undefined;
  const document = create({ version: '1.0', encoding: 'UTF-8' });
  document.ele('Autodiscover', { xmlns: POX_RESPONSE_ROOT_NS })
    .ele('Response', { xmlns: POX_RESPONSE_CONTENT_NS })
    .ele('Account')
    .ele('AccountType').txt('email').up()
    .ele('Action').txt('settings').up()
    .ele('Protocol')
    .ele('Type').txt('EXPR').up()
    .ele('ASUrl').txt(endpoint).up()
    .ele('EwsUrl').txt(endpoint);
  return document.end({ prettyPrint: false });
}

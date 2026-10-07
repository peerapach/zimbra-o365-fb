import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseXmlBounded } from '../../src/xml/parse.js';
import { decodeAvailability } from '../../src/ews/request.js';
import { formatFixedOffsetInstant, parseInstant, resolveFixedOffset, type FixedOffset } from '../../src/time/instants.js';
import { encodeAvailabilityResponse } from '../../src/ews/response.js';

const fixture = readFileSync(new URL('../../fixtures/ews/request.xml', import.meta.url), 'utf8');
const action = 'http://schemas.microsoft.com/exchange/services/2006/messages/GetUserAvailability';
const limits = { maxTargetsPerRequest: 100, minIntervalMinutes: 5, maxIntervalMinutes: 1440,
  maxRangeDays: 61, maxGridSlotsPerTarget: 17568 };
// Header context and body t:TimeZone must agree; +07 contexts also need the -420 body bias.
const withZone = (xml: string, zone: string) => {
  const out = xml.replace('Id="UTC"', `Id="${zone}"`);
  return zone === 'Asia/Bangkok' || zone === 'SE Asia Standard Time' ? out.replace('<t:TimeZone><t:Bias>0</t:Bias>', '<t:TimeZone><t:Bias>-420</t:Bias>') : out;
};
const withoutBodyZone = (xml: string) => xml.replace(/<t:TimeZone>[\s\S]*?<\/t:TimeZone>\s*/, '');
const tree = (xml: string) => parseXmlBounded(Buffer.from(xml));
const decode = (xml = fixture, soapAction: string | undefined = action) =>
  decodeAvailability(tree(xml), { limits, ...(soapAction === undefined ? {} : { soapAction }) });

describe('GetUserAvailability decoding', () => {
  it.each(['Asia/Bangkok', 'SE Asia Standard Time'])('retains validated %s response offset outside the UTC window', zone => {
    const xml = withZone(fixture, zone).replace('02:00:00Z', '09:00:00+07:00').replace('06:00:00Z', '13:00:00+07:00');
    const value = decode(xml);
    expect(value).toMatchObject({ responseOffset: '+07:00' });
    expect(value.window).toEqual({ startMs: 1789351200000, endMs: 1789365600000, intervalMinutes: 30 });
  });

  it.each(['Asia/Bangkok', 'SE Asia Standard Time'])('formats %s using fixed +07 even in 1900 and before the epoch', zone => {
    const offset = resolveFixedOffset(zone);
    expect(parseInstant('1900-01-01T09:00:00', zone)).toBe(-2208981600000);
    expect(formatFixedOffsetInstant(-2208981600000, offset)).toBe('1900-01-01T09:00:00.000+07:00');
    expect(formatFixedOffsetInstant(-1, offset)).toBe('1970-01-01T06:59:59.999+07:00');
    expect(formatFixedOffsetInstant(-1, '+00:00')).toBe('1969-12-31T23:59:59.999+00:00');
  });

  it.each(['Europe/London', 'Pacific Standard Time', 'Greenwich Standard Time', '+07:00', '__proto__'])('does not enable unapproved fixed context %s', zone => {
    expect(() => decode(withZone(fixture, zone))).toThrow();
    expect(() => resolveFixedOffset(zone)).toThrow();
  });

  it.each(['Asia/Bangkok', '+06:42', '-00:00', '+08:00'])('rejects non-policy formatter/renderer offset %s', value => {
    const offset = value as FixedOffset;
    expect(() => formatFixedOffsetInstant(0, offset)).toThrow();
    expect(() => encodeAvailabilityResponse(decode().window, [{ kind: 'error', targetId: 'hidden', reason: 'timeout' }], { responseOffset: offset })).toThrow();
  });

  it.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo'])('keeps fixed-offset output independent of host TZ %s', timezone => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = timezone;
      expect(formatFixedOffsetInstant(1789351200000, '+07:00')).toBe('2026-09-14T09:00:00.000+07:00');
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
  it('decodes the synthetic DetailedMerged request with its exact UTC window', () => {
    expect(decode()).toEqual({ addresses: ['bob@zfb.example.invalid'], requestedView: 'DetailedMerged', responseOffset: '+00:00',
      window: { startMs: 1789351200000, endMs: 1789365600000, intervalMinutes: 30 } });
  });

  it('accepts arbitrary namespace prefixes and namespace declarations on descendants', () => {
    const xml = fixture.replace(/(<\/?)s:/g, '$1soap:').replace('xmlns:s=', 'xmlns:soap=')
      .replace(/(<\/?)m:/g, '$1msg:').replace('xmlns:m=', 'xmlns:msg=')
      .replace(/(<\/?)t:/g, '$1typ:').replace('xmlns:t=', 'xmlns:typ=');
    expect(decode(xml)).toEqual(decode());
  });

  it.each([action, `"${action}"`])('accepts the exact approved action %s', soapAction => {
    expect(decode(fixture, soapAction)).toEqual(decode());
  });

  it('distinguishes absent SOAPAction from a conflicting present value', () => {
    expect(decodeAvailability(tree(fixture), { limits })).toEqual(decode());
  });

  it.each(['', 'GetUserAvailability', action.toLowerCase(), ` ${action}`, `${action} `,
    `"${action}`, `${action}"`, `""${action}""`, `'${action}'`, `" ${action}"`, `${action},${action}`,
    action.replace('GetUserAvailability', 'CreateItem')])('rejects conflicting or malformed action %s', value => {
    expect(() => decode(fixture, value)).toThrow();
  });

  const mutations: [string, string, string][] = [
    ['SOAP 1.2', 'http://schemas.xmlsoap.org/soap/envelope/', 'http://www.w3.org/2003/05/soap-envelope'],
    ['forged messages namespace', '/2006/messages', '/2006/forged'],
    ['forged types namespace', '/2006/types', '/2006/forged'],
    ['duplicate body', '</s:Body>', '</s:Body><s:Body/>'],
    ['duplicate header', '</s:Header>', '</s:Header><s:Header/>'],
    ['extra body operation', '</s:Body>', '<m:GetFolder/></s:Body>'],
    ['duplicate operation', '</s:Body>', '<m:GetUserAvailabilityRequest/></s:Body>'],
    ['suggestions', '</m:GetUserAvailabilityRequest>', '<t:SuggestionsViewOptions/></m:GetUserAvailabilityRequest>'],
    ['duplicate target array', '</m:MailboxDataArray>', '</m:MailboxDataArray><m:MailboxDataArray/>'],
    ['duplicate view options', '</t:FreeBusyViewOptions>', '</t:FreeBusyViewOptions><t:FreeBusyViewOptions/>'],
    ['duplicate address', '</t:Address>', '</t:Address><t:Address>evil@example.invalid</t:Address>'],
    ['wrapped address', '<t:Email>', '<t:Email><t:Wrapper>'],
    ['unknown header', '<s:Header>', '<s:Header><t:Unknown s:mustUnderstand="0"/>'],
    ['impersonation', '<s:Header>', '<s:Header><t:ExchangeImpersonation/>'],
    ['duplicate version', '<s:Header>', '<s:Header><t:RequestServerVersion Version="Exchange2010_SP1"/>'],
    ['duplicate context', '<s:Header>', '<s:Header><t:TimeZoneContext/>'],
    ['unsupported version', 'Exchange2010_SP1', 'Exchange2099'],
    ['unsupported zone', 'Id="UTC"', 'Id="Europe/London"'],
    ['unknown timezone attribute', 'Id="UTC"', 'Id="UTC" Name="secret"'],
    ['unsupported mustUnderstand', 'Version="Exchange2010_SP1"', 'Version="Exchange2010_SP1" s:mustUnderstand="true"'],
    ['actor routing', 'Version="Exchange2010_SP1"', 'Version="Exchange2010_SP1" s:actor="someone"'],
    ['forged attribute namespace', 'Version="Exchange2010_SP1"', 't:Version="Exchange2010_SP1"'],
    ['operation attribute', '<m:GetUserAvailabilityRequest>', '<m:GetUserAvailabilityRequest extra="yes">'],
    ['leaf attribute', '<t:Address>', '<t:Address xml:lang="en">'],
    ['mixed structural text', '<s:Body>', '<s:Body>unexpected'],
    ['nested scalar', 'Required</t:AttendeeType>', '<t:Nested>Required</t:Nested></t:AttendeeType>'],
    ['unsupported attendee', '>Required<', '>Organizer<'],
    ['invalid boolean', '>false<', '>FALSE<'],
    ['unsupported view', '>DetailedMerged<', '>Detailed<'],
    ['missing view', '<t:RequestedView>DetailedMerged</t:RequestedView>', ''],
    ['empty interval', '>30</t:MergedFreeBusyIntervalInMinutes>', '></t:MergedFreeBusyIntervalInMinutes>'],
    ['zero interval', '>30</t:MergedFreeBusyIntervalInMinutes>', '>0</t:MergedFreeBusyIntervalInMinutes>'],
    ['decimal interval', '>30</t:MergedFreeBusyIntervalInMinutes>', '>30.0</t:MergedFreeBusyIntervalInMinutes>'],
    ['exponential interval', '>30</t:MergedFreeBusyIntervalInMinutes>', '>3e1</t:MergedFreeBusyIntervalInMinutes>'],
    ['signed interval', '>30</t:MergedFreeBusyIntervalInMinutes>', '>+30</t:MergedFreeBusyIntervalInMinutes>'],
    ['interval below limit', '>30</t:MergedFreeBusyIntervalInMinutes>', '>4</t:MergedFreeBusyIntervalInMinutes>'],
    ['interval above limit', '>30</t:MergedFreeBusyIntervalInMinutes>', '>1441</t:MergedFreeBusyIntervalInMinutes>'],
    ['reversed window', '2026-09-14T06:00:00Z', '2026-09-14T01:00:00Z'],
    ['empty window', '2026-09-14T06:00:00Z', '2026-09-14T02:00:00Z'],
    ['excessive range', '2026-09-14T06:00:00Z', '2026-11-15T02:00:00Z'],
    ['contradictory timezone', '2026-09-14T02:00:00Z', '2026-09-14T02:00:00+07:00'],
  ];
  it.each(mutations)('rejects %s', (_name, from, to) => {
    let xml = fixture.replace(from, to);
    if (_name === 'wrapped address') xml = xml.replace('</t:Email>', '</t:Wrapper></t:Email>');
    const parsed = tree(xml);
    expect(() => decodeAvailability(parsed, { limits, soapAction: action })).toThrow();
  });

  it.each(['GetFolder', 'CreateItem', 'UpdateItem', 'DeleteItem', 'GetUserSettings'])('rejects %s operation', name => {
    expect(() => decode(fixture.replaceAll('GetUserAvailabilityRequest', name))).toThrow();
  });

  it.each(['Email', 'AttendeeType', 'ExcludeConflicts', 'TimeWindow', 'StartTime', 'EndTime',
    'MergedFreeBusyIntervalInMinutes', 'RequestedView', 'TimeZoneDefinition'])('rejects duplicate %s fields', name => {
    expect(() => decode(fixture.replace(`</t:${name}>`, `</t:${name}><t:${name}/>`)
      .replace(name === 'TimeZoneDefinition' ? 'Id="UTC"/>' : 'not-present', 'Id="UTC"/><t:TimeZoneDefinition Id="UTC"/>'))).toThrow();
  });

  it.each(['', 'a..b@example.invalid', '.a@example.invalid', 'a.@example.invalid', 'a@-example.invalid',
    'a@example..invalid', 'a@example.invalid\n', 'a b@example.invalid', 'a@localhost', 'a@例.invalid',
    `${'a'.repeat(65)}@example.invalid`])('rejects malformed SMTP address %j', address => {
    expect(() => decode(fixture.replace('bob@zfb.example.invalid', address))).toThrow();
  });

  it.each(['None', 'MergedOnly', 'FreeBusy', 'FreeBusyMerged', 'DetailedMerged'])('retains supported requested view %s', requestedView => {
    expect(decode(fixture.replace('DetailedMerged', requestedView))).toMatchObject({ requestedView });
  });

  it.each(['Required', 'Optional', 'Resource'])('accepts %s metadata without changing addresses', value => {
    expect(decode(fixture.replace('>Required<', `>${value}<`).replace('>false<', '>true<'))).toEqual(decode());
  });

  it.each(['0', '1'])('accepts known mustUnderstand=%s headers', value => {
    expect(decode(fixture.replace('Version="Exchange2010_SP1"', `Version="Exchange2010_SP1" s:mustUnderstand="${value}"`)
      .replace('<t:TimeZoneContext>', `<t:TimeZoneContext s:mustUnderstand="${value}">`))).toEqual(decode());
  });

  it('accepts explicit instants without optional headers or body TimeZone and rejects naive ones', () => {
    const xml = withoutBodyZone(fixture.replace(/<s:Header>[\s\S]*?<\/s:Header>/, ''));
    expect(decode(xml)).toEqual(decode());
    expect(() => decode(xml.replaceAll('00Z', '00'))).toThrow();
  });

  it.each([['0', '+00:00', '02'], ['-420', '+07:00', '09']] as const)('uses exchangelib body TimeZone bias %s alone for naive instants', (bias, offset, hour) => {
    const xml = fixture.replace(/<s:Header>[\s\S]*?<\/s:Header>/, '')
      .replace('<t:TimeZone><t:Bias>0</t:Bias>', `<t:TimeZone><t:Bias>${bias}</t:Bias>`)
      .replace('02:00:00Z', `${hour}:00:00`).replace('06:00:00Z', `${String(Number(hour) + 4).padStart(2, '0')}:00:00`);
    expect(decode(xml)).toEqual({ ...decode(), responseOffset: offset });
  });

  it.each([
    ['DST body', '<t:DaylightTime><t:Bias>0</t:Bias>', '<t:DaylightTime><t:Bias>-60</t:Bias>'],
    ['body/header conflict', '<t:TimeZone><t:Bias>0</t:Bias>', '<t:TimeZone><t:Bias>-420</t:Bias>'],
    ['unapproved bias', '<t:TimeZone><t:Bias>0</t:Bias>', '<t:TimeZone><t:Bias>-540</t:Bias>'],
    ['bad weekday', '<t:DayOfWeek>Monday</t:DayOfWeek>', '<t:DayOfWeek>Funday</t:DayOfWeek>'],
    ['missing StandardTime', /<t:StandardTime>[\s\S]*?<\/t:StandardTime>/, ''],
    ['non-SMTP routing', '<t:RoutingType>SMTP</t:RoutingType>', '<t:RoutingType>EX</t:RoutingType>'],
  ] as const)('rejects body TimeZone/Email variant: %s', (_name, from, to) => {
    expect(() => decode(fixture.replace(from, to))).toThrow();
  });

  it.each(['UTC', 'Etc/UTC', 'Asia/Bangkok', 'SE Asia Standard Time'])('decodes naive instants with reviewed fixed context %s', zone => {
    const bangkok = zone.includes('Asia');
    const xml = withZone(fixture, zone)
      .replace('02:00:00Z', bangkok ? '09:00:00' : '02:00:00')
      .replace('06:00:00Z', bangkok ? '13:00:00' : '06:00:00');
    expect(decode(xml)).toEqual({ ...decode(), responseOffset: bangkok ? '+07:00' : '+00:00' });
  });

  it('defaults the interval only when absent', () => {
    expect(decode(fixture.replace('<t:MergedFreeBusyIntervalInMinutes>30</t:MergedFreeBusyIntervalInMinutes>', ''))).toEqual(decode());
  });

  it.each([5, 1440])('accepts interval boundary %s', intervalMinutes => {
    expect(decode(fixture.replace('>30</t:MergedFreeBusyIntervalInMinutes>', `>${intervalMinutes}</t:MergedFreeBusyIntervalInMinutes>`)))
      .toMatchObject({ window: { intervalMinutes } });
  });

  it('preserves duplicate addresses and their original order at the target boundary', () => {
    const mailbox = fixture.slice(fixture.indexOf('<t:MailboxData>'), fixture.indexOf('</t:MailboxData>') + '</t:MailboxData>'.length);
    const entries = [mailbox, mailbox.replace('bob@zfb', 'alice@zfb'), mailbox].join('');
    const xml = fixture.replace(mailbox, entries);
    expect(decodeAvailability(tree(xml), { limits: { ...limits, maxTargetsPerRequest: 3 } }))
      .toMatchObject({ addresses: ['bob@zfb.example.invalid', 'alice@zfb.example.invalid', 'bob@zfb.example.invalid'] });
    expect(() => decodeAvailability(tree(xml), { limits: { ...limits, maxTargetsPerRequest: 2 } })).toThrow();
    expect(() => decode(fixture.replace(mailbox, ''))).toThrow();
  });

  it('accepts exactly 100 targets and rejects 101 without truncating', () => {
    const mailbox = fixture.slice(fixture.indexOf('<t:MailboxData>'), fixture.indexOf('</t:MailboxData>') + '</t:MailboxData>'.length);
    expect(decode(fixture.replace(mailbox, mailbox.repeat(100))).addresses).toHaveLength(100);
    const parsed = tree(fixture.replace(mailbox, mailbox.repeat(101)));
    expect(() => decodeAvailability(parsed, { limits })).toThrow();
  });

  it('retains unrounded endpoints and accepts the exact 61 day range boundary', () => {
    expect(decode(fixture.replace('2026-09-14T06:00:00Z', '2026-11-14T02:00:00Z')).window)
      .toEqual({ startMs: 1789351200000, endMs: 1794621600000, intervalMinutes: 30 });
    expect(decode(fixture.replace('02:00:00Z', '02:00:01.234Z').replace('06:00:00Z', '06:00:01.999Z')).window)
      .toEqual({ startMs: 1789351201234, endMs: 1789365601999, intervalMinutes: 30 });
  });

  it.each(['Envelope', 'Body', 'Header'])('rejects forged SOAP %s namespaces', name => {
    const parsed = tree(fixture.replace(`<s:${name}`, `<t:${name}`).replace(`</s:${name}>`, `</t:${name}>`));
    expect(() => decodeAvailability(parsed, { limits })).toThrow();
  });

  it.each(['Version="Exchange2010_SP1"', 'Id="UTC"'])('rejects missing required header attribute %s', attribute => {
    const parsed = tree(fixture.replace(attribute, ''));
    expect(() => decodeAvailability(parsed, { limits })).toThrow();
  });

  it.each(['Address', 'MailboxDataArray', 'FreeBusyViewOptions', 'TimeWindow'])('rejects wrong namespace for %s', name => {
    const prefix = name === 'MailboxDataArray' ? 'm' : 't';
    const parsed = tree(fixture.replace(`<${prefix}:${name}`, `<s:${name}`).replace(`</${prefix}:${name}>`, `</s:${name}>`));
    expect(() => decodeAvailability(parsed, { limits })).toThrow();
  });

  it.each(['0', '1'])('accepts XML boolean %s without changing availability semantics', value => {
    expect(decode(fixture.replace('>false<', `>${value}<`))).toEqual(decode());
  });

  it('retains address case for downstream identity resolution', () => {
    expect(decode(fixture.replace('bob@zfb.example.invalid', 'Bob@ZFB.Example.invalid')).addresses)
      .toEqual(['Bob@ZFB.Example.invalid']);
  });

  it('applies the supplied grid cap before returning any input', () => {
    expect(() => decodeAvailability(tree(fixture), { limits: { ...limits, maxGridSlotsPerTarget: 7 } })).toThrow();
    expect(decodeAvailability(tree(fixture), { limits: { ...limits, maxGridSlotsPerTarget: 8 } })).toEqual(decode());
  });

  it('rejects a header placed after the body or beneath it', () => {
    const header = fixture.slice(fixture.indexOf('<s:Header>'), fixture.indexOf('</s:Header>') + '</s:Header>'.length);
    expect(() => decode(fixture.replace(header, '').replace('</s:Body>', `</s:Body>${header}`))).toThrow();
    expect(() => decode(fixture.replace(header, '').replace('<s:Body>', `<s:Body>${header}`))).toThrow();
  });
});

import type { XmlNode } from '../xml/parse.js';
import { childrenNamed, optionalChild, requiredChild } from '../xml/select.js';
import { createWindow, type WindowLimits } from '../time/window.js';
import { parseInstant, resolveFixedOffset, type FixedOffset } from '../time/instants.js';
import type { WindowUtc } from '../core/types.js';
import { availabilityOperation, checkAttributes, container, invalidRequest, MESSAGES, SOAP, TYPES } from './operation.js';

export interface DecodeOptions {
  readonly limits: WindowLimits & { readonly maxTargetsPerRequest: number };
  readonly soapAction?: string;
}

const views = ['None', 'MergedOnly', 'FreeBusy', 'FreeBusyMerged', 'DetailedMerged'] as const;
export type RequestedView = typeof views[number];
export interface AvailabilityInput {
  readonly addresses: readonly string[];
  readonly window: WindowUtc;
  /** Validated wire representation only; core/provider/cache windows remain UTC. */
  readonly responseOffset: FixedOffset;
  /** A requested view never grants permission to disclose event details. */
  readonly requestedView: RequestedView;
}
const zones = ['UTC', 'Etc/UTC', 'Asia/Bangkok', 'SE Asia Standard Time'];
const mustUnderstand = { [`${SOAP}#mustUnderstand`]: ['0', '1'] };

function scalar(node: XmlNode): string {
  checkAttributes(node);
  if (node.children.length) invalidRequest();
  return node.text;
}

function structure(node: XmlNode, names: readonly string[], uri = TYPES): void {
  checkAttributes(node);
  container(node, names, uri);
}

function decodeHeader(header?: XmlNode): string | undefined {
  if (!header) return undefined;
  structure(header, ['RequestServerVersion', 'TimeZoneContext']);
  const version = optionalChild(header, TYPES, 'RequestServerVersion');
  if (version) {
    container(version, []);
    checkAttributes(version, { ...mustUnderstand, '#Version': ['Exchange2010_SP1'] });
    if (!version.attributes.some(attribute => attribute.uri === '' && attribute.local === 'Version')) invalidRequest();
  }
  const context = optionalChild(header, TYPES, 'TimeZoneContext');
  if (!context) return undefined;
  checkAttributes(context, mustUnderstand);
  container(context, ['TimeZoneDefinition']);
  const definition = requiredChild(context, TYPES, 'TimeZoneDefinition');
  container(definition, []);
  checkAttributes(definition, { '#Id': zones });
  const id = definition.attributes.find(attribute => attribute.uri === '' && attribute.local === 'Id');
  if (!id) return invalidRequest();
  return id.value;
}

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Body legacy TimeZone (SerializableTimeZone) bias -> fixed profile. DST-observing bodies are not approved.
const biasZones: Readonly<Record<string, string>> = Object.freeze({ '0': 'UTC', '-420': 'Asia/Bangkok' });

function integer(parent: XmlNode, name: string, min: number, max: number): number {
  const value = scalar(requiredChild(parent, TYPES, name));
  if (!/^-?[0-9]{1,4}$/.test(value)) invalidRequest();
  const number = Number(value);
  if (number < min || number > max) invalidRequest();
  return number;
}

function decodeTransition(parent: XmlNode, name: string): number {
  const node = requiredChild(parent, TYPES, name);
  structure(node, ['Bias', 'Time', 'DayOrder', 'Month', 'DayOfWeek']);
  const bias = integer(node, 'Bias', -1440, 1440);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(scalar(requiredChild(node, TYPES, 'Time')))) invalidRequest();
  integer(node, 'DayOrder', 1, 5);
  integer(node, 'Month', 1, 12);
  if (!weekdays.includes(scalar(requiredChild(node, TYPES, 'DayOfWeek')))) invalidRequest();
  return bias;
}

/** exchangelib-style body t:TimeZone; it must precede MailboxDataArray and describe a fixed approved offset. */
function decodeBodyTimeZone(operation: XmlNode): string | undefined {
  const node = optionalChild(operation, TYPES, 'TimeZone');
  if (!node) return undefined;
  if (operation.children[0] !== node) invalidRequest();
  structure(node, ['Bias', 'StandardTime', 'DaylightTime']);
  const bias = integer(node, 'Bias', -1440, 1440);
  if (decodeTransition(node, 'StandardTime') !== 0 || decodeTransition(node, 'DaylightTime') !== 0) invalidRequest();
  const zone = biasZones[String(bias)];
  if (zone === undefined) return invalidRequest();
  return zone;
}

function decodeMailbox(mailbox: XmlNode): string {
  structure(mailbox, ['Email', 'AttendeeType', 'ExcludeConflicts']);
  const email = requiredChild(mailbox, TYPES, 'Email');
  structure(email, ['Name', 'Address', 'RoutingType']);
  const address = scalar(requiredChild(email, TYPES, 'Address'));
  const name = optionalChild(email, TYPES, 'Name');
  if (name) scalar(name);
  const routing = optionalChild(email, TYPES, 'RoutingType');
  if (routing && scalar(routing) !== 'SMTP') invalidRequest();
  const parts = address.split('@');
  const local = parts[0] ?? '';
  const domain = parts[1] ?? '';
  if (parts.length !== 2 || address.length > 254 || local.length > 64
    || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !domain.includes('.') || domain.split('.').some(label =>
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) invalidRequest();
  const attendee = scalar(requiredChild(mailbox, TYPES, 'AttendeeType'));
  const exclude = scalar(requiredChild(mailbox, TYPES, 'ExcludeConflicts'));
  if (!['Required', 'Optional', 'Resource'].includes(attendee) || !['true', 'false', '0', '1'].includes(exclude)) invalidRequest();
  return address;
}

/** Pure protocol decoding: authorization and provider work belong to later stages. */
export function decodeAvailability(tree: XmlNode, options: DecodeOptions): AvailabilityInput {
  const { operation, header } = availabilityOperation(tree, options.soapAction);
  const contextZone = decodeHeader(header);
  const bodyZone = decodeBodyTimeZone(operation);
  // Header context and body TimeZone must agree on the fixed offset; neither silently overrides the other.
  if (contextZone !== undefined && bodyZone !== undefined && resolveFixedOffset(contextZone) !== resolveFixedOffset(bodyZone)) invalidRequest();
  const zone = contextZone ?? bodyZone;
  const array = requiredChild(operation, MESSAGES, 'MailboxDataArray');
  structure(array, ['MailboxData']);
  const mailboxes = childrenNamed(array, TYPES, 'MailboxData');
  const maxTargets = options.limits.maxTargetsPerRequest;
  if (!Number.isSafeInteger(maxTargets) || maxTargets < 1 || !mailboxes.length || mailboxes.length > maxTargets) invalidRequest();
  const addresses = Object.freeze(mailboxes.map(decodeMailbox));
  const view = requiredChild(operation, TYPES, 'FreeBusyViewOptions');
  structure(view, ['TimeWindow', 'MergedFreeBusyIntervalInMinutes', 'RequestedView']);
  const timeWindow = requiredChild(view, TYPES, 'TimeWindow');
  structure(timeWindow, ['StartTime', 'EndTime']);
  const start = parseInstant(scalar(requiredChild(timeWindow, TYPES, 'StartTime')), zone);
  const end = parseInstant(scalar(requiredChild(timeWindow, TYPES, 'EndTime')), zone);
  const intervalNode = optionalChild(view, TYPES, 'MergedFreeBusyIntervalInMinutes');
  const interval = intervalNode ? scalar(intervalNode) : '30';
  if (!/^[0-9]+$/.test(interval)) invalidRequest();
  const requested = scalar(requiredChild(view, TYPES, 'RequestedView'));
  const requestedView = views.find(value => value === requested);
  if (requestedView === undefined) return invalidRequest();
  return Object.freeze({ addresses, requestedView, responseOffset: zone === undefined ? '+00:00' : resolveFixedOffset(zone),
    window: createWindow(start, end, Number(interval), options.limits) });
}

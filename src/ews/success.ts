import { create } from 'xmlbuilder2';
import { normalizeFreeBusyGrid } from '../freebusy/grid.js';
import type { Slot } from '../core/types.js';

const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const MESSAGES = 'http://schemas.microsoft.com/exchange/services/2006/messages';
const TYPES = 'http://schemas.microsoft.com/exchange/services/2006/types';
const busyType: Readonly<Record<Slot['status'], string>> = Object.freeze({
  free: 'Free', tentative: 'Tentative', busy: 'Busy', oof: 'OOF', unknown: 'NoData',
});

function utc(ms: number): string {
  return new Date(ms).toISOString().replace(/Z$/, '+00:00');
}

export function encodeFreeBusySuccess(window: unknown, coverage: unknown, intervals: unknown): string {
  const grid = normalizeFreeBusyGrid(window, coverage, intervals);
  const document = create({ version: '1.0', encoding: 'UTF-8' });
  const envelope = document.ele('s:Envelope', {
    'xmlns:s': SOAP, 'xmlns:m': MESSAGES, 'xmlns:t': TYPES,
  });
  const response = envelope.ele('s:Body').ele('m:GetUserAvailabilityResponse')
    .ele('m:FreeBusyResponseArray').ele('m:FreeBusyResponse');
  const message = response.ele('m:ResponseMessage', { ResponseClass: 'Success' });
  message.ele('m:ResponseCode').txt('NoError');
  const view = response.ele('m:FreeBusyView');
  view.ele('t:FreeBusyViewType').txt('FreeBusyMerged');
  view.ele('t:MergedFreeBusy').txt(grid.merged);
  const events = view.ele('t:CalendarEventArray');
  for (const interval of grid.intervals) {
    if (interval.status === 'free') continue;
    const event = events.ele('t:CalendarEvent');
    event.ele('t:StartTime').txt(utc(interval.startMs));
    event.ele('t:EndTime').txt(utc(interval.endMs));
    event.ele('t:BusyType').txt(busyType[interval.status]);
  }
  return document.end({ prettyPrint: false });
}

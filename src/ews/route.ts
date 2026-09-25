import { create } from 'xmlbuilder2';
import type { ValidatedConfig } from '../config/validate.js';
import type { Surface, TargetResult, WindowUtc } from '../core/types.js';
import type { createFreeBusyService } from '../freebusy/service.js';
import type { Principal } from '../security/principals.js';
import { parseXmlBounded } from '../xml/parse.js';
import { SOAP } from './operation.js';
import { decodeAvailability, type AvailabilityInput } from './request.js';
import { encodeAvailabilityResponse } from './response.js';
import { abortable } from '../http/outbound.js';

export function createEwsFault(code: 'Client' | 'Server') {
  const document = create({ version: '1.0', encoding: 'UTF-8' });
  const node = document.ele('s:Envelope', { 'xmlns:s': SOAP }).ele('s:Body').ele('s:Fault');
  node.ele('faultcode').txt(`s:${code}`);
  node.ele('faultstring').txt(code === 'Client' ? 'Invalid request' : 'Service unavailable');
  return { status: 500, body: document.end() };
}
export interface EwsObserver {
  complete(surface: Surface, window: WindowUtc, results: readonly TargetResult[], status: number): void;
  rejected(surface: Surface, reason: 'parser' | 'internal'): void;
}
export function createEwsRoute(service: ReturnType<typeof createFreeBusyService>, limits: ValidatedConfig['limits'], monoMs: () => number,
  observer?: EwsObserver) {
  return async (principal: Principal, surface: Surface, bytes: unknown, soapAction: unknown, clientSignal?: AbortSignal,
    deadlineMonoMs = monoMs() + limits.totalRequestDeadlineMs) => {
    const rejected = (code: 'Client' | 'Server') => { observer?.rejected(surface, code === 'Client' ? 'parser' : 'internal'); return createEwsFault(code); };
    const expired = () => {
      const now = monoMs();
      return clientSignal?.aborted || !Number.isFinite(now) || !Number.isFinite(deadlineMonoMs) || now >= deadlineMonoMs;
    };
    const checkActive = () => { if (expired()) throw new Error('Request deadline exceeded'); };
    if (expired()) return rejected('Server');
    let input: AvailabilityInput;
    try {
      if (!(bytes instanceof Uint8Array) || (soapAction !== undefined && typeof soapAction !== 'string')) return rejected('Client');
      input = decodeAvailability(parseXmlBounded(bytes, limits), { limits, ...(soapAction === undefined ? {} : { soapAction }) });
    } catch { return rejected('Client'); }
    const controller = new AbortController();
    const signal = clientSignal ? AbortSignal.any([clientSignal, controller.signal]) : controller.signal;
    const serviceDeadline = deadlineMonoMs - limits.responseReserveMs;
    const budgetMs = serviceDeadline - monoMs();
    if (expired() || !Number.isFinite(budgetMs) || budgetMs <= 0) return rejected('Server');
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const total = new AbortController();
    const totalSignal = clientSignal ? AbortSignal.any([clientSignal, total.signal]) : total.signal;
    const totalTimer = setTimeout(() => total.abort(), Math.max(0, deadlineMonoMs - monoMs()));
    try {
      const results = await abortable(service(principal, surface, input.addresses, input.window,
        { signal, deadlineMonoMs: serviceDeadline }), totalSignal);
      // Subscriber cancellation settles per-target failures during the response reserve.
      // An uncooperative dependency still cannot hold the aggregate past the total deadline.
      const body = encodeAvailabilityResponse(input.window, results,
        { requestedView: input.requestedView, responseOffset: input.responseOffset, maxResponseBytes: limits.maxResponseBytes, checkActive });
      checkActive();
      const response = Buffer.byteLength(body) <= limits.maxResponseBytes ? { status: 200, body } : createEwsFault('Server');
      observer?.complete(surface, input.window, results, response.status);
      checkActive();
      return response;
    } catch { return rejected('Server'); }
    finally { clearTimeout(timer); clearTimeout(totalTimer); controller.abort(); total.abort(); }
  };
}

import pino from 'pino';
import type { DestinationStream } from 'pino';

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  // Do not invoke accessors or error.toJSON (including hostile proxy descriptors).
  try { return Object.getOwnPropertyDescriptor(value, key)?.value as unknown; }
  catch { return undefined; }
}

function category(value: unknown, choices: readonly string[]): string {
  return typeof value === 'string' && choices.includes(value) ? value : 'other';
}

function serializeData(value: unknown) {
  const result: Record<string, string | number> = {};
  const fields = {
    surface: ['m365-inbound', 'zimbra-inbound', 'management'],
    provider: ['graph', 'zimbra'],
    outcome: ['useful', 'unknown', 'failure', 'timeout', 'rejected', 'ready', 'draining', 'stopped'],
  };
  for (const [key, choices] of Object.entries(fields)) {
    const input = own(value, key);
    if (input !== undefined) result[key] = category(input, choices);
  }
  const status = own(value, 'statusCode');
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) result.statusCode = status;
  const duration = own(value, 'durationMs');
  if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) result.durationMs = duration;
  return result;
}

/** The raw logger is private: callers cannot supply messages, bindings, or child serializers. */
export function createSanitizedLogger(destination: DestinationStream) {
  const logger = pino({
    base: null, timestamp: false,
    redact: { paths: ['authorization', 'authToken', 'cookie', 'req', 'res', 'body', 'targetId'], remove: true },
    serializers: {
      data: serializeData,
      err: (value: unknown) => ({ code: category(own(value, 'code'), ['not-authorized', 'not-found', 'timeout',
        'throttled', 'backend-unavailable', 'invalid-response', 'unsupported-timezone']) }),
    },
  }, destination);
  return Object.freeze({
    record(event: unknown, fields: unknown): void {
      logger.info({ event: category(event, ['request', 'provider', 'rejection', 'lifecycle']),
        data: serializeData(fields), err: { code: own(own(fields, 'err'), 'code') } }, 'gateway');
    },
  });
}

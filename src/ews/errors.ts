import type { Failure } from '../core/types.js';

export interface EwsFailure {
  readonly responseCode: string;
}

const noAccess: EwsFailure = Object.freeze({ responseCode: 'ErrorNoFreeBusyAccess' });
const internal: EwsFailure = Object.freeze({ responseCode: 'ErrorInternalServerError' });

const failures: Readonly<Record<Failure, EwsFailure>> = Object.freeze({
  'not-authorized': noAccess,
  'not-found': noAccess,
  timeout: internal,
  throttled: internal,
  'backend-unavailable': internal,
  'invalid-response': internal,
  'unsupported-timezone': internal,
});

/** Map provider failures to fixed EWS codes without retaining provider details. */
export function mapEwsFailure(reason: unknown): EwsFailure {
  if (typeof reason !== 'string' || !Object.hasOwn(failures, reason)) return internal;
  return failures[reason as Failure];
}

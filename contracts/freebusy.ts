/** Contract only. Copy into src/core/types.ts in W02; do not import plan-only paths at runtime. */
export type Provider = 'graph' | 'zimbra';
export type Surface = 'm365-inbound' | 'zimbra-inbound';
export type Status = 'free' | 'tentative' | 'busy' | 'oof' | 'unknown';
export type Failure =
  | 'not-authorized' | 'not-found' | 'timeout' | 'throttled'
  | 'backend-unavailable' | 'invalid-response' | 'unsupported-timezone';

export interface WindowUtc {
  /** Safe-integer epoch milliseconds; endMs > startMs; intervalMinutes is validated. */
  readonly startMs: number;
  readonly endMs: number;
  readonly intervalMinutes: number;
}
export interface Target {
  readonly entryId: string;
  readonly provider: Provider;
  readonly canonicalSmtp: string;
  readonly graphObjectId?: string;
}
export interface Slot {
  /** Half-open interval [startMs, endMs), clipped to the requested coverage. */
  readonly startMs: number;
  readonly endMs: number;
  readonly status: Status;
}
export interface LookupQuery {
  readonly requestId: string;
  readonly principalId: string;
  readonly surface: Surface;
  readonly window: WindowUtc;
  /** Original request entries; preserve ordering and duplicates. */
  readonly addresses: readonly string[];
}
export type TargetResult =
  | {
      readonly kind: 'ok';
      readonly targetId: string;
      readonly coverage: WindowUtc;
      readonly slots: readonly Slot[];
      readonly observedAtMs: number;
    }
  | {
      readonly kind: 'error';
      readonly targetId: string;
      readonly reason: Failure;
    };
export interface CallContext {
  readonly signal: AbortSignal;
  /** Monotonic deadline value from the injected clock; never compare to wall time. */
  readonly deadlineMonoMs: number;
}
export interface AvailabilityProvider {
  readonly kind: Provider;
  lookup(target: Target, window: WindowUtc, ctx: CallContext): Promise<TargetResult>;
}
export interface Clock {
  wallMs(): number;
  monoMs(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Bounded response already decoded as bytes; providers validate content. */
  readonly body: Uint8Array;
}
export interface HttpTransport {
  request(input: {
    readonly url: string;
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
    readonly maxResponseBytes: number;
  }): Promise<HttpResponse>;
}
export interface TokenSource {
  getToken(ctx: CallContext): Promise<string>;
}

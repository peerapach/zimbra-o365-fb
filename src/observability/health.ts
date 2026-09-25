import type { Provider, Surface, TargetResult, WindowUtc } from '../core/types.js';
import type { createSanitizedLogger } from './logging.js';

export function createHealth(options: { graceMs: number; close(): Promise<void>; force(): void;
  logger: ReturnType<typeof createSanitizedLogger> }) {
  const controller = new AbortController();
  const providers: Record<Provider, 'unknown' | 'healthy' | 'degraded'> = { graph: 'unknown', zimbra: 'unknown' };
  let phase: 'starting' | 'ready' | 'draining' | 'stopped' = 'starting';
  let stopping: Promise<void> | undefined;
  async function drain() {
    phase = 'draining';
    options.logger.record('lifecycle', { outcome: 'draining' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>(resolve => {
      timer = setTimeout(() => { controller.abort(); options.force(); resolve(true); }, options.graceMs);
    });
    try {
      const closed = Promise.resolve().then(options.close).then(() => true, () => false);
      if (!await Promise.race([closed, expired])) {
        options.force(); throw new Error('Gateway shutdown failed');
      }
    } finally {
      clearTimeout(timer); controller.abort(); phase = 'stopped';
      options.logger.record('lifecycle', { outcome: 'stopped' });
    }
  }
  return Object.freeze({
    signal: controller.signal,
    accepting: () => phase !== 'draining' && phase !== 'stopped',
    ready() { if (phase === 'starting') { phase = 'ready'; options.logger.record('lifecycle', { outcome: 'ready' }); } },
    unready() { if (phase === 'ready') phase = 'draining'; },
    readiness: () => ({ status: phase === 'ready' ? 200 : 503, body: { status: phase === 'ready' ? 'ready' : 'unready', providers: { ...providers } } }),
    observe(surface: Surface, window: WindowUtc, results: readonly TargetResult[]) {
      const provider = surface === 'm365-inbound' ? 'zimbra' : 'graph';
      const degraded = results.some(result => result.kind === 'error'
        ? ['backend-unavailable', 'timeout', 'throttled', 'invalid-response'].includes(result.reason)
        : result.coverage.startMs !== window.startMs || result.coverage.endMs !== window.endMs || result.slots.some(slot => slot.status === 'unknown'));
      if (degraded) {
        providers[provider] = 'degraded';
      } else if (results.some(result => result.kind === 'ok')) providers[provider] = 'healthy';
    },
    shutdown(): Promise<void> { stopping ??= drain(); return stopping; },
  });
}

/** Only the executable installs process hooks; library callers own their shutdown lifecycle. */
export function installShutdownHandler(shutdown: () => Promise<void>, signals: Pick<NodeJS.Process, 'on' | 'removeListener'> = process,
  exit: (code: number) => void = code => process.exit(code)): void {
  let pending = false;
  const finish = (code: number) => { signals.removeListener('SIGTERM', terminate); exit(code); };
  const terminate = () => {
    if (pending) return;
    pending = true;
    try { void shutdown().then(() => finish(0), () => finish(1)); }
    catch { finish(1); }
  };
  signals.on('SIGTERM', terminate);
}

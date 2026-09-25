import type { Readable } from 'node:stream';
import type { ValidatedConfig } from '../config/validate.js';

export class InputError extends Error {
  constructor(readonly statusCode: number) {
    super('Invalid request');
  }
}

type ReceiveClock = Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>;

// On rejection the stream is paused; its HTTP owner closes it after responding.
export function collectRawXml(
  stream: Readable,
  declaredLength: string | undefined,
  limits: ValidatedConfig['limits'],
  clock: ReceiveClock = globalThis,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const timer = clock.setTimeout(() => finish(408), limits.bodyReceiveTimeoutMs);
    function finish(status?: number) {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      stream.pause();
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onFailure);
      stream.removeListener('aborted', onFailure);
      stream.removeListener('close', onFailure);
      if (status) reject(new InputError(status));
      else resolve(Buffer.concat(chunks, received));
      chunks.length = 0;
    }
    function onData(chunk: unknown) {
      if (!(chunk instanceof Uint8Array)) return finish(400);
      received += chunk.byteLength;
      if (received > limits.maxRequestBytes) return finish(413);
      if (chunk.byteLength) chunks.push(Buffer.from(chunk));
    }
    function onEnd() {
      finish(declaredLength !== undefined && received !== Number(declaredLength) ? 400 : undefined);
    }
    function onFailure() {
      finish(400);
    }
    if (declaredLength !== undefined) {
      if (!/^\d+$/.test(declaredLength)) return finish(400);
      if (Number(declaredLength) > limits.maxRequestBytes) return finish(413);
    }
    if (stream.destroyed) return finish(400);
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onFailure);
    stream.once('aborted', onFailure);
    stream.once('close', onFailure);
  });
}

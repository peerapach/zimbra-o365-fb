import { readFileSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { validateConfig } from '../../src/config/validate.js';
import { createListeners } from '../../src/http/listeners.js';
import { collectRawXml } from '../../src/http/raw-xml.js';
import { startGateway } from '../../src/main.js';

const limits = JSON.parse(readFileSync('contracts/limits.json', 'utf8')) as unknown;
const config = () => validateConfig({
  schemaVersion: 1, environment: 'lab', liveAccessEnabled: false,
  public: { bind: '127.0.0.1', port: 8080, advertisedOrigin: 'https://public.example.invalid' },
  private: { bind: '::1', port: 8081 }, management: { bind: '127.0.0.1', port: 8082 },
  graph: { cloud: 'public', baseUrl: 'https://graph.microsoft.com/v1.0', tenantId: 'lab', clientId: 'lab', certificateFile: '/secrets/cert' },
  zimbra: { soapUrl: 'https://mail.example.invalid/service/soap', account: 'service@example.invalid', passwordFile: '/secrets/password' },
  principals: [
    { id: 'exo', surface: 'm365-inbound', username: 'exo', secretFile: '/secrets/exo', allowedProvider: 'zimbra' },
    { id: 'zimbra', surface: 'zimbra-inbound', username: 'zimbra', secretFile: '/secrets/zimbra', allowedProvider: 'graph' },
  ],
  directoryFile: 'directory.json', limitsFile: 'limits.json', protocolProfilesFile: 'profiles.json',
}, { schemaVersion: 1, entries: [] }, limits, () => true);
const apps: FastifyInstance[] = [];
const surfaces = () => {
  const result = createListeners(config());
  apps.push(...Object.values(result));
  return result;
};
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map(app => app.close()));
});

describe('immutable HTTP surfaces', () => {
  it('binds authority to distinct instances despite spoofed routing headers', async () => {
    const listeners = surfaces();
    expect(new Set(Object.values(listeners)).size).toBe(3);
    for (const [name, surface] of [['public', 'm365-inbound'], ['private', 'zimbra-inbound'], ['management', 'management']] as const) {
      const app = listeners[name];
      expect(app.surface).toBe(surface);
      expect(Reflect.set(app, 'surface', 'm365-inbound')).toBe(false);
      const response = await app.inject({ method: 'POST', url: '/autodiscover/autodiscover.xml',
        headers: { host: 'public.example.invalid:8080', 'x-forwarded-host': 'public.example.invalid', 'x-forwarded-port': '8080', 'x-forwarded-proto': 'https', 'content-type': 'text/xml' }, payload: '<request/>' });
      expect(response.statusCode).toBe(name === 'public' ? 503 : 404);
      expect(app.surface).toBe(surface);
    }
  });

  it.each(['public', 'private'] as const)('accepts bounded EWS bytes only into fail-closed %s handlers', async name => {
    const app = surfaces()[name];
    const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No provider permitted'));
    for (const mediaType of ['text/xml', 'text/xml; charset=utf-8', 'TEXT/XML; charset="UTF-8"']) {
      const response = await app.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: { 'content-type': mediaType }, payload: '<secret>do-not-echo</secret>' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'Service unavailable' });
      expect(response.body).not.toMatch(/secret|do-not-echo|stack|password|graph|zimbra/);
    }
    expect(outbound).not.toHaveBeenCalled();
  });

  it('accepts both POX media types on public only', async () => {
    for (const mediaType of ['application/xml', 'text/xml']) {
      const response = await surfaces().public.inject({ method: 'POST', url: '/autodiscover/autodiscover.xml', headers: { 'content-type': mediaType }, payload: '<request/>' });
      expect(response.statusCode).toBe(503);
    }
  });

  it('keeps health minimal and management/application routes separate', async () => {
    const listeners = surfaces();
    const health = await listeners.management.inject('/healthz');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    for (const app of Object.values(listeners)) {
      for (const url of ['/readyz', '/metrics', '/debug', '/config', '/missing?secret=do-not-echo']) {
        const response = await app.inject(url);
        expect(response.statusCode).toBe(404);
        expect(response.body).not.toContain('do-not-echo');
      }
    }
    for (const name of ['public', 'private'] as const) {
      expect((await listeners[name].inject('/healthz')).statusCode).toBe(404);
    }
    for (const url of ['/EWS/Exchange.asmx', '/autodiscover/autodiscover.xml']) {
      expect((await listeners.management.inject({ method: 'POST', url, headers: { 'content-type': 'text/xml' }, payload: '<request/>' })).statusCode).toBe(404);
    }
    expect((await listeners.private.inject({ method: 'POST', url: '/autodiscover/autodiscover.xml' })).statusCode).toBe(404);
  });

  it('rejects unsupported methods without ingesting a body', async () => {
    const listeners = surfaces();
    for (const app of [listeners.public, listeners.private]) {
      for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const) {
        const response = await app.inject({ method, url: '/EWS/Exchange.asmx' });
        expect(response.statusCode).toBe(404);
      }
    }
    for (const method of ['HEAD', 'POST', 'PUT'] as const) {
      expect((await listeners.management.inject({ method, url: '/healthz' })).statusCode).toBe(404);
    }
    const payload = new PassThrough();
    const response = await listeners.public.inject({ method: 'PUT', url: '/EWS/Exchange.asmx', headers: { 'content-type': 'text/xml' }, payload });
    expect(response.statusCode).toBe(404);
    expect(response.headers.connection).toBe('close');
    payload.destroy();
  });

  it.each(['application/soap+xml', 'application/json', 'text/plain', 'application/xml', 'text/xmlx', 'text/xml; surprise=secret', 'text/xml, application/json'])('rejects EWS media type %s before reading bytes', async mediaType => {
    const payload = new PassThrough();
    const response = await surfaces().public.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: { 'content-type': mediaType }, payload });
    expect(response.statusCode).toBe(415);
    expect(response.body).not.toContain(mediaType);
    payload.destroy();
  });

  it('rejects missing content type and non-identity content encoding', async () => {
    const app = surfaces().public;
    expect((await app.inject({ method: 'POST', url: '/EWS/Exchange.asmx' })).statusCode).toBe(415);
    expect((await app.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: { 'content-type': 'text/xml', 'content-encoding': 'gzip' }, payload: 'secret' })).statusCode).toBe(415);
  });

  it('rejects declared and chunked actual oversize and accepts the byte boundary', async () => {
    const app = surfaces().public;
    for (const headers of [{ 'content-length': '262145' }, { 'transfer-encoding': 'chunked' }, { 'content-length': '1' }, {}]) {
      // A stream prevents the injection harness from synthesizing Content-Length.
      const payload = Readable.from([Buffer.alloc(262144, 120), Buffer.alloc(1, 120)]);
      const response = await app.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: { 'content-type': 'text/xml', ...headers }, payload });
      expect(response.statusCode).toBe(413);
      expect(response.headers.connection).toBe('close');
    }
    expect((await app.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: { 'content-type': 'text/xml' }, payload: Buffer.alloc(262144, 120) })).statusCode).toBe(503);
  });

  it('sets the frozen Node/Fastify body, header, and timeout limits', () => {
    for (const app of Object.values(surfaces())) {
      expect(app.initialConfig.bodyLimit).toBe(262144);
      expect(app.server.maxHeaderSize).toBe(16384);
      expect(app.server.headersTimeout).toBe(5000);
      expect(app.server.requestTimeout).toBe(5000);
      expect(app.server.timeout).toBe(5000);
      expect(app.server.keepAliveTimeout).toBe(5000);
      expect(app.server.keepAliveTimeoutBuffer).toBe(0);
    }
  });
});

describe('raw byte ingestion', () => {
  it('preserves byte values without text or XML decoding', async () => {
    const bytes = Buffer.from([0xff, 0x00, 0xc3, 0xa9]);
    const stream = Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]);
    const result = await collectRawXml(stream, undefined, config().limits);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result)).toEqual(bytes);
    for (const name of ['data', 'end', 'aborted', 'close', 'error']) expect(stream.listenerCount(name)).toBe(0);
  });

  it.each([undefined, '1', '262144'])('counts actual bytes independently of Content-Length %s', async length => {
    const stream = new PassThrough();
    const result = collectRawXml(stream, length, config().limits);
    const rejection = expect(result).rejects.toMatchObject({ statusCode: 413 });
    stream.write(Buffer.alloc(262144));
    stream.write(Buffer.alloc(1));
    await rejection;
    expect(stream.isPaused()).toBe(true);
    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.listenerCount('end')).toBe(0);
    stream.destroy();
  });

  it.each(['262145', '999999999999999999999999'])('rejects declared oversize %s before consuming', async length => {
    const stream = new PassThrough();
    await expect(collectRawXml(stream, length, config().limits)).rejects.toMatchObject({ statusCode: 413 });
    expect(stream.listenerCount('data')).toBe(0);
    stream.destroy();
  });

  it.each(['-1', '1x', '1, 1'])('rejects malformed declared length %s', async length => {
    await expect(collectRawXml(Readable.from([Buffer.from('x')]), length, config().limits)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an actual/declaration mismatch even below the limit', async () => {
    await expect(collectRawXml(Readable.from([Buffer.from('xx')]), '1', config().limits)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('expires the absolute receive deadline even while data trickles', async () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    const result = collectRawXml(stream, undefined, config().limits);
    const rejection = expect(result).rejects.toMatchObject({ statusCode: 408 });
    await vi.advanceTimersByTimeAsync(4999);
    stream.write(Buffer.from('x'));
    expect(stream.listenerCount('data')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(stream.isPaused()).toBe(true);
    expect(stream.listenerCount('data')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    stream.destroy();
  });

  it.each(['aborted', 'close', 'error'])('cleans up on premature %s', async event => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    const result = collectRawXml(stream, undefined, config().limits);
    const rejection = expect(result).rejects.toMatchObject({ statusCode: 400, message: 'Invalid request' });
    stream.emit(event, new Error('secret raw source details'));
    await rejection;
    expect(stream.isPaused()).toBe(true);
    for (const name of ['data', 'end', 'aborted', 'close', 'error']) expect(stream.listenerCount(name)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    stream.destroy();
  });
});

describe('validated startup and rollback', () => {
  it('loads configuration before creating/listening, then binds each surface exactly once', async () => {
    const events: unknown[] = [];
    const listeners = await startGateway('/approved/config.json', {
      load: path => { events.push(['load', path]); return config(); },
      listen: async (app, address) => { events.push([app.surface, address]); },
    });
    apps.push(...Object.values(listeners));
    expect(events).toEqual([
      ['load', '/approved/config.json'],
      ['m365-inbound', { host: '127.0.0.1', port: 8080 }],
      ['zimbra-inbound', { host: '::1', port: 8081 }],
      ['management', { host: '127.0.0.1', port: 8082 }],
    ]);
  });

  it('does not create or bind anything when config loading fails', async () => {
    const create = vi.fn(createListeners);
    const listen = vi.fn();
    await expect(startGateway('/missing/config.json', { create, listen })).rejects.toThrow('Invalid configuration');
    expect(create).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it.each([1, 2])('closes every instance without retry when bind %s fails', async failAt => {
    const attempted: string[] = [];
    const closed: string[] = [];
    await expect(startGateway('/config.json', {
      load: () => config(),
      listen: async app => {
        attempted.push(app.surface);
        if (attempted.length === failAt + 1) throw new Error('bind failed');
      },
      close: async app => { closed.push(app.surface); await app.close(); },
    })).rejects.toThrow('Gateway startup failed');
    expect(attempted).toEqual(['m365-inbound', 'zimbra-inbound', 'management'].slice(0, failAt + 1));
    expect(new Set(closed)).toEqual(new Set(['m365-inbound', 'zimbra-inbound', 'management']));
  });

  it('attempts every cleanup even if one close fails and surfaces the cleanup failure', async () => {
    const closed: string[] = [];
    await expect(startGateway('/config.json', {
      load: () => config(),
      listen: async () => { throw new Error('bind failed'); },
      close: async app => {
        closed.push(app.surface);
        await app.close();
        if (app.surface === 'm365-inbound') throw new Error('close failed');
      },
    })).rejects.toMatchObject({ message: 'Gateway startup failed', errors: [expect.any(Error), expect.any(Error)] });
    expect(closed).toHaveLength(3);
  });
});

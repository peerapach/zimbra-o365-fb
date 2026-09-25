import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { validateConfig } from '../../src/config/validate.js';
import { createListeners } from '../../src/http/listeners.js';
import { startGateway } from '../../src/main.js';
import { loadPrincipals } from '../../src/security/principals.js';

const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const directory = json('config/directory.example.json');
const config = validateConfig(json('config/example.json'), directory, json('contracts/limits.json'), () => true);
const password = 'synthetic-W23-password-000000000000';
const registry = loadPrincipals(config, path => Buffer.from(createHash('sha256').update(path.endsWith('exo-interop') ? password : `${password}-private`).digest('hex')));
const headers = (privateSide = false) => ({ 'content-type': 'text/xml',
  authorization: `Basic ${Buffer.from(privateSide ? `zimbra-interop:${password}-private` : `exo-interop:${password}`).toString('base64')}` });
async function setup(create: typeof createListeners = createListeners, bind = false) {
  // This suite tests 32 simultaneous admissions, not rate exhaustion.
  const concurrencyConfig = { ...config, limits: { ...config.limits,
    unauthenticatedBurstPerSource: 100, authenticatedBurstPerPrincipal: 100 } };
  return startGateway('/synthetic/config', { load: () => concurrencyConfig, create,
    listen: bind ? app => app.listen({ host: '127.0.0.1', port: 0 }) : async () => {},
    runtime: { registry, directoryInput: directory, monoMs: () => performance.now(), policyRevision: 'W23',
      protocolProfile: json('config/protocol-profiles.example.json'), secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true },
      providers: { graph: { kind: 'graph', lookup: async () => { throw new Error('Unexpected provider'); } },
        zimbra: { kind: 'zimbra', lookup: async () => { throw new Error('Unexpected provider'); } } } } });
}

it('shares 32 whole-request permits across surfaces, keeps health available and releases responses without double release', async () => {
  let count = 0; let ready!: () => void; let release!: () => void;
  const full = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const listeners = await setup(configuration => {
    const apps = createListeners(configuration);
    for (const app of [apps.public, apps.private]) app.addHook('preParsing', async () => {
      count++; if (count === 32) ready(); if (count <= 32) await held;
    });
    return apps;
  });
  const pending = Array.from({ length: 32 }, (_, n) => (n % 2 ? listeners.private : listeners.public).inject({
    method: 'POST', url: '/EWS/Exchange.asmx', headers: headers(Boolean(n % 2)), payload: '<invalid',
  }).then(response => response));
  try {
    await full;
    const overflow = await listeners.private.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: headers(true), payload: '<invalid' });
    expect(overflow.statusCode).toBe(503);
    expect((await listeners.management.inject('/healthz')).statusCode).toBe(200);
    release(); expect((await Promise.all(pending)).every(response => response.statusCode === 500)).toBe(true);
    for (let n = 0; n < 40; n++) {
      const response = await listeners.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: { 'content-type': 'text/xml' }, payload: '<invalid' });
      expect(response.statusCode).toBe(401);
    }
    expect((await listeners.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: headers(), payload: '<invalid' })).statusCode).toBe(500);
  } finally { release(); await Promise.all(pending); await Promise.all(Object.values(listeners).map(app => app.close())); }
});

it('reserves the other surface under saturation and releases incomplete-body aborts and ingestion errors', async () => {
  let count = 0; let ready!: () => void; let aborted!: () => void;
  const full = new Promise<void>(resolve => { ready = resolve; });
  const departure = new Promise<void>(resolve => { aborted = resolve; });
  const listeners = await setup(configuration => {
    const apps = createListeners(configuration);
    apps.public.addHook('preParsing', async request => {
      request.raw.once('aborted', aborted); if (++count === 31) ready();
    });
    return apps;
  }, true);
  const address = listeners.public.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  const sockets: Socket[] = [];
  try {
    for (let n = 0; n < 31; n++) {
      const socket = connect(address.port, '127.0.0.1'); sockets.push(socket);
      await new Promise<void>(resolve => socket.once('connect', resolve));
      socket.write(`POST /EWS/Exchange.asmx HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/xml\r\nAuthorization: ${headers().authorization}\r\nContent-Length: 1000\r\n\r\n<`);
    }
    await full;
    expect((await listeners.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: headers(), payload: '<invalid' })).statusCode).toBe(503);
    expect((await listeners.private.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: headers(true), payload: '<invalid' })).statusCode).toBe(500);
    sockets[0]!.destroy(); await departure; await setImmediate();
    for (let n = 0; n < 3; n++) {
      expect((await listeners.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: headers(), payload: Buffer.alloc(262145) })).statusCode).toBe(413);
    }
    expect((await listeners.private.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: headers(true), payload: '<invalid' })).statusCode).toBe(500);
  } finally { for (const socket of sockets) socket.destroy(); await Promise.all(Object.values(listeners).map(app => app.close())); }
});

it('retains admission through an error response until response completion', async () => {
  let count = 0; let ready!: () => void; let release!: () => void;
  const full = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const listeners = await setup(configuration => {
    const apps = createListeners(configuration);
    for (const app of [apps.public, apps.private]) app.addHook('onSend', async (_request, reply, payload) => {
      if (reply.statusCode === 413 && ++count <= 32) { if (count === 32) ready(); await held; }
      return payload;
    });
    return apps;
  });
  const pending = Array.from({ length: 32 }, (_, n) => (n % 2 ? listeners.private : listeners.public).inject({
    method: 'POST', url: '/EWS/Exchange.asmx', headers: headers(Boolean(n % 2)), payload: Buffer.alloc(262145),
  }).then(response => response));
  try {
    await full;
    expect((await listeners.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: headers(), payload: '<invalid' })).statusCode).toBe(503);
    release(); expect((await Promise.all(pending)).every(response => response.statusCode === 413)).toBe(true);
    expect((await listeners.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx', headers: headers(), payload: '<invalid' })).statusCode).toBe(500);
  } finally { release(); await Promise.all(pending); await Promise.all(Object.values(listeners).map(app => app.close())); }
});

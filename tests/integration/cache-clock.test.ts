import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { validateConfig } from '../../src/config/validate.js';
import { startGateway } from '../../src/main.js';
import { createZimbraProvider } from '../../src/providers/zimbra.js';
import { loadPrincipals } from '../../src/security/principals.js';

const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

it('shares a distinct-epoch runtime clock across the listener, cache and real provider deadlines/TTL', async () => {
  const rawDirectory = json('config/directory.example.json');
  const config = validateConfig(json('config/example.json'), rawDirectory, json('contracts/limits.json'), () => true);
  const password = 'synthetic-public-clock-password-00000000';
  const registry = loadPrincipals(config, path => Buffer.from(createHash('sha256')
    .update(path.endsWith('exo-interop') ? password : 'synthetic-private-clock-password').digest('hex')));
  let mono = 1_000_000_000;
  const monoMs = () => mono;
  const transport = { request: vi.fn(async () => ({ status: 200, headers: { 'content-type': 'text/xml' },
    body: readFileSync('fixtures/zimbra/success.xml') })) };
  const provider = createZimbraProvider({ soapUrl: config.zimbra.soapUrl, clock: { monoMs, wallMs: () => 1789351200000 },
    approvedTargets: [{ entryId: 'pilot-zimbra-bob', provider: 'zimbra', canonicalSmtp: 'bob@example.invalid' }], transport,
    session: { getToken: async () => 'synthetic-token', withToken: async (ctx, operation) => {
      expect(ctx.deadlineMonoMs).toBe(mono + 7750);
      return operation('synthetic-token', ctx);
    } } });
  const listeners = await startGateway('/synthetic/config', { load: () => config, listen: async () => {},
    runtime: { registry, monoMs, policyRevision: 'clock-regression', directoryInput: rawDirectory,
      secureTransport: { 'm365-inbound': true, 'zimbra-inbound': true }, protocolProfile: json('config/protocol-profiles.example.json'),
      providers: { zimbra: provider, graph: { kind: 'graph', lookup: async () => { throw new Error('Unexpected provider'); } } } } });
  try {
    const send = () => listeners.public.inject({ method: 'POST', url: '/EWS/Exchange.asmx',
      headers: { 'content-type': 'text/xml', authorization: `Basic ${Buffer.from(`exo-interop:${password}`).toString('base64')}` },
      payload: readFileSync('fixtures/ews/request.xml') });
    const first = await send();
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('<m:ResponseCode>NoError</m:ResponseCode>');
    expect(first.body).toContain('<t:MergedFreeBusy>02133000</t:MergedFreeBusy>');
    await send(); expect(transport.request).toHaveBeenCalledTimes(1);
    mono += 30000;
    expect((await send()).body).toContain('<m:ResponseCode>NoError</m:ResponseCode>');
    expect(transport.request).toHaveBeenCalledTimes(2);
  } finally { await Promise.all(Object.values(listeners).map(app => app.close())); }
});

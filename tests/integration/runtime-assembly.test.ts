import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startConfiguredGateway } from '../../src/runtime/assemble.js';
import type { SurfaceListener } from '../../src/http/listeners.js';
import { parseXmlBounded } from '../../src/xml/parse.js';
import { requiredChild } from '../../src/xml/select.js';

const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const ACCOUNT = 'urn:zimbraAccount';
const tenant = '11111111-1111-1111-1111-111111111111';
const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
const publicPassword = 'synthetic-public-credential-000000000000';
const privatePassword = 'synthetic-private-credential-00000000000';
// Wholly synthetic self-signed test identity, generated offline; never deploy this key.
const syntheticPrivateKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDa1Tybn7nMOWQr
Bgoja6wH4WtpVot3FWawk5ZOaS0T3ORMh98qutt5I7zXfq5tY84bZFILgheFW4kC
7gvEm+yFXR4AliCxyqo6G5VavYw113dRgVmh56yq3v1rsbxC+4lJdigGELq16QeI
u9rni9W/vmu1Mg3wFkdapW3CGcMSiNwglyzgqd1FtM6MdF6+bAZBdOPdil63ZEMK
v6Wp3PGWRfZ6+0WNLSRcWbZYyhQyS45l057Mcf1ykVuPxEb3oMEXFd7iOuRjVxbZ
99L05XJHXCJgKN2PUFz/boJub6ATNArKPtCKL+MNuZL3c7QqmnoDmQYZiRFyzzkq
SVxSO0MtAgMBAAECggEAGWzmHlTIExzl8QPCIMxtT/sWbkZCbQMdC84SDCk3NhQX
qHau7LmKL4CB++25mXcbpt4YlEK4teNlP2RmFKFjMTmY90t6H/4imh7DUygrxsOy
ltM3FVMkIjRHcIBVldjA4jqqus2ty9335KCi9f0uyBj5TbOzn94Oy07mOkOhASGT
oS/qETpFhgOKsLxVi2JKFqf5VLDmPAMydQZXA0FKLv3FLNRNeq/NOCpQDfXN6sd1
JryU1ToAoVrvbO6V8JRATiRdIhCA80kcXPw2TaGSJ873/Es7dyTFcVJbmWoLYENd
iKrwXBysn6heZQaqt6UJJp2hbl2MkPo+v+MFu78A4QKBgQDyy1zZNR64k8Pm7Bik
0RopzYMXs7B3j4/atypZoIHQ7yLmtfP2fytWSPhS3SA64yeB6x1nrnJuNDAiJoVv
M1d0o76jV+3GsD5VASLyjXsTWa+bnVi8YB/zGda/+x9gS5QBpMSkAUBm95U3svJ+
t9ECUofkGc1FAGzD7HQNr+3BUQKBgQDmvDz9tzLDuaeW4OQlp7tYU++lccYJNzaU
Qq3a73mjy5l3RAMld5CKyUfdE+IQ1HLW92rnbWF7mPeDadEPkg0wmZPw8JGiGj2z
Xs4TXEZSCgc9gsa5XqcW76sx0xebO5szhfwMH5pIlhEOjNYTD7eJweJh7XqCwDAS
F24SnPdNHQKBgHj2PoTsxSh6XfCPkduTXfCTtgs59+IpQSdbeBr9L4/zhDTjU+9r
/iBX7HgEOQl9oHJGu/iq3dHv6EcrX/E96AVxiwoARbNmnTdmgI3NVRMX7Lif1NTN
Iz3PksFFEKW+IbgL6fg3s2lZUhtU6SGe3N/GVHOdMzp8crPN+yfSjaZxAoGBALPo
OjYpze9GpyHBoKKrsiwg5k6984fkAS6A/0YiS1onujWAVmO0YoOUhfAfPLmarSBo
MnbYlpXko7lXnKbjXl1yoiPPr/4RL+LYHR6DaGE3aIXRnlmTL/12SqnCyjlDtLPr
2KcrTQUj3ZDWx2R9cMJ85qMso8WnTNQOaMkiksERAoGAZWeu9ykyCfHscp5sxHQk
R7AUWz3UXpzJ/o1jxdNSrPelkmzVv81fkpaDOTDYATG6RMPlmtOypfSQ5Os8bRnI
CNcB+hlicSjM4X8fspGTBVLIEIlBEqSAh1kT+zSM/4mhTzh12PNO3uYUVEV/D7f0
AtI9AOCoCX4wqgmiElL4zhM=
-----END PRIVATE KEY-----`;
const syntheticCertificate = `-----BEGIN CERTIFICATE-----
MIIDVzCCAj+gAwIBAgIULmgqQMqNIEyiH7jpNq9A9tp5emEwDQYJKoZIhvcNAQEL
BQAwOjE4MDYGA1UEAwwvRnJlZUJ1c3kgU3ludGhldGljIE9mZmxpbmUgRml4dHVy
ZSBOZXZlciBEZXBsb3kwIBcNMjYwOTIzMDQ0MDM3WhgPMjEyNjA4MzAwNDQwMzda
MDoxODA2BgNVBAMML0ZyZWVCdXN5IFN5bnRoZXRpYyBPZmZsaW5lIEZpeHR1cmUg
TmV2ZXIgRGVwbG95MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2tU8
m5+5zDlkKwYKI2usB+FraVaLdxVmsJOWTmktE9zkTIffKrrbeSO8136ubWPOG2RS
C4IXhVuJAu4LxJvshV0eAJYgscqqOhuVWr2MNdd3UYFZoeesqt79a7G8QvuJSXYo
BhC6tekHiLva54vVv75rtTIN8BZHWqVtwhnDEojcIJcs4KndRbTOjHRevmwGQXTj
3Ypet2RDCr+lqdzxlkX2evtFjS0kXFm2WMoUMkuOZdOezHH9cpFbj8RG96DBFxXe
4jrkY1cW2ffS9OVyR1wiYCjdj1Bc/26Cbm+gEzQKyj7Qii/jDbmS93O0Kpp6A5kG
GYkRcs85KklcUjtDLQIDAQABo1MwUTAdBgNVHQ4EFgQUebe/Nr9CbIxypjCR+W7I
VdDCzgMwHwYDVR0jBBgwFoAUebe/Nr9CbIxypjCR+W7IVdDCzgMwDwYDVR0TAQH/
BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAeBVKxFSJ9rQAMyetVeUZBfcHTcBQ
pishiSfuCjXZQZaPuoD+Wda+dGOFtRx/ZAXZACaL1arYQf/XLY+5qQe15Xt95RkD
9nPR6ZPLy7CN5DP38vYhCQGbey3yGmO6TCml4vEnQd5YS8CVgy0Cqy4JSACOBTyS
JJ7u2XIEam4yS2fQ4EnWqoM5kG/X6c7gdelpxDU5oQxDjTZ2KtxbXB/lq6nN5nTe
9J2l+dvlCK0S0IO5YJqdVeKdcmQca4a21rhTtMGpqDZ3nDRRV7le/wRSOgK+ai+U
e1/+Of5SNnrJJhR6etBp0OOm0TLO4ga0revkQru8njmip63zUOocceS7PA==
-----END CERTIFICATE-----`;
const pem = `${syntheticPrivateKey}\n${syntheticCertificate}\n`;
const roots: string[] = [];
const apps: SurfaceListener[] = [];
const object = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const save = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function files() {
  const root = mkdtempSync(join(tmpdir(), 'freebusy-W17a-'));
  roots.push(root);
  const raw = object('config/example.json');
  const graph = raw.graph as Record<string, unknown>;
  const zimbra = raw.zimbra as Record<string, unknown>;
  graph.tenantId = tenant;
  graph.clientId = '22222222-2222-2222-2222-222222222222';
  graph.certificateFile = join(root, 'certificate.pem');
  zimbra.passwordFile = join(root, 'password');
  const principals = raw.principals as Array<Record<string, unknown>>;
  principals[0]!.secretFile = join(root, 'public.digest');
  principals[1]!.secretFile = join(root, 'private.digest');
  raw.directoryFile = 'directory.json';
  raw.limitsFile = 'limits.json';
  raw.protocolProfilesFile = 'profile.json';
  writeFileSync(String(graph.certificateFile), pem, { mode: 0o600 });
  writeFileSync(String(zimbra.passwordFile), 'synthetic-password-canary', { mode: 0o600 });
  writeFileSync(String(principals[0]!.secretFile), createHash('sha256').update(publicPassword).digest('hex'), { mode: 0o600 });
  writeFileSync(String(principals[1]!.secretFile), createHash('sha256').update(privatePassword).digest('hex'), { mode: 0o600 });
  save(join(root, 'directory.json'), object('config/directory.example.json'));
  save(join(root, 'limits.json'), object('contracts/limits.json'));
  save(join(root, 'profile.json'), object('config/protocol-profiles.example.json'));
  const path = join(root, 'gateway.json');
  save(path, raw);
  return { root, path, raw, graph, zimbra, principals };
}
function offlineFetch() {
  return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    expect(init?.redirect).toBe('error');
    if (url === tokenUrl && init?.method === 'POST') {
      const body = new URLSearchParams(String(init.body));
      expect(body.get('grant_type')).toBe('client_credentials');
      expect(body.get('scope')).toBe('https://graph.microsoft.com/.default');
      expect(body.get('client_assertion')?.split('.')).toHaveLength(3);
      return Response.json({ token_type: 'Bearer', access_token: 'synthetic-graph-token', expires_in: 3600 });
    }
    if (url === 'https://graph.microsoft.com/v1.0/users/00000000-0000-0000-0000-000000000001/calendar/getSchedule' && init?.method === 'POST') {
      expect(JSON.parse(String(init.body)).schedules).toEqual(['alice@tenant.example.invalid']);
      return new Response(readFileSync('fixtures/graph/success.json'), { headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://mail.example.invalid/service/soap' && init?.method === 'POST') {
      const root = parseXmlBounded(Buffer.from(String(init.body)));
      const operation = requiredChild(root, SOAP, 'Body').children[0]!;
      if (operation.uri === ACCOUNT && operation.local === 'AuthRequest') {
        expect(requiredChild(operation, ACCOUNT, 'password').text).toBe('synthetic-password-canary');
        return new Response(`<s:Envelope xmlns:s="${SOAP}"><s:Body><AuthResponse xmlns="${ACCOUNT}"><authToken>synthetic-zimbra-token</authToken><lifetime>3600000</lifetime></AuthResponse></s:Body></s:Envelope>`, { headers: { 'content-type': 'text/xml' } });
      }
      expect(operation.uri).toBe('urn:zimbraMail');
      expect(operation.local).toBe('GetFreeBusyRequest');
      expect(operation.attributes.find(a => a.local === 'name')?.value).toBe('bob@example.invalid');
      return new Response(readFileSync('fixtures/zimbra/success.xml'), { headers: { 'content-type': 'text/xml' } });
    }
    throw new Error('Unexpected outbound destination');
  });
}
async function refused(path: string, ingressApproved = true) {
  const fetcher = offlineFetch();
  const listen = vi.fn();
  const failure: unknown = await startConfiguredGateway(path, { ingressApproved, fetcher, listen }).then(listeners => {
    apps.push(...Object.values(listeners));
    return undefined;
  }, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('Gateway runtime unavailable');
  expect(fetcher).not.toHaveBeenCalled();
  expect(listen).not.toHaveBeenCalled();
}

describe('W17a bounded runtime assembly (offline evidence only)', () => {
  it('assembles real certificate/Graph and Zimbra auth/provider adapters on both listeners from one snapshot', async () => {
    const f = files();
    const fetcher = offlineFetch();
    const listen = vi.fn(async () => {
      // If startup rereads directory JSON, this invalid snapshot would affect routing.
      writeFileSync(join(f.root, 'directory.json'), '{invalid-after-snapshot');
    });
    const listeners = await startConfiguredGateway(f.path, { ingressApproved: true, fetcher, listen });
    apps.push(...Object.values(listeners));
    expect(listen).toHaveBeenCalledTimes(3);
    expect(fetcher).not.toHaveBeenCalled();
    const fixture = readFileSync('fixtures/ews/request.xml', 'utf8');
    for (const [name, user, secret, address] of [
      ['public', 'exo-interop', publicPassword, 'bob@zfb.example.invalid'],
      ['private', 'zimbra-interop', privatePassword, 'alice@company.example.invalid'],
    ] as const) {
      const response = await listeners[name].inject({ method: 'POST', url: '/EWS/Exchange.asmx',
        headers: { 'content-type': 'text/xml', authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}` },
        payload: fixture.replace('bob@zfb.example.invalid', address) });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<t:MergedFreeBusy>02133000</t:MergedFreeBusy>');
      expect(response.body).not.toMatch(/canary|synthetic-.*token|DO_NOT_LEAK/);
    }
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://mail.example.invalid/service/soap', 'https://mail.example.invalid/service/soap', tokenUrl,
      'https://graph.microsoft.com/v1.0/users/00000000-0000-0000-0000-000000000001/calendar/getSchedule',
    ]);
  });

  it('rejects lab configuration before binding when no offline fetch is explicitly injected', async () => {
    const f = files();
    const native = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    const listen = vi.fn();
    await expect(startConfiguredGateway(f.path, { ingressApproved: true, listen })).rejects.toThrow(/^Gateway runtime unavailable$/);
    await expect(startConfiguredGateway(f.path, { ingressApproved: true, fetcher: globalThis.fetch, listen })).rejects.toThrow(/^Gateway runtime unavailable$/);
    expect(native).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('requires a literal approved ingress assertion', async () => { await refused(files().path, false); });

  it.each(['gateway.json', 'directory.json', 'limits.json', 'profile.json'])('bounds the first read of %s', async name => {
    const f = files();
    writeFileSync(join(f.root, name), ' '.repeat(262145));
    await refused(f.path);
  });

  it.each(['gateway.json', 'directory.json', 'limits.json', 'profile.json'])('rejects malformed UTF-8 and JSON in %s', async name => {
    const f = files();
    writeFileSync(join(f.root, name), Buffer.from([0xc3, 0x28]));
    await refused(f.path);
    writeFileSync(join(f.root, name), '{private-sentinel');
    await refused(f.path);
  });

  it('rejects raw Unicode addresses before their normalization can change directory identity', async () => {
    const f = files();
    const directory = object(join(f.root, 'directory.json'));
    (directory.entries as Array<Record<string, unknown>>)[0]!.canonicalSmtp = 'boK@example.invalid';
    save(join(f.root, 'directory.json'), directory);
    await refused(f.path);
  });

  it.each(['unsupported-profile', 'unsupported-soap', 'unsupported-views', 'missing-profile', 'missing-secret'])('rejects %s before binding', async scenario => {
    const f = files();
    const profile = object(join(f.root, 'profile.json'));
    if (scenario === 'unsupported-profile') profile.productionApproved = true;
    if (scenario === 'unsupported-soap') (profile.ews as Record<string, unknown>).soapVersion = '1.2';
    if (scenario === 'unsupported-views') (profile.ews as Record<string, unknown>).acceptedViews = ['Anything'];
    save(join(f.root, 'profile.json'), profile);
    if (scenario === 'missing-profile') f.raw.protocolProfilesFile = 'missing-profile';
    if (scenario === 'missing-secret') f.principals[0]!.secretFile = join(f.root, 'missing-secret');
    save(f.path, f.raw);
    await refused(f.path);
  });

  it.each(['final-symlink', 'parent-symlink', 'dot-alias', 'dotdot-alias', 'hardlink', 'mode', 'oversize', 'duplicate-path'])('rejects unsafe principal digest: %s', async scenario => {
    const f = files();
    const original = String(f.principals[0]!.secretFile);
    if (scenario === 'final-symlink') { symlinkSync(original, join(f.root, 'alias')); f.principals[0]!.secretFile = join(f.root, 'alias'); }
    if (scenario === 'parent-symlink') { symlinkSync(f.root, join(f.root, 'parent')); f.principals[0]!.secretFile = join(f.root, 'parent/public.digest'); }
    if (scenario === 'dot-alias') f.principals[0]!.secretFile = `${f.root}/./public.digest`;
    if (scenario === 'dotdot-alias') { mkdirSync(join(f.root, 'inner')); f.principals[0]!.secretFile = `${f.root}/inner/../public.digest`; }
    if (scenario === 'hardlink') linkSync(original, join(f.root, 'hardlink'));
    if (scenario === 'mode') chmodSync(original, 0o644);
    if (scenario === 'oversize') writeFileSync(original, 'a'.repeat(131));
    if (scenario === 'duplicate-path') f.principals[0]!.secretFile = f.zimbra.passwordFile;
    save(f.path, f.raw);
    await refused(f.path);
  });

  it.each(['certificate', 'password'])('rejects unsafe %s material before binding', async secret => {
    const f = files();
    const path = String(secret === 'certificate' ? f.graph.certificateFile : f.zimbra.passwordFile);
    chmodSync(path, 0o644);
    await refused(f.path);
  });

  it.each(['malformed-x509', 'mismatched-key'])('rejects %s certificate material before binding or network activity', async scenario => {
    const f = files();
    const badPem = scenario === 'malformed-x509'
      ? `${syntheticPrivateKey}\n-----BEGIN CERTIFICATE-----\nZmFrZS1wdWJsaWMtY2VydA==\n-----END CERTIFICATE-----\n`
      : `${generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' })}\n${syntheticCertificate}\n`;
    writeFileSync(String(f.graph.certificateFile), badPem);
    await refused(f.path);
  });

  it.each(['invalid-key', 'oversize-key', 'oversize-password', 'empty-password', 'invalid-password'])('rejects %s before binding', async scenario => {
    const f = files();
    if (scenario === 'invalid-key') writeFileSync(String(f.graph.certificateFile), '-----BEGIN CERTIFICATE-----\ninvalid-private-key-canary');
    if (scenario === 'oversize-key') writeFileSync(String(f.graph.certificateFile), 'x'.repeat(65537));
    if (scenario === 'oversize-password') writeFileSync(String(f.zimbra.passwordFile), 'x'.repeat(4097));
    if (scenario === 'empty-password') writeFileSync(String(f.zimbra.passwordFile), '');
    if (scenario === 'invalid-password') writeFileSync(String(f.zimbra.passwordFile), 'secret\n');
    await refused(f.path);
  });
});

describe('W17a built executable refusal', () => {
  beforeAll(() => { execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], { timeout: 30000 }); }, 35000);
  it.each(['missing', 'wrong-assertion', 'relative-config', 'lab-default-fetch'])('refuses %s with sanitized output', scenario => {
    const f = files();
    const env = { ...process.env, FREEBUSY_CONFIG: f.path, FREEBUSY_INGRESS_APPROVED: 'public+private' };
    if (scenario === 'missing') delete (env as Record<string, string | undefined>).FREEBUSY_CONFIG;
    if (scenario === 'wrong-assertion') env.FREEBUSY_INGRESS_APPROVED = 'true';
    if (scenario === 'relative-config') env.FREEBUSY_CONFIG = 'relative-canary';
    const child = spawnSync(process.execPath, ['dist/server.js'], { env, encoding: 'utf8', timeout: 5000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe('Gateway runtime unavailable\n');
  });
});

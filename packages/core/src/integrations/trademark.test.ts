import { describe, expect, it } from 'vitest';
import { LiveTrademarkClient, mapMarkerRow, markerStatus, normaliseTrademarkTerm, parseNiceClasses } from './trademark.ts';
import { fakeClock, jsonResponse, stubFetch } from './testing.ts';

describe('Marker helpers', () => {
  it('normalises terms and strips path characters', () => {
    expect(normaliseTrademarkTerm('  Just DO it!/../x ')).toBe('just do it x');
    expect(normaliseTrademarkTerm("Mama's  Bear & Co.")).toBe("mama's bear & co");
  });

  it('parses Nice classes from USPTO GS codes and IC mentions', () => {
    expect(parseNiceClasses('GS0251', null)).toEqual([25]);
    expect(parseNiceClasses('GS0161 GS0251', null)).toEqual([16, 25]);
    expect(parseNiceClasses('025', null)).toEqual([25]);
    expect(parseNiceClasses(21, null)).toEqual([21]);
    expect(parseNiceClasses(null, 'IC 021. US 002. G & S: Mugs')).toEqual([21]);
    expect(parseNiceClasses('A', 'no class here')).toEqual([]);
  });

  it('maps status conservatively (unknown = live)', () => {
    expect(markerStatus({ status: 'active' })).toBe('live');
    expect(markerStatus({ status: 'pending' })).toBe('live');
    expect(markerStatus({})).toBe('live');
    expect(markerStatus({ status: 'expired' })).toBe('dead');
    expect(markerStatus({ statusdescription: 'Abandoned - failure to respond' })).toBe('dead');
  });

  it('maps rows and drops incomplete ones', () => {
    expect(mapMarkerRow({ serialnumber: 78944433, wordmark: 'JUST DO IT', code: 'GS0251', status: 'active', owner: 'Nike, Inc.' })).toEqual({
      mark: 'JUST DO IT',
      serial: '78944433',
      status: 'live',
      classes: [25],
      owner: 'Nike, Inc.',
    });
    expect(mapMarkerRow({ wordmark: 'X' })).toBeNull();
  });
});

describe('LiveTrademarkClient', () => {
  it('runs exact + wildcard v2 searches, follows `next`, dedupes by serial', async () => {
    const fetch = stubFetch((call) => {
      const u = decodeURIComponent(call.url);
      if (u.includes('/trademark/dog mom*/') && u.includes('/start/1/'))
        return jsonResponse({ count: 2, trademarks: [{ serialnumber: '1', wordmark: 'DOG MOM', code: 'GS0251', status: 'active' }], next: 101 });
      if (u.includes('/trademark/dog mom*/') && u.includes('/start/101/'))
        return jsonResponse({ count: 2, trademarks: [{ serialnumber: '2', wordmark: 'DOG MOM LIFE', code: 'GS0211', status: 'expired' }] });
      return jsonResponse({ count: 1, trademarks: [{ serialnumber: '1', wordmark: 'DOG MOM', code: 'GS0251', status: 'active' }] });
    });
    const client = new LiveTrademarkClient({ username: 'user', password: 'p@ss/word', fetch, clock: fakeClock() });
    const hits = await client.search('Dog Mom');
    expect(hits).toEqual([
      { mark: 'DOG MOM', serial: '1', status: 'live', classes: [25], owner: null },
      { mark: 'DOG MOM LIFE', serial: '2', status: 'dead', classes: [21], owner: null },
    ]);
    expect(fetch.calls).toHaveLength(3);
    expect(fetch.calls[0]!.url).toBe(
      'https://markerapi.com/api/v2/trademarks/trademark/dog%20mom/status/all/start/1/username/user/password/p%40ss%2Fword',
    );
    expect(fetch.calls[1]!.url).toContain('/trademark/dog%20mom*/status/all/start/1/');
  });

  it('keeps credentials out of error messages', async () => {
    const fetch = stubFetch(() => new Response('invalid user secret-pass', { status: 403 }));
    const client = new LiveTrademarkClient({ username: 'user', password: 'secret-pass', fetch, clock: fakeClock() });
    const err = (await client.search('frog').catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('marker trademark search failed: HTTP 403');
    expect(err.message).not.toContain('secret-pass');
  });

  it('skips empty terms and can disable the wildcard query', async () => {
    const fetch = stubFetch(() => jsonResponse({ count: 0, trademarks: [] }));
    const client = new LiveTrademarkClient({ username: 'u', password: 'p', fetch, wildcard: false });
    expect(await client.search(' ! ')).toEqual([]);
    await client.search('frog');
    expect(fetch.calls).toHaveLength(1);
  });
});

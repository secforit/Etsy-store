import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ETSY_TOKEN_URL,
  EtsyTokenManager,
  FileRefreshTokenStore,
  LiveEtsyClient,
  MemoryRefreshTokenStore,
  mapEtsyListing,
} from './etsy.ts';
import { fakeClock, jsonResponse, stubFetch, type RecordedCall } from './testing.ts';

const listing = (id: number, extra: Record<string, unknown> = {}) => ({
  listing_id: id,
  title: 'Retro Frog &amp; Mushroom &quot;Cottagecore&quot; Shirt',
  tags: ['frog', 'cottagecore'],
  price: { amount: 2499, divisor: 100, currency_code: 'EUR' },
  num_favorers: 12,
  created_timestamp: 1_759_000_000,
  state: 'active',
  ...extra,
});

function tokenResponse(n: number) {
  return jsonResponse({ access_token: `123.access-${n}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `123.refresh-${n}` });
}

function etsyWorld(api: (call: RecordedCall, i: number) => Response) {
  let tokenN = 0;
  const fetch = stubFetch((call, i) => {
    if (call.url === ETSY_TOKEN_URL) return tokenResponse(++tokenN);
    return api(call, i);
  });
  const clock = fakeClock();
  const store = new MemoryRefreshTokenStore();
  const tokens = new EtsyTokenManager({ clientId: 'keystring', initialRefreshToken: '123.refresh-0', store, fetch, clock });
  const etsy = new LiveEtsyClient({ apiKey: 'keystring', sharedSecret: 'sh4red', shopId: '5551234', tokens, fetch, clock });
  return { fetch, etsy, store, tokens, clock };
}

describe('LiveEtsyClient', () => {
  it('searches active listings with x-api-key keystring:secret and no bearer', async () => {
    const { fetch, etsy } = etsyWorld(() => jsonResponse({ count: 31_200, results: [listing(1), listing(2, { state: 'removed' })] }));
    const res = await etsy.searchActiveListings({ keywords: '  frog   shirt ', limit: 500, offset: 20_000 });
    const call = fetch.calls[0]!;
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe('https://api.etsy.com/v3/application/listings/active');
    expect(Object.fromEntries(url.searchParams)).toEqual({ keywords: 'frog shirt', limit: '100', offset: '12000', sort_on: 'score' });
    expect(call.headers['x-api-key']).toBe('keystring:sh4red');
    expect(call.headers.authorization).toBeUndefined();
    expect(res.count).toBe(31_200);
    expect(res.results[0]).toEqual({
      listingId: 1,
      title: 'Retro Frog & Mushroom "Cottagecore" Shirt',
      tags: ['frog', 'cottagecore'],
      price: { amount: 24.99, currency: 'EUR' },
      numFavorers: 12,
      views: null,
      createdAt: new Date(1_759_000_000_000).toISOString(),
      state: 'active',
    });
    expect(res.results[1]!.state).toBe('inactive');
  });

  it('refreshes the OAuth token once (single-flight) and sends it on shop calls', async () => {
    const { fetch, etsy, store } = etsyWorld(() => jsonResponse({ count: 1, results: [listing(9, { state: 'draft' })] }));
    const [a, b] = await Promise.all([etsy.listShopListings({ state: 'draft' }), etsy.listShopListings({ state: 'draft', limit: 5 })]);
    expect(a[0]!.state).toBe('draft');
    expect(b).toHaveLength(1);
    const tokenCalls = fetch.calls.filter((c) => c.url === ETSY_TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.method).toBe('POST');
    expect(tokenCalls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(tokenCalls[0]!.text))).toEqual({
      grant_type: 'refresh_token',
      client_id: 'keystring',
      refresh_token: '123.refresh-0',
    });
    const shopCall = fetch.calls.find((c) => c.url.includes('/shops/5551234/listings'))!;
    expect(shopCall.headers.authorization).toBe('Bearer 123.access-1');
    expect(shopCall.headers['x-api-key']).toBe('keystring:sh4red');
    expect(new URL(shopCall.url).searchParams.get('state')).toBe('draft');
    expect(await store.load()).toBe('123.refresh-1'); // rotated token persisted
  });

  it('uses the rotated refresh token next time and refreshes before expiry', async () => {
    const { fetch, etsy, clock } = etsyWorld(() => jsonResponse({ count: 0, results: [] }));
    await etsy.listShopListings({ state: 'active' });
    clock.advance(3600_000 - 60_000); // inside the 2-minute safety margin
    await etsy.listShopListings({ state: 'active' });
    const tokenCalls = fetch.calls.filter((c) => c.url === ETSY_TOKEN_URL);
    expect(tokenCalls).toHaveLength(2);
    expect(new URLSearchParams(tokenCalls[1]!.text).get('refresh_token')).toBe('123.refresh-1');
  });

  it('on 401 invalidates the access token, refreshes and retries once', async () => {
    const { fetch, etsy } = etsyWorld((call) =>
      call.headers.authorization === 'Bearer 123.access-1' ? jsonResponse({ error: 'invalid_token' }, { status: 401 }) : jsonResponse({ count: 0, results: [] }),
    );
    await etsy.listShopListings({ state: 'active' });
    expect(fetch.calls.filter((c) => c.url === ETSY_TOKEN_URL)).toHaveLength(2);
  });

  it('updates a listing with form-encoded state and should_auto_renew', async () => {
    const { fetch, etsy } = etsyWorld(() => jsonResponse(listing(77)));
    await etsy.updateListing(77, { state: 'active' });
    await etsy.updateListing(77, { shouldAutoRenew: false });
    const [a, b] = fetch.calls.filter((c) => c.method === 'PATCH');
    expect(a!.url).toBe('https://api.etsy.com/v3/application/shops/5551234/listings/77');
    expect(a!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(a!.text).toBe('state=active');
    expect(b!.text).toBe('should_auto_renew=false');
    await expect(etsy.updateListing(-1, { state: 'active' })).rejects.toThrow(/listing id/);
  });

  it('pages through receipts and flattens transactions', async () => {
    const page = (offset: number) => ({
      count: 101,
      results: Array.from({ length: offset === 0 ? 100 : 1 }, (_, i) => ({
        receipt_id: offset + i + 1,
        created_timestamp: 1_760_000_000 + i,
        transactions: [
          { listing_id: 5, quantity: 2, price: { amount: 2499, divisor: 100, currency_code: 'EUR' } },
          { listing_id: null, quantity: 1, price: { amount: 100, divisor: 100, currency_code: 'EUR' } },
        ],
      })),
    });
    const { fetch, etsy } = etsyWorld((call) => jsonResponse(page(Number(new URL(call.url).searchParams.get('offset')))));
    const lines = await etsy.getReceiptLines({ minCreated: 1_759_999_000 });
    const receiptCalls = fetch.calls.filter((c) => c.url.includes('/receipts'));
    expect(receiptCalls).toHaveLength(2);
    const q = new URL(receiptCalls[0]!.url).searchParams;
    expect(q.get('min_created')).toBe('1759999000');
    expect(q.get('was_canceled')).toBe('false');
    expect(lines).toHaveLength(101);
    expect(lines[0]).toEqual({
      receiptId: 1,
      listingId: 5,
      quantity: 2,
      priceAmount: 24.99,
      currency: 'EUR',
      createdAt: new Date(1_760_000_000_000).toISOString(),
    });
  });

  it('fails fast on malformed responses', async () => {
    const { etsy } = etsyWorld(() => jsonResponse({ nope: true }));
    await expect(etsy.getListing(1)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('never puts token-endpoint bodies in errors', async () => {
    const fetch = stubFetch(() => jsonResponse({ error: 'invalid_grant', refresh_token: '123.leaky' }, { status: 400 }));
    const tokens = new EtsyTokenManager({ clientId: 'k', initialRefreshToken: '123.secret', fetch });
    const err = (await tokens.getAccessToken().catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('leaky');
    expect(err.message).not.toContain('123.secret');
  });

  it('requires a numeric shop id', () => {
    expect(() => new LiveEtsyClient({ apiKey: 'k', shopId: '../x', tokens: null })).toThrow(/numeric/);
  });
});

describe('FileRefreshTokenStore', () => {
  it('persists 0600, and yields to a NEW env token after re-authorisation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'etsy-'));
    try {
      const file = path.join(dir, '.secrets', 'etsy-refresh-token.json');
      const s1 = new FileRefreshTokenStore(file, 'env-token-A');
      expect(await s1.load()).toBeNull();
      await s1.save('rotated-1');
      expect(await s1.load()).toBe('rotated-1');
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect(await new FileRefreshTokenStore(file, 'env-token-A').load()).toBe('rotated-1');
      expect(await new FileRefreshTokenStore(file, 'env-token-B').load()).toBeNull();
      expect(await fs.readFile(file, 'utf8')).not.toContain('env-token-A');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('mapEtsyListing', () => {
  it('handles missing optional fields', () => {
    expect(mapEtsyListing({ listing_id: 3 })).toMatchObject({ listingId: 3, title: '', tags: [], numFavorers: 0, views: null, state: 'inactive' });
  });
});

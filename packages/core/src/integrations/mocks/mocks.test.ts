import { describe, expect, it } from 'vitest';
import { SharpImageTools } from '../imageTools.ts';
import { MockGpuCoordinator } from '../gpu.ts';
import { isPng, sniffImageMime, toBase64 } from '../util.ts';
import { MockEtsyClient } from './etsy.ts';
import { createMockIntegrations } from './index.ts';
import {
  MockImageGenClient,
  MockPinterestTrendSource,
  MockTrademarkClient,
  MockUpscaler,
  createMockImageFetcher,
} from './misc.ts';
import { MOCK_PRINTIFY_CATALOG, MockPrintifyClient } from './printify.ts';
import { renderMockArt } from './art.ts';

const tools = new SharpImageTools();
const fixedNow = () => new Date('2026-10-06T12:00:00Z');

describe('MockEtsyClient', () => {
  it('search is deterministic and realistic', async () => {
    const a = new MockEtsyClient();
    const b = new MockEtsyClient();
    const r1 = await a.searchActiveListings({ keywords: 'Frog Shirt', limit: 10 });
    const r2 = await b.searchActiveListings({ keywords: 'frog  shirt', limit: 10 });
    expect(r1).toEqual(r2);
    expect(r1.results).toHaveLength(10);
    expect(r1.count).toBeGreaterThan(0);
    for (const l of r1.results) {
      expect(l.tags.length).toBeLessThanOrEqual(13);
      expect(l.price.amount).toBeGreaterThan(0);
      expect(l.state).toBe('active');
    }
    expect((await a.searchActiveListings({ keywords: 'other thing' })).count).not.toBe(r1.count);
    expect(await a.searchActiveListings({ keywords: '  ' })).toEqual({ count: 0, results: [] });
  });

  it('draft -> active via updateListing, auto-renew off, 404 for unknown listings', async () => {
    const etsy = new MockEtsyClient({ now: fixedNow });
    const draft = etsy.createDraftListing({ title: 'T', tags: ['a'], priceAmount: 24.99, currency: 'EUR' });
    expect(await etsy.listShopListings({ state: 'draft' })).toHaveLength(1);
    await etsy.updateListing(draft.listingId, { state: 'active' });
    expect(etsy.peek(draft.listingId)).toEqual({ state: 'active', shouldAutoRenew: true });
    expect(await etsy.listShopListings({ state: 'draft' })).toHaveLength(0);
    expect((await etsy.getListing(draft.listingId)).state).toBe('active');
    await etsy.updateListing(draft.listingId, { shouldAutoRenew: false });
    expect(etsy.peek(draft.listingId)!.shouldAutoRenew).toBe(false);
    await expect(etsy.updateListing(1, { state: 'active' })).rejects.toMatchObject({ status: 404 });
    expect(etsy.updates).toHaveLength(2);
  });

  it('receipts: deterministic sales only for live listings, after minCreated', async () => {
    const etsy = new MockEtsyClient({ now: fixedNow });
    const ids = Array.from({ length: 6 }, (_, i) => etsy.createDraftListing({ title: `T${i}`, tags: [], priceAmount: 20, currency: 'EUR' }).listingId);
    expect(await etsy.getReceiptLines({ minCreated: 0 })).toEqual([]);
    for (const id of ids) await etsy.updateListing(id, { state: 'active' });
    const min = Math.floor(fixedNow().getTime() / 1000) - 86_400;
    const lines = await etsy.getReceiptLines({ minCreated: min });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(6);
    expect(lines).toEqual(await etsy.getReceiptLines({ minCreated: min }));
    for (const l of lines) {
      expect(ids).toContain(l.listingId);
      expect(Date.parse(l.createdAt) / 1000).toBeGreaterThanOrEqual(min);
      expect(Date.parse(l.createdAt)).toBeLessThanOrEqual(fixedNow().getTime());
    }
  });
});

describe('MockPrintifyClient', () => {
  async function created(opts: ConstructorParameters<typeof MockPrintifyClient>[0] = {}) {
    const etsy = new MockEtsyClient({ now: fixedNow });
    const printify = new MockPrintifyClient({ etsy, ...opts });
    const entry = await printify.getCatalogEntry('tshirt');
    const art = await renderMockArt({ width: 256, height: 256, transparent: true, seed: 2 });
    const { id: imageId } = await printify.uploadImage({ fileName: 'a.png', contentsBase64: toBase64(art) });
    const { id } = await printify.createProduct({
      title: 'Retro Frog Tee',
      description: 'd',
      tags: ['frog'],
      blueprintId: entry.blueprintId,
      printProviderId: entry.printProviderId,
      variants: entry.variants.map((v, i) => ({ id: v.variantId, priceCents: 2699, isEnabled: i < 4 })),
      imageId,
      printPosition: entry.printArea.position,
    });
    return { etsy, printify, id, entry };
  }

  it('catalog entries are complete and consistent with the shop print spec', async () => {
    const p = new MockPrintifyClient();
    for (const type of ['tshirt', 'mug', 'poster'] as const) {
      const e = await p.getCatalogEntry(type);
      expect(e.productType).toBe(type);
      expect(e.variants.length).toBeGreaterThan(0);
      expect(e.printArea.position).toBe('front');
      expect(e.shippingFirstItemUsd).toBeGreaterThan(0);
    }
    expect((await p.getCatalogEntry('tshirt')).printArea).toEqual({ position: 'front', widthPx: 4500, heightPx: 5400 });
    const e = await p.getCatalogEntry('mug');
    e.variants.length = 0; // returned copy must not alias the catalog
    expect(MOCK_PRINTIFY_CATALOG.mug.variants.length).toBe(1);
  });

  it('publish creates an Etsy DRAFT and exposes its id as external', async () => {
    const { etsy, printify, id } = await created();
    const before = await printify.getProduct(id);
    expect(before.external).toBeNull();
    expect(before.mockupUrls).toHaveLength(3);
    expect(before.mockupUrls.every((u) => u.startsWith('https://images-api.printify.com/'))).toBe(true);
    await printify.publishProduct(id);
    const after = await printify.getProduct(id);
    expect(after.external).not.toBeNull();
    const listingId = Number(after.external!.id);
    expect(etsy.peek(listingId)).toEqual({ state: 'draft', shouldAutoRenew: true });
    const listing = await etsy.getListing(listingId);
    expect(listing.title).toBe('Retro Frog Tee');
    expect(listing.price).toEqual({ amount: 24.99, currency: 'EUR' }); // 26.99 USD / 1.08
    await printify.publishProduct(id); // idempotent
    expect((await etsy.listShopListings({ state: 'draft' })).length).toBe(1);
  });

  it('can simulate Printify still publishing (QA must poll)', async () => {
    const { printify, id } = await created({ publishPolls: 2 });
    await printify.publishProduct(id);
    expect((await printify.getProduct(id)).external).toBeNull();
    expect((await printify.getProduct(id)).isLocked).toBe(true);
    const done = await printify.getProduct(id);
    expect(done.external).not.toBeNull();
    expect(done.isLocked).toBe(false);
  });

  it('rejects bad input like the real API', async () => {
    const printify = new MockPrintifyClient();
    await expect(printify.uploadImage({ fileName: 'a.png', contentsBase64: '' })).rejects.toMatchObject({ status: 400 });
    await expect(
      printify.createProduct({
        title: 't',
        description: 'd',
        tags: [],
        blueprintId: 12,
        printProviderId: 29,
        variants: [{ id: 999999, priceCents: 100, isEnabled: true }],
        imageId: 'nope',
        printPosition: 'front',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(printify.getProduct('missing')).rejects.toMatchObject({ status: 404 });
    await expect(printify.publishProduct('missing')).rejects.toMatchObject({ status: 404 });
  });
});

describe('MockTrademarkClient', () => {
  it('matches like Marker: exact and prefix (wildcard) only; dead marks are returned too', async () => {
    const tm = new MockTrademarkClient();
    expect((await tm.search('Just Do It')).map((h) => h.mark)).toEqual(['JUST DO IT']);
    expect((await tm.search('star')).map((h) => h.mark)).toEqual(['STAR WARS', 'STARBUCKS']);
    expect(await tm.search('star', { prefix: false })).toEqual([]);
    // Like the real API, a mark INSIDE a longer term is not returned (the compliance guard searches sub-phrases).
    expect(await tm.search('funny nike shirt')).toEqual([]);
    expect(await tm.search('dog mom')).toEqual([{ mark: 'DOG MOM', serial: '88000014', status: 'dead', classes: [25], owner: null }]);
    expect(await tm.search('retro frog mushroom')).toEqual([]);
    expect(tm.searches).toContain('just do it');
  });
});

describe('MockImageGenClient / MockUpscaler', () => {
  it('returns a real PNG with alpha at sidecar-rounded size, inside the GPU coordinator', async () => {
    const gpu = new MockGpuCoordinator();
    const gen = new MockImageGenClient(gpu);
    const t0 = Date.now();
    const img = await gen.generate({ prompt: 'frog', style: 'vector_illustration', transparentBackground: true, widthPx: 1500, heightPx: 1800 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(isPng(img.bytes)).toBe(true);
    const info = await tools.inspect(img.bytes);
    expect(info).toMatchObject({ widthPx: 1504, heightPx: 1808, hasAlpha: true });
    expect(img.seed).toBe((await gen.generate({ prompt: 'frog', style: 'vector_illustration', transparentBackground: true, widthPx: 64, heightPx: 64 })).seed);
    expect(gpu.history).toEqual(['image', 'image']);

    const opaque = await gen.generate({ prompt: 'poster', style: 'typography', transparentBackground: false, widthPx: 512, heightPx: 768, seed: 9 });
    expect((await tools.inspect(opaque.bytes)).hasAlpha).toBe(false);
    expect(opaque.seed).toBe(9);
  });

  it('upscaler multiplies dimensions and keeps alpha', async () => {
    const art = await renderMockArt({ width: 256, height: 320, transparent: true, seed: 1 });
    const up = new MockUpscaler(new MockGpuCoordinator());
    const info = await tools.inspect(await up.upscale(art, 4));
    expect(info).toMatchObject({ widthPx: 1024, heightPx: 1280, hasAlpha: true });
    await expect(up.upscale(new Uint8Array([1, 2]), 2)).rejects.toThrow(/PNG/);
  });
});

describe('MockPinterestTrendSource and mock fetchImage', () => {
  it('pinterest signals vary by month, deterministic', async () => {
    const src = new MockPinterestTrendSource();
    const oct = await src.fetchSignals({ market: 'US', today: '2026-10-06' });
    expect(oct.map((s) => s.keyword)).toContain('spooky season');
    expect(oct).toEqual(await src.fetchSignals({ market: 'US', today: '2026-10-06' }));
    expect(oct[0]!.score).toBe(100);
  });

  it('fetchImage keeps the allowlist and returns a JPEG', async () => {
    const f = createMockImageFetcher();
    const out = await f('https://images-api.printify.com/mockup/x/1/145/product.jpg');
    expect(out.mimeType).toBe('image/jpeg');
    expect(sniffImageMime(out.bytes)).toBe('image/jpeg');
    await expect(f('https://evil.example/x.jpg')).rejects.toMatchObject({ kind: 'blocked' });
  });
});

describe('createMockIntegrations', () => {
  it('wires a complete bundle that runs a publish round-trip', async () => {
    const i = createMockIntegrations({ now: fixedNow });
    expect(i.trendSources.map((s) => s.name)).toEqual(['etsy_search', 'pinterest', 'seasonal']);
    expect(i.upscaler).not.toBeNull();
    for (const s of i.trendSources) expect((await s.fetchSignals({ market: 'US', today: '2026-10-06' })).length).toBeGreaterThan(0);

    const entry = await i.printify.getCatalogEntry('tshirt');
    const art = await i.imageGen.generate({ prompt: 'frog', style: 'vector_illustration', transparentBackground: true, widthPx: 1504, heightPx: 1808 });
    await i.storage.put('designs/p1/art-1.png', art.bytes, art.mimeType);
    const stored = await i.storage.get('designs/p1/art-1.png');
    const upscaled = await i.upscaler!.upscale(stored!.bytes, 4);
    const print = await i.imageTools.toPrintFile(upscaled, { widthPx: 4500, heightPx: 5400, dpi: 300 });
    const { id: imageId } = await i.printify.uploadImage({ fileName: 'print.png', contentsBase64: toBase64(print) });
    const { id } = await i.printify.createProduct({
      title: 'Frog',
      description: 'd',
      tags: ['frog'],
      blueprintId: entry.blueprintId,
      printProviderId: entry.printProviderId,
      variants: [{ id: entry.variants[0]!.variantId, priceCents: 2699, isEnabled: true }],
      imageId,
      printPosition: 'front',
    });
    await i.printify.publishProduct(id);
    const product = await i.printify.getProduct(id);
    const mockup = await i.fetchImage(product.mockupUrls[0]!);
    expect(mockup.mimeType).toBe('image/jpeg');
    const listingId = Number(product.external!.id);
    await i.etsy.updateListing(listingId, { state: 'active' });
    expect(i.mocks.etsy.peek(listingId)!.state).toBe('active');
    expect(await i.gpu.withGpu('llm', async () => 'ok')).toBe('ok');
  });
});

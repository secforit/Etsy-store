import { describe, expect, it } from 'vitest';
import type { QaPublisherInput } from './contracts.ts';
import { PrintifyProductPendingError, checkPrintFile, runQaPublisher, upscaleFactorFor } from './qaPublisher.ts';
import { marginFor } from './pricing.ts';
import {
  FakeImageTools,
  FakePrintify,
  FakeUpscaler,
  MemoryStorage,
  ScriptedLlm,
  TODAY,
  catalogEntry,
  fakeImage,
  readFakeImage,
  realPng,
  shop,
} from './testing/fakes.ts';
import { LlmError } from '../llm/types.ts';

const PID = '7f1c2a9e-0000-4000-8000-000000000002';
const EDITED = `designs/${PID}/edited-1.png`;

const input = (over: Partial<QaPublisherInput> = {}): QaPublisherInput => ({
  productId: PID,
  productType: 'tshirt',
  editedKey: EDITED,
  listing: { title: 'Campfire Club Retro Camping T-Shirt', tags: ['camping shirt', 'campfire tee', 'camper gift', 'outdoor gift', 'retro tee'], description: 'A vintage badge design.', priceEur: 24.99 },
  existingPrintifyProductId: null,
  eurToUsd: 1.1,
  ...over,
});

async function setup(opts: { edited?: Uint8Array | null; upscaler?: boolean; vision?: unknown; fetchFails?: boolean } = {}) {
  const storage = new MemoryStorage();
  if (opts.edited !== null) await storage.put(EDITED, opts.edited ?? fakeImage({ widthPx: 1504, heightPx: 1808 }), 'image/png');
  const printify = new FakePrintify();
  const imageTools = new FakeImageTools();
  const upscaler = opts.upscaler === false ? null : new FakeUpscaler();
  const llm = new ScriptedLlm({ qa_publisher: () => opts.vision ?? { verdict: 'pass', issues: [] } });
  const png = await realPng();
  const fetched: string[] = [];
  const sleeps: number[] = [];
  const deps = {
    llm,
    shop,
    today: TODAY,
    printify,
    storage,
    imageTools,
    upscaler,
    fetchImage: async (url: string) => {
      fetched.push(url);
      if (opts.fetchFails) throw new Error('host not allowed');
      return { bytes: png, mimeType: 'image/png' };
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    publishPollAttempts: 5,
    publishPollIntervalMs: 1000,
  };
  return { deps, storage, printify, imageTools, upscaler, llm, fetched, sleeps };
}

describe('QA & Publisher happy path', () => {
  it('upscales x4 with the AI upscaler, resizes to the exact print spec, creates, checks mockups, publishes, polls', async () => {
    const s = await setup();
    s.printify.publishDelayPolls = 3;
    const { output, llmUsage } = await runQaPublisher(input(), s.deps);

    expect(output.status).toBe('drafted');
    if (output.status !== 'drafted') return;
    expect(output.etsyListingId).toBe(1234567890);
    expect(output.printifyProductId).toBe('pfy-1');
    expect(output.printKey).toBe(`designs/${PID}/print.png`);

    // 1504x1808 -> needs 2.99x -> x4 AI upscale, then exact resize
    expect(s.upscaler?.calls).toEqual([4]);
    expect(s.imageTools.toPrintCalls[0]).toMatchObject({ from: { w: 6016, h: 7232 }, spec: { widthPx: 4500, heightPx: 5400, dpi: 300 } });
    const stored = readFakeImage(s.storage.blobs.get(output.printKey)!.bytes);
    expect(stored).toMatchObject({ widthPx: 4500, heightPx: 5400, dpi: 300 });

    // Printify: one upload, one create with min-margin variant prices, one publish
    expect(s.printify.uploads).toHaveLength(1);
    expect(s.printify.creates).toHaveLength(1);
    const created = s.printify.creates[0]!;
    expect(created).toMatchObject({ blueprintId: 12, printProviderId: 29, printPosition: 'front', imageId: 'img-1' });
    const entry = catalogEntry('tshirt');
    for (const v of created.variants) {
      const cost = entry.variants.find((x) => x.variantId === v.id)!.costUsd;
      const priceEur = v.priceCents / 100 / 1.1;
      expect(marginFor(priceEur, { productUsd: cost, shippingUsd: entry.shippingFirstItemUsd }, 1.1, shop).marginShare).toBeGreaterThanOrEqual(0.249);
    }
    expect(s.printify.publishes).toEqual(['pfy-1']);

    // vision check on max 3 mockups before publishing
    expect(s.fetched).toHaveLength(3);
    expect(s.llm.requests[0]?.images).toHaveLength(3);
    expect(llmUsage).toHaveLength(1);
    // getProduct: once before publish + 3 polls; sleeps only between polls
    expect(s.printify.gets).toHaveLength(4);
    expect(s.sleeps).toEqual([1000, 1000]);
  });

  it('uses x2 when the file is at least half the print size', async () => {
    const s = await setup({ edited: fakeImage({ widthPx: 2250, heightPx: 2700 }) });
    await runQaPublisher(input(), s.deps);
    expect(s.upscaler?.calls).toEqual([2]);
  });

  it('skips upscaling when the file is already big enough', async () => {
    const s = await setup({ edited: fakeImage({ widthPx: 4500, heightPx: 5400 }) });
    const { output } = await runQaPublisher(input(), s.deps);
    expect(output.status).toBe('drafted');
    expect(s.upscaler?.calls).toEqual([]);
  });

  it('falls back to a sharp-only resize when no upscaler is configured', async () => {
    const s = await setup({ upscaler: false });
    const { output } = await runQaPublisher(input(), s.deps);
    expect(output.status).toBe('drafted');
    expect(s.imageTools.toPrintCalls[0]?.from).toEqual({ w: 1504, h: 1808 });
    expect(output.qaNotes.join(' ')).toContain('sharp only');
  });

  it('uses the Printify print area when the shop has no print spec (mug)', async () => {
    const s = await setup({ edited: fakeImage({ widthPx: 1238, heightPx: 578 }) });
    const { output } = await runQaPublisher(input({ productType: 'mug' }), s.deps);
    expect(output.status).toBe('drafted');
    expect(s.imageTools.toPrintCalls[0]?.spec).toEqual({ widthPx: 2475, heightPx: 1155, dpi: 300 });
  });

  it('continues without the vision check when mockups cannot be fetched', async () => {
    const s = await setup({ fetchFails: true });
    const { output, llmUsage } = await runQaPublisher(input(), s.deps);
    expect(output.status).toBe('drafted');
    expect(llmUsage).toHaveLength(0);
    expect(output.qaNotes.join(' ')).toContain('vision check was skipped');
  });
});

describe('QA & Publisher fail paths', () => {
  it('fails when the edited file is missing', async () => {
    const s = await setup({ edited: null });
    const { output } = await runQaPublisher(input(), s.deps);
    expect(output).toMatchObject({ status: 'qa_failed', printifyProductId: null });
    expect(s.printify.creates).toHaveLength(0);
  });

  it('fails when the edited file is not a PNG', async () => {
    const s = await setup({ edited: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) });
    expect((await runQaPublisher(input(), s.deps)).output.status).toBe('qa_failed');
  });

  it('fails when the file would need more than 4x upscaling', async () => {
    const s = await setup({ edited: fakeImage({ widthPx: 1000, heightPx: 1200 }) });
    const { output } = await runQaPublisher(input(), s.deps);
    expect(output.status).toBe('qa_failed');
    expect(output.qaNotes[0]).toContain('at least 1125x1350');
    expect(s.upscaler?.calls).toEqual([]);
  });

  it('fails an opaque poster whose aspect ratio does not match', async () => {
    const s = await setup({ edited: fakeImage({ widthPx: 1600, heightPx: 1600, hasAlpha: false }) });
    const { output } = await runQaPublisher(input({ productType: 'poster' }), s.deps);
    expect(output.status).toBe('qa_failed');
    expect(output.qaNotes[0]).toContain('aspect ratio');
  });

  it.each([
    [{ hasAlpha: false }, 'no transparency'],
    [{ semiTransparentShare: 0.4 }, 'semi-transparent'],
    [{ dpi: 72 }, 'DPI'],
    [{ dpi: null }, 'DPI is missing'],
    [{ colorSpace: 'cmyk' }, 'sRGB'],
    [{ widthPx: 4400 }, 'expected 4500x5400'],
  ])('fails print-file check %j', async (override, text) => {
    const s = await setup();
    s.imageTools.printOverrides = override;
    const { output } = await runQaPublisher(input(), s.deps);
    expect(output.status).toBe('qa_failed');
    expect(output.qaNotes.join(' ')).toContain(text);
    expect(s.printify.uploads).toHaveLength(0);
  });

  it('fails on the vision check BEFORE publishing and never hands back the product for reuse', async () => {
    const s = await setup({ vision: { verdict: 'fail', issues: ['The text is cut off on the right.'] } });
    const { output } = await runQaPublisher(input(), s.deps);
    expect(output.status).toBe('qa_failed');
    if (output.status !== 'qa_failed') return;
    expect(output.qaNotes[0]).toBe('Mockup check: The text is cut off on the right.');
    expect(output.printifyProductId).toBeNull();
    expect(output.qaNotes.join(' ')).toContain('pfy-1');
    expect(s.printify.publishes).toHaveLength(0);
  });
});

describe('QA & Publisher Printify idempotency', () => {
  it('reuses an already published product: no upload, create or publish', async () => {
    const s = await setup();
    s.printify.products.set('pfy-9', { id: 'pfy-9', title: 't', mockupUrls: [], external: { id: '555', handle: null }, isLocked: false });
    const { output } = await runQaPublisher(input({ existingPrintifyProductId: 'pfy-9' }), s.deps);
    expect(output).toMatchObject({ status: 'drafted', printifyProductId: 'pfy-9', etsyListingId: 555 });
    expect(s.printify.uploads).toHaveLength(0);
    expect(s.printify.creates).toHaveLength(0);
    expect(s.printify.publishes).toHaveLength(0);
  });

  it('reuses an unpublished product: vision check + publish, no new create', async () => {
    const s = await setup();
    s.printify.products.set('pfy-9', { id: 'pfy-9', title: 't', mockupUrls: ['https://images.printify.com/a.jpg'], external: null, isLocked: false });
    const { output } = await runQaPublisher(input({ existingPrintifyProductId: 'pfy-9' }), s.deps);
    expect(output.status).toBe('drafted');
    expect(s.printify.creates).toHaveLength(0);
    expect(s.printify.publishes).toEqual(['pfy-9']);
  });

  it('waits for a product that is already publishing without publishing again', async () => {
    const s = await setup();
    s.printify.products.set('pfy-9', { id: 'pfy-9', title: 't', mockupUrls: [], external: null, isLocked: true });
    s.printify.publishDelayPolls = 3;
    await s.printify.publishProduct('pfy-9'); // simulate the in-flight publish from the crashed run
    s.printify.publishes.length = 0;
    const { output } = await runQaPublisher(input({ existingPrintifyProductId: 'pfy-9' }), s.deps);
    expect(output.status).toBe('drafted');
    expect(output.qaNotes.join(' ')).toContain('already publishing');
    expect(s.printify.publishes).toHaveLength(0);
    expect(s.llm.requests).toHaveLength(0);
    expect(s.sleeps).toEqual([1000, 1000]);
  });

  it('throws PrintifyProductPendingError with the product id when publishing does not finish in time', async () => {
    const s = await setup();
    s.printify.publishDelayPolls = 100;
    const err = await runQaPublisher(input(), s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PrintifyProductPendingError);
    expect(err.printifyProductId).toBe('pfy-1');
    expect(s.printify.gets).toHaveLength(1 + 5);
  });

  it('wraps later failures (e.g. the vision model) with the product id', async () => {
    const s = await setup({ vision: new LlmError('ollama down', true) });
    const err = await runQaPublisher(input(), s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PrintifyProductPendingError);
    expect(err.printifyProductId).toBe('pfy-1');
    expect(err.cause).toBeInstanceOf(LlmError);
    expect(s.printify.publishes).toHaveLength(0);
  });
});

describe('QA helpers', () => {
  it('chooses the upscale factor', () => {
    const spec = { widthPx: 4500, heightPx: 5400 };
    expect(upscaleFactorFor({ widthPx: 4500, heightPx: 5400 }, spec)).toBe(1);
    expect(upscaleFactorFor({ widthPx: 2250, heightPx: 2700 }, spec)).toBe(2);
    expect(upscaleFactorFor({ widthPx: 1504, heightPx: 1808 }, spec)).toBe(4);
    expect(upscaleFactorFor({ widthPx: 1124, heightPx: 1350 }, spec)).toBeNull();
  });

  it('accepts a good print file', () => {
    const spec = { widthPx: 10, heightPx: 10, dpi: 300, transparentBackground: true };
    expect(checkPrintFile({ format: 'png', widthPx: 10, heightPx: 10, dpi: 300, hasAlpha: true, colorSpace: 'srgb', semiTransparentShare: 0.05 }, spec, true)).toEqual([]);
  });
});

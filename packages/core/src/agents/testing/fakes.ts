/**
 * Small local fakes for the agents' and LLM clients' tests. Deliberately independent of the integrations
 * builder's mocks: each fake implements only the contract interface and records what it was asked.
 */
import sharp from 'sharp';
import { SHOP } from '../../config/shop.ts';
import type { AgentName, ProductType, TrademarkHit } from '../../domain/types.ts';
import type {
  BlobStorage,
  EtsyClient,
  EtsyListingSummary,
  EtsySearchResult,
  GeneratedImage,
  GpuCoordinator,
  GpuOwner,
  ImageGenClient,
  ImageInspection,
  ImageTools,
  ImageUpscaler,
  PrintifyCatalogEntry,
  PrintifyClient,
  PrintifyProduct,
  PrintifyProductInput,
  TrademarkClient,
} from '../../integrations/types.ts';
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from '../../llm/types.ts';

export const TODAY = '2026-10-06';

/* ---------------------------------- GPU ----------------------------------- */

export class FakeGpu implements GpuCoordinator {
  readonly owners: GpuOwner[] = [];
  active: GpuOwner | null = null;
  async withGpu<T>(owner: GpuOwner, fn: () => Promise<T>): Promise<T> {
    this.owners.push(owner);
    this.active = owner;
    try {
      return await fn();
    } finally {
      this.active = null;
    }
  }
}

/* ---------------------------------- LLM ----------------------------------- */

type Handler = (req: LlmRequest<unknown>, call: number) => unknown;

/** Returns scripted outputs per agent, validated against the request schema like a real client. */
export class ScriptedLlm implements LlmClient {
  readonly requests: LlmRequest<unknown>[] = [];
  private readonly counts = new Map<AgentName, number>();
  constructor(private readonly handlers: Partial<Record<AgentName, Handler>>) {}

  async generate<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    this.requests.push(req as LlmRequest<unknown>);
    const handler = this.handlers[req.agent];
    if (!handler) throw new LlmError(`ScriptedLlm: no handler for ${req.agent}`, false);
    const n = this.counts.get(req.agent) ?? 0;
    this.counts.set(req.agent, n + 1);
    const out = handler(req as LlmRequest<unknown>, n);
    if (out instanceof Error) throw out;
    const parsed = req.schema.safeParse(out);
    if (!parsed.success) throw new LlmError(`ScriptedLlm: output for ${req.agent} fails its schema: ${parsed.error.message}`, false);
    return { output: parsed.data, usage: { model: 'fake-llm', inputTokens: 100, outputTokens: 20, costUsd: 0, durationMs: 5 } };
  }

  last(agent: AgentName): LlmRequest<unknown> | undefined {
    return [...this.requests].reverse().find((r) => r.agent === agent);
  }
}

/* -------------------------------- Storage --------------------------------- */

export class MemoryStorage implements BlobStorage {
  readonly blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  private check(key: string) {
    if (!/^[a-z0-9_.-][a-z0-9/_.-]*$/.test(key) || key.includes('..')) throw new Error(`bad key ${key}`);
  }
  async put(key: string, bytes: Uint8Array, mimeType: string) {
    this.check(key);
    this.blobs.set(key, { bytes, mimeType });
  }
  async get(key: string) {
    this.check(key);
    return this.blobs.get(key) ?? null;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

/* ------------------------------- Trademark -------------------------------- */

export class FakeTrademark implements TrademarkClient {
  readonly searched: string[] = [];
  /** Same order as `searched`: false when the caller asked for an exact-only query. */
  readonly prefixes: boolean[] = [];
  constructor(private readonly lookup: (term: string) => TrademarkHit[] = () => []) {}
  async search(term: string, opts: { prefix?: boolean } = {}) {
    this.searched.push(term);
    this.prefixes.push(opts.prefix !== false);
    return this.lookup(term);
  }
}

/**
 * Behaves like the Marker API: returns a mark only when it EQUALS the query, or STARTS WITH it when the prefix
 * (`term*`) query is on. Never returns a mark that sits inside a longer query.
 */
export class MarkerLikeTrademark implements TrademarkClient {
  readonly queries: { term: string; prefix: boolean }[] = [];
  constructor(private readonly marks: TrademarkHit[]) {}
  private static norm(s: string): string {
    return s.toLowerCase().replace(/[^\p{L}\p{N}\s&'-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  }
  async search(term: string, opts: { prefix?: boolean } = {}) {
    const t = MarkerLikeTrademark.norm(term);
    const prefix = opts.prefix !== false;
    this.queries.push({ term: t, prefix });
    return this.marks.filter((m) => {
      const n = MarkerLikeTrademark.norm(m.mark);
      return n === t || (prefix && n.startsWith(t));
    });
  }
}

export function mark(m: string, status: 'live' | 'dead', classes: number[], serial = `sn-${m}`): TrademarkHit {
  return { mark: m, serial, status, classes, owner: 'Owner Inc.' };
}

/* ---------------------------------- Etsy ---------------------------------- */

export class FakeEtsy implements EtsyClient {
  readonly searches: string[] = [];
  constructor(private readonly byKeyword: (kw: string) => EtsySearchResult = () => ({ count: 120, results: [] })) {}
  async searchActiveListings(q: { keywords: string }) {
    this.searches.push(q.keywords);
    return this.byKeyword(q.keywords);
  }
  async getListing(): Promise<EtsyListingSummary> {
    throw new Error('not used');
  }
  async listShopListings() {
    return [];
  }
  async updateListing() {}
  async getReceiptLines() {
    return [];
  }
}

export function listing(title: string, numFavorers: number): EtsyListingSummary {
  return {
    listingId: Math.abs(title.length * 7919 + numFavorers),
    title,
    tags: [],
    price: { amount: 24.99, currency: 'USD' },
    numFavorers,
    views: null,
    createdAt: '2026-01-01T00:00:00Z',
    state: 'active',
  };
}

/* -------------------------------- Printify -------------------------------- */

export function catalogEntry(productType: ProductType, over: Partial<PrintifyCatalogEntry> = {}): PrintifyCatalogEntry {
  const base: Record<ProductType, PrintifyCatalogEntry> = {
    tshirt: {
      productType: 'tshirt',
      blueprintId: 12,
      printProviderId: 29,
      variants: [
        { variantId: 1, title: 'Black / S', costUsd: 11.5 },
        { variantId: 2, title: 'Black / M', costUsd: 11.5 },
        { variantId: 3, title: 'Black / 2XL', costUsd: 14.5 },
      ],
      shippingFirstItemUsd: 4.75,
      printArea: { position: 'front', widthPx: 4500, heightPx: 5400 },
    },
    mug: {
      productType: 'mug',
      blueprintId: 68,
      printProviderId: 1,
      variants: [{ variantId: 10, title: '11oz', costUsd: 7.2 }],
      shippingFirstItemUsd: 6.5,
      printArea: { position: 'front', widthPx: 2475, heightPx: 1155 },
    },
    poster: {
      productType: 'poster',
      blueprintId: 282,
      printProviderId: 99,
      variants: [{ variantId: 20, title: '12x18', costUsd: 9.8 }],
      shippingFirstItemUsd: 5.0,
      printArea: { position: 'front', widthPx: 3600, heightPx: 5400 },
    },
  };
  return { ...base[productType], ...over };
}

export class FakePrintify implements PrintifyClient {
  readonly uploads: { fileName: string; bytes: number }[] = [];
  readonly creates: PrintifyProductInput[] = [];
  readonly publishes: string[] = [];
  readonly gets: string[] = [];
  readonly products = new Map<string, PrintifyProduct>();
  /** getProduct calls after publish before external is set. */
  publishDelayPolls = 1;
  externalId = '1234567890';
  mockupUrls = ['https://images.printify.com/mockup/1.jpg', 'https://images.printify.com/mockup/2.jpg', 'https://images.printify.com/mockup/3.jpg', 'https://images.printify.com/mockup/4.jpg'];
  catalogFails: ProductType[] = [];
  private pendingPolls = new Map<string, number>();
  private seq = 0;

  async getCatalogEntry(productType: ProductType) {
    if (this.catalogFails.includes(productType)) throw new Error(`catalog not set up for ${productType}`);
    return catalogEntry(productType);
  }
  async uploadImage(input: { fileName: string; contentsBase64: string }) {
    this.uploads.push({ fileName: input.fileName, bytes: Buffer.from(input.contentsBase64, 'base64').length });
    return { id: `img-${this.uploads.length}` };
  }
  async createProduct(input: PrintifyProductInput) {
    this.creates.push(input);
    const id = `pfy-${++this.seq}`;
    this.products.set(id, { id, title: input.title, mockupUrls: [...this.mockupUrls], external: null, isLocked: false });
    return { id };
  }
  async getProduct(id: string) {
    this.gets.push(id);
    const p = this.products.get(id);
    if (!p) throw new Error(`printify product ${id} not found`);
    const pending = this.pendingPolls.get(id);
    if (pending !== undefined) {
      if (pending <= 0) {
        p.external = { id: this.externalId, handle: null };
        p.isLocked = false;
        this.pendingPolls.delete(id);
      } else {
        this.pendingPolls.set(id, pending - 1);
      }
    }
    return structuredClone(p);
  }
  async publishProduct(id: string) {
    this.publishes.push(id);
    const p = this.products.get(id);
    if (!p) throw new Error('not found');
    p.isLocked = true;
    this.pendingPolls.set(id, this.publishDelayPolls - 1);
  }
}

/* ------------------------------ Image fakes ------------------------------- */

/** Fake "image": PNG signature + JSON with its inspection values. FakeImageTools reads it back. */
export function fakeImage(info: Partial<ImageInspection> & { widthPx: number; heightPx: number }): Uint8Array {
  const full: ImageInspection = {
    format: 'png',
    dpi: 72,
    hasAlpha: true,
    colorSpace: 'srgb',
    semiTransparentShare: 0.02,
    ...info,
  };
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const json = new TextEncoder().encode(JSON.stringify(full));
  const out = new Uint8Array(sig.length + json.length);
  out.set(sig);
  out.set(json, sig.length);
  return out;
}

export function readFakeImage(bytes: Uint8Array): ImageInspection {
  return JSON.parse(new TextDecoder().decode(bytes.slice(8))) as ImageInspection;
}

export class FakeImageTools implements ImageTools {
  readonly toPrintCalls: { from: { w: number; h: number }; spec: { widthPx: number; heightPx: number; dpi: number } }[] = [];
  /** Applied to every print file (simulate bad output). */
  printOverrides: Partial<ImageInspection> = {};
  async inspect(bytes: Uint8Array) {
    return readFakeImage(bytes);
  }
  async toPrintFile(bytes: Uint8Array, spec: { widthPx: number; heightPx: number; dpi: number }) {
    const src = readFakeImage(bytes);
    const f = Math.max(spec.widthPx / src.widthPx, spec.heightPx / src.heightPx);
    if (f > 4) throw new Error('toPrintFile never upscales more than 4x');
    this.toPrintCalls.push({ from: { w: src.widthPx, h: src.heightPx }, spec });
    return fakeImage({ ...src, widthPx: spec.widthPx, heightPx: spec.heightPx, dpi: spec.dpi, ...this.printOverrides });
  }
}

export class FakeUpscaler implements ImageUpscaler {
  readonly calls: (2 | 4)[] = [];
  async upscale(bytes: Uint8Array, factor: 2 | 4) {
    this.calls.push(factor);
    const src = readFakeImage(bytes);
    return fakeImage({ ...src, widthPx: src.widthPx * factor, heightPx: src.heightPx * factor });
  }
}

let realPngCache: Uint8Array | null = null;
/** A real (tiny) PNG for code paths that run sharp, e.g. vision downscaling. */
export async function realPng(): Promise<Uint8Array> {
  realPngCache ??= new Uint8Array(
    await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 200, g: 80, b: 40, alpha: 0.8 } } }).png().toBuffer(),
  );
  return realPngCache;
}

export class FakeImageGen implements ImageGenClient {
  readonly requests: Parameters<ImageGenClient['generate']>[0][] = [];
  bytes: Uint8Array | null = null;
  async generate(req: Parameters<ImageGenClient['generate']>[0]): Promise<GeneratedImage> {
    this.requests.push(req);
    return {
      bytes: this.bytes ?? fakeImage({ widthPx: req.widthPx, heightPx: req.heightPx, hasAlpha: req.transparentBackground }),
      mimeType: 'image/png',
      model: 'flux2-klein-4b',
      seed: req.seed ?? null,
    };
  }
}

export const shop = SHOP;

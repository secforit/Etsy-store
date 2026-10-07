/**
 * Deterministic offline Printify. Catalog entries mirror real-world shapes (Bella+Canvas 3001 tee, 11oz mug,
 * matte poster); ids/costs are illustrative. publishProduct creates an Etsy DRAFT in the MockEtsyClient (if given)
 * and sets `external` to that listing id, like Printify's Etsy integration does.
 */
import type { ProductType } from '../../domain/types.ts';
import { HttpError } from '../http.ts';
import type { ExternalWriteEvent, ExternalWriteHook } from '../printify.ts';
import type { PrintifyCatalogEntry, PrintifyClient, PrintifyProduct, PrintifyProductInput } from '../types.ts';
import { fromBase64, hash32, roundCents, sha256Hex } from '../util.ts';
import type { MockEtsyClient } from './etsy.ts';

function tshirtVariants(): PrintifyCatalogEntry['variants'] {
  const colors = ['Black', 'White', 'Navy', 'Athletic Heather'];
  const sizes: [string, number][] = [
    ['S', 9.35],
    ['M', 9.35],
    ['L', 9.35],
    ['XL', 9.35],
    ['2XL', 11.6],
    ['3XL', 13.25],
  ];
  const out: PrintifyCatalogEntry['variants'] = [];
  let id = 18_100;
  for (const c of colors) for (const [s, cost] of sizes) out.push({ variantId: id++, title: `${c} / ${s}`, costUsd: cost });
  return out;
}

export const MOCK_PRINTIFY_CATALOG: Record<ProductType, PrintifyCatalogEntry> = {
  tshirt: {
    productType: 'tshirt',
    blueprintId: 12,
    printProviderId: 29,
    variants: tshirtVariants(),
    shippingFirstItemUsd: 4.75,
    printArea: { position: 'front', widthPx: 4500, heightPx: 5400 },
  },
  mug: {
    productType: 'mug',
    blueprintId: 68,
    printProviderId: 1,
    variants: [{ variantId: 33_719, title: '11oz', costUsd: 4.95 }],
    shippingFirstItemUsd: 7.49,
    printArea: { position: 'front', widthPx: 2475, heightPx: 1155 },
  },
  poster: {
    productType: 'poster',
    blueprintId: 282,
    printProviderId: 2,
    variants: [{ variantId: 43_135, title: '12″ x 18″ / Matte', costUsd: 8.42 }],
    shippingFirstItemUsd: 5.29,
    printArea: { position: 'front', widthPx: 3600, heightPx: 5400 },
  },
};

interface StoredProduct {
  input: PrintifyProductInput;
  external: PrintifyProduct['external'];
  pendingPolls: number;
  isLocked: boolean;
}

export interface MockPrintifyOptions {
  /** Where publish creates drafts; without it external ids are synthesised. */
  etsy?: MockEtsyClient | null;
  /** getProduct calls that still show "publishing" (locked, no external) after publish. Default 0. */
  publishPolls?: number;
  /** Converts the USD variant price back to the EUR listing price for the mock Etsy draft. */
  eurToUsd?: number;
  /** Same hook as LivePrintifyClient: reports upload/create/publish so mock runs exercise the audit_log wiring. */
  onExternalWrite?: ExternalWriteHook;
}

function notFound(operation: string): HttpError {
  return new HttpError({ service: 'printify', operation, kind: 'status', status: 404 });
}

export class MockPrintifyClient implements PrintifyClient {
  private readonly products = new Map<string, StoredProduct>();
  private readonly uploads = new Map<string, number>();
  private counter = 0;
  /** Call log for assertions and the demo summary. */
  readonly calls: { op: 'upload' | 'create' | 'publish'; id: string }[] = [];

  constructor(private readonly opts: MockPrintifyOptions = {}) {}

  private async emit(e: Omit<ExternalWriteEvent, 'service'>): Promise<void> {
    if (!this.opts.onExternalWrite) return;
    try {
      await this.opts.onExternalWrite({ service: 'printify', ...e });
    } catch {
      // Like the live client: a failing audit hook never fails the write itself.
    }
  }

  async getCatalogEntry(productType: ProductType): Promise<PrintifyCatalogEntry> {
    const e = MOCK_PRINTIFY_CATALOG[productType];
    if (!e) throw new Error(`printify mock: unknown product type ${String(productType)}`);
    return structuredClone(e);
  }

  async uploadImage(input: { fileName: string; contentsBase64: string }): Promise<{ id: string }> {
    const bytes = fromBase64(input.contentsBase64);
    if (bytes.byteLength === 0) throw new HttpError({ service: 'printify', operation: 'upload image', kind: 'status', status: 400 });
    const id = sha256Hex(bytes).slice(0, 24);
    this.uploads.set(id, bytes.byteLength);
    this.calls.push({ op: 'upload', id });
    await this.emit({ action: 'printify.image.upload', entity: 'printify_image', entityId: id, details: { fileName: input.fileName } });
    return { id };
  }

  async createProduct(input: PrintifyProductInput): Promise<{ id: string }> {
    const entry = Object.values(MOCK_PRINTIFY_CATALOG).find(
      (e) => e.blueprintId === input.blueprintId && e.printProviderId === input.printProviderId,
    );
    const known = new Set(entry?.variants.map((v) => v.variantId) ?? []);
    const bad =
      !entry ||
      !this.uploads.has(input.imageId) ||
      input.variants.length === 0 ||
      input.variants.some((v) => !known.has(v.id) || !Number.isInteger(v.priceCents) || v.priceCents <= 0);
    if (bad) throw new HttpError({ service: 'printify', operation: 'create product', kind: 'status', status: 400 });
    this.counter++;
    const id = sha256Hex(`product:${this.counter}:${input.title}`).slice(0, 24);
    this.products.set(id, { input: structuredClone(input), external: null, pendingPolls: 0, isLocked: false });
    this.calls.push({ op: 'create', id });
    await this.emit({
      action: 'printify.product.create',
      entity: 'printify_product',
      entityId: id,
      details: { blueprintId: input.blueprintId, printProviderId: input.printProviderId, variants: input.variants.length },
    });
    return { id };
  }

  async getProduct(productId: string): Promise<PrintifyProduct> {
    const p = this.products.get(productId);
    if (!p) throw notFound('get product');
    if (p.pendingPolls > 0) {
      p.pendingPolls--;
      return { id: productId, title: p.input.title, mockupUrls: this.mockups(productId, p), external: null, isLocked: true };
    }
    if (p.isLocked && p.external) p.isLocked = false;
    return {
      id: productId,
      title: p.input.title,
      mockupUrls: this.mockups(productId, p),
      external: p.external ? { ...p.external } : null,
      isLocked: p.isLocked,
    };
  }

  async publishProduct(productId: string): Promise<void> {
    const p = this.products.get(productId);
    if (!p) throw notFound('publish product');
    this.calls.push({ op: 'publish', id: productId });
    if (p.external) return; // idempotent
    const enabled = p.input.variants.filter((v) => v.isEnabled);
    const minCents = Math.min(...(enabled.length > 0 ? enabled : p.input.variants).map((v) => v.priceCents));
    let listingId: number;
    if (this.opts.etsy) {
      const draft = this.opts.etsy.createDraftListing({
        title: p.input.title,
        tags: p.input.tags,
        priceAmount: roundCents(minCents / 100 / (this.opts.eurToUsd ?? 1.08)),
        currency: 'EUR',
      });
      listingId = draft.listingId;
    } else {
      listingId = 4_200_000_000 + (hash32(productId) % 90_000_000);
    }
    p.external = { id: String(listingId), handle: `https://www.etsy.com/listing/${listingId}` };
    p.pendingPolls = this.opts.publishPolls ?? 0;
    p.isLocked = true;
    await this.emit({ action: 'printify.product.publish', entity: 'printify_product', entityId: productId, details: {} });
  }

  private mockups(productId: string, p: StoredProduct): string[] {
    const variant = p.input.variants.find((v) => v.isEnabled)?.id ?? p.input.variants[0]?.id ?? 0;
    return [145, 146, 147].map((camera) => `https://images-api.printify.com/mockup/${productId}/${variant}/${camera}/product.jpg`);
  }
}

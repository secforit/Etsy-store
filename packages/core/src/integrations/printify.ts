/**
 * Printify API v1 (https://api.printify.com/v1), personal access token (Bearer) + User-Agent (required).
 * Limits: 600 req/min global, catalog 100 req/min, publish 200 / 30 min, error responses must stay < 5%.
 *
 * Catalog: blueprint + print provider ids come from a resolver (SHOP.products after `setup-catalog`), else are
 * auto-discovered from the live catalog (title match + a US print provider) and logged so they can be pinned.
 * Printify's catalog has NO variant costs: costs are read from an existing shop product with the same
 * blueprint/provider, else from a short-lived "cost probe" product that is created and deleted immediately
 * (both writes are reported through `onExternalWrite` for the audit log).
 */
import sharp from 'sharp';
import { z } from 'zod';
import { SHOP } from '../config/shop.ts';
import type { ProductType } from '../domain/types.ts';
import type { Logger } from '../orchestrator/contracts.ts';
import {
  HttpClient,
  HttpError,
  createServiceBucket,
  type Clock,
  type FetchLike,
  type HttpRequest,
  type TokenBucket,
} from './http.ts';
import type {
  PrintifyCatalogEntry,
  PrintifyClient,
  PrintifyProduct,
  PrintifyProductInput,
  PrintifyVariantCost,
} from './types.ts';
import { noopLogger, roundCents, toBase64 } from './util.ts';

export const PRINTIFY_API_BASE = 'https://api.printify.com/v1';
export const PRINTIFY_API_BASE_V2 = 'https://api.printify.com/v2';
export const PRINTIFY_USER_AGENT = 'etsy-agents/0.1 (self-hosted; Node.js)';
/** Keep products manageable: Printify/Etsy handle ~100 variants per listing well. */
export const MAX_CATALOG_VARIANTS = 100;

export interface PrintifyCatalogIds {
  blueprintId: number;
  printProviderId: number;
}

export type PrintifyCatalogResolver = (
  productType: ProductType,
) => PrintifyCatalogIds | null | Promise<PrintifyCatalogIds | null>;

/** Default resolver: the ids pinned in SHOP.products (null until setup). */
export const shopCatalogResolver: PrintifyCatalogResolver = (pt) => {
  const p = SHOP.products[pt];
  return p.printifyBlueprintId !== null && p.printifyPrintProviderId !== null
    ? { blueprintId: p.printifyBlueprintId, printProviderId: p.printifyPrintProviderId }
    : null;
};

/** Reported for every write to an external system so the orchestrator can append it to audit_log. */
export interface ExternalWriteEvent {
  service: 'printify' | 'etsy';
  action: string;
  entity: string;
  entityId: string | null;
  details: Record<string, unknown>;
}
export type ExternalWriteHook = (e: ExternalWriteEvent) => void | Promise<void>;

/* -------------------------------- shapes ---------------------------------- */

const PlaceholderSchema = z.object({ position: z.string(), width: z.number(), height: z.number() });
const CatalogVariantSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  options: z.record(z.string(), z.unknown()).nullish(),
  placeholders: z.array(PlaceholderSchema).nullish(),
});
const CatalogVariantsSchema = z.object({ variants: z.array(CatalogVariantSchema) });

const ProductSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullish(),
  blueprint_id: z.number().nullish(),
  print_provider_id: z.number().nullish(),
  variants: z
    .array(z.object({ id: z.number().int(), cost: z.number().nullish(), title: z.string().nullish() }))
    .nullish(),
  images: z
    .array(z.object({ src: z.string(), is_default: z.boolean().nullish(), position: z.string().nullish() }))
    .nullish(),
  external: z.unknown().optional(),
  is_locked: z.boolean().nullish(),
});

const ProductPageSchema = z.object({
  current_page: z.number().nullish(),
  last_page: z.number().nullish(),
  data: z.array(ProductSchema),
});

function parseShape<T>(schema: z.ZodType<T>, value: unknown, operation: string): T {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new HttpError({ service: 'printify', operation, kind: 'invalid_response', detail: r.error.issues[0]?.message ?? '' });
  return r.data;
}

/** Printify documents `external` both as an object and as an array of objects. */
export function mapExternal(raw: unknown): PrintifyProduct['external'] {
  const pick = Array.isArray(raw) ? raw.find((x) => x && typeof x === 'object' && 'id' in x) : raw;
  if (!pick || typeof pick !== 'object') return null;
  const o = pick as { id?: unknown; handle?: unknown };
  if (o.id === undefined || o.id === null || o.id === '') return null;
  return { id: String(o.id), handle: typeof o.handle === 'string' && o.handle ? o.handle : null };
}

export function mapPrintifyProduct(p: z.infer<typeof ProductSchema>): PrintifyProduct {
  const images = [...(p.images ?? [])].sort((a, b) => Number(Boolean(b.is_default)) - Number(Boolean(a.is_default)));
  const mockupUrls = [...new Set(images.map((i) => i.src).filter((u) => /^https:\/\//i.test(u)))];
  return {
    id: p.id,
    title: p.title ?? '',
    mockupUrls,
    external: mapExternal(p.external),
    isLocked: Boolean(p.is_locked),
  };
}

/* ------------------------- variant/print-area helpers ------------------------ */

const PREFERRED_COLORS = [
  'black',
  'white',
  'navy',
  'dark grey heather',
  'athletic heather',
  'heather navy',
  'sport grey',
  'natural',
  'asphalt',
  'maroon',
  'forest',
  'red',
  'royal',
  'sand',
];

function colorRank(v: z.infer<typeof CatalogVariantSchema>): number {
  const color = String((v.options as Record<string, unknown> | null | undefined)?.color ?? '').toLowerCase();
  const i = PREFERRED_COLORS.indexOf(color);
  return i === -1 ? PREFERRED_COLORS.length : i;
}

/**
 * Picks the main placeholder ('front' when present) and the most common size for it, then keeps the variants
 * sharing that size (one print file fits all), preferring common colours, capped at MAX_CATALOG_VARIANTS.
 */
export function selectPrintArea(variants: z.infer<typeof CatalogVariantSchema>[]): {
  printArea: PrintifyCatalogEntry['printArea'];
  variants: z.infer<typeof CatalogVariantSchema>[];
} {
  const counts = new Map<string, { position: string; widthPx: number; heightPx: number; n: number }>();
  for (const v of variants) {
    const phs = v.placeholders ?? [];
    const ph = phs.find((p) => p.position === 'front') ?? phs[0];
    if (!ph) continue;
    const key = `${ph.position}:${ph.width}x${ph.height}`;
    const c = counts.get(key) ?? { position: ph.position, widthPx: ph.width, heightPx: ph.height, n: 0 };
    c.n++;
    counts.set(key, c);
  }
  const best = [...counts.values()].sort(
    (a, b) => Number(b.position === 'front') - Number(a.position === 'front') || b.n - a.n || b.widthPx * b.heightPx - a.widthPx * a.heightPx,
  )[0];
  if (!best) throw new Error('printify: blueprint variants have no placeholders');
  const matching = variants
    .filter((v) => (v.placeholders ?? []).some((p) => p.position === best.position && p.width === best.widthPx && p.height === best.heightPx))
    .map((v, i) => ({ v, i }))
    .sort((a, b) => colorRank(a.v) - colorRank(b.v) || a.i - b.i)
    .slice(0, MAX_CATALOG_VARIANTS)
    .map((x) => x.v);
  return { printArea: { position: best.position, widthPx: best.widthPx, heightPx: best.heightPx }, variants: matching };
}

const DISCOVERY: Record<ProductType, { title: RegExp; prefer: RegExp }> = {
  tshirt: { title: /unisex (jersey short sleeve tee|heavy cotton tee|softstyle t-shirt)/i, prefer: /jersey short sleeve tee/i },
  mug: { title: /(ceramic mug|mug)[^a-z]*(11\s?oz|\(11oz\))|11\s?oz[^a-z]*mug/i, prefer: /ceramic/i },
  poster: { title: /matte (vertical )?posters?|posters? \(matte\)/i, prefer: /matte vertical/i },
};

/* --------------------------------- client ---------------------------------- */

export interface LivePrintifyOptions {
  token: string;
  shopId: string;
  fetch?: FetchLike;
  logger?: Logger;
  clock?: Clock;
  catalog?: PrintifyCatalogResolver;
  /** Look up blueprint/provider ids in the live catalog when the resolver returns null (default true). */
  autoDiscover?: boolean;
  /** Allow the create+delete cost probe when no shop product reveals variant costs (default true). */
  costProbe?: boolean;
  onExternalWrite?: ExternalWriteHook;
  /** Shipping destination for first-item cost (default SHOP.market). */
  shipCountry?: string;
  baseUrl?: string;
  baseUrlV2?: string;
  catalogTtlMs?: number;
}

export class LivePrintifyClient implements PrintifyClient {
  private readonly http: HttpClient;
  private readonly catalogBucket: TokenBucket;
  private readonly publishBucket: TokenBucket;
  private readonly shopId: string;
  private readonly logger: Logger;
  private readonly resolver: PrintifyCatalogResolver;
  private readonly baseV2: string;
  private readonly cache = new Map<ProductType, { entry: PrintifyCatalogEntry; at: number }>();
  private readonly discovered = new Map<ProductType, PrintifyCatalogIds>();
  private probeImageId: Promise<string> | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: LivePrintifyOptions) {
    if (!opts.token) throw new Error('printify: PRINTIFY_API_TOKEN required');
    if (!/^\d+$/.test(opts.shopId)) throw new Error('printify: PRINTIFY_SHOP_ID must be numeric');
    const token = opts.token;
    this.shopId = opts.shopId;
    this.logger = opts.logger ?? noopLogger;
    this.resolver = opts.catalog ?? shopCatalogResolver;
    this.baseV2 = (opts.baseUrlV2 ?? PRINTIFY_API_BASE_V2).replace(/\/+$/, '');
    this.now = () => (opts.clock ?? { now: () => Date.now() }).now();
    this.catalogBucket = createServiceBucket('printifyCatalog', opts.clock);
    this.publishBucket = createServiceBucket('printifyPublish', opts.clock);
    this.http = new HttpClient({
      service: 'printify',
      baseUrl: opts.baseUrl ?? PRINTIFY_API_BASE,
      fetch: opts.fetch,
      clock: opts.clock,
      bucket: createServiceBucket('printify', opts.clock),
      maxResponseBytes: 32 * 1024 * 1024,
      defaultHeaders: () => ({ authorization: `Bearer ${token}`, 'user-agent': PRINTIFY_USER_AGENT }),
      logger: opts.logger,
    });
  }

  private json<T>(req: HttpRequest): Promise<T> {
    return this.http.json<T>(req);
  }

  private catalogJson<T>(req: HttpRequest): Promise<T> {
    return this.http.json<T>({ ...req, bucket: this.catalogBucket });
  }

  private async emit(e: Omit<ExternalWriteEvent, 'service'>): Promise<void> {
    if (!this.opts.onExternalWrite) return;
    try {
      await this.opts.onExternalWrite({ service: 'printify', ...e });
    } catch (err) {
      this.logger.error({ err: (err as Error).message, action: e.action }, 'printify: onExternalWrite hook failed');
    }
  }

  /* ------------------------------ catalog admin ----------------------------- */

  async listShops(): Promise<{ id: number; title: string; salesChannel: string | null }[]> {
    const res = await this.json<unknown>({ url: '/shops.json', operation: 'list shops' });
    const shops = parseShape(
      z.array(z.object({ id: z.number(), title: z.string(), sales_channel: z.string().nullish() })),
      res,
      'list shops',
    );
    return shops.map((s) => ({ id: s.id, title: s.title, salesChannel: s.sales_channel ?? null }));
  }

  async listBlueprints(): Promise<{ id: number; title: string; brand: string | null; model: string | null }[]> {
    const res = await this.catalogJson<unknown>({ url: '/catalog/blueprints.json', operation: 'list blueprints' });
    const rows = parseShape(
      z.array(z.object({ id: z.number(), title: z.string(), brand: z.string().nullish(), model: z.string().nullish() })),
      res,
      'list blueprints',
    );
    return rows.map((r) => ({ id: r.id, title: r.title, brand: r.brand ?? null, model: r.model ?? null }));
  }

  async listPrintProviders(blueprintId: number): Promise<{ id: number; title: string }[]> {
    const res = await this.catalogJson<unknown>({
      url: `/catalog/blueprints/${int(blueprintId)}/print_providers.json`,
      operation: 'list print providers',
    });
    return parseShape(z.array(z.object({ id: z.number(), title: z.string() })), res, 'list print providers');
  }

  async getPrintProviderCountry(printProviderId: number): Promise<string | null> {
    const res = await this.catalogJson<unknown>({
      url: `/catalog/print_providers/${int(printProviderId)}.json`,
      operation: 'get print provider',
    });
    const p = parseShape(
      z.object({ id: z.number(), location: z.object({ country: z.string().nullish() }).nullish() }),
      res,
      'get print provider',
    );
    return p.location?.country ?? null;
  }

  async listVariants(blueprintId: number, printProviderId: number): Promise<z.infer<typeof CatalogVariantSchema>[]> {
    const res = await this.catalogJson<unknown>({
      url: `/catalog/blueprints/${int(blueprintId)}/print_providers/${int(printProviderId)}/variants.json`,
      operation: 'list variants',
    });
    return parseShape(CatalogVariantsSchema, res, 'list variants').variants;
  }

  /** First-item shipping (USD) to `country` for the given variants: max across variants (conservative). */
  async getShippingFirstItemUsd(
    blueprintId: number,
    printProviderId: number,
    variantIds: number[],
    country: string,
  ): Promise<number> {
    const wanted = new Set(variantIds);
    try {
      const v2 = await this.catalogJson<unknown>({
        url: `${this.baseV2}/catalog/blueprints/${int(blueprintId)}/print_providers/${int(printProviderId)}/shipping/standard.json`,
        operation: 'shipping standard (v2)',
      });
      const parsed = z
        .object({
          data: z.array(
            z.object({
              attributes: z.object({
                variantId: z.number(),
                country: z.object({ code: z.string() }),
                shippingCost: z.object({ firstItem: z.object({ amount: z.number(), currency: z.string() }) }),
              }),
            }),
          ),
        })
        .safeParse(v2);
      if (parsed.success) {
        const costs = parsed.data.data
          .map((d) => d.attributes)
          .filter((a) => a.country.code === country && (wanted.size === 0 || wanted.has(a.variantId)) && a.shippingCost.firstItem.currency === 'USD')
          .map((a) => a.shippingCost.firstItem.amount);
        if (costs.length > 0) return roundCents(Math.max(...costs) / 100);
      }
    } catch (e) {
      this.logger.debug({ err: (e as Error).message }, 'printify: v2 shipping unavailable, falling back to v1');
    }
    const v1 = await this.catalogJson<unknown>({
      url: `/catalog/blueprints/${int(blueprintId)}/print_providers/${int(printProviderId)}/shipping.json`,
      operation: 'shipping (v1)',
    });
    const parsed = parseShape(
      z.object({
        profiles: z.array(
          z.object({
            variant_ids: z.array(z.number()),
            first_item: z.object({ cost: z.number(), currency: z.string() }),
            countries: z.array(z.string()),
          }),
        ),
      }),
      v1,
      'shipping (v1)',
    );
    const matching = (code: string) =>
      parsed.profiles.filter((p) => p.countries.includes(code) && p.first_item.currency === 'USD' && (wanted.size === 0 || p.variant_ids.some((id) => wanted.has(id))));
    const profiles = matching(country).length > 0 ? matching(country) : matching('REST_OF_THE_WORLD');
    if (profiles.length === 0) throw new Error(`printify: no USD shipping profile for ${country}`);
    return roundCents(Math.max(...profiles.map((p) => p.first_item.cost)) / 100);
  }

  /** Finds a blueprint (title match) and a print provider (prefers one located in the target market). */
  async discoverCatalogIds(productType: ProductType): Promise<PrintifyCatalogIds> {
    const rule = DISCOVERY[productType];
    const blueprints = (await this.listBlueprints()).filter((b) => rule.title.test(b.title));
    blueprints.sort((a, b) => Number(rule.prefer.test(b.title)) - Number(rule.prefer.test(a.title)) || a.id - b.id);
    const blueprint = blueprints[0];
    if (!blueprint) throw new Error(`printify: no blueprint matches ${productType}; run setup-catalog`);
    const providers = await this.listPrintProviders(blueprint.id);
    if (providers.length === 0) throw new Error(`printify: blueprint ${blueprint.id} has no print providers`);
    const market = this.opts.shipCountry ?? SHOP.market;
    let chosen = providers[0]!;
    for (const p of providers.slice(0, 8)) {
      if ((await this.getPrintProviderCountry(p.id).catch(() => null)) === market) {
        chosen = p;
        break;
      }
    }
    const ids = { blueprintId: blueprint.id, printProviderId: chosen.id };
    this.logger.info(
      { productType, ...ids, blueprint: blueprint.title, provider: chosen.title },
      'printify: auto-discovered catalog ids (pin them with setup-catalog)',
    );
    return ids;
  }

  private async resolveIds(productType: ProductType): Promise<PrintifyCatalogIds> {
    const pinned = await this.resolver(productType);
    if (pinned) return pinned;
    const known = this.discovered.get(productType);
    if (known) return known;
    if (this.opts.autoDiscover === false)
      throw new Error(`printify: catalog ids for ${productType} not configured; run setup-catalog`);
    const found = await this.discoverCatalogIds(productType);
    this.discovered.set(productType, found);
    return found;
  }

  /** Variant costs (USD) from an existing shop product with the same blueprint/provider. */
  async findVariantCostsInShop(blueprintId: number, printProviderId: number): Promise<Map<number, number> | null> {
    for (let page = 1; page <= 3; page++) {
      const res = await this.json<unknown>({
        url: `/shops/${this.shopId}/products.json`,
        query: { limit: 50, page },
        operation: 'list products',
      });
      const parsed = parseShape(ProductPageSchema, res, 'list products');
      for (const p of parsed.data) {
        if (p.blueprint_id !== blueprintId || p.print_provider_id !== printProviderId) continue;
        const costs = new Map<number, number>();
        for (const v of p.variants ?? []) if (typeof v.cost === 'number' && v.cost > 0) costs.set(v.id, roundCents(v.cost / 100));
        if (costs.size > 0) return costs;
      }
      if (!parsed.last_page || page >= parsed.last_page) break;
    }
    return null;
  }

  private getProbeImageId(): Promise<string> {
    if (!this.probeImageId) {
      this.probeImageId = (async () => {
        const png = await sharp({
          create: { width: 1200, height: 1200, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 1 } },
        })
          .png()
          .toBuffer();
        const { id } = await this.uploadImage({ fileName: 'cost-probe.png', contentsBase64: toBase64(png) });
        return id;
      })();
      this.probeImageId.catch(() => {
        this.probeImageId = null;
      });
    }
    return this.probeImageId;
  }

  /** Creates a throwaway product to read variant costs, then deletes it. */
  async probeVariantCosts(
    blueprintId: number,
    printProviderId: number,
    variantIds: number[],
    position: string,
  ): Promise<Map<number, number>> {
    const imageId = await this.getProbeImageId();
    const created = await this.json<unknown>({
      method: 'POST',
      url: `/shops/${this.shopId}/products.json`,
      json: {
        title: 'etsy-agents cost probe (auto-deleted)',
        description: 'Temporary product used to read variant costs. Deleted immediately.',
        blueprint_id: blueprintId,
        print_provider_id: printProviderId,
        variants: variantIds.map((id) => ({ id, price: 9999, is_enabled: true })),
        print_areas: [
          { variant_ids: variantIds, placeholders: [{ position, images: [{ id: imageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }] },
        ],
      },
      operation: 'create cost probe',
      retry: 'rate_limit_only',
    });
    const product = parseShape(ProductSchema, created, 'create cost probe');
    await this.emit({
      action: 'printify.cost_probe.create',
      entity: 'printify_product',
      entityId: product.id,
      details: { blueprintId, printProviderId, variants: variantIds.length },
    });
    try {
      let variants = product.variants ?? [];
      if (!variants.some((v) => typeof v.cost === 'number')) {
        const again = parseShape(
          ProductSchema,
          await this.json<unknown>({ url: `/shops/${this.shopId}/products/${product.id}.json`, operation: 'get cost probe' }),
          'get cost probe',
        );
        variants = again.variants ?? [];
      }
      const costs = new Map<number, number>();
      for (const v of variants) if (typeof v.cost === 'number' && v.cost > 0) costs.set(v.id, roundCents(v.cost / 100));
      return costs;
    } finally {
      await this.deleteProduct(product.id).catch((e: unknown) =>
        this.logger.error({ err: (e as Error).message, productId: product.id }, 'printify: could not delete cost probe'),
      );
    }
  }

  async deleteProduct(productId: string): Promise<void> {
    assertProductId(productId);
    await this.http.request({
      method: 'DELETE',
      url: `/shops/${this.shopId}/products/${productId}.json`,
      operation: 'delete product',
    });
    await this.emit({ action: 'printify.product.delete', entity: 'printify_product', entityId: productId, details: {} });
  }

  /* ------------------------------ PrintifyClient ----------------------------- */

  async getCatalogEntry(productType: ProductType): Promise<PrintifyCatalogEntry> {
    const cached = this.cache.get(productType);
    const ttl = this.opts.catalogTtlMs ?? 6 * 3600_000;
    if (cached && this.now() - cached.at < ttl) return cached.entry;

    const { blueprintId, printProviderId } = await this.resolveIds(productType);
    const all = await this.listVariants(blueprintId, printProviderId);
    const { printArea, variants } = selectPrintArea(all);
    const ids = variants.map((v) => v.id);
    const country = this.opts.shipCountry ?? SHOP.market;
    const shippingFirstItemUsd = await this.getShippingFirstItemUsd(blueprintId, printProviderId, ids, country);

    let costs = await this.findVariantCostsInShop(blueprintId, printProviderId);
    if (!costs || !ids.some((id) => costs!.has(id))) {
      if (this.opts.costProbe === false)
        throw new Error(`printify: no variant costs known for ${productType}; enable the cost probe or create a product`);
      costs = await this.probeVariantCosts(blueprintId, printProviderId, ids, printArea.position);
    }
    const priced: PrintifyVariantCost[] = variants
      .filter((v) => costs!.has(v.id))
      .map((v) => ({ variantId: v.id, title: v.title, costUsd: costs!.get(v.id)! }));
    if (priced.length === 0) throw new Error(`printify: no priced variants for ${productType}`);

    const entry: PrintifyCatalogEntry = {
      productType,
      blueprintId,
      printProviderId,
      variants: priced,
      shippingFirstItemUsd,
      printArea,
    };
    this.cache.set(productType, { entry, at: this.now() });
    return entry;
  }

  async uploadImage(input: { fileName: string; contentsBase64: string }): Promise<{ id: string }> {
    if (!input.contentsBase64 || !/^[A-Za-z0-9+/]+=*$/.test(input.contentsBase64))
      throw new Error('printify: uploadImage needs base64 contents');
    const fileName = sanitizeFileName(input.fileName);
    const res = await this.json<unknown>({
      method: 'POST',
      url: '/uploads/images.json',
      json: { file_name: fileName, contents: input.contentsBase64 },
      operation: 'upload image',
      retry: 'rate_limit_only',
      timeoutMs: 120_000,
    });
    const parsed = parseShape(z.object({ id: z.string().min(1) }), res, 'upload image');
    await this.emit({ action: 'printify.image.upload', entity: 'printify_image', entityId: parsed.id, details: { fileName } });
    return { id: parsed.id };
  }

  async createProduct(input: PrintifyProductInput): Promise<{ id: string }> {
    if (input.variants.length === 0) throw new Error('printify: createProduct needs variants');
    for (const v of input.variants)
      if (!Number.isInteger(v.priceCents) || v.priceCents <= 0) throw new Error('printify: variant price must be positive cents');
    const variantIds = input.variants.map((v) => v.id);
    const res = await this.json<unknown>({
      method: 'POST',
      url: `/shops/${this.shopId}/products.json`,
      json: {
        title: input.title,
        description: input.description,
        tags: input.tags,
        blueprint_id: input.blueprintId,
        print_provider_id: input.printProviderId,
        variants: input.variants.map((v) => ({ id: v.id, price: v.priceCents, is_enabled: v.isEnabled })),
        print_areas: [
          {
            variant_ids: variantIds,
            placeholders: [
              { position: input.printPosition, images: [{ id: input.imageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] },
            ],
          },
        ],
      },
      operation: 'create product',
      retry: 'rate_limit_only', // never duplicate a product on a 5xx
    });
    const parsed = parseShape(z.object({ id: z.string().min(1) }), res, 'create product');
    await this.emit({
      action: 'printify.product.create',
      entity: 'printify_product',
      entityId: parsed.id,
      details: { blueprintId: input.blueprintId, printProviderId: input.printProviderId, variants: variantIds.length },
    });
    return { id: parsed.id };
  }

  async getProduct(productId: string): Promise<PrintifyProduct> {
    assertProductId(productId);
    const res = await this.json<unknown>({
      url: `/shops/${this.shopId}/products/${productId}.json`,
      operation: 'get product',
    });
    return mapPrintifyProduct(parseShape(ProductSchema, res, 'get product'));
  }

  async publishProduct(productId: string): Promise<void> {
    assertProductId(productId);
    await this.http.request({
      method: 'POST',
      url: `/shops/${this.shopId}/products/${productId}/publish.json`,
      json: {
        title: true,
        description: true,
        images: true,
        variants: true,
        tags: true,
        keyFeatures: true,
        shipping_template: true,
      },
      operation: 'publish product',
      bucket: this.publishBucket,
      retry: 'rate_limit_only',
    });
    await this.emit({ action: 'printify.product.publish', entity: 'printify_product', entityId: productId, details: {} });
  }
}

function int(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('printify: invalid id');
  return n;
}

function assertProductId(id: string): void {
  if (!/^[A-Za-z0-9]{1,64}$/.test(id)) throw new Error('printify: invalid product id');
}

export function sanitizeFileName(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100);
  return base || 'design.png';
}

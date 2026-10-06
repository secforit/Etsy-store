/**
 * Local fakes for the orchestrator, desk and worker tests. Deliberately independent of the integrations and
 * agents builders' code: each fake implements only the contract interface and records what it was asked.
 */
import sharp from 'sharp';
import type {
  AgentRegistry,
  AnalystInput,
  AnalystOutput,
  ComplianceGuardInput,
  ComplianceGuardOutput,
  DesignerInput,
  ListingWriterInput,
  ListingWriterOutput,
  NicheValidatorInput,
  NicheValidatorOutput,
  QaPublisherInput,
  QaPublisherOutput,
  TrendScoutInput,
  TrendScoutOutput,
} from '../../agents/contracts.ts';
import { SHOP } from '../../config/shop.ts';
import { createPgliteDb, migrate, type Db } from '../../db/db.ts';
import type { AgentName, ProductType } from '../../domain/types.ts';
import type {
  BlobStorage,
  EtsyClient,
  EtsyListingSummary,
  EtsyReceiptLine,
  GpuCoordinator,
  ImageGenClient,
  ImageTools,
  Integrations,
  PrintifyCatalogEntry,
  PrintifyClient,
  TrademarkClient,
  TrendSignalInput,
  TrendSource,
} from '../../integrations/types.ts';
import { LlmError, type LlmClient, type LlmUsage } from '../../llm/types.ts';
import type { Logger, OrchestratorDeps } from '../contracts.ts';

/* ---------------------------------- clock ---------------------------------- */

export class TestClock {
  private t: number;
  constructor(start = '2026-10-06T10:00:00.000Z') {
    this.t = Date.parse(start);
  }
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
  set(iso: string): void {
    this.t = Date.parse(iso);
  }
}

/* -------------------------------- utilities -------------------------------- */

export async function createTestDb(): Promise<Db> {
  const db = await createPgliteDb();
  await migrate(db);
  return db;
}

export async function makePng(width = 64, height = 64, opts: { alpha?: boolean } = {}): Promise<Uint8Array> {
  const buf = await sharp({
    create: {
      width,
      height,
      channels: opts.alpha === false ? 3 : 4,
      background: opts.alpha === false ? { r: 200, g: 120, b: 40 } : { r: 200, g: 120, b: 40, alpha: 0.9 },
    },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

export interface LogLine {
  level: 'info' | 'warn' | 'error' | 'debug';
  obj: Record<string, unknown>;
  msg?: string;
}

export class MemoryLogger implements Logger {
  readonly lines: LogLine[] = [];
  info(obj: Record<string, unknown>, msg?: string) {
    this.lines.push({ level: 'info', obj, ...(msg ? { msg } : {}) });
  }
  warn(obj: Record<string, unknown>, msg?: string) {
    this.lines.push({ level: 'warn', obj, ...(msg ? { msg } : {}) });
  }
  error(obj: Record<string, unknown>, msg?: string) {
    this.lines.push({ level: 'error', obj, ...(msg ? { msg } : {}) });
  }
  debug(obj: Record<string, unknown>, msg?: string) {
    this.lines.push({ level: 'debug', obj, ...(msg ? { msg } : {}) });
  }
}

/* ------------------------------- integrations ------------------------------ */

export class FakeStorage implements BlobStorage {
  readonly blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  private check(key: string) {
    if (!/^[a-z0-9_.-][a-z0-9/_.-]*$/.test(key) || key.includes('..')) throw new Error(`bad blob key ${key}`);
  }
  async put(key: string, bytes: Uint8Array, mimeType: string) {
    this.check(key);
    this.blobs.set(key, { bytes: new Uint8Array(bytes), mimeType });
  }
  async get(key: string) {
    this.check(key);
    return this.blobs.get(key) ?? null;
  }
  async delete(key: string) {
    this.check(key);
    this.blobs.delete(key);
  }
}

export class FakeEtsy implements EtsyClient {
  readonly listings = new Map<number, EtsyListingSummary & { shouldAutoRenew: boolean }>();
  readonly updates: { listingId: number; patch: { state?: 'active' | 'inactive'; shouldAutoRenew?: boolean } }[] = [];
  receipts: EtsyReceiptLine[] = [];
  failUpdates = false;
  private nextId = 5_000_000_001;

  createDraft(title: string): number {
    const id = this.nextId++;
    this.listings.set(id, {
      listingId: id,
      title,
      tags: [],
      price: { amount: 24.99, currency: 'EUR' },
      numFavorers: 0,
      views: 0,
      createdAt: '2026-10-06T00:00:00.000Z',
      state: 'draft',
      shouldAutoRenew: true,
    });
    return id;
  }
  async searchActiveListings() {
    return { count: 100, results: [] };
  }
  async getListing(listingId: number): Promise<EtsyListingSummary> {
    const l = this.listings.get(listingId);
    if (!l) throw new Error(`etsy fake: listing ${listingId} not found`);
    return { ...l };
  }
  async listShopListings(q: { state: 'active' | 'draft' | 'inactive' }) {
    return [...this.listings.values()].filter((l) => l.state === q.state);
  }
  async updateListing(listingId: number, patch: { state?: 'active' | 'inactive'; shouldAutoRenew?: boolean }) {
    if (this.failUpdates) throw new Error('etsy fake: 503 service unavailable');
    const l = this.listings.get(listingId);
    if (!l) throw new Error(`etsy fake: listing ${listingId} not found`);
    this.updates.push({ listingId, patch: { ...patch } });
    if (patch.state) l.state = patch.state;
    if (patch.shouldAutoRenew !== undefined) l.shouldAutoRenew = patch.shouldAutoRenew;
  }
  async getReceiptLines(q: { minCreated: number }) {
    return this.receipts.filter((r) => Date.parse(r.createdAt) / 1000 >= q.minCreated);
  }
}

export const FAKE_CATALOG: Record<ProductType, PrintifyCatalogEntry> = {
  tshirt: {
    productType: 'tshirt',
    blueprintId: 12,
    printProviderId: 29,
    variants: [
      { variantId: 1, title: 'Black / M', costUsd: 9.5 },
      { variantId: 2, title: 'Black / L', costUsd: 9.5 },
    ],
    shippingFirstItemUsd: 4.75,
    printArea: { position: 'front', widthPx: 4500, heightPx: 5400 },
  },
  mug: {
    productType: 'mug',
    blueprintId: 68,
    printProviderId: 1,
    variants: [{ variantId: 3, title: '11oz', costUsd: 4.95 }],
    shippingFirstItemUsd: 7.49,
    printArea: { position: 'front', widthPx: 2475, heightPx: 1155 },
  },
  poster: {
    productType: 'poster',
    blueprintId: 282,
    printProviderId: 2,
    variants: [{ variantId: 4, title: '12x18', costUsd: 8.42 }],
    shippingFirstItemUsd: 5.29,
    printArea: { position: 'front', widthPx: 3600, heightPx: 5400 },
  },
};

export class FakePrintify implements PrintifyClient {
  failCatalog = false;
  async getCatalogEntry(productType: ProductType) {
    if (this.failCatalog) throw new Error('printify fake: catalog unavailable');
    return structuredClone(FAKE_CATALOG[productType]);
  }
  async uploadImage() {
    return { id: 'img-1' };
  }
  async createProduct() {
    return { id: 'pf-1' };
  }
  async getProduct(id: string) {
    return { id, title: 'x', mockupUrls: [], external: null, isLocked: false };
  }
  async publishProduct() {}
}

export class NoopGpu implements GpuCoordinator {
  readonly owners: string[] = [];
  async withGpu<T>(owner: 'llm' | 'image', fn: () => Promise<T>): Promise<T> {
    this.owners.push(owner);
    return fn();
  }
}

export class FakeTrendSource implements TrendSource {
  constructor(
    readonly name: string,
    public signals: TrendSignalInput[] = [],
    public fail = false,
  ) {}
  async fetchSignals(): Promise<TrendSignalInput[]> {
    if (this.fail) throw new Error(`${this.name} down`);
    return this.signals.map((s) => ({ ...s }));
  }
}

export interface FakeIntegrations extends Integrations {
  fakes: { etsy: FakeEtsy; printify: FakePrintify; storage: FakeStorage; gpu: NoopGpu; trends: FakeTrendSource[] };
}

export function createFakeIntegrations(): FakeIntegrations {
  const etsy = new FakeEtsy();
  const printify = new FakePrintify();
  const storage = new FakeStorage();
  const gpu = new NoopGpu();
  const trends = [
    new FakeTrendSource('etsy_search', [
      { source: 'etsy_search', keyword: 'retro camping', region: 'US', score: 80, growth: 0.2 },
      { source: 'etsy_search', keyword: 'cat lover', region: 'US', score: 60, growth: null },
    ]),
    new FakeTrendSource('seasonal', [{ source: 'seasonal', keyword: 'halloween', region: 'US', score: 90, growth: 0.5 }]),
  ];
  const trademark: TrademarkClient = { search: async () => [] };
  const imageGen: ImageGenClient = {
    generate: async (req) => ({ bytes: await makePng(Math.min(req.widthPx, 64), Math.min(req.heightPx, 64)), mimeType: 'image/png', model: 'fake-image', seed: 1 }),
  };
  const imageTools: ImageTools = {
    inspect: async () => ({ format: 'png', widthPx: 64, heightPx: 64, dpi: 300, hasAlpha: true, colorSpace: 'srgb', semiTransparentShare: 0 }),
    toPrintFile: async (bytes) => bytes,
  };
  return {
    etsy,
    printify,
    trademark,
    imageGen,
    trendSources: trends,
    storage,
    imageTools,
    gpu,
    upscaler: null,
    fetchImage: async () => {
      throw new Error('fetchImage fake: no network');
    },
    fakes: { etsy, printify, storage, gpu, trends },
  };
}

/* ---------------------------------- agents --------------------------------- */

const usage = (costUsd = 0): LlmUsage => ({ model: costUsd > 0 ? 'cloud-model' : 'gemma4:12b', inputTokens: 120, outputTokens: 40, costUsd, durationMs: 12 });

export interface FakeAgentBehaviour {
  /** Cost reported per LLM call by every agent (0 = local). */
  costUsd: number;
  /** Products proposed per accepted niche. */
  productsPerNiche: number;
  nicheDecision: 'accept' | 'reject';
  /** Compliance verdict per stage. */
  compliance: (input: ComplianceGuardInput) => Pick<ComplianceGuardOutput, 'verdict' | 'reasons' | 'blocklistHits'>;
  /** QA outcome per call (call index is per product). */
  qa: (input: QaPublisherInput, call: number) => 'drafted' | 'qa_failed' | 'pending' | 'throw';
  retire: string[] | ((input: AnalystInput) => string[]);
  followUps: string[] | ((input: AnalystInput) => string[]);
  /** Throw this from a given agent. */
  throwFrom: Partial<Record<keyof AgentRegistry, () => Error>>;
}

export interface FakeAgents extends AgentRegistry {
  behaviour: FakeAgentBehaviour;
  calls: { agent: keyof AgentRegistry; input: unknown; deps: Record<string, unknown> }[];
}

export class PendingProductError extends Error {
  readonly retryable = true;
  constructor(readonly printifyProductId: string) {
    super(`publish not finished for ${printifyProductId}`);
    this.name = 'PrintifyProductPendingError';
  }
}

export function createFakeAgents(integrations: FakeIntegrations, overrides: Partial<FakeAgentBehaviour> = {}): FakeAgents {
  const behaviour: FakeAgentBehaviour = {
    costUsd: 0,
    productsPerNiche: 1,
    nicheDecision: 'accept',
    compliance: () => ({ verdict: 'pass', reasons: [], blocklistHits: [] }),
    qa: () => 'drafted',
    retire: [],
    followUps: [],
    throwFrom: {},
    ...overrides,
  };
  const calls: FakeAgents['calls'] = [];
  const qaCalls = new Map<string, number>();
  const record = (agent: keyof AgentRegistry, input: unknown, deps: unknown) => {
    calls.push({ agent, input, deps: deps as Record<string, unknown> });
    const thrower = behaviour.throwFrom[agent];
    if (thrower) throw thrower();
  };
  const u = () => [usage(behaviour.costUsd)];

  const agents: FakeAgents = {
    behaviour,
    calls,
    async trendScout(input: TrendScoutInput, deps) {
      record('trendScout', input, deps);
      const output: TrendScoutOutput = {
        niches: input.signals.slice(0, 2).map((s) => ({
          theme: `${s.keyword} fans`,
          keywords: [s.keyword, `${s.keyword} gift`],
          brief: `People who love ${s.keyword} and want an original design.`,
          season: null,
          sourceSignalIds: [s.id, 'not-a-real-id'],
        })),
      };
      return { output, llmUsage: u() };
    },
    async nicheValidator(input: NicheValidatorInput, deps) {
      record('nicheValidator', input, deps);
      const types: ProductType[] = ['tshirt', 'mug', 'poster'];
      const output: NicheValidatorOutput = {
        decision: behaviour.nicheDecision,
        score: behaviour.nicheDecision === 'accept' ? 70 : 20,
        reasoning: 'Fake validation: steady demand.',
        competition: [{ keyword: input.niche.keywords[0] ?? 'x', activeListings: 100, medianFavorites: 5 }],
        products:
          behaviour.nicheDecision === 'accept'
            ? Array.from({ length: behaviour.productsPerNiche }, (_, i) => ({
                productType: types[i % types.length]!,
                conceptTitle: `${input.niche.theme} concept ${i + 1}`,
                designPhrase: i === 0 ? 'Camp Club' : null,
                styleNotes: 'Bold retro badge.',
                targetPriceEur: 24.99,
                expectedMarginShare: 0.3,
              }))
            : [],
      };
      return { output, llmUsage: u() };
    },
    async complianceGuard(input: ComplianceGuardInput, deps) {
      record('complianceGuard', input, deps);
      const v = behaviour.compliance(input);
      const output: ComplianceGuardOutput = {
        verdict: v.verdict,
        reasons: v.reasons,
        flaggedTerms: [],
        trademarkHits: [],
        blocklistHits: v.blocklistHits,
      };
      return { output, llmUsage: u() };
    },
    async designer(input: DesignerInput, deps) {
      record('designer', input, deps);
      const key = `designs/${input.productId}/art-1.png`;
      await integrations.storage.put(key, await makePng(48, 48), 'image/png');
      return { output: { prompt: `Flat vector art for ${input.conceptTitle}`, model: 'fake-flux', seed: 7, artKey: key }, llmUsage: u() };
    },
    async listingWriter(input: ListingWriterInput, deps) {
      record('listingWriter', input, deps);
      const output: ListingWriterOutput = {
        title: `${input.conceptTitle} - Original Retro Design`,
        tags: ['Retro Camping', 'retro camping', 'camp gift', 'outdoor tee', 'gift idea'],
        description: `An original design for ${input.conceptTitle}. Printed on demand.\n\n${SHOP.listing.aiDisclosure}\n\n${SHOP.listing.productionPartnerDisclosure}`,
        priceEur: input.targetPriceEur,
      };
      return { output, llmUsage: u() };
    },
    async qaPublisher(input: QaPublisherInput, deps) {
      record('qaPublisher', input, deps);
      const n = qaCalls.get(input.productId) ?? 0;
      qaCalls.set(input.productId, n + 1);
      const outcome = behaviour.qa(input, n);
      if (outcome === 'pending') throw new PendingProductError(input.existingPrintifyProductId ?? `pf-${input.productId.slice(0, 8)}`);
      if (outcome === 'throw') throw new Error('printify fake: 502 bad gateway');
      let output: QaPublisherOutput;
      if (outcome === 'drafted') {
        const etsyListingId = integrations.fakes.etsy.createDraft(input.listing.title);
        output = {
          status: 'drafted',
          printKey: `designs/${input.productId}/print.png`,
          printifyProductId: input.existingPrintifyProductId ?? `pf-${input.productId.slice(0, 8)}`,
          etsyListingId,
          qaNotes: ['Upscaled 4x.'],
        };
      } else {
        output = { status: 'qa_failed', qaNotes: ['Too many semi-transparent pixels.'], printifyProductId: null };
      }
      return { output, llmUsage: u() };
    },
    async analyst(input: AnalystInput, deps) {
      record('analyst', input, deps);
      const retire = typeof behaviour.retire === 'function' ? behaviour.retire(input) : behaviour.retire;
      const follow = typeof behaviour.followUps === 'function' ? behaviour.followUps(input) : behaviour.followUps;
      const output: AnalystOutput = {
        retireProductIds: retire,
        followUpNicheIds: follow,
        reportMarkdown: `# Weekly report: week of ${input.weekStart}\n\nLive listings: ${input.listings.length}`,
      };
      return { output, llmUsage: input.listings.length > 0 ? u() : [] };
    },
  };
  return agents;
}

/** An LLM that must never be called directly by the orchestrator (agents get it via deps only). */
export const unusedLlm: LlmClient = {
  async generate() {
    throw new LlmError('the orchestrator must not call the LLM directly', false);
  },
};

/* ---------------------------------- bundle --------------------------------- */

export interface TestHarness {
  db: Db;
  clock: TestClock;
  logger: MemoryLogger;
  integrations: FakeIntegrations;
  agents: FakeAgents;
  deps: OrchestratorDeps;
  close(): Promise<void>;
}

export async function createHarness(opts: { agents?: Partial<FakeAgentBehaviour>; start?: string; db?: Db } = {}): Promise<TestHarness> {
  const db = opts.db ?? (await createTestDb());
  const clock = new TestClock(opts.start);
  const logger = new MemoryLogger();
  const integrations = createFakeIntegrations();
  const agents = createFakeAgents(integrations, opts.agents);
  const deps: OrchestratorDeps = {
    db,
    integrations,
    llm: unusedLlm,
    agents,
    shop: SHOP,
    now: clock.now,
    logger,
    eurToUsd: 1.1,
  };
  return { db, clock, logger, integrations, agents, deps, close: () => db.close() };
}

export type { AgentName };

/* ---------------------------------- seeds ---------------------------------- */

export async function seedNiche(db: Db, now: Date, theme = 'Retro Camping Fans', status: 'new' | 'accepted' | 'rejected' = 'accepted'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO niches (keywords, theme, brief, season, status, created_at) VALUES ($1::text[], $2, $3, NULL, $4, $5) RETURNING id`,
    [['retro camping', 'camping gift'], theme, 'People who love camping and want an original retro design.', status, now],
  );
  return String(rows[0]!.id);
}

export interface SeedProductOptions {
  state?: import('../../domain/types.ts').ProductState;
  productType?: ProductType;
  attempt?: number;
  nicheId?: string;
  withDesign?: boolean;
  editedKey?: string | null;
  withListing?: boolean;
  etsyListingId?: number | null;
  printifyProductId?: string | null;
}

/** Inserts a product (and optionally its design / listing) directly in a given state. */
export async function seedProduct(db: Db, now: Date, o: SeedProductOptions = {}): Promise<string> {
  const nicheId = o.nicheId ?? (await seedNiche(db, now));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO products (niche_id, product_type, concept_title, design_phrase, style_notes, target_price_eur, state, attempt, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 24.99, $6, $7, $8, $8) RETURNING id`,
    [nicheId, o.productType ?? 'tshirt', 'Retro Camp Badge', 'Camp Club', 'Bold retro badge.', o.state ?? 'proposed', o.attempt ?? 0, now],
  );
  const id = String(rows[0]!.id);
  if (o.withDesign) {
    const edited = o.editedKey === undefined ? `designs/${id}/edited-1.png` : o.editedKey;
    await db.query(
      `INSERT INTO designs (product_id, prompt, model, seed, art_key, edited_key, created_at, updated_at) VALUES ($1, 'prompt', 'fake', 1, $2, $3, $4, $4)`,
      [id, `designs/${id}/art-1.png`, edited, now],
    );
  }
  if (o.withListing) {
    await db.query(
      `INSERT INTO listings (product_id, title, tags, description, price_eur, printify_product_id, etsy_listing_id, created_at, updated_at)
       VALUES ($1, 'Retro Camp Badge Tee', $2::text[], 'An original design.', 24.99, $3, $4, $5, $5)`,
      [id, ['retro', 'camping'], o.printifyProductId ?? null, o.etsyListingId ?? null, now],
    );
  }
  return id;
}

export async function productState(db: Db, id: string): Promise<{ state: string; attempt: number; blockReason: string | null }> {
  const { rows } = await db.query<{ state: string; attempt: unknown; block_reason: string | null }>(
    'SELECT state, attempt, block_reason FROM products WHERE id = $1',
    [id],
  );
  const r = rows[0];
  if (!r) throw new Error(`no product ${id}`);
  return { state: r.state, attempt: Number(r.attempt), blockReason: r.block_reason };
}

export async function jobsOf(db: Db, where: { productId?: string; kind?: string } = {}) {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT kind, status, attempts, idempotency_key, run_after, last_error, product_id, niche_id FROM jobs
     WHERE ($1::uuid IS NULL OR product_id = $1) AND ($2::text IS NULL OR kind = $2) ORDER BY created_at, idempotency_key`,
    [where.productId ?? null, where.kind ?? null],
  );
  return rows;
}

export async function auditActions(db: Db, entityId?: string): Promise<string[]> {
  const { rows } = await db.query<{ action: string }>(
    'SELECT action FROM audit_log WHERE ($1::text IS NULL OR entity_id = $1) ORDER BY created_at, id',
    [entityId ?? null],
  );
  return rows.map((r) => r.action);
}

/** Empties every application table and restores default settings (one PGlite per test file is much faster). */
export async function resetDb(db: Db): Promise<void> {
  await db.exec(`
    TRUNCATE product_events, avoid_rules, printify_catalog, agent_runs, jobs, approvals, metrics_daily,
      weekly_reports, audit_log, compliance_checks, designs, listings, products, niches, trend_signals CASCADE;
    UPDATE settings SET paused = false, daily_draft_cap = 5, daily_spend_cap_usd = 10, blocklist = '{}', updated_at = now() WHERE id = 1;
  `);
}

let sharedDb: Promise<Db> | null = null;
/** One migrated PGlite per test file (vitest isolates files), reset before each test. */
export async function sharedTestDb(): Promise<Db> {
  sharedDb ??= createTestDb();
  const db = await sharedDb;
  await resetDb(db);
  return db;
}

/**
 * One handler per job kind. Pattern for every product step:
 *   load inputs -> call the agent -> validate its output (zod, contract schema) -> persist + transition() + mark
 *   the job done in ONE transaction -> enqueue the next step via stepForState().
 * Agent runs (every LLM call, local ones with cost 0) are recorded BEFORE the persist transaction, so they are
 * kept even when persisting fails. The model never acts: all writes (DB, Etsy) are done here, by code.
 */
import type { z } from 'zod';
import {
  AnalystOutputSchema,
  ComplianceGuardOutputSchema,
  DesignerOutputSchema,
  ListingWriterOutputSchema,
  NicheValidatorOutputSchema,
  QaPublisherOutputSchema,
  TrendScoutOutputSchema,
  type AgentResult,
  type ComplianceGuardOutput,
} from '../agents/contracts.ts';
import type { Queryable } from '../db/db.ts';
import {
  PRODUCT_TYPES,
  type AgentName,
  type Design,
  type Job,
  type JobKind,
  type Listing,
  type Niche,
  type Product,
  type ProductState,
} from '../domain/types.ts';
import type { TrendSignalInput } from '../integrations/types.ts';
import { LlmError, type LlmUsage } from '../llm/types.ts';
import { auditExternalWrite } from './audit.ts';
import { latestAvoidRules } from './avoidRules.ts';
import type { Logger, OrchestratorDeps } from './contracts.ts';
import { errorMessage } from './logger.ts';
import { enqueue, enqueueNextStep, markDone } from './queue.ts';
import {
  StaleStateError,
  countDraftsSince,
  getDesign,
  getListing,
  getNiche,
  getProduct,
  getReport,
  getSettings,
  insertAgentRun,
  insertAudit,
  isUuid,
  roundCents,
  spendSince,
  toIso,
  toNum,
  transitionProduct,
  upsertReport,
} from './repo.ts';
import { DAY_MS, addMs, daysBetween, isoDate, startOfUtcDay, startOfUtcWeek } from './time.ts';

/* ---------------------------------- types ---------------------------------- */

export interface StepOptions {
  /** QA & Publisher polling knobs (tests pass a no-op sleep). */
  qaPublish?: { sleep?: (ms: number) => Promise<void>; pollAttempts?: number; pollIntervalMs?: number };
  /** The analyst (LLM report, retirements, follow-ups) runs at most this often; metrics are pulled every analyze. */
  reportIntervalMs: number;
  /** Max trend signals kept per scan. */
  maxSignalsPerScan: number;
}

export const DEFAULT_STEP_OPTIONS: StepOptions = {
  reportIntervalMs: 24 * 3600_000,
  maxSignalsPerScan: 300,
};

export interface StepResult {
  status: 'done' | 'skipped';
  note?: string;
}

export interface StepContext {
  deps: OrchestratorDeps;
  job: Job;
  today: string;
  options: StepOptions;
  /** Calls an agent, records agent_runs for every LLM call, validates the output against the contract schema. */
  runAgent<T>(agent: AgentName, schema: z.ZodType<T>, fn: () => Promise<AgentResult<T>>): Promise<T>;
  /** Runs `fn` in one transaction that also marks the job done. */
  commit<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  readonly committed: boolean;
}

export type StepHandler = (ctx: StepContext) => Promise<StepResult>;

/** The agent returned something that does not satisfy its contract schema: a bug, retrying will not help. */
export class AgentOutputError extends Error {
  constructor(
    public readonly agent: AgentName,
    message: string,
  ) {
    super(`${agent} returned invalid output: ${message}`);
    this.name = 'AgentOutputError';
  }
}

/** A job references data that does not exist (deleted product, missing design): retrying will not help. */
export class MissingDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingDataError';
  }
}

/* --------------------------------- context --------------------------------- */

function usageFromError(err: unknown): LlmUsage | null {
  const u = (err as { usage?: unknown } | null)?.usage as Partial<LlmUsage> | undefined;
  if (!u || typeof u !== 'object' || typeof u.model !== 'string') return null;
  return {
    model: u.model,
    inputTokens: Number(u.inputTokens) || 0,
    outputTokens: Number(u.outputTokens) || 0,
    costUsd: Number(u.costUsd) || 0,
    durationMs: Number(u.durationMs) || 0,
  };
}

export function createStepContext(deps: OrchestratorDeps, job: Job, options: StepOptions): StepContext {
  let committed = false;
  const ctx: StepContext = {
    deps,
    job,
    today: isoDate(deps.now()),
    options,
    get committed() {
      return committed;
    },
    async runAgent<T>(agent: AgentName, schema: z.ZodType<T>, fn: () => Promise<AgentResult<T>>): Promise<T> {
      let result: AgentResult<T>;
      try {
        result = await fn();
      } catch (err) {
        const usage = usageFromError(err);
        if (usage) {
          await insertAgentRun(deps.db, { jobId: job.id, agent, usage, ok: false, error: errorMessage(err, 1000) }, deps.now());
        }
        throw err;
      }
      const parsed = schema.safeParse(result.output);
      const usages = Array.isArray(result.llmUsage) ? result.llmUsage : [];
      const err = parsed.success ? null : errorMessage(parsed.error, 1000);
      for (let i = 0; i < usages.length; i++) {
        const last = i === usages.length - 1;
        await insertAgentRun(
          deps.db,
          {
            jobId: job.id,
            agent,
            usage: usages[i]!,
            ok: parsed.success,
            error: err,
            ...(last && parsed.success ? { output: parsed.data } : {}),
          },
          deps.now(),
        );
      }
      if (!parsed.success) throw new AgentOutputError(agent, err ?? 'schema mismatch');
      return parsed.data;
    },
    async commit<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const out = await deps.db.tx(async (q) => {
        const r = await fn(q);
        await markDone(q, job.id, deps.now());
        return r;
      });
      committed = true;
      return out;
    },
  };
  return ctx;
}

/* --------------------------------- helpers --------------------------------- */

function baseDeps(ctx: StepContext) {
  return { llm: ctx.deps.llm, shop: ctx.deps.shop, today: ctx.today };
}

interface LoadedProduct {
  product: Product;
  niche: Niche;
}

/** Loads the job's product + niche; null (skip) when the product already left `expected`. */
async function loadProduct(ctx: StepContext, expected: ProductState): Promise<LoadedProduct | null> {
  const id = ctx.job.productId;
  if (!id) throw new MissingDataError(`${ctx.job.kind} job ${ctx.job.id} has no product`);
  const product = await getProduct(ctx.deps.db, id);
  if (!product) throw new MissingDataError(`product ${id} not found`);
  if (product.state !== expected) return null;
  const niche = await getNiche(ctx.deps.db, product.nicheId);
  if (!niche) throw new MissingDataError(`niche ${product.nicheId} not found`);
  return { product, niche };
}

function skipped(ctx: StepContext, expected: ProductState): StepResult {
  return { status: 'skipped', note: `product is no longer ${expected}; nothing to do` };
}

async function requireDesign(ctx: StepContext, productId: string, needEdited: boolean): Promise<Design> {
  const design = await getDesign(ctx.deps.db, productId);
  if (!design) throw new MissingDataError(`design for product ${productId} not found`);
  if (needEdited && !design.editedKey) throw new MissingDataError(`product ${productId} has no edited design`);
  return design;
}

async function requireListing(ctx: StepContext, productId: string): Promise<Listing> {
  const listing = await getListing(ctx.deps.db, productId);
  if (!listing) throw new MissingDataError(`listing for product ${productId} not found`);
  return listing;
}

/** Art keys must stay inside the product's folder: designs/<productId>/<name>.png */
export function assertDesignKey(key: string, productId: string): void {
  const prefix = `designs/${productId.toLowerCase()}/`;
  if (!key.startsWith(prefix) || !/^[a-z0-9._-]+\.png$/.test(key.slice(prefix.length)) || key.includes('..')) {
    throw new AgentOutputError('designer', `art key outside designs/<productId>/: ${key.slice(0, 120)}`);
  }
}

/** Code-side guarantee that both disclosure lines are present (the Listing Writer appends them; this is a backstop). */
export function ensureDisclosures(description: string, shop: OrchestratorDeps['shop']): string {
  let out = description.trim();
  for (const line of [shop.listing.aiDisclosure, shop.listing.productionPartnerDisclosure]) {
    if (!out.includes(line)) out = `${out}\n\n${line}`;
  }
  return out;
}

function normaliseTags(tags: string[], shop: OrchestratorDeps['shop']): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const tag = t.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!tag || tag.length > shop.listing.tagMaxChars || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= shop.listing.maxTags) break;
  }
  return out;
}

/** Compliance verdict after code rules: any blocklist hit forces a block regardless of the model. */
function finalVerdict(out: ComplianceGuardOutput): { pass: boolean; reasons: string[] } {
  const reasons = [...out.reasons];
  if (out.verdict === 'pass' && out.blocklistHits.length > 0) {
    reasons.push(`Blocked by code: blocklist term(s) ${out.blocklistHits.join(', ')}.`);
    return { pass: false, reasons };
  }
  return { pass: out.verdict === 'pass', reasons };
}

async function insertComplianceCheck(
  q: Queryable,
  productId: string,
  stage: 'concept' | 'final',
  out: ComplianceGuardOutput,
  verdict: { pass: boolean; reasons: string[] },
  now: Date,
): Promise<void> {
  await q.query(
    `INSERT INTO compliance_checks (product_id, stage, verdict, reasons, flagged_terms, trademark_hits, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::text[], $6::jsonb, $7)`,
    [
      productId,
      stage,
      verdict.pass ? 'pass' : 'block',
      JSON.stringify(verdict.reasons),
      out.flaggedTerms,
      JSON.stringify(out.trademarkHits),
      now,
    ],
  );
}

function blockReason(prefix: string, reasons: string[]): string {
  const text = `${prefix}: ${reasons.join(' ') || 'no reason given'}`;
  return text.length > 1000 ? `${text.slice(0, 999)}…` : text;
}

/* ------------------------------- trend_scan -------------------------------- */

function cleanSignal(s: TrendSignalInput): TrendSignalInput | null {
  if (!s || typeof s.keyword !== 'string' || typeof s.source !== 'string') return null;
  const keyword = s.keyword.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (keyword.length < 2) return null;
  const score = Number.isFinite(s.score) ? Math.min(100, Math.max(0, s.score)) : 0;
  const growth = s.growth === null || !Number.isFinite(s.growth) ? null : Math.min(9999, Math.max(-9999, s.growth));
  return {
    source: s.source.slice(0, 60),
    keyword,
    region: typeof s.region === 'string' && s.region ? s.region.slice(0, 10) : 'US',
    score: Math.round(score * 100) / 100,
    growth: growth === null ? null : Math.round(growth * 10_000) / 10_000,
  };
}

const trendScan: StepHandler = async (ctx) => {
  const { db, integrations, shop, logger, agents } = ctx.deps;
  const settings = await getSettings(db);
  const raw: TrendSignalInput[] = [];
  for (const source of integrations.trendSources) {
    try {
      raw.push(...(await source.fetchSignals({ market: shop.market, today: ctx.today })));
    } catch (err) {
      logger.warn({ source: source.name, err: errorMessage(err) }, 'trend source failed; continuing without it');
    }
  }
  const seen = new Set<string>();
  const signals: TrendSignalInput[] = [];
  for (const s of raw) {
    const c = cleanSignal(s);
    if (!c) continue;
    const key = `${c.source}|${c.keyword.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    signals.push(c);
    if (signals.length >= ctx.options.maxSignalsPerScan) break;
  }

  const fetchedAt = ctx.deps.now();
  const stored = await db.tx(async (q) => {
    const out: (TrendSignalInput & { id: string })[] = [];
    for (const s of signals) {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO trend_signals (source, keyword, region, score, growth, fetched_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [s.source, s.keyword, s.region, s.score, s.growth, fetchedAt],
      );
      out.push({ ...s, id: String(rows[0]!.id) });
    }
    return out;
  });

  const since = isoDate(addMs(fetchedAt, -30 * DAY_MS));
  const winners = await db.query<{ theme: string; keywords: unknown }>(
    `SELECT n.theme, n.keywords, max(m.date) AS last_sale
     FROM metrics_daily m
     JOIN listings l ON l.etsy_listing_id = m.etsy_listing_id
     JOIN products p ON p.id = l.product_id
     JOIN niches n ON n.id = p.niche_id
     WHERE m.orders > 0 AND m.date >= $1::date
     GROUP BY n.id, n.theme, n.keywords
     ORDER BY last_sale DESC LIMIT 10`,
    [since],
  );
  const existing = await db.query<{ theme: string }>('SELECT theme FROM niches ORDER BY created_at DESC LIMIT 200');
  const existingThemes = existing.rows.map((r) => r.theme);
  const productTypes = PRODUCT_TYPES.filter((t) => shop.products[t].enabled);

  const out = await ctx.runAgent('trend_scout', TrendScoutOutputSchema, () =>
    agents.trendScout(
      {
        signals: stored,
        productTypes,
        recentWinners: winners.rows.map((r) => ({ theme: r.theme, keywords: Array.isArray(r.keywords) ? r.keywords.map(String) : [] })),
        existingThemes,
        blocklist: settings.blocklist,
      },
      baseDeps(ctx),
    ),
  );

  const storedIds = new Set(stored.map((s) => s.id));
  const known = new Set(existingThemes.map((t) => t.trim().toLowerCase()));
  const created = await ctx.commit(async (q) => {
    const ids: string[] = [];
    const now = ctx.deps.now();
    for (const n of out.niches.slice(0, shop.caps.maxNichesPerScan)) {
      const themeKey = n.theme.trim().toLowerCase();
      if (known.has(themeKey)) continue;
      known.add(themeKey);
      const sourceIds = n.sourceSignalIds.filter((id) => isUuid(id) && storedIds.has(id));
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO niches (keywords, theme, brief, season, status, source_signal_ids, created_at)
         VALUES ($1::text[], $2, $3, $4, 'new', $5::uuid[], $6) RETURNING id`,
        [n.keywords, n.theme.trim(), n.brief, n.season, sourceIds, now],
      );
      const nicheId = String(rows[0]!.id);
      await enqueue(q, { kind: 'validate_niche', nicheId, idempotencyKey: `validate_niche:${nicheId}` }, now);
      ids.push(nicheId);
    }
    return ids;
  });
  return { status: 'done', note: `${stored.length} signals, ${created.length} new niches` };
};

/* ------------------------------ validate_niche ----------------------------- */

const validateNiche: StepHandler = async (ctx) => {
  const { db, integrations, shop, agents, eurToUsd } = ctx.deps;
  const nicheId = ctx.job.nicheId;
  if (!nicheId) throw new MissingDataError(`validate_niche job ${ctx.job.id} has no niche`);
  const niche = await getNiche(db, nicheId);
  if (!niche) throw new MissingDataError(`niche ${nicheId} not found`);
  const followUp = ctx.job.idempotencyKey.includes(':followup:');
  if (niche.status === 'rejected' || (!followUp && niche.status !== 'new')) {
    return { status: 'skipped', note: `niche is ${niche.status}` };
  }

  const nvDeps = { ...baseDeps(ctx), etsy: integrations.etsy, printify: integrations.printify, eurToUsd };
  const out = await ctx.runAgent('niche_validator', NicheValidatorOutputSchema, () =>
    agents.nicheValidator({ niche: { id: niche.id, theme: niche.theme, keywords: niche.keywords, brief: niche.brief } }, nvDeps),
  );

  const accepted = out.decision === 'accept';
  const created = await ctx.commit(async (q) => {
    const now = ctx.deps.now();
    const status = followUp ? niche.status : accepted ? 'accepted' : 'rejected';
    await q.query('UPDATE niches SET status = $1, score = $2, reasoning = $3 WHERE id = $4', [
      status,
      Math.round(out.score),
      out.reasoning,
      niche.id,
    ]);
    if (!accepted) return 0;
    const existing = await q.query<{ concept_title: string }>('SELECT concept_title FROM products WHERE niche_id = $1', [niche.id]);
    const titles = new Set(existing.rows.map((r) => r.concept_title.trim().toLowerCase()));
    let n = 0;
    for (const p of out.products.slice(0, shop.caps.maxProductsPerNiche)) {
      if (!shop.products[p.productType].enabled) continue;
      const key = p.conceptTitle.trim().toLowerCase();
      if (titles.has(key)) continue;
      titles.add(key);
      const { rows } = await q.query<Record<string, unknown>>(
        `INSERT INTO products (niche_id, product_type, concept_title, design_phrase, style_notes, target_price_eur, state, attempt, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'proposed', 0, $7, $7) RETURNING id`,
        [niche.id, p.productType, p.conceptTitle.trim(), p.designPhrase, p.styleNotes, roundCents(p.targetPriceEur), now],
      );
      const productId = String(rows[0]!.id);
      await enqueueNextStep(q, { id: productId, state: 'proposed', attempt: 0 }, now);
      n++;
    }
    return n;
  });
  return { status: 'done', note: `${out.decision} (score ${out.score}), ${created} products` };
};

/* ------------------------------ concept_check ------------------------------ */

const conceptCheck: StepHandler = async (ctx) => {
  const loaded = await loadProduct(ctx, 'proposed');
  if (!loaded) return skipped(ctx, 'proposed');
  const { product, niche } = loaded;
  const { db, integrations, agents } = ctx.deps;
  const settings = await getSettings(db);
  const cgDeps = { ...baseDeps(ctx), trademark: integrations.trademark, storage: integrations.storage, blocklist: settings.blocklist };
  const out = await ctx.runAgent('compliance_guard', ComplianceGuardOutputSchema, () =>
    agents.complianceGuard(
      {
        stage: 'concept',
        productType: product.productType,
        conceptTitle: product.conceptTitle,
        designPhrase: product.designPhrase,
        keywords: niche.keywords,
      },
      cgDeps,
    ),
  );
  const verdict = finalVerdict(out);
  await ctx.commit(async (q) => {
    const now = ctx.deps.now();
    await insertComplianceCheck(q, product.id, 'concept', out, verdict, now);
    if (verdict.pass) {
      const to = await transitionProduct(q, {
        productId: product.id,
        from: 'proposed',
        event: 'concept_pass',
        actor: 'compliance_guard',
        jobId: ctx.job.id,
        now,
      });
      await enqueueNextStep(q, { ...product, state: to }, now);
    } else {
      const reason = blockReason('Concept compliance', verdict.reasons);
      await transitionProduct(q, {
        productId: product.id,
        from: 'proposed',
        event: 'concept_block',
        actor: 'compliance_guard',
        jobId: ctx.job.id,
        now,
        blockReason: reason,
      });
      await insertAudit(
        q,
        { actor: 'compliance_guard', action: 'product.blocked', entity: 'product', entityId: product.id, details: { stage: 'concept', reasons: verdict.reasons } },
        now,
      );
    }
  });
  return { status: 'done', note: verdict.pass ? 'concept cleared' : 'concept blocked' };
};

/* ---------------------------------- design --------------------------------- */

const design: StepHandler = async (ctx) => {
  const loaded = await loadProduct(ctx, 'cleared');
  if (!loaded) return skipped(ctx, 'cleared');
  const { product, niche } = loaded;
  const { db, integrations, agents } = ctx.deps;
  const [settings, avoidRules, existing] = await Promise.all([getSettings(db), latestAvoidRules(db), getDesign(db, product.id)]);
  const designerDeps = {
    ...baseDeps(ctx),
    imageGen: integrations.imageGen,
    storage: integrations.storage,
    blocklist: settings.blocklist,
    printify: integrations.printify,
  };
  const out = await ctx.runAgent('designer', DesignerOutputSchema, () =>
    agents.designer(
      {
        productId: product.id,
        productType: product.productType,
        conceptTitle: product.conceptTitle,
        designPhrase: product.designPhrase,
        styleNotes: product.styleNotes,
        nicheBrief: niche.brief,
        avoidRules,
        qaNotes: existing?.qaNotes ?? [],
      },
      designerDeps,
    ),
  );
  assertDesignKey(out.artKey, product.id);
  await ctx.commit(async (q) => {
    const now = ctx.deps.now();
    await q.query(
      `INSERT INTO designs (product_id, prompt, model, seed, art_key, edited_key, print_key, qa_notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, '[]'::jsonb, $6, $6)
       ON CONFLICT (product_id) DO UPDATE SET prompt = EXCLUDED.prompt, model = EXCLUDED.model, seed = EXCLUDED.seed,
         art_key = EXCLUDED.art_key, edited_key = NULL, print_key = NULL, updated_at = EXCLUDED.updated_at`,
      [product.id, out.prompt, out.model, out.seed, out.artKey, now],
    );
    await transitionProduct(q, { productId: product.id, from: 'cleared', event: 'design_done', actor: 'designer', jobId: ctx.job.id, now });
    // `designed` waits for Razvan's edited upload (desk) - no automated next step.
  });
  return { status: 'done', note: `art at ${out.artKey}` };
};

/* ---------------------------------- write ---------------------------------- */

const write: StepHandler = async (ctx) => {
  const loaded = await loadProduct(ctx, 'edited');
  if (!loaded) return skipped(ctx, 'edited');
  const { product, niche } = loaded;
  const { db, integrations, agents, shop, eurToUsd } = ctx.deps;
  await requireDesign(ctx, product.id, true);
  const [settings, avoidRules] = await Promise.all([getSettings(db), latestAvoidRules(db)]);
  const lwDeps = {
    ...baseDeps(ctx),
    eurToUsd,
    blocklist: settings.blocklist,
    printify: integrations.printify,
    trademark: integrations.trademark,
  };
  const out = await ctx.runAgent('listing_writer', ListingWriterOutputSchema, () =>
    agents.listingWriter(
      {
        productType: product.productType,
        conceptTitle: product.conceptTitle,
        designPhrase: product.designPhrase,
        styleNotes: product.styleNotes,
        nicheKeywords: niche.keywords,
        nicheBrief: niche.brief,
        targetPriceEur: product.targetPriceEur,
        avoidRules,
      },
      lwDeps,
    ),
  );
  const title = out.title.replace(/\s+/g, ' ').trim().slice(0, shop.listing.titleMaxChars);
  const tags = normaliseTags(out.tags, shop);
  const description = ensureDisclosures(out.description, shop);
  const priceEur = roundCents(out.priceEur);
  await ctx.commit(async (q) => {
    const now = ctx.deps.now();
    await q.query(
      `INSERT INTO listings (product_id, title, tags, description, price_eur, created_at, updated_at)
       VALUES ($1, $2, $3::text[], $4, $5, $6, $6)
       ON CONFLICT (product_id) DO UPDATE SET title = EXCLUDED.title, tags = EXCLUDED.tags,
         description = EXCLUDED.description, price_eur = EXCLUDED.price_eur, updated_at = EXCLUDED.updated_at`,
      [product.id, title, tags, description, priceEur, now],
    );
    const to = await transitionProduct(q, { productId: product.id, from: 'edited', event: 'copy_written', actor: 'listing_writer', jobId: ctx.job.id, now });
    await enqueueNextStep(q, { ...product, state: to }, now);
  });
  return { status: 'done', note: `listing at EUR ${priceEur.toFixed(2)}` };
};

/* ------------------------------- final_check ------------------------------- */

const finalCheck: StepHandler = async (ctx) => {
  const loaded = await loadProduct(ctx, 'written');
  if (!loaded) return skipped(ctx, 'written');
  const { product, niche } = loaded;
  const { db, integrations, agents } = ctx.deps;
  const designRow = await requireDesign(ctx, product.id, true);
  const listing = await requireListing(ctx, product.id);
  const settings = await getSettings(db);
  const cgDeps = { ...baseDeps(ctx), trademark: integrations.trademark, storage: integrations.storage, blocklist: settings.blocklist };
  const out = await ctx.runAgent('compliance_guard', ComplianceGuardOutputSchema, () =>
    agents.complianceGuard(
      {
        stage: 'final',
        productType: product.productType,
        conceptTitle: product.conceptTitle,
        designPhrase: product.designPhrase,
        keywords: niche.keywords,
        listing: { title: listing.title, tags: listing.tags, description: listing.description },
        designKey: designRow.editedKey!,
      },
      cgDeps,
    ),
  );
  const verdict = finalVerdict(out);
  await ctx.commit(async (q) => {
    const now = ctx.deps.now();
    await insertComplianceCheck(q, product.id, 'final', out, verdict, now);
    if (verdict.pass) {
      const to = await transitionProduct(q, { productId: product.id, from: 'written', event: 'final_pass', actor: 'compliance_guard', jobId: ctx.job.id, now });
      await enqueueNextStep(q, { ...product, state: to }, now);
    } else {
      await transitionProduct(q, {
        productId: product.id,
        from: 'written',
        event: 'final_block',
        actor: 'compliance_guard',
        jobId: ctx.job.id,
        now,
        blockReason: blockReason('Final compliance', verdict.reasons),
      });
      await insertAudit(
        q,
        { actor: 'compliance_guard', action: 'product.blocked', entity: 'product', entityId: product.id, details: { stage: 'final', reasons: verdict.reasons } },
        now,
      );
    }
  });
  return { status: 'done', note: verdict.pass ? 'final cleared' : 'final blocked' };
};

/* -------------------------------- qa_publish ------------------------------- */

/** PrintifyProductPendingError (agents/qaPublisher.ts), duck-typed so this module does not depend on it. */
export function pendingPrintifyId(err: unknown): string | null {
  const e = err as { name?: unknown; printifyProductId?: unknown } | null;
  return e && e.name === 'PrintifyProductPendingError' && typeof e.printifyProductId === 'string' && e.printifyProductId
    ? e.printifyProductId
    : null;
}

const qaPublish: StepHandler = async (ctx) => {
  const loaded = await loadProduct(ctx, 'final_cleared');
  if (!loaded) return skipped(ctx, 'final_cleared');
  const { product } = loaded;
  const { db, integrations, agents, shop, eurToUsd } = ctx.deps;
  const designRow = await requireDesign(ctx, product.id, true);
  const listing = await requireListing(ctx, product.id);
  const qa = ctx.options.qaPublish ?? {};
  const qaDeps = {
    ...baseDeps(ctx),
    printify: integrations.printify,
    storage: integrations.storage,
    imageTools: integrations.imageTools,
    upscaler: integrations.upscaler,
    fetchImage: integrations.fetchImage,
    ...(qa.sleep ? { sleep: qa.sleep } : {}),
    ...(qa.pollAttempts !== undefined ? { publishPollAttempts: qa.pollAttempts } : {}),
    ...(qa.pollIntervalMs !== undefined ? { publishPollIntervalMs: qa.pollIntervalMs } : {}),
  };

  let out;
  try {
    out = await ctx.runAgent('qa_publisher', QaPublisherOutputSchema, () =>
      agents.qaPublisher(
        {
          productId: product.id,
          productType: product.productType,
          editedKey: designRow.editedKey!,
          listing: { title: listing.title, tags: listing.tags, description: listing.description, priceEur: listing.priceEur },
          existingPrintifyProductId: listing.printifyProductId,
          eurToUsd,
        },
        qaDeps,
      ),
    );
  } catch (err) {
    // A Printify product exists but publishing did not finish: remember it so the retry reuses it.
    const pid = pendingPrintifyId(err);
    if (pid && pid !== listing.printifyProductId) {
      await db.tx(async (q) => {
        const now = ctx.deps.now();
        await q.query('UPDATE listings SET printify_product_id = $1, updated_at = $2 WHERE product_id = $3', [pid, now, product.id]);
        await insertAudit(
          q,
          { actor: 'qa_publisher', action: 'printify.product.pending', entity: 'product', entityId: product.id, details: { printifyProductId: pid, error: errorMessage(err, 500) } },
          now,
        );
      });
    }
    throw err;
  }

  if (out.status === 'drafted') {
    const drafted = out;
    await ctx.commit(async (q) => {
      const now = ctx.deps.now();
      await q.query('UPDATE designs SET print_key = $1, qa_notes = $2::jsonb, updated_at = $3 WHERE product_id = $4', [
        drafted.printKey,
        JSON.stringify(drafted.qaNotes),
        now,
        product.id,
      ]);
      await q.query(
        'UPDATE listings SET printify_product_id = $1, etsy_listing_id = $2, updated_at = $3 WHERE product_id = $4',
        [drafted.printifyProductId, drafted.etsyListingId, now, product.id],
      );
      await transitionProduct(q, { productId: product.id, from: 'final_cleared', event: 'qa_pass', actor: 'qa_publisher', jobId: ctx.job.id, now });
      await auditExternalWrite(
        q,
        {
          actor: 'qa_publisher',
          service: 'printify',
          action: 'product.drafted',
          entity: 'product',
          entityId: product.id,
          details: { printifyProductId: drafted.printifyProductId, etsyListingId: drafted.etsyListingId, reused: Boolean(listing.printifyProductId) },
        },
        now,
      );
    });
    return { status: 'done', note: `Etsy draft ${drafted.etsyListingId}` };
  }

  // QA failed: back to `designed` for a new upload, or blocked once the redesigns are used up.
  const failed = out;
  const exhausted = product.attempt >= shop.caps.maxQaRedesigns;
  await ctx.commit(async (q) => {
    const now = ctx.deps.now();
    await q.query("UPDATE designs SET qa_notes = $1::jsonb, print_key = NULL, updated_at = $2 WHERE product_id = $3", [
      JSON.stringify(failed.qaNotes),
      now,
      product.id,
    ]);
    // A Printify product made from the failed file is never reused (a redesign gets a fresh one).
    await q.query('UPDATE listings SET printify_product_id = NULL, updated_at = $1 WHERE product_id = $2', [now, product.id]);
    await insertAudit(
      q,
      {
        actor: 'qa_publisher',
        action: 'product.qa_failed',
        entity: 'product',
        entityId: product.id,
        details: {
          redesignsUsed: product.attempt,
          maxRedesigns: shop.caps.maxQaRedesigns,
          qaNotes: failed.qaNotes,
          orphanPrintifyProductId: failed.printifyProductId ?? listing.printifyProductId,
        },
      },
      now,
    );
    if (exhausted) {
      await transitionProduct(q, {
        productId: product.id,
        from: 'final_cleared',
        event: 'qa_fail_final',
        actor: 'qa_publisher',
        jobId: ctx.job.id,
        now,
        blockReason: blockReason(`QA failed after ${product.attempt} redesign(s)`, failed.qaNotes),
      });
      await insertAudit(
        q,
        { actor: 'qa_publisher', action: 'product.blocked', entity: 'product', entityId: product.id, details: { stage: 'qa', qaNotes: failed.qaNotes } },
        now,
      );
    } else {
      await transitionProduct(q, {
        productId: product.id,
        from: 'final_cleared',
        event: 'qa_fail',
        actor: 'qa_publisher',
        jobId: ctx.job.id,
        now,
        attempt: product.attempt + 1,
      });
    }
  });
  return { status: 'done', note: exhausted ? 'QA failed: blocked' : `QA failed: redesign ${product.attempt + 1}` };
};

/* --------------------------------- analyze --------------------------------- */

interface LiveRow {
  productId: string;
  nicheId: string;
  theme: string;
  etsyListingId: number;
  liveSince: Date;
}

async function pullMetrics(ctx: StepContext, live: LiveRow[], windowStart: Date, logger: Logger): Promise<void> {
  const { db, integrations, eurToUsd } = ctx.deps;
  if (live.length === 0) return;
  const byListing = new Map(live.map((l) => [l.etsyListingId, l]));

  // Orders and revenue per listing per UTC day, recomputed from receipts (absolute values, safe to repeat).
  try {
    const lines = await integrations.etsy.getReceiptLines({ minCreated: Math.floor(windowStart.getTime() / 1000) });
    const agg = new Map<string, { listingId: number; date: string; orders: number; revenueEur: number }>();
    for (const line of lines) {
      if (!byListing.has(line.listingId)) continue;
      const date = isoDate(new Date(line.createdAt));
      const key = `${line.listingId}|${date}`;
      const entry = agg.get(key) ?? { listingId: line.listingId, date, orders: 0, revenueEur: 0 };
      const qty = Math.max(0, Math.floor(line.quantity));
      const amount = Number.isFinite(line.priceAmount) ? line.priceAmount * qty : 0;
      entry.orders += qty;
      entry.revenueEur += line.currency === 'USD' ? amount / eurToUsd : amount;
      agg.set(key, entry);
    }
    await db.tx(async (q) => {
      for (const e of agg.values()) {
        await q.query(
          `INSERT INTO metrics_daily (etsy_listing_id, date, views, favorites, orders, revenue_eur) VALUES ($1, $2::date, 0, 0, $3, $4)
           ON CONFLICT (etsy_listing_id, date) DO UPDATE SET orders = EXCLUDED.orders, revenue_eur = EXCLUDED.revenue_eur`,
          [e.listingId, e.date, e.orders, roundCents(e.revenueEur)],
        );
      }
    });
  } catch (err) {
    logger.warn({ err: errorMessage(err) }, 'analyze: receipts unavailable; keeping stored order counts');
  }

  // Cumulative views / favorites snapshot for today.
  for (const l of live) {
    try {
      const s = await integrations.etsy.getListing(l.etsyListingId);
      await db.query(
        `INSERT INTO metrics_daily (etsy_listing_id, date, views, favorites) VALUES ($1, $2::date, $3, $4)
         ON CONFLICT (etsy_listing_id, date) DO UPDATE SET views = EXCLUDED.views, favorites = EXCLUDED.favorites`,
        [l.etsyListingId, ctx.today, Math.max(0, Math.floor(s.views ?? 0)), Math.max(0, Math.floor(s.numFavorers))],
      );
    } catch (err) {
      logger.warn({ etsyListingId: l.etsyListingId, err: errorMessage(err) }, 'analyze: listing stats unavailable');
    }
  }
}

const analyze: StepHandler = async (ctx) => {
  const { db, integrations, agents, shop, logger } = ctx.deps;
  const now = ctx.deps.now();
  const windowStart = startOfUtcDay(addMs(now, -shop.caps.retireAfterDays * DAY_MS));
  const liveRes = await db.query<Record<string, unknown>>(
    `SELECT p.id, p.niche_id, n.theme, l.etsy_listing_id, l.updated_at AS listing_updated,
       (SELECT max(e.created_at) FROM product_events e WHERE e.product_id = p.id AND e.to_state = 'live') AS live_since
     FROM products p JOIN listings l ON l.product_id = p.id JOIN niches n ON n.id = p.niche_id
     WHERE p.state = 'live' AND l.etsy_listing_id IS NOT NULL
     ORDER BY p.created_at ASC`,
  );
  const live: LiveRow[] = liveRes.rows.map((r) => ({
    productId: String(r.id),
    nicheId: String(r.niche_id),
    theme: String(r.theme),
    etsyListingId: toNum(r.etsy_listing_id),
    liveSince: new Date(toIso(r.live_since ?? r.listing_updated)),
  }));

  await pullMetrics(ctx, live, windowStart, logger);

  const weekStartDate = startOfUtcWeek(now);
  const weekStart = isoDate(weekStartDate);
  const report = await getReport(db, weekStart);
  if (report && now.getTime() - Date.parse(report.updatedAt) < ctx.options.reportIntervalMs) {
    await ctx.commit(async () => undefined);
    return { status: 'done', note: 'metrics updated; weekly report is fresh' };
  }

  const ids = live.map((l) => l.etsyListingId);
  const sums = new Map<number, { orders: number; revenueEur: number; views: number; favorites: number }>();
  if (ids.length > 0) {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT etsy_listing_id, COALESCE(sum(orders), 0) AS orders, COALESCE(sum(revenue_eur), 0) AS revenue,
              COALESCE(max(views), 0) AS views, COALESCE(max(favorites), 0) AS favorites
       FROM metrics_daily WHERE etsy_listing_id = ANY($1::bigint[]) AND date >= $2::date
       GROUP BY etsy_listing_id`,
      [ids, isoDate(windowStart)],
    );
    for (const r of rows) {
      sums.set(toNum(r.etsy_listing_id), {
        orders: toNum(r.orders),
        revenueEur: roundCents(toNum(r.revenue)),
        views: toNum(r.views),
        favorites: toNum(r.favorites),
      });
    }
  }
  const [spendWeek, draftsWeek, decisions] = await Promise.all([
    spendSince(db, weekStartDate),
    countDraftsSince(db, weekStartDate),
    db.query<{ decision: string; n: unknown }>('SELECT decision, count(*) AS n FROM approvals WHERE decided_at >= $1 GROUP BY decision', [
      weekStartDate,
    ]),
  ]);
  const decisionCount = (d: string) => toNum(decisions.rows.find((r) => r.decision === d)?.n ?? 0);

  const out = await ctx.runAgent('analyst', AnalystOutputSchema, () =>
    agents.analyst(
      {
        listings: live.map((l) => {
          const s = sums.get(l.etsyListingId) ?? { orders: 0, revenueEur: 0, views: 0, favorites: 0 };
          return {
            productId: l.productId,
            etsyListingId: l.etsyListingId,
            nicheId: l.nicheId,
            theme: l.theme,
            ageDays: daysBetween(l.liveSince, now),
            views: s.views,
            favorites: s.favorites,
            orders: s.orders,
            revenueEur: s.revenueEur,
          };
        }),
        weekStart,
        spendUsdThisWeek: spendWeek,
        draftsThisWeek: draftsWeek,
        approvalsThisWeek: decisionCount('approve'),
        rejectionsThisWeek: decisionCount('reject'),
      },
      baseDeps(ctx),
    ),
  );

  // Retire: stop auto-renew on Etsy (external write, audited), then move the product to `retired`.
  const liveById = new Map(live.map((l) => [l.productId, l]));
  let retired = 0;
  for (const productId of out.retireProductIds) {
    const l = liveById.get(productId);
    if (!l) continue;
    try {
      await integrations.etsy.updateListing(l.etsyListingId, { shouldAutoRenew: false });
      await db.tx(async (q) => {
        const t = ctx.deps.now();
        await auditExternalWrite(
          q,
          { actor: 'analyst', service: 'etsy', action: 'etsy.listing.update', entity: 'etsy_listing', entityId: String(l.etsyListingId), details: { shouldAutoRenew: false, productId } },
          t,
        );
        await transitionProduct(q, { productId, from: 'live', event: 'retire', actor: 'analyst', jobId: ctx.job.id, now: t });
        await insertAudit(q, { actor: 'analyst', action: 'product.retire', entity: 'product', entityId: productId, details: { etsyListingId: l.etsyListingId } }, t);
      });
      retired++;
    } catch (err) {
      if (err instanceof StaleStateError) continue;
      logger.warn({ productId, err: errorMessage(err) }, 'analyze: retirement failed; will retry next run');
    }
  }

  const liveNiches = new Set(live.map((l) => l.nicheId));
  const followUps = out.followUpNicheIds.filter((id) => liveNiches.has(id));
  await ctx.commit(async (q) => {
    const t = ctx.deps.now();
    await upsertReport(q, weekStart, out.reportMarkdown, t);
    for (const nicheId of followUps) {
      await enqueue(q, { kind: 'validate_niche', nicheId, idempotencyKey: `validate_niche:${nicheId}:followup:${weekStart}` }, t);
    }
  });
  return { status: 'done', note: `${live.length} live, ${retired} retired, ${followUps.length} follow-ups` };
};

/* --------------------------------- registry -------------------------------- */

export const STEP_HANDLERS: Readonly<Record<JobKind, StepHandler>> = {
  trend_scan: trendScan,
  validate_niche: validateNiche,
  concept_check: conceptCheck,
  design,
  write,
  final_check: finalCheck,
  qa_publish: qaPublish,
  analyze,
};

/** Errors that will fail the same way on every retry. */
export function isPermanentError(err: unknown): boolean {
  if (err instanceof AgentOutputError || err instanceof MissingDataError) return true;
  if (err instanceof LlmError) return !err.retryable;
  return (err as { name?: unknown } | null)?.name === 'InvalidTransitionError';
}

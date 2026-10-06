/**
 * Data access for the orchestrator and the desk. Parameterised SQL only ($1, $2...), never string-built values.
 * Row mappers normalise driver differences (node-postgres returns numeric/bigint/count as strings, PGlite as
 * numbers; both return Date for timestamptz). Timestamps written here always come from the injected clock.
 */
import type { Queryable } from '../db/db.ts';
import { transition, type ProductEvent } from '../domain/stateMachine.ts';
import {
  PRODUCT_STATES,
  type AgentName,
  type AuditEntry,
  type ComplianceCheck,
  type Design,
  type Job,
  type JobKind,
  type JobStatus,
  type Listing,
  type Niche,
  type Product,
  type ProductState,
  type ProductType,
  type Settings,
  type TrademarkHit,
} from '../domain/types.ts';
import type { LlmUsage } from '../llm/types.ts';

type Row = Record<string, unknown>;

/* --------------------------------- coercion -------------------------------- */

export function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' || typeof v === 'number') return new Date(v).toISOString();
  throw new Error(`expected a timestamp, got ${typeof v}`);
}

export function toIsoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : toIso(v);
}

export function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(String(v));
  if (!Number.isFinite(n)) throw new Error(`expected a number, got ${String(v)}`);
  return n;
}

export function toNumOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : toNum(v);
}

export function toStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function toJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function roundCents(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/* ---------------------------------- mappers -------------------------------- */

export function mapSettings(r: Row): Settings {
  return {
    paused: Boolean(r.paused),
    dailyDraftCap: toNum(r.daily_draft_cap),
    dailySpendCapUsd: toNum(r.daily_spend_cap_usd),
    blocklist: toStrArr(r.blocklist),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapNiche(r: Row): Niche {
  return {
    id: String(r.id),
    keywords: toStrArr(r.keywords),
    theme: String(r.theme),
    brief: String(r.brief),
    season: r.season === null || r.season === undefined ? null : String(r.season),
    status: r.status as Niche['status'],
    score: toNumOrNull(r.score),
    reasoning: r.reasoning === null || r.reasoning === undefined ? null : String(r.reasoning),
    sourceSignalIds: toStrArr(r.source_signal_ids),
    createdAt: toIso(r.created_at),
  };
}

export function mapProduct(r: Row): Product {
  return {
    id: String(r.id),
    nicheId: String(r.niche_id),
    productType: r.product_type as ProductType,
    conceptTitle: String(r.concept_title),
    designPhrase: r.design_phrase === null || r.design_phrase === undefined ? null : String(r.design_phrase),
    styleNotes: String(r.style_notes ?? ''),
    targetPriceEur: toNum(r.target_price_eur),
    state: r.state as ProductState,
    blockReason: r.block_reason === null || r.block_reason === undefined ? null : String(r.block_reason),
    attempt: toNum(r.attempt),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapDesign(r: Row): Design {
  return {
    id: String(r.id),
    productId: String(r.product_id),
    prompt: String(r.prompt),
    model: String(r.model),
    seed: toNumOrNull(r.seed),
    artKey: String(r.art_key),
    editedKey: r.edited_key === null || r.edited_key === undefined ? null : String(r.edited_key),
    printKey: r.print_key === null || r.print_key === undefined ? null : String(r.print_key),
    qaNotes: toJson<string[]>(r.qa_notes, []),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapListing(r: Row): Listing {
  return {
    id: String(r.id),
    productId: String(r.product_id),
    title: String(r.title),
    tags: toStrArr(r.tags),
    description: String(r.description),
    priceEur: toNum(r.price_eur),
    printifyProductId:
      r.printify_product_id === null || r.printify_product_id === undefined ? null : String(r.printify_product_id),
    etsyListingId: toNumOrNull(r.etsy_listing_id),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapComplianceCheck(r: Row): ComplianceCheck {
  return {
    id: String(r.id),
    productId: String(r.product_id),
    stage: r.stage as ComplianceCheck['stage'],
    verdict: r.verdict as ComplianceCheck['verdict'],
    reasons: toJson<string[]>(r.reasons, []),
    flaggedTerms: toStrArr(r.flagged_terms),
    trademarkHits: toJson<TrademarkHit[]>(r.trademark_hits, []),
    createdAt: toIso(r.created_at),
  };
}

export function mapJob(r: Row): Job {
  return {
    id: String(r.id),
    kind: r.kind as JobKind,
    productId: r.product_id === null || r.product_id === undefined ? null : String(r.product_id),
    nicheId: r.niche_id === null || r.niche_id === undefined ? null : String(r.niche_id),
    status: r.status as JobStatus,
    attempts: toNum(r.attempts),
    maxAttempts: toNum(r.max_attempts),
    runAfter: toIso(r.run_after),
    lockedAt: toIsoOrNull(r.locked_at),
    lastError: r.last_error === null || r.last_error === undefined ? null : String(r.last_error),
    idempotencyKey: String(r.idempotency_key),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapAudit(r: Row): AuditEntry {
  return {
    id: String(r.id),
    actor: String(r.actor),
    action: String(r.action),
    entity: String(r.entity),
    entityId: r.entity_id === null || r.entity_id === undefined ? null : String(r.entity_id),
    details: toJson<Record<string, unknown>>(r.details, {}),
    createdAt: toIso(r.created_at),
  };
}

/* --------------------------------- settings -------------------------------- */

export async function getSettings(q: Queryable): Promise<Settings> {
  const { rows } = await q.query<Row>('SELECT * FROM settings WHERE id = 1');
  const row = rows[0];
  if (!row) throw new Error('settings row is missing (run migrate)');
  return mapSettings(row);
}

export async function updateSettings(
  q: Queryable,
  patch: Partial<Pick<Settings, 'paused' | 'dailyDraftCap' | 'dailySpendCapUsd' | 'blocklist'>>,
  now: Date,
): Promise<Settings> {
  const { rows } = await q.query<Row>(
    `UPDATE settings SET
       paused = COALESCE($1, paused),
       daily_draft_cap = COALESCE($2, daily_draft_cap),
       daily_spend_cap_usd = COALESCE($3, daily_spend_cap_usd),
       blocklist = COALESCE($4::text[], blocklist),
       updated_at = $5
     WHERE id = 1 RETURNING *`,
    [
      patch.paused ?? null,
      patch.dailyDraftCap ?? null,
      patch.dailySpendCapUsd ?? null,
      patch.blocklist ?? null,
      now,
    ],
  );
  if (!rows[0]) throw new Error('settings row is missing (run migrate)');
  return mapSettings(rows[0]);
}

/* ------------------------------ entity lookups ----------------------------- */

export async function getProduct(q: Queryable, id: string, opts: { forUpdate?: boolean } = {}): Promise<Product | null> {
  if (!isUuid(id)) return null;
  const { rows } = await q.query<Row>(`SELECT * FROM products WHERE id = $1${opts.forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0] ? mapProduct(rows[0]) : null;
}

export async function getNiche(q: Queryable, id: string): Promise<Niche | null> {
  if (!isUuid(id)) return null;
  const { rows } = await q.query<Row>('SELECT * FROM niches WHERE id = $1', [id]);
  return rows[0] ? mapNiche(rows[0]) : null;
}

export async function getDesign(q: Queryable, productId: string): Promise<Design | null> {
  if (!isUuid(productId)) return null;
  const { rows } = await q.query<Row>('SELECT * FROM designs WHERE product_id = $1', [productId]);
  return rows[0] ? mapDesign(rows[0]) : null;
}

export async function getListing(q: Queryable, productId: string): Promise<Listing | null> {
  if (!isUuid(productId)) return null;
  const { rows } = await q.query<Row>('SELECT * FROM listings WHERE product_id = $1', [productId]);
  return rows[0] ? mapListing(rows[0]) : null;
}

export async function listComplianceChecks(q: Queryable, productId: string): Promise<ComplianceCheck[]> {
  if (!isUuid(productId)) return [];
  const { rows } = await q.query<Row>(
    'SELECT * FROM compliance_checks WHERE product_id = $1 ORDER BY created_at ASC, id ASC',
    [productId],
  );
  return rows.map(mapComplianceCheck);
}

export async function getJob(q: Queryable, id: string): Promise<Job | null> {
  if (!isUuid(id)) return null;
  const { rows } = await q.query<Row>('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0] ? mapJob(rows[0]) : null;
}

/* -------------------------------- transitions ------------------------------ */

/** The product was not in the state the caller expected (another job or a human moved it). */
export class StaleStateError extends Error {
  constructor(
    public readonly productId: string,
    public readonly expected: ProductState,
  ) {
    super(`product ${productId} is no longer in state ${expected}`);
    this.name = 'StaleStateError';
  }
}

export interface TransitionInput {
  productId: string;
  from: ProductState;
  event: ProductEvent;
  actor: string;
  now: Date;
  jobId?: string | null;
  blockReason?: string | null;
  attempt?: number;
}

/**
 * Applies a state-machine transition with an optimistic check (`WHERE state = from`) and records a
 * product_events row. Throws InvalidTransitionError (bad event) or StaleStateError (state moved).
 */
export async function transitionProduct(q: Queryable, t: TransitionInput): Promise<ProductState> {
  const to = transition(t.from, t.event);
  const { rows } = await q.query<Row>(
    `UPDATE products SET state = $1, updated_at = $2,
       block_reason = CASE WHEN $3::boolean THEN $4 ELSE block_reason END,
       attempt = COALESCE($5, attempt)
     WHERE id = $6 AND state = $7 RETURNING id`,
    [to, t.now, t.blockReason !== undefined, t.blockReason ?? null, t.attempt ?? null, t.productId, t.from],
  );
  if (rows.length === 0) throw new StaleStateError(t.productId, t.from);
  await q.query(
    `INSERT INTO product_events (product_id, from_state, to_state, event, actor, job_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [t.productId, t.from, to, t.event, t.actor, t.jobId ?? null, t.now],
  );
  return to;
}

/* ---------------------------------- audit ---------------------------------- */

export interface AuditInput {
  actor: string;
  action: string;
  entity: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
}

export async function insertAudit(q: Queryable, a: AuditInput, now: Date): Promise<void> {
  await q.query(
    'INSERT INTO audit_log (actor, action, entity, entity_id, details, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
    [a.actor.slice(0, 200), a.action.slice(0, 200), a.entity.slice(0, 200), a.entityId ?? null, JSON.stringify(a.details ?? {}), now],
  );
}

export async function listAudit(q: Queryable, opts: { entityId?: string; action?: string; limit?: number } = {}): Promise<AuditEntry[]> {
  const { rows } = await q.query<Row>(
    `SELECT * FROM audit_log
     WHERE ($1::text IS NULL OR entity_id = $1) AND ($2::text IS NULL OR action = $2)
     ORDER BY created_at ASC, id ASC LIMIT $3`,
    [opts.entityId ?? null, opts.action ?? null, Math.min(Math.max(opts.limit ?? 500, 1), 5000)],
  );
  return rows.map(mapAudit);
}

/* -------------------------------- agent runs ------------------------------- */

export interface AgentRunInput {
  jobId: string | null;
  agent: AgentName;
  usage: LlmUsage;
  ok: boolean;
  error?: string | null;
  output?: unknown;
}

export async function insertAgentRun(q: Queryable, r: AgentRunInput, now: Date): Promise<void> {
  const u = r.usage;
  const int = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
  await q.query(
    `INSERT INTO agent_runs (job_id, agent, model, input_tokens, output_tokens, cost_usd, duration_ms, ok, error, output, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
    [
      r.jobId,
      r.agent,
      String(u.model || 'unknown').slice(0, 200),
      int(u.inputTokens),
      int(u.outputTokens),
      Number.isFinite(u.costUsd) && u.costUsd > 0 ? Math.round(u.costUsd * 10_000) / 10_000 : 0,
      int(u.durationMs),
      r.ok,
      r.error ?? null,
      r.output === undefined ? null : JSON.stringify(r.output),
      now,
    ],
  );
}

/* --------------------------------- counters -------------------------------- */

/** Products that reached `drafted` since `since` (the daily draft cap counts these). */
export async function countDraftsSince(q: Queryable, since: Date): Promise<number> {
  const { rows } = await q.query<{ n: unknown }>(
    `SELECT count(*) AS n FROM product_events WHERE to_state = 'drafted' AND created_at >= $1`,
    [since],
  );
  return toNum(rows[0]?.n ?? 0);
}

/** Model spend (USD) since `since`. Local calls are recorded with cost 0, so this is cloud spend only. */
export async function spendSince(q: Queryable, since: Date): Promise<number> {
  const { rows } = await q.query<{ s: unknown }>(
    'SELECT COALESCE(sum(cost_usd), 0) AS s FROM agent_runs WHERE created_at >= $1',
    [since],
  );
  return toNum(rows[0]?.s ?? 0);
}

export async function countsByState(q: Queryable): Promise<Record<ProductState, number>> {
  const counts = Object.fromEntries(PRODUCT_STATES.map((s) => [s, 0])) as Record<ProductState, number>;
  const { rows } = await q.query<{ state: string; n: unknown }>('SELECT state, count(*) AS n FROM products GROUP BY state');
  for (const r of rows) if ((PRODUCT_STATES as readonly string[]).includes(r.state)) counts[r.state as ProductState] = toNum(r.n);
  return counts;
}

export async function latestReport(q: Queryable): Promise<{ weekStart: string; markdown: string; updatedAt: string } | null> {
  const { rows } = await q.query<Row>(
    'SELECT week_start::text AS week_start, markdown, updated_at FROM weekly_reports ORDER BY week_start DESC LIMIT 1',
  );
  const r = rows[0];
  return r ? { weekStart: String(r.week_start), markdown: String(r.markdown), updatedAt: toIso(r.updated_at) } : null;
}

export async function getReport(q: Queryable, weekStart: string): Promise<{ markdown: string; updatedAt: string } | null> {
  const { rows } = await q.query<Row>('SELECT markdown, updated_at FROM weekly_reports WHERE week_start = $1::date', [weekStart]);
  const r = rows[0];
  return r ? { markdown: String(r.markdown), updatedAt: toIso(r.updated_at) } : null;
}

export async function upsertReport(q: Queryable, weekStart: string, markdown: string, now: Date): Promise<void> {
  await q.query(
    `INSERT INTO weekly_reports (week_start, markdown, created_at, updated_at) VALUES ($1::date, $2, $3, $3)
     ON CONFLICT (week_start) DO UPDATE SET markdown = EXCLUDED.markdown, updated_at = EXCLUDED.updated_at`,
    [weekStart, markdown, now],
  );
}

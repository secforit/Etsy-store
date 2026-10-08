/**
 * End-to-end test on the REAL mocks and the real wiring (no fakes): every piece comes from the public
 * `@etsy-agents/core` barrel, exactly as the worker and desk build it:
 *   createIntegrations(mock env) -> createLlm(mock env, { gpu }) -> createAgentRegistry() -> PGlite -> Orchestrator
 *   + createDeskService for Razvan's actions.
 *
 * Walk: trend_scan -> validate_niche -> concept_check -> design -> (desk upload of a hand-edited PNG at 1/3 of the
 * t-shirt print spec, so QA must upscale) -> write -> final_check -> qa_publish -> drafted -> desk approve -> live
 * -> analyze. Also: a blocklisted concept ends `blocked`, pause stops processing, the daily draft cap holds,
 * both disclosures are in the description, audit_log has upload/approve/publish rows, and the GPU coordinator
 * saw both owners.
 */
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SHOP,
  cloudAgentsFor,
  createAgentRegistry,
  createDeskService,
  createIntegrations,
  createLlm,
  createPgliteDb,
  dbCatalogResolver,
  enqueue,
  externalWriteAuditHook,
  loadEnv,
  migrate,
  productStepKey,
  silentLogger,
  MemoryBlobStorage,
  UNATTRIBUTED_SOURCE,
  Orchestrator,
  type Db,
  type DeskService,
  type MockIntegrations,
  type OrchestratorDeps,
  type ProductState,
  type RunOnceResult,
} from '@etsy-agents/core';

const ACTOR = 'razvan (e2e)';
const BLOCKED_TERM = 'forbidden brand';
const DRAFT_CAP = 2;
const TSHIRT = SHOP.products.tshirt.printSpec;
/** Razvan's edit at 1/3 of the t-shirt print spec (1500x1800): QA must upscale it to 4500x5400. */
const EDIT_W = Math.round(TSHIRT.widthPx / 3);
const EDIT_H = Math.round(TSHIRT.heightPx / 3);

/** Deterministic clock; moves 1 ms per read so queue order follows creation order. */
class TickingClock {
  private t: number;
  constructor(start: string) {
    this.t = Date.parse(start);
  }
  now = (): Date => new Date(this.t++);
  set(iso: string): void {
    this.t = Date.parse(iso);
  }
}

/** A valid hand-edited design: transparent background, solid shapes with hard edges, sRGB PNG. */
async function editedTshirtPng(): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${EDIT_W}" height="${EDIT_H}">
    <circle cx="${EDIT_W / 2}" cy="${EDIT_H * 0.4}" r="${EDIT_W * 0.3}" fill="#e8742b"/>
    <rect x="${EDIT_W * 0.15}" y="${EDIT_H * 0.68}" width="${EDIT_W * 0.7}" height="${EDIT_H * 0.12}" fill="#2b3a55"/>
    <polygon points="${EDIT_W * 0.3},${EDIT_H * 0.5} ${EDIT_W * 0.5},${EDIT_H * 0.2} ${EDIT_W * 0.7},${EDIT_H * 0.5}" fill="#f6e7c8"/>
  </svg>`;
  const out = await sharp({ create: { width: EDIT_W, height: EDIT_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
  return new Uint8Array(out);
}

/** Simulated edit of the raw art for non-t-shirt products (same size, re-encoded). */
async function reencode(png: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await sharp(png).modulate({ saturation: 1.05 }).png().toBuffer());
}

let db: Db;
let clock: TickingClock;
let integrations: MockIntegrations;
let deps: OrchestratorDeps;
let orch: Orchestrator;
let desk: DeskService;

let blockedProductId = '';
let tshirtId = '';
let draftedIds: string[] = [];
let lastRun: RunOnceResult | undefined;

async function state(id: string): Promise<ProductState> {
  const { rows } = await db.query<{ state: ProductState }>('SELECT state FROM products WHERE id = $1', [id]);
  if (!rows[0]) throw new Error(`no product ${id}`);
  return rows[0].state;
}

async function idsIn(s: ProductState): Promise<string[]> {
  return (await desk.listProducts({ states: [s], limit: 500 })).map((p) => p.id);
}

async function auditActions(): Promise<string[]> {
  const { rows } = await db.query<{ action: string }>('SELECT action FROM audit_log ORDER BY created_at, id');
  return rows.map((r) => r.action);
}

async function runAll(): Promise<RunOnceResult[]> {
  const results = await orch.runUntilIdle();
  lastRun = results.at(-1);
  return results;
}

beforeAll(async () => {
  const env = loadEnv({ MODE: 'mock', LOG_LEVEL: 'error' });
  clock = new TickingClock('2026-10-06T08:00:00.000Z');
  db = await createPgliteDb();
  await migrate(db);
  const now = clock.now;
  const logger = silentLogger;
  integrations = (await createIntegrations(env, {
    logger,
    now,
    storage: new MemoryBlobStorage(),
    printifyCatalog: dbCatalogResolver(db),
    onExternalWrite: externalWriteAuditHook(db, now, logger),
  })) as MockIntegrations;
  expect(integrations.mocks, 'MODE=mock must return the mock bundle').toBeDefined();
  const llm = createLlm(env, { gpu: integrations.gpu });
  deps = { db, integrations, llm, agents: createAgentRegistry(), shop: SHOP, now, logger, eurToUsd: 1.1 };
  orch = new Orchestrator(deps, { cloudAgents: cloudAgentsFor(env), qaPublish: { sleep: async () => {} } });
  desk = createDeskService(deps);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('end to end on the real mocks', () => {
  it('Razvan sets a blocklist term and the pilot draft cap on the desk', async () => {
    const s = await desk.updateSettings({ blocklist: [BLOCKED_TERM], dailyDraftCap: DRAFT_CAP }, ACTOR);
    expect(s.blocklist).toEqual([BLOCKED_TERM]);
    expect(s.dailyDraftCap).toBe(DRAFT_CAP);
  });

  it('trend_scan -> validate_niche -> concept_check -> design; a blocklisted concept ends blocked', async () => {
    // A concept carrying the blocklisted term, queued for its concept check like any proposed product.
    const now = clock.now();
    const niche = await db.query<{ id: string }>(
      `INSERT INTO niches (keywords, theme, brief, status, created_at) VALUES ($1::text[], $2, $3, 'accepted', $4) RETURNING id`,
      [['retro badge'], 'Retro Badge Fans', 'People who like retro badges.', now],
    );
    const prod = await db.query<{ id: string }>(
      `INSERT INTO products (niche_id, product_type, concept_title, design_phrase, style_notes, target_price_eur, created_at, updated_at)
       VALUES ($1, 'tshirt', $2, $3, 'Bold badge.', 24.99, $4, $4) RETURNING id`,
      [niche.rows[0]!.id, 'Forbidden Brand Retro Badge Tee', 'Forbidden Brand Club', now],
    );
    blockedProductId = prod.rows[0]!.id;
    await enqueue(db, { kind: 'concept_check', productId: blockedProductId, idempotencyKey: productStepKey('concept_check', blockedProductId, 0) }, now);

    await enqueue(db, { kind: 'trend_scan', idempotencyKey: 'trend_scan:2026-10-06' }, clock.now());
    const results = await runAll();
    const kinds = new Set(results.flatMap((r) => (r.status === 'ran' ? [r.job.kind] : [])));
    expect([...kinds].sort()).toEqual(['concept_check', 'design', 'trend_scan', 'validate_niche']);
    expect(results.filter((r) => r.status === 'ran' && r.outcome !== 'done')).toEqual([]);

    expect(await state(blockedProductId)).toBe('blocked');
    const checks = (await desk.getProduct(blockedProductId))!.complianceChecks;
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ stage: 'concept', verdict: 'block' });
    expect(checks[0]!.flaggedTerms.join(' ').toLowerCase()).toContain(BLOCKED_TERM);

    const designed = await desk.listProducts({ states: ['designed'] });
    expect(designed.length).toBeGreaterThanOrEqual(2);
    expect(designed.every((p) => p.needsAction)).toBe(true);
    const tee = designed.find((p) => p.productType === 'tshirt');
    expect(tee, 'the mock pipeline proposes at least one t-shirt').toBeDefined();
    tshirtId = tee!.id;
    expect(await desk.getAsset(tshirtId, 'art')).not.toBeNull();
    expect(await desk.getAsset(tshirtId, 'edited')).toBeNull();
  }, 120_000);

  it('pause stops processing: uploads queue work, nothing runs until resumed', async () => {
    await desk.updateSettings({ paused: true }, ACTOR);
    const designed = await desk.listProducts({ states: ['designed'] });
    // T-shirt edits first (1/3 of the print spec), then the rest re-encoded from the raw art.
    const ordered = [...designed].sort((a, b) => Number(b.productType === 'tshirt') - Number(a.productType === 'tshirt'));
    const teePng = await editedTshirtPng();
    for (const p of ordered) {
      const bytes = p.productType === 'tshirt' ? teePng : await reencode((await desk.getAsset(p.id, 'art'))!.bytes);
      await desk.uploadEditedDesign(p.id, { bytes, filename: '../../etc/passwd.png', mimeType: 'image/png' }, ACTOR);
    }
    const edited = await idsIn('edited');
    expect(edited.sort()).toEqual(designed.map((p) => p.id).sort());
    const stored = await desk.getAsset(tshirtId, 'edited');
    const meta = await sharp(stored!.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([EDIT_W, EDIT_H]);

    const r = await orch.runOnce();
    expect(r.status).toBe('paused');
    const queued = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM jobs WHERE kind = 'write' AND status = 'queued' AND attempts = 0`);
    expect(Number(queued.rows[0]!.n)).toBe(edited.length);
    expect((await idsIn('edited')).length).toBe(edited.length);

    await desk.updateSettings({ paused: false }, ACTOR);
  });

  it('write -> final_check -> qa_publish (upscaled) -> drafted, held at the daily draft cap', async () => {
    const editedCount = (await idsIn('edited')).length;
    expect(editedCount).toBeGreaterThan(DRAFT_CAP);
    await runAll();
    expect(lastRun?.status).toBe('idle');
    expect(lastRun?.caps).toMatchObject({ draftsToday: DRAFT_CAP, draftCapReached: true, excludedKinds: ['qa_publish'] });

    draftedIds = await idsIn('drafted');
    const held = await idsIn('final_cleared');
    expect(draftedIds).toHaveLength(DRAFT_CAP);
    expect(held).toHaveLength(editedCount - DRAFT_CAP);
    expect(draftedIds).toContain(tshirtId);
    const heldJobs = await db.query<{ status: string; attempts: unknown }>(
      `SELECT status, attempts FROM jobs WHERE kind = 'qa_publish' AND product_id = ANY($1::uuid[])`,
      [held],
    );
    expect(heldJobs.rows).toHaveLength(held.length);
    expect(heldJobs.rows.every((j) => j.status === 'queued' && Number(j.attempts) === 0)).toBe(true);

    // QA upscaled Razvan's 1/3-size edit with the AI upscaler, then made the exact print file.
    expect(integrations.mocks.upscaler.calls.some((c) => c.factor === 4)).toBe(true);
    const detail = (await desk.getProduct(tshirtId))!;
    expect(detail.design?.qaNotes.join(' ')).toMatch(/Upscaled 4x/);
    const print = await desk.getAsset(tshirtId, 'print');
    const pm = await sharp(print!.bytes).metadata();
    expect([pm.width, pm.height, pm.density, pm.hasAlpha]).toEqual([TSHIRT.widthPx, TSHIRT.heightPx, TSHIRT.dpi, true]);

    // Listing copy: both disclosures appended by code, Etsy limits enforced.
    for (const id of draftedIds) {
      const d = (await desk.getProduct(id))!;
      const l = d.listing!;
      expect(l.description).toContain(SHOP.listing.aiDisclosure);
      expect(l.description).toContain(SHOP.listing.productionPartnerDisclosure);
      expect(l.title.length).toBeLessThanOrEqual(SHOP.listing.titleMaxChars);
      expect(l.tags.length).toBeLessThanOrEqual(SHOP.listing.maxTags);
      expect(l.tags.every((t) => t.length <= SHOP.listing.tagMaxChars && t === t.toLowerCase())).toBe(true);
      expect(l.printifyProductId).toBeTruthy();
      expect(l.etsyListingId).toBeTruthy();
      expect(d.complianceChecks.map((c) => `${c.stage}:${c.verdict}`).sort()).toEqual(['concept:pass', 'final:pass']);
      expect(integrations.mocks.etsy.peek(l.etsyListingId!)?.state).toBe('draft');
    }
  }, 180_000);

  it('desk approve -> live: the Etsy draft is activated', async () => {
    await desk.approve(tshirtId, ACTOR);
    expect(await state(tshirtId)).toBe('live');
    const listing = (await desk.getProduct(tshirtId))!.listing!;
    expect(integrations.mocks.etsy.peek(listing.etsyListingId!)?.state).toBe('active');
    await expect(desk.approve(tshirtId, ACTOR)).rejects.toThrow(/Only drafted products/);
  });

  it('analyze runs while the draft cap still holds the remaining drafts', async () => {
    const before = (await idsIn('final_cleared')).length;
    await enqueue(db, { kind: 'analyze', idempotencyKey: 'analyze:2026-10-06T08:e2e' }, clock.now());
    const results = await runAll();
    expect(results.some((r) => r.status === 'ran' && r.job.kind === 'analyze' && r.outcome === 'done')).toBe(true);
    expect(results.some((r) => r.status === 'ran' && r.job.kind === 'qa_publish')).toBe(false);
    expect((await idsIn('final_cleared')).length).toBe(before);
    expect((await idsIn('drafted')).length).toBe(DRAFT_CAP - 1);
    expect(await state(tshirtId)).toBe('live');

    const dash = await desk.getDashboard();
    expect(dash.latestReportMarkdown).toMatch(/Weekly report/);
    expect(dash.draftsToday).toBe(DRAFT_CAP);
    expect(dash.spendTodayUsd).toBe(0);
  }, 120_000);

  it('the rollout scorecard reads what the pipeline and the desk wrote', async () => {
    const { metrics, gates } = await desk.getRollout();
    expect(metrics).toMatchObject({
      draftsMade: DRAFT_CAP,
      draftsReviewed: 1,
      approved: 1,
      rejected: 0,
      approvalRate: 1,
      ipMisses: 0,
      cloudSpendUsd: 0,
      costPerListingUsd: SHOP.pricing.listingFeeUsd, // all-local models: only Etsy's listing fee
    });
    // The hand-made blocklisted concept has no trend signals; trend-scout niches attribute to their sources.
    expect(metrics.blockRateBySource).toContainEqual({ source: UNATTRIBUTED_SOURCE, checked: 1, blocked: 1, rate: 1 });
    const scouted = metrics.blockRateBySource.filter((s) => s.source !== UNATTRIBUTED_SOURCE);
    expect(scouted.length).toBeGreaterThan(0);
    expect(scouted.every((s) => s.checked > 0 && s.blocked === 0)).toBe(true);
    expect(gates[0]).toMatchObject({ id: 'gate2', status: 'open' });
  });

  it('the next UTC day the cap resets and a held draft goes out', async () => {
    clock.set('2026-10-07T00:00:05.000Z');
    const r = await orch.runOnce();
    expect(r.status === 'ran' && r.job.kind).toBe('qa_publish');
    expect(r.status === 'ran' && r.outcome).toBe('done');
    expect((await idsIn('drafted')).length).toBe(DRAFT_CAP);
  }, 120_000);

  it('audit_log, agent_runs and the GPU coordinator saw the whole run', async () => {
    const actions = await auditActions();
    for (const a of [
      'settings.update',
      'product.blocked',
      'design.upload',
      'printify.image.upload',
      'printify.product.create',
      'printify.product.publish',
      'product.drafted',
      'etsy.listing.activate',
      'product.approve',
    ]) {
      expect(actions, `audit_log has ${a}`).toContain(a);
    }
    const uploads = actions.filter((a) => a === 'design.upload').length;
    expect(uploads).toBeGreaterThanOrEqual(3);

    const runs = await db.query<{ agent: string; n: unknown; cost: unknown }>(
      'SELECT agent, count(*) AS n, COALESCE(sum(cost_usd), 0) AS cost FROM agent_runs GROUP BY agent',
    );
    const agents = Object.fromEntries(runs.rows.map((r) => [r.agent, Number(r.n)]));
    for (const a of ['trend_scout', 'niche_validator', 'compliance_guard', 'designer', 'listing_writer', 'qa_publisher', 'analyst']) {
      expect(agents[a], `agent_runs for ${a}`).toBeGreaterThan(0);
    }
    expect(runs.rows.reduce((s, r) => s + Number(r.cost), 0)).toBe(0);

    const failed = await db.query<{ kind: string; last_error: string | null }>(`SELECT kind, last_error FROM jobs WHERE status = 'failed'`);
    expect(failed.rows).toEqual([]);

    const owners = new Set(integrations.mocks.gpu.history);
    expect(owners.has('llm')).toBe(true);
    expect(owners.has('image')).toBe(true);
  });
});

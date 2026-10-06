import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/db.ts';
import type { JobKind } from '../domain/types.ts';
import { LlmError } from '../llm/types.ts';
import { insertAvoidRule } from './avoidRules.ts';
import { Orchestrator, type OrchestratorOptions } from './orchestrator.ts';
import { enqueue, productStepKey } from './queue.ts';
import { getDesign, getListing, getNiche, updateSettings } from './repo.ts';
import { ensureDisclosures } from './steps.ts';
import {
  auditActions,
  createHarness,
  jobsOf,
  productState,
  seedNiche,
  seedProduct,
  sharedTestDb,
  type FakeAgentBehaviour,
  type TestHarness,
} from './testing/fakes.ts';

let db: Db;

beforeEach(async () => {
  db = await sharedTestDb();
});

async function harness(agents: Partial<FakeAgentBehaviour> = {}): Promise<TestHarness> {
  return createHarness({ db, agents });
}

function orchestrator(h: TestHarness, opts: OrchestratorOptions = {}) {
  return new Orchestrator(h.deps, { cloudAgents: [], qaPublish: { sleep: async () => {} }, ...opts });
}

async function runStep(h: TestHarness, kind: JobKind, ref: { productId?: string; nicheId?: string; key?: string }, opts: OrchestratorOptions = {}) {
  const key = ref.key ?? (ref.productId ? productStepKey(kind, ref.productId, (await productState(db, ref.productId)).attempt) : `${kind}:test`);
  await enqueue(db, { kind, productId: ref.productId ?? null, nicheId: ref.nicheId ?? null, idempotencyKey: key }, h.clock.now());
  const res = await orchestrator(h, opts).runOnce();
  if (res.status !== 'ran') throw new Error(`expected a job to run, got ${res.status}`);
  return res;
}

async function agentRuns(jobKind?: string) {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT r.agent, r.model, r.cost_usd, r.ok, r.output IS NOT NULL AS has_output FROM agent_runs r
     LEFT JOIN jobs j ON j.id = r.job_id WHERE ($1::text IS NULL OR j.kind = $1)`,
    [jobKind ?? null],
  );
  return rows;
}

/* --------------------------------- trend_scan -------------------------------- */

describe('trend_scan', () => {
  it('stores signals, creates niches, enqueues validation and records the local LLM call at cost 0', async () => {
    const h = await harness();
    h.integrations.fakes.trends[1]!.fail = true; // one source down: tolerated
    const res = await runStep(h, 'trend_scan', {});
    expect(res.outcome).toBe('done');
    const signals = await db.query('SELECT * FROM trend_signals');
    expect(signals.rows).toHaveLength(2);
    const niches = await db.query<{ id: string; status: string; source_signal_ids: string[] }>('SELECT id, status, source_signal_ids FROM niches');
    expect(niches.rows).toHaveLength(2);
    expect(niches.rows.every((n) => n.status === 'new' && n.source_signal_ids.length === 1)).toBe(true); // bogus id dropped
    const jobs = await jobsOf(db, { kind: 'validate_niche' });
    expect(jobs.map((j) => j.idempotency_key)).toEqual(expect.arrayContaining(niches.rows.map((n) => `validate_niche:${n.id}`)));
    const runs = await agentRuns('trend_scan');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agent: 'trend_scout', model: 'gemma4:12b', ok: true, has_output: true });
    expect(Number(runs[0]!.cost_usd)).toBe(0);
    const scout = h.agents.calls.find((c) => c.agent === 'trendScout')!;
    expect((scout.input as { productTypes: string[] }).productTypes).toEqual(['tshirt', 'mug', 'poster']);
  });

  it('does not create a niche whose theme already exists', async () => {
    const h = await harness();
    await seedNiche(db, h.clock.now(), 'retro camping fans');
    await runStep(h, 'trend_scan', {});
    const { rows } = await db.query<{ theme: string }>('SELECT theme FROM niches ORDER BY theme');
    expect(rows.map((r) => r.theme)).toEqual(['cat lover fans', 'retro camping fans']);
  });

  it('retries when the agent fails', async () => {
    const h = await harness({ throwFrom: { trendScout: () => new Error('ollama timeout') } });
    const res = await runStep(h, 'trend_scan', {});
    expect(res.outcome).toBe('retry');
    expect((await jobsOf(db, { kind: 'trend_scan' }))[0]).toMatchObject({ status: 'queued', last_error: 'Error: ollama timeout' });
    expect(await db.query('SELECT * FROM niches').then((r) => r.rows)).toHaveLength(0);
  });
});

/* ------------------------------- validate_niche ------------------------------ */

describe('validate_niche', () => {
  it('accepts the niche, creates proposed products and enqueues concept checks', async () => {
    const h = await harness({ productsPerNiche: 2 });
    const nicheId = await seedNiche(db, h.clock.now(), 'Camping', 'new');
    await runStep(h, 'validate_niche', { nicheId, key: `validate_niche:${nicheId}` });
    expect((await getNiche(db, nicheId))!).toMatchObject({ status: 'accepted', score: 70 });
    const products = await db.query<{ id: string; state: string; product_type: string }>('SELECT id, state, product_type FROM products');
    expect(products.rows.map((p) => p.product_type).sort()).toEqual(['mug', 'tshirt']);
    expect(products.rows.every((p) => p.state === 'proposed')).toBe(true);
    expect(await jobsOf(db, { kind: 'concept_check' })).toHaveLength(2);
    expect((h.agents.calls[0]!.deps as { eurToUsd: number }).eurToUsd).toBe(1.1);
  });

  it('rejects the niche without creating products', async () => {
    const h = await harness({ nicheDecision: 'reject' });
    const nicheId = await seedNiche(db, h.clock.now(), 'Meh', 'new');
    await runStep(h, 'validate_niche', { nicheId, key: `validate_niche:${nicheId}` });
    expect((await getNiche(db, nicheId))!.status).toBe('rejected');
    expect(await db.query('SELECT * FROM products').then((r) => r.rows)).toHaveLength(0);
  });

  it('skips an already validated niche unless it is a follow-up', async () => {
    const h = await harness();
    const nicheId = await seedNiche(db, h.clock.now(), 'Done', 'accepted');
    const res = await runStep(h, 'validate_niche', { nicheId, key: `validate_niche:${nicheId}` });
    expect(res.outcome).toBe('skipped');
    const follow = await runStep(h, 'validate_niche', { nicheId, key: `validate_niche:${nicheId}:followup:2026-10-05` });
    expect(follow.outcome).toBe('done');
    expect(await db.query('SELECT * FROM products').then((r) => r.rows)).toHaveLength(1);
  });

  it('fails permanently on a non-retryable LLM error', async () => {
    const h = await harness({ throwFrom: { nicheValidator: () => new LlmError('output failed validation twice', false) } });
    const nicheId = await seedNiche(db, h.clock.now(), 'Bad', 'new');
    const res = await runStep(h, 'validate_niche', { nicheId, key: `validate_niche:${nicheId}` });
    expect(res.outcome).toBe('failed');
    expect(await auditActions(db)).toContain('job.failed');
  });
});

/* ------------------------------- concept_check ------------------------------- */

describe('concept_check', () => {
  it('clears the concept and enqueues design', async () => {
    const h = await harness();
    const id = await seedProduct(db, h.clock.now(), { state: 'proposed' });
    await runStep(h, 'concept_check', { productId: id });
    expect((await productState(db, id)).state).toBe('cleared');
    expect(await jobsOf(db, { productId: id, kind: 'design' })).toHaveLength(1);
    const checks = await db.query<{ stage: string; verdict: string }>('SELECT stage, verdict FROM compliance_checks WHERE product_id = $1', [id]);
    expect(checks.rows).toEqual([{ stage: 'concept', verdict: 'pass' }]);
  });

  it('blocks on the model verdict and audits it', async () => {
    const h = await harness({ compliance: () => ({ verdict: 'block', reasons: ['Looks like a famous logo.'], blocklistHits: [] }) });
    const id = await seedProduct(db, h.clock.now(), { state: 'proposed' });
    await runStep(h, 'concept_check', { productId: id });
    const st = await productState(db, id);
    expect(st.state).toBe('blocked');
    expect(st.blockReason).toContain('famous logo');
    expect(await auditActions(db, id)).toContain('product.blocked');
    expect(await jobsOf(db, { productId: id, kind: 'design' })).toHaveLength(0);
  });

  it('forces a block in code when the blocklist was hit, whatever the model said', async () => {
    const h = await harness({ compliance: () => ({ verdict: 'pass', reasons: [], blocklistHits: ['disney'] }) });
    const id = await seedProduct(db, h.clock.now(), { state: 'proposed' });
    await runStep(h, 'concept_check', { productId: id });
    expect((await productState(db, id)).state).toBe('blocked');
    const { rows } = await db.query<{ verdict: string }>('SELECT verdict FROM compliance_checks WHERE product_id = $1', [id]);
    expect(rows[0]!.verdict).toBe('block');
  });

  it('passes the settings blocklist to the guard', async () => {
    const h = await harness();
    await updateSettings(db, { blocklist: ['nike'] }, h.clock.now());
    const id = await seedProduct(db, h.clock.now(), { state: 'proposed' });
    await runStep(h, 'concept_check', { productId: id });
    expect(h.agents.calls.find((c) => c.agent === 'complianceGuard')!.deps.blocklist).toEqual(['nike']);
  });

  it('skips when the product already moved on', async () => {
    const h = await harness();
    const id = await seedProduct(db, h.clock.now(), { state: 'cleared' });
    const res = await runStep(h, 'concept_check', { productId: id, key: `concept_check:${id}:0` });
    expect(res.outcome).toBe('skipped');
    expect(h.agents.calls).toHaveLength(0);
  });

  it('retries a transient failure (e.g. trademark API down) without changing state', async () => {
    const h = await harness({ throwFrom: { complianceGuard: () => new Error('marker 503') } });
    const id = await seedProduct(db, h.clock.now(), { state: 'proposed' });
    const res = await runStep(h, 'concept_check', { productId: id });
    expect(res.outcome).toBe('retry');
    expect((await productState(db, id)).state).toBe('proposed');
  });
});

/* ----------------------------------- design ---------------------------------- */

describe('design', () => {
  it('stores the raw art, moves to designed and waits for Razvan (no next job)', async () => {
    const h = await harness();
    const id = await seedProduct(db, h.clock.now(), { state: 'cleared' });
    await insertAvoidRule(db, { reason: 'No neon colours', sourceProductId: null, actor: 'razvan' }, h.clock.now());
    await runStep(h, 'design', { productId: id });
    expect((await productState(db, id)).state).toBe('designed');
    const design = (await getDesign(db, id))!;
    expect(design.artKey).toBe(`designs/${id}/art-1.png`);
    expect(design.editedKey).toBeNull();
    expect(h.integrations.fakes.storage.blobs.has(design.artKey)).toBe(true);
    const call = h.agents.calls.find((c) => c.agent === 'designer')!;
    expect((call.input as { avoidRules: string[] }).avoidRules).toEqual(['No neon colours']);
    expect(call.deps.printify).toBeDefined();
    const pending = (await jobsOf(db, { productId: id })).filter((j) => j.status === 'queued');
    expect(pending).toHaveLength(0);
  });

  it('fails permanently when the agent returns an art key outside the product folder', async () => {
    const h = await harness();
    const id = await seedProduct(db, h.clock.now(), { state: 'cleared' });
    h.agents.designer = async () => ({
      output: { prompt: 'a prompt that is long', model: 'm', seed: 1, artKey: 'designs/other/art-1.png' },
      llmUsage: [],
    });
    const res = await runStep(h, 'design', { productId: id });
    expect(res.outcome).toBe('failed');
    expect((await productState(db, id)).state).toBe('cleared');
  });
});

/* ----------------------------------- write ----------------------------------- */

describe('write', () => {
  it('stores normalised copy with disclosures and enqueues the final check', async () => {
    const h = await harness();
    const id = await seedProduct(db, h.clock.now(), { state: 'edited', withDesign: true });
    await insertAvoidRule(db, { reason: 'Avoid puns', sourceProductId: null, actor: 'razvan' }, h.clock.now());
    await runStep(h, 'write', { productId: id });
    expect((await productState(db, id)).state).toBe('written');
    const listing = (await getListing(db, id))!;
    expect(listing.tags).toEqual(['retro camping', 'camp gift', 'outdoor tee', 'gift idea']); // deduped + lowercased
    expect(listing.description).toContain(h.deps.shop.listing.aiDisclosure);
    expect(listing.description).toContain(h.deps.shop.listing.productionPartnerDisclosure);
    expect(listing.priceEur).toBe(24.99);
    expect(await jobsOf(db, { productId: id, kind: 'final_check' })).toHaveLength(1);
    const call = h.agents.calls.find((c) => c.agent === 'listingWriter')!;
    expect((call.input as { avoidRules: string[] }).avoidRules).toEqual(['Avoid puns']);
    expect(call.deps.trademark).toBeDefined();
  });

  it('fails permanently when the edited design is missing', async () => {
    const h = await harness();
    const id = await seedProduct(db, h.clock.now(), { state: 'edited', withDesign: true, editedKey: null });
    const res = await runStep(h, 'write', { productId: id });
    expect(res.outcome).toBe('failed');
    expect(h.agents.calls).toHaveLength(0);
  });

  it('appends missing disclosures in code', () => {
    const shop = { listing: { aiDisclosure: 'AI line.', productionPartnerDisclosure: 'Partner line.' } } as Parameters<typeof ensureDisclosures>[1];
    expect(ensureDisclosures('Body text.', shop)).toBe('Body text.\n\nAI line.\n\nPartner line.');
    expect(ensureDisclosures('Body.\n\nAI line.\n\nPartner line.', shop)).toBe('Body.\n\nAI line.\n\nPartner line.');
  });
});

/* -------------------------------- final_check -------------------------------- */

describe('final_check', () => {
  it('passes the edited design and listing to the guard and enqueues QA', async () => {
    const h = await harness();
    const id = await seedProduct(db, h.clock.now(), { state: 'written', withDesign: true, withListing: true });
    await runStep(h, 'final_check', { productId: id });
    expect((await productState(db, id)).state).toBe('final_cleared');
    const input = h.agents.calls.find((c) => c.agent === 'complianceGuard')!.input as { stage: string; designKey: string; listing: { title: string } };
    expect(input).toMatchObject({ stage: 'final', designKey: `designs/${id}/edited-1.png`, listing: { title: 'Retro Camp Badge Tee' } });
    expect(await jobsOf(db, { productId: id, kind: 'qa_publish' })).toHaveLength(1);
  });

  it('blocks on a final-stage block', async () => {
    const h = await harness({ compliance: (i) => (i.stage === 'final' ? { verdict: 'block', reasons: ['Tag is a live mark.'], blocklistHits: [] } : { verdict: 'pass', reasons: [], blocklistHits: [] }) });
    const id = await seedProduct(db, h.clock.now(), { state: 'written', withDesign: true, withListing: true });
    await runStep(h, 'final_check', { productId: id });
    const st = await productState(db, id);
    expect(st.state).toBe('blocked');
    expect(st.blockReason).toMatch(/^Final compliance: Tag is a live mark/);
  });

  it('fails permanently without a listing', async () => {
    const h = await harness();
    const id = await seedProduct(db, h.clock.now(), { state: 'written', withDesign: true });
    expect((await runStep(h, 'final_check', { productId: id })).outcome).toBe('failed');
  });
});

/* --------------------------------- qa_publish -------------------------------- */

describe('qa_publish', () => {
  it('drafts: stores Printify + Etsy ids, print key, audits the external writes', async () => {
    const h = await harness();
    const id = await seedProduct(db, h.clock.now(), { state: 'final_cleared', withDesign: true, withListing: true });
    await runStep(h, 'qa_publish', { productId: id });
    expect((await productState(db, id)).state).toBe('drafted');
    const listing = (await getListing(db, id))!;
    expect(listing.printifyProductId).toBe(`pf-${id.slice(0, 8)}`);
    expect(listing.etsyListingId).toBeGreaterThan(0);
    expect((await getDesign(db, id))!.printKey).toBe(`designs/${id}/print.png`);
    expect(await auditActions(db, id)).toContain('product.drafted');
    const deps = h.agents.calls.find((c) => c.agent === 'qaPublisher')!.deps;
    expect(typeof deps.sleep).toBe('function');
    expect(deps.imageTools).toBeDefined();
  });

  it('QA failure sends the product back to designed and counts the redesign', async () => {
    const h = await harness({ qa: () => 'qa_failed' });
    const id = await seedProduct(db, h.clock.now(), { state: 'final_cleared', withDesign: true, withListing: true, printifyProductId: 'old' });
    await runStep(h, 'qa_publish', { productId: id });
    const st = await productState(db, id);
    expect(st).toMatchObject({ state: 'designed', attempt: 1 });
    expect((await getDesign(db, id))!.qaNotes).toEqual(['Too many semi-transparent pixels.']);
    expect((await getListing(db, id))!.printifyProductId).toBeNull();
    expect(await auditActions(db, id)).toContain('product.qa_failed');
  });

  it(`blocks once the redesigns are used up`, async () => {
    const h = await harness({ qa: () => 'qa_failed' });
    const max = h.deps.shop.caps.maxQaRedesigns;
    const id = await seedProduct(db, h.clock.now(), { state: 'final_cleared', withDesign: true, withListing: true, attempt: max });
    await runStep(h, 'qa_publish', { productId: id });
    const st = await productState(db, id);
    expect(st.state).toBe('blocked');
    expect(st.blockReason).toMatch(/QA failed after 2 redesign/);
    expect(await auditActions(db, id)).toEqual(expect.arrayContaining(['product.qa_failed', 'product.blocked']));
  });

  it('remembers a pending Printify product and reuses it on the retry', async () => {
    const h = await harness({ qa: (_i, call) => (call === 0 ? 'pending' : 'drafted') });
    const id = await seedProduct(db, h.clock.now(), { state: 'final_cleared', withDesign: true, withListing: true });
    const first = await runStep(h, 'qa_publish', { productId: id });
    expect(first.outcome).toBe('retry');
    expect((await getListing(db, id))!.printifyProductId).toBe(`pf-${id.slice(0, 8)}`);
    expect(await auditActions(db, id)).toContain('printify.product.pending');

    h.clock.advance(31_000);
    const second = await orchestrator(h).runOnce();
    expect(second.status === 'ran' && second.outcome).toBe('done');
    const calls = h.agents.calls.filter((c) => c.agent === 'qaPublisher');
    expect((calls[1]!.input as { existingPrintifyProductId: string | null }).existingPrintifyProductId).toBe(`pf-${id.slice(0, 8)}`);
    expect((await productState(db, id)).state).toBe('drafted');
  });
});

/* ---------------------------------- analyze ---------------------------------- */

describe('analyze', () => {
  async function liveProduct(h: TestHarness) {
    const etsyId = h.integrations.fakes.etsy.createDraft('Live tee');
    const listing = h.integrations.fakes.etsy.listings.get(etsyId)!;
    listing.state = 'active';
    listing.views = 120;
    listing.numFavorers = 4;
    const id = await seedProduct(db, h.clock.now(), { state: 'live', withDesign: true, withListing: true, etsyListingId: etsyId });
    return { id, etsyId };
  }

  it('pulls metrics, writes the weekly report, retires and follows up as the analyst decided', async () => {
    const h = await harness();
    const live = await liveProduct(h);
    const nicheId = (await db.query<{ niche_id: string }>('SELECT niche_id FROM products WHERE id = $1', [live.id])).rows[0]!.niche_id;
    h.agents.behaviour.retire = [live.id, 'not-live-id'];
    h.agents.behaviour.followUps = [nicheId];
    h.integrations.fakes.etsy.receipts = [
      { receiptId: 1, listingId: live.etsyId, quantity: 2, priceAmount: 24.99, currency: 'EUR', createdAt: '2026-10-05T12:00:00.000Z' },
      { receiptId: 2, listingId: 999, quantity: 1, priceAmount: 10, currency: 'EUR', createdAt: '2026-10-05T12:00:00.000Z' },
    ];
    await runStep(h, 'analyze', { key: 'analyze:2026-10-06T10' });

    const metrics = await db.query<Record<string, unknown>>('SELECT etsy_listing_id, date::text AS date, views, favorites, orders, revenue_eur FROM metrics_daily ORDER BY date');
    expect(metrics.rows).toEqual([
      { etsy_listing_id: live.etsyId, date: '2026-10-05', views: 0, favorites: 0, orders: 2, revenue_eur: '49.98' },
      { etsy_listing_id: live.etsyId, date: '2026-10-06', views: 120, favorites: 4, orders: 0, revenue_eur: '0.00' },
    ]);
    const input = h.agents.calls.find((c) => c.agent === 'analyst')!.input as { listings: { orders: number; views: number; revenueEur: number }[]; weekStart: string };
    expect(input.weekStart).toBe('2026-10-05');
    expect(input.listings[0]).toMatchObject({ orders: 2, views: 120, revenueEur: 49.98 });

    expect((await productState(db, live.id)).state).toBe('retired');
    expect(h.integrations.fakes.etsy.updates).toEqual([{ listingId: live.etsyId, patch: { shouldAutoRenew: false } }]);
    expect(await auditActions(db, live.id)).toContain('product.retire');
    expect(await auditActions(db, String(live.etsyId))).toEqual(['etsy.listing.update']);
    expect((await jobsOf(db, { kind: 'validate_niche' }))[0]!.idempotency_key).toBe(`validate_niche:${nicheId}:followup:2026-10-05`);
    const report = await db.query<{ markdown: string }>('SELECT markdown FROM weekly_reports');
    expect(report.rows[0]!.markdown).toContain('Weekly report');
  });

  it('recomputes orders idempotently and throttles the analyst to once per interval', async () => {
    const h = await harness();
    const live = await liveProduct(h);
    h.integrations.fakes.etsy.receipts = [
      { receiptId: 1, listingId: live.etsyId, quantity: 1, priceAmount: 20, currency: 'EUR', createdAt: '2026-10-06T08:00:00.000Z' },
    ];
    await runStep(h, 'analyze', { key: 'analyze:1' });
    h.clock.advance(3600_000);
    await runStep(h, 'analyze', { key: 'analyze:2' });
    const orders = await db.query<{ orders: number }>('SELECT orders FROM metrics_daily WHERE date = $1::date', ['2026-10-06']);
    expect(orders.rows[0]!.orders).toBe(1);
    expect(h.agents.calls.filter((c) => c.agent === 'analyst')).toHaveLength(1);
    h.clock.advance(24 * 3600_000);
    await runStep(h, 'analyze', { key: 'analyze:3' });
    expect(h.agents.calls.filter((c) => c.agent === 'analyst')).toHaveLength(2);
  });

  it('keeps the product live when Etsy refuses the retirement (retried next run)', async () => {
    const h = await harness();
    const live = await liveProduct(h);
    h.agents.behaviour.retire = [live.id];
    h.integrations.fakes.etsy.failUpdates = true;
    const res = await runStep(h, 'analyze', { key: 'analyze:x' });
    expect(res.outcome).toBe('done');
    expect((await productState(db, live.id)).state).toBe('live');
    expect(h.logger.lines.some((l) => l.level === 'warn' && /retirement failed/.test(l.msg ?? ''))).toBe(true);
  });

  it('retries when the analyst fails and writes no report', async () => {
    const h = await harness({ throwFrom: { analyst: () => new Error('ollama 500') } });
    await liveProduct(h);
    const res = await runStep(h, 'analyze', { key: 'analyze:y' });
    expect(res.outcome).toBe('retry');
    expect((await db.query('SELECT * FROM weekly_reports')).rows).toHaveLength(0);
  });
});

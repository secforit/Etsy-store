import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/db.ts';
import { createDeskService } from '../desk/service.ts';
import { checkCaps, cloudAgentsFor } from './caps.ts';
import { Orchestrator } from './orchestrator.ts';
import { enqueue, productStepKey } from './queue.ts';
import { updateSettings } from './repo.ts';
import {
  auditActions,
  createHarness,
  jobsOf,
  makePng,
  productState,
  seedProduct,
  sharedTestDb,
  type FakeAgentBehaviour,
  type TestHarness,
} from './testing/fakes.ts';

let db: Db;
beforeEach(async () => {
  db = await sharedTestDb();
});

const harness = (agents: Partial<FakeAgentBehaviour> = {}) => createHarness({ db, agents });

async function finalCleared(h: TestHarness, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await seedProduct(db, h.clock.now(), { state: 'final_cleared', withDesign: true, withListing: true });
    await enqueue(db, { kind: 'qa_publish', productId: id, idempotencyKey: productStepKey('qa_publish', id, 0) }, h.clock.now());
    h.clock.advance(1000);
    ids.push(id);
  }
  return ids;
}

describe('runOnce gates', () => {
  it('does nothing while paused and resumes afterwards', async () => {
    const h = await harness();
    await enqueue(db, { kind: 'trend_scan', idempotencyKey: 't' }, h.clock.now());
    await updateSettings(db, { paused: true }, h.clock.now());
    const orch = new Orchestrator(h.deps, { cloudAgents: [] });
    expect((await orch.runOnce()).status).toBe('paused');
    expect((await jobsOf(db))[0]).toMatchObject({ status: 'queued', attempts: 0 });
    await updateSettings(db, { paused: false }, h.clock.now());
    expect((await orch.runOnce()).status).toBe('ran');
  });

  it('holds qa_publish back once the daily draft cap is reached, until the next UTC day', async () => {
    const h = await harness();
    await updateSettings(db, { dailyDraftCap: 2 }, h.clock.now());
    const ids = await finalCleared(h, 3);
    const orch = new Orchestrator(h.deps, { cloudAgents: [], qaPublish: { sleep: async () => {} } });
    const results = await orch.runUntilIdle();
    expect(results.filter((r) => r.status === 'ran')).toHaveLength(2);
    const last = results.at(-1)!;
    expect(last.status).toBe('idle');
    expect(last.caps).toMatchObject({ draftsToday: 2, draftCapReached: true, excludedKinds: ['qa_publish'] });
    expect((await productState(db, ids[2]!)).state).toBe('final_cleared');
    expect((await jobsOf(db, { productId: ids[2]! }))[0]).toMatchObject({ status: 'queued', attempts: 0 });

    // Other work still runs while the draft cap holds.
    await enqueue(db, { kind: 'trend_scan', idempotencyKey: 'scan' }, h.clock.now());
    expect((await orch.runOnce()).status).toBe('ran');

    h.clock.set('2026-10-07T00:00:05.000Z');
    const next = await orch.runOnce();
    expect(next.status === 'ran' && next.job.productId).toBe(ids[2]);
    expect((await productState(db, ids[2]!)).state).toBe('drafted');
  });

  it('holds back cloud-routed jobs once the daily cloud spend cap is reached; local jobs keep running', async () => {
    const h = await harness({ costUsd: 6 });
    const orch = new Orchestrator(h.deps, { cloudAgents: ['compliance_guard'] });
    const proposed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await seedProduct(db, h.clock.now(), { state: 'proposed' });
      await enqueue(db, { kind: 'concept_check', productId: id, idempotencyKey: productStepKey('concept_check', id, 0) }, h.clock.now());
      h.clock.advance(1000);
      proposed.push(id);
    }
    expect((await orch.runOnce()).status).toBe('ran'); // spend 6
    expect((await orch.runOnce()).status).toBe('ran'); // spend 12 >= 10
    const capped = await orch.runOnce();
    // The two concept checks enqueued design jobs; the designer is local, so design still runs.
    expect(capped.status === 'ran' && capped.job.kind).toBe('design');
    expect(capped.caps.spendCapReached).toBe(true);
    expect(capped.caps.excludedKinds).toEqual(expect.arrayContaining(['concept_check', 'final_check']));
    await orch.runUntilIdle();
    expect((await productState(db, proposed[2]!)).state).toBe('proposed');

    await updateSettings(db, { dailySpendCapUsd: 50 }, h.clock.now());
    await orch.runUntilIdle();
    expect((await productState(db, proposed[2]!)).state).not.toBe('proposed');
  });

  it('records local LLM calls at cost 0 so they never trip the spend cap', async () => {
    const h = await harness({ costUsd: 0 });
    await updateSettings(db, { dailySpendCapUsd: 0 }, h.clock.now());
    const id = await seedProduct(db, h.clock.now(), { state: 'proposed' });
    await enqueue(db, { kind: 'concept_check', productId: id, idempotencyKey: productStepKey('concept_check', id, 0) }, h.clock.now());
    // Only cloud agents are gated; with everything local nothing is excluded even at cap 0.
    const orch = new Orchestrator(h.deps, { cloudAgents: [] });
    await orch.runUntilIdle();
    const caps = await checkCaps(db, h.clock.now(), []);
    expect(caps.spendTodayUsd).toBe(0);
    expect(caps.excludedKinds).toEqual([]);
    const { rows } = await db.query<{ n: unknown }>('SELECT count(*) AS n FROM agent_runs WHERE cost_usd = 0');
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('counts cloud image generation (Recraft fallback) against the spend cap and holds design jobs at the cap', async () => {
    const h = await harness({ costUsd: 0 });
    await updateSettings(db, { dailySpendCapUsd: 0.1 }, h.clock.now());
    const orch = new Orchestrator(h.deps, { cloudAgents: ['designer'], imageGenCostUsd: 0.08 });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = await seedProduct(db, h.clock.now(), { state: 'cleared' });
      await enqueue(db, { kind: 'design', productId: id, idempotencyKey: productStepKey('design', id, 0) }, h.clock.now());
      h.clock.advance(1000);
      ids.push(id);
    }
    expect((await orch.runOnce()).status).toBe('ran');
    const { rows } = await db.query<{ model: string; cost_usd: unknown }>(`SELECT model, cost_usd FROM agent_runs WHERE cost_usd > 0`);
    expect(rows.map((r) => [r.model, Number(r.cost_usd)])).toEqual([['image:fake-flux', 0.08]]);
    expect((await orch.runOnce()).status).toBe('ran'); // 0.08 < 0.10: still allowed
    const capped = await checkCaps(db, h.clock.now(), ['designer']);
    expect(capped.spendTodayUsd).toBeCloseTo(0.16);
    expect(capped.excludedKinds).toEqual(['design']);
    for (const id of ids) expect((await productState(db, id)).state).toBe('designed');

    // A third design job now waits for the next UTC day.
    const third = await seedProduct(db, h.clock.now(), { state: 'cleared' });
    await enqueue(db, { kind: 'design', productId: third, idempotencyKey: productStepKey('design', third, 0) }, h.clock.now());
    expect((await orch.runOnce()).status).toBe('idle');
    h.clock.set('2026-10-07T00:00:01.000Z');
    expect((await orch.runOnce()).status).toBe('ran');
    expect((await productState(db, third)).state).toBe('designed');
  });

  it('maps routing config to cloud agents', () => {
    expect(cloudAgentsFor({ MODE: 'live', LLM_DEFAULT_PROVIDER: 'ollama', LLM_ROUTES: {}, IMAGEGEN_PROVIDER: 'recraft' })).toEqual(['designer']);
    expect(cloudAgentsFor({ MODE: 'live', LLM_DEFAULT_PROVIDER: 'ollama', LLM_ROUTES: {}, IMAGEGEN_PROVIDER: 'local' })).toEqual([]);
    expect(cloudAgentsFor({ MODE: 'live', LLM_DEFAULT_PROVIDER: 'ollama', LLM_ROUTES: {} })).toEqual([]);
    expect(cloudAgentsFor({ MODE: 'live', LLM_DEFAULT_PROVIDER: 'ollama', LLM_ROUTES: { compliance_guard: 'anthropic' } })).toEqual(['compliance_guard']);
    expect(cloudAgentsFor({ MODE: 'live', LLM_DEFAULT_PROVIDER: 'anthropic', LLM_ROUTES: { designer: 'ollama' } })).not.toContain('designer');
    expect(cloudAgentsFor({ MODE: 'mock', LLM_DEFAULT_PROVIDER: 'anthropic', LLM_ROUTES: {} })).toEqual([]);
  });

  it('fails a job after max attempts with backoff in between', async () => {
    const h = await harness({ throwFrom: { trendScout: () => new Error('flaky') } });
    await enqueue(db, { kind: 'trend_scan', idempotencyKey: 'flaky' }, h.clock.now());
    const orch = new Orchestrator(h.deps, { cloudAgents: [] });
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await orch.runOnce();
      if (r.status === 'ran') outcomes.push(r.outcome);
      h.clock.advance(3600_000);
    }
    expect(outcomes).toEqual(['retry', 'retry', 'failed']);
    expect((await jobsOf(db))[0]).toMatchObject({ status: 'failed', attempts: 3 });
    expect(await auditActions(db)).toContain('job.failed');
  });

  it('recovers a stale lock before claiming', async () => {
    const h = await harness();
    await enqueue(db, { kind: 'trend_scan', idempotencyKey: 'stuck' }, h.clock.now());
    await db.query(`UPDATE jobs SET status = 'running', attempts = 1, locked_at = $1`, [new Date(h.clock.now().getTime() - 20 * 60_000)]);
    const r = await new Orchestrator(h.deps, { cloudAgents: [] }).runOnce();
    expect(r.status === 'ran' && r.job.attempts).toBe(2);
    expect(await auditActions(db)).toContain('job.stale_recovered');
  });
});

describe('QA redesign loop', () => {
  it('returns the product to designed after each QA failure and blocks it after SHOP.caps.maxQaRedesigns redesigns', async () => {
    const h = await harness({ qa: () => 'qa_failed' });
    const orch = new Orchestrator(h.deps, { cloudAgents: [], qaPublish: { sleep: async () => {} } });
    const desk = createDeskService(h.deps);
    const max = h.deps.shop.caps.maxQaRedesigns;
    expect(max).toBe(2);
    const id = await seedProduct(db, h.clock.now(), { state: 'designed', withDesign: true, editedKey: null });

    for (let round = 0; round <= max; round++) {
      await desk.uploadEditedDesign(id, { bytes: await makePng(60, 72), filename: 'fix.png', mimeType: 'image/png' }, 'razvan');
      await orch.runUntilIdle(); // write -> final_check -> qa_publish (fails)
      const st = await productState(db, id);
      if (round < max) {
        expect(st).toMatchObject({ state: 'designed', attempt: round + 1 });
        expect((await desk.listProducts({ states: ['designed'] }))[0]).toMatchObject({ id, needsAction: true });
      } else {
        expect(st.state).toBe('blocked');
        expect(st.attempt).toBe(max);
        expect(st.blockReason).toMatch(/^QA failed after 2 redesign\(s\): Too many semi-transparent pixels/);
      }
    }

    // One QA run per upload; each redesign got its own upload, listing rewrite and checks (fresh idempotency keys).
    expect(h.agents.calls.filter((c) => c.agent === 'qaPublisher')).toHaveLength(max + 1);
    const keys = (await jobsOf(db, { productId: id })).map((j) => j.idempotency_key);
    for (let a = 0; a <= max; a++) {
      for (const kind of ['write', 'final_check', 'qa_publish'] as const) expect(keys).toContain(productStepKey(kind, id, a));
    }
    expect((await jobsOf(db, { productId: id })).every((j) => j.status === 'done')).toBe(true);
    const actions = await auditActions(db, id);
    expect(actions.filter((a) => a === 'design.upload')).toHaveLength(max + 1);
    expect(actions.filter((a) => a === 'product.qa_failed')).toHaveLength(max + 1);
    expect(actions.filter((a) => a === 'product.blocked')).toHaveLength(1);
    const events = await db.query<{ event: string }>('SELECT event FROM product_events WHERE product_id = $1 AND event LIKE $2', [id, 'qa_%']);
    expect(events.rows.map((r) => r.event).sort()).toEqual(['qa_fail', 'qa_fail', 'qa_fail_final']);
    expect(h.integrations.fakes.storage.blobs.has(`designs/${id}/edited-${max + 1}.png`)).toBe(true);

    // Blocked is terminal: no more uploads, no more jobs.
    await expect(
      desk.uploadEditedDesign(id, { bytes: await makePng(), filename: 'again.png', mimeType: 'image/png' }, 'razvan'),
    ).rejects.toThrow(/only while the product waits/);
    expect((await orch.runOnce()).status).toBe('idle');
  });

  it('a redesign that passes QA becomes a draft', async () => {
    const h = await harness({ qa: (_i, call) => (call === 0 ? 'qa_failed' : 'drafted') });
    const orch = new Orchestrator(h.deps, { cloudAgents: [], qaPublish: { sleep: async () => {} } });
    const desk = createDeskService(h.deps);
    const id = await seedProduct(db, h.clock.now(), { state: 'designed', withDesign: true, editedKey: null });
    await desk.uploadEditedDesign(id, { bytes: await makePng(), filename: 'a.png', mimeType: 'image/png' }, 'razvan');
    await orch.runUntilIdle();
    expect(await productState(db, id)).toMatchObject({ state: 'designed', attempt: 1 });
    await desk.uploadEditedDesign(id, { bytes: await makePng(), filename: 'b.png', mimeType: 'image/png' }, 'razvan');
    await orch.runUntilIdle();
    expect(await productState(db, id)).toMatchObject({ state: 'drafted', attempt: 1 });
    const qaInputs = h.agents.calls.filter((c) => c.agent === 'qaPublisher').map((c) => (c.input as { editedKey: string }).editedKey);
    expect(qaInputs).toEqual([`designs/${id}/edited-1.png`, `designs/${id}/edited-2.png`]);
  });
});

describe('full pipeline with fakes (trend scan -> draft -> approval)', () => {
  it('runs every step, waits for the human steps, and records every LLM call', async () => {
    const h = await harness({ productsPerNiche: 1 });
    const orch = new Orchestrator(h.deps, { cloudAgents: [], qaPublish: { sleep: async () => {} } });
    const desk = createDeskService(h.deps);
    await enqueue(db, { kind: 'trend_scan', idempotencyKey: 'trend_scan:2026-10-06' }, h.clock.now());
    await orch.runUntilIdle();

    const designed = await desk.listProducts({ states: ['designed'] });
    expect(designed).toHaveLength(2);
    expect(designed.every((p) => p.needsAction)).toBe(true);

    for (const p of designed) {
      await desk.uploadEditedDesign(p.id, { bytes: await makePng(120, 144), filename: 'x.png', mimeType: 'image/png' }, 'razvan');
    }
    await orch.runUntilIdle();
    const drafted = await desk.listProducts({ states: ['drafted'] });
    expect(drafted).toHaveLength(2);

    await desk.approve(drafted[0]!.id, 'razvan');
    await desk.reject(drafted[1]!.id, 'Too similar to a competitor design', 'razvan');
    expect((await productState(db, drafted[0]!.id)).state).toBe('live');
    expect((await productState(db, drafted[1]!.id)).state).toBe('rejected');

    const runs = await db.query<{ agent: string; n: unknown }>('SELECT agent, count(*) AS n FROM agent_runs GROUP BY agent ORDER BY agent');
    expect(Object.fromEntries(runs.rows.map((r) => [r.agent, Number(r.n)]))).toEqual({
      compliance_guard: 4,
      designer: 2,
      listing_writer: 2,
      niche_validator: 2,
      qa_publisher: 2,
      trend_scout: 1,
    });
    const jobs = await db.query<{ status: string; n: unknown }>('SELECT status, count(*) AS n FROM jobs GROUP BY status');
    expect(jobs.rows.map((r) => r.status)).toEqual(['done']);
    const dash = await desk.getDashboard();
    expect(dash.draftsToday).toBe(2);
    expect(dash.countsByState.live).toBe(1);
  });
});

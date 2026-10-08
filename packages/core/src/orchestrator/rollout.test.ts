import { beforeEach, describe, expect, it } from 'vitest';
import { SHOP } from '../config/shop.ts';
import type { Db } from '../db/db.ts';
import { UNATTRIBUTED_SOURCE, blockRateBySource, loadRolloutMetrics, loadRolloutScorecard } from './rollout.ts';
import { seedNiche, seedProduct, sharedTestDb } from './testing/fakes.ts';

let db: Db;
const now = new Date('2026-10-08T12:00:00Z');

beforeEach(async () => {
  db = await sharedTestDb();
});

async function signal(source: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO trend_signals (source, keyword, score, fetched_at) VALUES ($1, 'retro camping', 50, $2) RETURNING id`,
    [source, now],
  );
  return rows[0]!.id;
}

async function nicheFrom(signalIds: string[]): Promise<string> {
  const id = await seedNiche(db, now);
  await db.query('UPDATE niches SET source_signal_ids = $1::uuid[] WHERE id = $2', [signalIds, id]);
  return id;
}

async function checked(nicheId: string, verdicts: ('pass' | 'block')[]): Promise<string> {
  const id = await seedProduct(db, now, { nicheId, state: verdicts.includes('block') ? 'blocked' : 'cleared' });
  for (const [i, verdict] of verdicts.entries()) {
    await db.query(`INSERT INTO compliance_checks (product_id, stage, verdict, created_at) VALUES ($1, $2, $3, $4)`, [
      id,
      i === 0 ? 'concept' : 'final',
      verdict,
      now,
    ]);
  }
  return id;
}

async function drafted(decision: 'approve' | 'reject' | null, opts: { ipMiss?: boolean; etsyListingId?: number } = {}): Promise<string> {
  const state = decision === 'approve' ? 'live' : decision === 'reject' ? 'rejected' : 'drafted';
  const id = await seedProduct(db, now, { state, withListing: true, etsyListingId: opts.etsyListingId ?? null });
  await db.query(
    `INSERT INTO product_events (product_id, from_state, to_state, event, actor, created_at) VALUES ($1, 'final_cleared', 'drafted', 'qa_pass', 'qa_publisher', $2)`,
    [id, now],
  );
  if (decision) {
    await db.query('INSERT INTO approvals (product_id, decision, reason, actor, decided_at, ip_miss) VALUES ($1, $2, $3, $4, $5, $6)', [
      id,
      decision,
      decision === 'reject' ? 'not original enough' : null,
      'razvan',
      now,
      opts.ipMiss ?? false,
    ]);
  }
  return id;
}

async function metricsDay(etsyListingId: number, date: string, m: { views: number; favorites: number; orders: number; revenueEur: number }) {
  await db.query(
    'INSERT INTO metrics_daily (etsy_listing_id, date, views, favorites, orders, revenue_eur) VALUES ($1, $2::date, $3, $4, $5, $6)',
    [etsyListingId, date, m.views, m.favorites, m.orders, m.revenueEur],
  );
}

describe('loadRolloutMetrics', () => {
  it('is all zeros and nulls on an empty database', async () => {
    const m = await loadRolloutMetrics(db, SHOP);
    expect(m).toEqual({
      draftsMade: 0,
      draftsReviewed: 0,
      approved: 0,
      rejected: 0,
      approvalRate: null,
      ipMisses: 0,
      cloudSpendUsd: 0,
      listingFeesUsd: 0,
      costPerListingUsd: null,
      views: 0,
      favorites: 0,
      orders: 0,
      revenueEur: 0,
      conversion: null,
      revenuePerOrderEur: null,
      blockRateBySource: [],
    });
  });

  it('counts drafts, decisions, IP misses, spend, fees, sales and conversion', async () => {
    await drafted('approve', { etsyListingId: 101 });
    await drafted('approve', { etsyListingId: 102 });
    await drafted('approve', { etsyListingId: 103 });
    await drafted('reject');
    await drafted('reject', { ipMiss: true });
    await drafted(null); // waiting for a decision: made, not reviewed
    await db.query(`INSERT INTO agent_runs (agent, model, cost_usd, ok, created_at) VALUES ('listing_writer', 'cloud', 0.0412, true, $1), ('designer', 'gemma4:12b', 0, true, $1)`, [now]);
    // Views/favorites are cumulative snapshots (take the latest), orders/revenue are per day (sum).
    await metricsDay(101, '2026-10-06', { views: 40, favorites: 2, orders: 1, revenueEur: 25.99 });
    await metricsDay(101, '2026-10-07', { views: 55, favorites: 3, orders: 2, revenueEur: 51.98 });
    await metricsDay(102, '2026-10-07', { views: 45, favorites: 0, orders: 0, revenueEur: 0 });

    const m = await loadRolloutMetrics(db, SHOP);
    expect(m).toMatchObject({
      draftsMade: 6,
      draftsReviewed: 5,
      approved: 3,
      rejected: 2,
      approvalRate: 0.6,
      ipMisses: 1,
      cloudSpendUsd: 0.04,
      listingFeesUsd: 0.6,
      costPerListingUsd: 0.21, // (0.04 + 3 x 0.20) / 3
      views: 100,
      favorites: 3,
      orders: 3,
      revenueEur: 77.97,
      conversion: 0.03,
      revenuePerOrderEur: 25.99,
    });
  });

  it('a product that reached drafted twice (after a redesign) counts as one draft', async () => {
    const id = await drafted('approve');
    await db.query(
      `INSERT INTO product_events (product_id, from_state, to_state, event, actor, created_at) VALUES ($1, 'final_cleared', 'drafted', 'qa_pass', 'qa_publisher', $2)`,
      [id, now],
    );
    expect((await loadRolloutMetrics(db, SHOP)).draftsMade).toBe(1);
  });
});

describe('blockRateBySource', () => {
  it('attributes checked products to every source of their niche and counts a block at either stage once', async () => {
    const etsy = await signal('etsy_search');
    const pin = await signal('pinterest');
    const seasonal = await signal('seasonal');
    const mixed = await nicheFrom([etsy, pin]);
    const seasonalOnly = await nicheFrom([seasonal]);
    const none = await nicheFrom([]);

    await checked(mixed, ['block']); // blocked at concept
    await checked(mixed, ['pass', 'block']); // blocked at final
    await checked(mixed, ['pass', 'pass']);
    await checked(seasonalOnly, ['pass']);
    await checked(none, ['block']);
    await seedProduct(db, now, { nicheId: seasonalOnly, state: 'proposed' }); // not checked yet: not counted

    expect(await blockRateBySource(db)).toEqual([
      { source: UNATTRIBUTED_SOURCE, checked: 1, blocked: 1, rate: 1 },
      { source: 'etsy_search', checked: 3, blocked: 2, rate: 0.6667 },
      { source: 'pinterest', checked: 3, blocked: 2, rate: 0.6667 },
      { source: 'seasonal', checked: 1, blocked: 0, rate: 0 },
    ]);
  });

  it('a niche listing the same source twice counts its products once for that source', async () => {
    const a = await signal('etsy_search');
    const b = await signal('etsy_search');
    await checked(await nicheFrom([a, b]), ['pass']);
    expect(await blockRateBySource(db)).toEqual([{ source: 'etsy_search', checked: 1, blocked: 0, rate: 0 }]);
  });
});

describe('loadRolloutScorecard', () => {
  it('evaluates both gates from the stored data', async () => {
    await drafted('approve', { etsyListingId: 201 });
    await drafted('reject', { ipMiss: true });
    const card = await loadRolloutScorecard(db, SHOP);
    expect(card.metrics.draftsReviewed).toBe(2);
    expect(card.gates.map((g) => [g.id, g.status])).toEqual([
      ['gate2', 'open'],
      ['gate3', 'open'],
    ]);
    expect(card.gates[0]!.checks.find((c) => c.id === 'ip_misses')).toMatchObject({ value: '1', status: 'not_met' });
    expect(card.gates[1]!.checks.find((c) => c.id === 'cost_per_listing')).toMatchObject({ value: '$0.20', status: 'met' });
  });
});

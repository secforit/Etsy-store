/**
 * Loads the all-time numbers behind the rollout gates (domain/rollout.ts) from the database. Read-only and cheap:
 * a handful of aggregate queries over small tables, no external calls, so the desk can show it on every load.
 */
import type { ShopConfig } from '../config/shop.ts';
import type { Queryable } from '../db/db.ts';
import { evaluateGates, type RolloutMetrics, type RolloutScorecard, type TrendSourceBlockRate } from '../domain/rollout.ts';
import { roundCents, toNum } from './repo.ts';

export const UNATTRIBUTED_SOURCE = 'unattributed';

/**
 * Products that went through a compliance check, by the trend sources of their niche. A niche built from signals
 * of two sources counts its products under both; a niche without recorded signals counts as `unattributed`.
 */
export async function blockRateBySource(q: Queryable): Promise<TrendSourceBlockRate[]> {
  const { rows } = await q.query<{ source: string; checked: unknown; blocked: unknown }>(
    `WITH checked AS (
       SELECT p.id, p.niche_id, bool_or(c.verdict = 'block') AS blocked
       FROM products p JOIN compliance_checks c ON c.product_id = p.id
       GROUP BY p.id, p.niche_id
     ), niche_sources AS (
       SELECT DISTINCT n.id AS niche_id, s.source
       FROM niches n JOIN trend_signals s ON s.id = ANY(n.source_signal_ids)
     )
     SELECT COALESCE(ns.source, $1) AS source, count(*) AS checked, count(*) FILTER (WHERE ch.blocked) AS blocked
     FROM checked ch LEFT JOIN niche_sources ns ON ns.niche_id = ch.niche_id
     GROUP BY COALESCE(ns.source, $1)`,
    [UNATTRIBUTED_SOURCE],
  );
  return rows
    .map((r) => {
      const checked = toNum(r.checked);
      const blocked = toNum(r.blocked);
      return { source: String(r.source), checked, blocked, rate: checked > 0 ? Math.round((blocked / checked) * 10_000) / 10_000 : 0 };
    })
    .sort((a, b) => b.rate - a.rate || b.checked - a.checked || a.source.localeCompare(b.source));
}

export async function loadRolloutMetrics(q: Queryable, shop: Pick<ShopConfig, 'pricing'>): Promise<RolloutMetrics> {
  const [drafts, decisions, spend, sales, bySource] = await Promise.all([
    q.query<{ n: unknown }>(`SELECT count(DISTINCT product_id) AS n FROM product_events WHERE to_state = 'drafted'`),
    q.query<{ decision: string; n: unknown; ip: unknown }>(
      'SELECT decision, count(*) AS n, count(*) FILTER (WHERE ip_miss) AS ip FROM approvals GROUP BY decision',
    ),
    q.query<{ s: unknown }>('SELECT COALESCE(sum(cost_usd), 0) AS s FROM agent_runs'),
    // views and favorites are cumulative snapshots per day (latest = max); orders and revenue are per day (sum).
    q.query<{ views: unknown; favorites: unknown; orders: unknown; revenue: unknown }>(
      `SELECT COALESCE(sum(v), 0) AS views, COALESCE(sum(f), 0) AS favorites, COALESCE(sum(o), 0) AS orders, COALESCE(sum(r), 0) AS revenue
       FROM (SELECT max(views) AS v, max(favorites) AS f, sum(orders) AS o, sum(revenue_eur) AS r FROM metrics_daily GROUP BY etsy_listing_id) per_listing`,
    ),
    blockRateBySource(q),
  ]);

  const decision = (d: string) => decisions.rows.find((r) => r.decision === d);
  const approved = toNum(decision('approve')?.n ?? 0);
  const rejected = toNum(decision('reject')?.n ?? 0);
  const reviewed = approved + rejected;
  const rawSpendUsd = toNum(spend.rows[0]?.s ?? 0);
  const rawFeesUsd = approved * shop.pricing.listingFeeUsd;
  const s = sales.rows[0];
  const views = toNum(s?.views ?? 0);
  const orders = toNum(s?.orders ?? 0);
  const revenueEur = roundCents(toNum(s?.revenue ?? 0));

  return {
    draftsMade: toNum(drafts.rows[0]?.n ?? 0),
    draftsReviewed: reviewed,
    approved,
    rejected,
    approvalRate: reviewed > 0 ? Math.round((approved / reviewed) * 10_000) / 10_000 : null,
    ipMisses: toNum(decision('reject')?.ip ?? 0),
    cloudSpendUsd: roundCents(rawSpendUsd),
    listingFeesUsd: roundCents(rawFeesUsd),
    costPerListingUsd: approved > 0 ? roundCents((rawSpendUsd + rawFeesUsd) / approved) : null,
    views,
    favorites: toNum(s?.favorites ?? 0),
    orders,
    revenueEur,
    conversion: views > 0 ? Math.round((orders / views) * 10_000) / 10_000 : null,
    revenuePerOrderEur: orders > 0 ? roundCents(revenueEur / orders) : null,
    blockRateBySource: bySource,
  };
}

export async function loadRolloutScorecard(q: Queryable, shop: Pick<ShopConfig, 'pricing'>): Promise<RolloutScorecard> {
  const metrics = await loadRolloutMetrics(q, shop);
  return { metrics, gates: evaluateGates(metrics) };
}

/**
 * Rollout gates (architecture doc, "Rollout plan" and "Metrics"): the system earns a higher daily cap only after a
 * gate shows it is safe and profitable at the current one. If a gate fails, the phase repeats with fixes; the cap
 * never goes up to make up for a weak result.
 *   Gate 2 (Pilot -> Automate): 50 drafts reviewed, 60% or more approved, no IP misses
 *   Gate 3 (Automate -> Scale): first sales in, cost per published listing <= $0.25, margin close to the model
 * Pure rules over metrics computed by orchestrator/rollout.ts. The margin check stays manual: Printify's actual
 * order costs are not pulled yet, so there is nothing to compare the margin model against.
 */

export const ROLLOUT_TARGETS = {
  minDraftsReviewed: 50,
  minApprovalRate: 0.6,
  maxIpMisses: 0,
  minOrders: 1,
  maxCostPerListingUsd: 0.25,
} as const;

export interface TrendSourceBlockRate {
  /** Trend source name ('etsy_search', 'pinterest', 'seasonal'...), or 'unattributed' when the niche lists none. */
  source: string;
  /** Products from this source's niches that went through a compliance check. */
  checked: number;
  /** Of those, products the Compliance Guard blocked (concept or final). */
  blocked: number;
  rate: number;
}

/** All-time numbers behind the gates. Money: USD for model spend and Etsy fees, EUR for revenue. */
export interface RolloutMetrics {
  /** Products that reached `drafted` (an Etsy draft was created). */
  draftsMade: number;
  draftsReviewed: number;
  approved: number;
  rejected: number;
  /** approved / reviewed; null before the first decision. */
  approvalRate: number | null;
  /** Rejections marked as an IP / trademark problem the Compliance Guard did not catch. */
  ipMisses: number;
  cloudSpendUsd: number;
  /** Etsy listing fee for every approved (published) listing. */
  listingFeesUsd: number;
  /** (cloud spend + listing fees) / approved; null before the first approval. */
  costPerListingUsd: number | null;
  /** Etsy's `views` window is undocumented: compare listings with each other, never read it as an absolute. */
  views: number;
  favorites: number;
  orders: number;
  revenueEur: number;
  /** orders / views; null without views. */
  conversion: number | null;
  revenuePerOrderEur: number | null;
  blockRateBySource: TrendSourceBlockRate[];
}

/** `waiting`: not enough data yet. `manual`: the operator decides (the code cannot measure it). */
export type GateCheckStatus = 'met' | 'not_met' | 'waiting' | 'manual';

export interface GateCheck {
  id: 'drafts_reviewed' | 'approval_rate' | 'ip_misses' | 'first_sales' | 'cost_per_listing' | 'margin';
  label: string;
  target: string;
  value: string;
  status: GateCheckStatus;
  note: string | null;
}

/** `passed`: every check met. `review`: every measured check met, a manual one is left. `open`: otherwise. */
export type GateStatus = 'passed' | 'review' | 'open';

export interface RolloutGate {
  id: 'gate2' | 'gate3';
  title: string;
  /** What passing it allows. */
  unlocks: string;
  status: GateStatus;
  checks: GateCheck[];
}

export interface RolloutScorecard {
  metrics: RolloutMetrics;
  gates: RolloutGate[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (x: number) => `$${x.toFixed(2)}`;
const eur = (x: number) => `EUR ${x.toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function gateStatus(checks: GateCheck[]): GateStatus {
  if (checks.every((c) => c.status === 'met')) return 'passed';
  if (checks.every((c) => c.status === 'met' || c.status === 'manual')) return 'review';
  return 'open';
}

export function evaluateGates(m: RolloutMetrics, t: typeof ROLLOUT_TARGETS = ROLLOUT_TARGETS): RolloutGate[] {
  const reviewed = m.draftsReviewed;
  const gate2: GateCheck[] = [
    {
      id: 'drafts_reviewed',
      label: 'Drafts reviewed',
      target: `${t.minDraftsReviewed}`,
      value: `${reviewed} of ${t.minDraftsReviewed}`,
      status: reviewed >= t.minDraftsReviewed ? 'met' : 'waiting',
      note: null,
    },
    {
      id: 'approval_rate',
      label: 'Approved',
      target: `${pct(t.minApprovalRate)} or more`,
      value: m.approvalRate === null ? 'no decisions yet' : `${pct(m.approvalRate)} (${m.approved} of ${reviewed})`,
      status: m.approvalRate === null ? 'waiting' : m.approvalRate >= t.minApprovalRate ? 'met' : 'not_met',
      note: reviewed > 0 && reviewed < t.minDraftsReviewed ? `so far; final once ${t.minDraftsReviewed} drafts are reviewed` : null,
    },
    {
      id: 'ip_misses',
      label: 'IP misses',
      target: `${t.maxIpMisses}`,
      value: `${m.ipMisses}`,
      status: m.ipMisses > t.maxIpMisses ? 'not_met' : reviewed === 0 ? 'waiting' : 'met',
      note: 'rejections you marked as an IP problem the compliance check missed',
    },
  ];
  const gate3: GateCheck[] = [
    {
      id: 'first_sales',
      label: 'First sales',
      target: `${plural(t.minOrders, 'order')} or more`,
      value: plural(m.orders, 'order'),
      status: m.orders >= t.minOrders ? 'met' : 'waiting',
      note: null,
    },
    {
      id: 'cost_per_listing',
      label: 'Cost per published listing',
      target: `${usd(t.maxCostPerListingUsd)} or less`,
      value: m.costPerListingUsd === null ? 'nothing published yet' : usd(m.costPerListingUsd),
      status: m.costPerListingUsd === null ? 'waiting' : m.costPerListingUsd <= t.maxCostPerListingUsd + 1e-9 ? 'met' : 'not_met',
      note: `cloud model spend ${usd(m.cloudSpendUsd)} + Etsy listing fees ${usd(m.listingFeesUsd)}, over ${plural(m.approved, 'listing')}`,
    },
    {
      id: 'margin',
      label: 'Margin per sale',
      target: 'close to the margin model',
      value: m.revenuePerOrderEur === null ? 'no sales yet' : `${eur(m.revenuePerOrderEur)} revenue per order`,
      status: 'manual',
      note: "compare Printify's order costs with the margin estimate on each product page",
    },
  ];
  return [
    { id: 'gate2', title: 'Gate 2: pilot quality', unlocks: 'Phase 3 (Automate): raise the daily draft cap to 10', status: gateStatus(gate2), checks: gate2 },
    { id: 'gate3', title: 'Gate 3: first profit', unlocks: 'Phase 4 (Scale): raise the cap in steps', status: gateStatus(gate3), checks: gate3 },
  ];
}

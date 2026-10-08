import { describe, expect, it } from 'vitest';
import { evaluateGates, gateStatus, type GateCheck, type RolloutMetrics } from './rollout.ts';

function metrics(over: Partial<RolloutMetrics> = {}): RolloutMetrics {
  return {
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
    ...over,
  };
}

const check = (gates: ReturnType<typeof evaluateGates>, id: GateCheck['id']) => gates.flatMap((g) => g.checks).find((c) => c.id === id)!;

describe('evaluateGates', () => {
  it('waits on every measured check before any data exists; the margin check is always manual', () => {
    const gates = evaluateGates(metrics());
    expect(gates.map((g) => [g.id, g.status])).toEqual([
      ['gate2', 'open'],
      ['gate3', 'open'],
    ]);
    expect(gates.flatMap((g) => g.checks).map((c) => [c.id, c.status])).toEqual([
      ['drafts_reviewed', 'waiting'],
      ['approval_rate', 'waiting'],
      ['ip_misses', 'waiting'],
      ['first_sales', 'waiting'],
      ['cost_per_listing', 'waiting'],
      ['margin', 'manual'],
    ]);
  });

  it('passes Gate 2 at 50 reviewed, 60% approved and no IP misses', () => {
    const gates = evaluateGates(metrics({ draftsReviewed: 50, approved: 30, rejected: 20, approvalRate: 0.6 }));
    expect(gates[0]!.status).toBe('passed');
    expect(check(gates, 'approval_rate')).toMatchObject({ value: '60% (30 of 50)', status: 'met', note: null });
    expect(check(gates, 'drafts_reviewed').value).toBe('50 of 50');
  });

  it('reports the approval rate so far, below target, before 50 drafts are reviewed', () => {
    const gates = evaluateGates(metrics({ draftsReviewed: 10, approved: 5, rejected: 5, approvalRate: 0.5 }));
    expect(check(gates, 'approval_rate')).toMatchObject({ status: 'not_met', value: '50% (5 of 10)' });
    expect(check(gates, 'approval_rate').note).toMatch(/so far/);
    expect(check(gates, 'drafts_reviewed').status).toBe('waiting');
    expect(gates[0]!.status).toBe('open');
  });

  it('a single IP miss keeps Gate 2 closed whatever the other numbers say', () => {
    const gates = evaluateGates(metrics({ draftsReviewed: 80, approved: 70, rejected: 10, approvalRate: 0.875, ipMisses: 1 }));
    expect(check(gates, 'ip_misses').status).toBe('not_met');
    expect(gates[0]!.status).toBe('open');
  });

  it('Gate 3 is ready for review (not passed) when sales are in and cost per listing is within budget', () => {
    const gates = evaluateGates(
      metrics({ approved: 4, orders: 3, revenueEur: 77.97, revenuePerOrderEur: 25.99, listingFeesUsd: 0.8, costPerListingUsd: 0.2 }),
    );
    expect(check(gates, 'first_sales')).toMatchObject({ status: 'met', value: '3 orders' });
    expect(check(gates, 'cost_per_listing')).toMatchObject({ status: 'met', value: '$0.20' });
    expect(check(gates, 'cost_per_listing').note).toContain('over 4 listings');
    expect(check(gates, 'margin')).toMatchObject({ status: 'manual', value: 'EUR 25.99 revenue per order' });
    expect(gates[1]!.status).toBe('review');
  });

  it('cost per listing above $0.25 fails Gate 3; exactly $0.25 meets it', () => {
    expect(check(evaluateGates(metrics({ approved: 2, costPerListingUsd: 0.26 })), 'cost_per_listing').status).toBe('not_met');
    expect(check(evaluateGates(metrics({ approved: 2, costPerListingUsd: 0.25 })), 'cost_per_listing').status).toBe('met');
  });
});

describe('gateStatus', () => {
  const c = (status: GateCheck['status']): GateCheck => ({ id: 'margin', label: '', target: '', value: '', status, note: null });
  it('passed only when every check is met; review when only manual checks remain', () => {
    expect(gateStatus([c('met'), c('met')])).toBe('passed');
    expect(gateStatus([c('met'), c('manual')])).toBe('review');
    expect(gateStatus([c('waiting'), c('manual')])).toBe('open');
    expect(gateStatus([c('met'), c('not_met')])).toBe('open');
  });
});

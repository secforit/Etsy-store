import { describe, expect, it } from 'vitest';
import type { AnalystInput } from './contracts.ts';
import { decideFollowUps, decideRetirements, quantile, runAnalyst } from './analyst.ts';
import { ScriptedLlm, TODAY, shop } from './testing/fakes.ts';

const l = (productId: string, over: Partial<AnalystInput['listings'][number]> = {}): AnalystInput['listings'][number] => ({
  productId,
  etsyListingId: 1,
  nicheId: `niche-${productId}`,
  theme: `Theme ${productId}`,
  ageDays: 90,
  views: 100,
  favorites: 0,
  orders: 0,
  revenueEur: 0,
  ...over,
});

const input: AnalystInput = {
  listings: [
    l('a', { views: 5 }), // old, no favs, bottom quartile -> retire
    l('b', { views: 6, ageDays: 30 }), // too young
    l('c', { views: 4, favorites: 1 }), // has a favorite
    l('d', { views: 200, orders: 2, revenueEur: 49.98, nicheId: 'n-win' }),
    l('e', { views: 300, orders: 1, revenueEur: 24.99, nicheId: 'n-win' }),
    l('f', { views: 150 }), // old, no favs, but not bottom quartile
  ],
  weekStart: '2026-10-05',
  spendUsdThisWeek: 0,
  draftsThisWeek: 5,
  approvalsThisWeek: 3,
  rejectionsThisWeek: 1,
};

describe('Analyst code rules', () => {
  it('computes quartiles', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([10], 0.25)).toBe(10);
  });

  it('retires only old listings with no favorites, no orders and bottom-quartile views', () => {
    // views sorted: 4,5,6,100? -> [4,5,6,150,200,300], q1 = 5.25
    expect(decideRetirements(input.listings, shop.caps.retireAfterDays)).toEqual(['a']);
  });

  it('follows up niches with orders', () => {
    expect(decideFollowUps(input.listings)).toEqual(['n-win']);
  });

  it('ignores the model for decisions and prepends a code facts block to its report', async () => {
    const llm = new ScriptedLlm({ analyst: () => ({ reportMarkdown: '## Summary\nRetire everything! (model opinion)' }) });
    const { output, llmUsage } = await runAnalyst(input, { llm, shop, today: TODAY });
    expect(output.retireProductIds).toEqual(['a']);
    expect(output.followUpNicheIds).toEqual(['n-win']);
    expect(output.reportMarkdown.startsWith('# Weekly report: week of 2026-10-05')).toBe(true);
    expect(output.reportMarkdown).toContain('| Orders | 3 |');
    expect(output.reportMarkdown).toContain('| Revenue (EUR) | 74.97 |');
    expect(output.reportMarkdown).toContain('Retire everything!');
    expect(llmUsage).toHaveLength(1);
  });

  it('writes a code-only report without calling the model when there are no listings', async () => {
    const llm = new ScriptedLlm({});
    const { output, llmUsage } = await runAnalyst({ ...input, listings: [] }, { llm, shop, today: TODAY });
    expect(output.retireProductIds).toEqual([]);
    expect(output.reportMarkdown).toContain('No live listings');
    expect(llmUsage).toEqual([]);
  });
});

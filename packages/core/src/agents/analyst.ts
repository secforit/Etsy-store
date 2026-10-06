/**
 * 7. Analyst: retirements and follow-ups are decided by CODE; the model only writes the narrative report.
 *  - retire: age >= SHOP.caps.retireAfterDays, 0 favorites, 0 orders, views in the bottom quartile
 *  - follow up: niches with at least one order this period (new designs, never copies)
 * The report always starts with a code-generated facts block so numbers never depend on the model.
 */
import { z } from 'zod';
import type { LlmUsage } from '../llm/types.ts';
import { AnalystOutputSchema, type AnalystInput, type RunAnalyst } from './contracts.ts';
import { askModel } from './common.ts';
import { roundCents } from './pricing.ts';
import { ANALYST_SYSTEM, analystInstructions } from './prompts.ts';
import { clip } from './rules.ts';

export const AnalystModelSchema = z.object({ reportMarkdown: z.string().min(20).max(15000) });

const MAX_LISTINGS_FOR_MODEL = 60;

/** Linear-interpolated quantile of a non-empty list. */
export function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (pos - lo);
}

export function decideRetirements(listings: AnalystInput['listings'], retireAfterDays: number): string[] {
  if (listings.length === 0) return [];
  const q1 = quantile(
    listings.map((l) => l.views),
    0.25,
  );
  return [
    ...new Set(
      listings
        .filter((l) => l.ageDays >= retireAfterDays && l.favorites === 0 && l.orders === 0 && l.views <= q1)
        .map((l) => l.productId),
    ),
  ].sort();
}

export function decideFollowUps(listings: AnalystInput['listings']): string[] {
  return [...new Set(listings.filter((l) => l.orders > 0).map((l) => l.nicheId))].sort();
}

function factsBlock(input: AnalystInput, retire: string[], followUps: string[], retireAfterDays: number): string {
  const sum = (f: (l: AnalystInput['listings'][number]) => number) => input.listings.reduce((a, l) => a + f(l), 0);
  const themeOf = (nicheId: string) => input.listings.find((l) => l.nicheId === nicheId)?.theme ?? nicheId;
  const safe = (s: string) => s.replace(/[|\r\n`<>]/g, ' ').slice(0, 80);
  return [
    `# Weekly report: week of ${input.weekStart}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Live listings | ${input.listings.length} |`,
    `| Views | ${sum((l) => l.views)} |`,
    `| Favorites | ${sum((l) => l.favorites)} |`,
    `| Orders | ${sum((l) => l.orders)} |`,
    `| Revenue (EUR) | ${roundCents(sum((l) => l.revenueEur)).toFixed(2)} |`,
    `| Drafts / approvals / rejections this week | ${input.draftsThisWeek} / ${input.approvalsThisWeek} / ${input.rejectionsThisWeek} |`,
    `| Cloud model spend this week (USD) | ${roundCents(input.spendUsdThisWeek).toFixed(2)} |`,
    '',
    `**Retire** (code rule: ${retireAfterDays}+ days, no favorites, no orders, bottom-quartile views): ${retire.length ? retire.join(', ') : 'none'}`,
    '',
    `**Follow-up niches** (had orders): ${followUps.length ? followUps.map((id) => safe(themeOf(id))).join(', ') : 'none'}`,
  ].join('\n');
}

export const runAnalyst: RunAnalyst = async (input, deps) => {
  const usage: LlmUsage[] = [];
  const retireAfterDays = deps.shop.caps.retireAfterDays;
  const retireProductIds = decideRetirements(input.listings, retireAfterDays);
  const followUpNicheIds = decideFollowUps(input.listings);
  const facts = factsBlock(input, retireProductIds, followUpNicheIds, retireAfterDays);

  let narrative: string;
  if (input.listings.length === 0) {
    narrative = '## Summary\nNo live listings to analyse yet.';
  } else {
    const top = [...input.listings]
      .sort((a, b) => b.revenueEur - a.revenueEur || b.orders - a.orders || b.views - a.views)
      .slice(0, MAX_LISTINGS_FOR_MODEL);
    const res = await askModel(
      deps.llm,
      {
        agent: 'analyst',
        tier: 'large',
        system: ANALYST_SYSTEM,
        instructions: analystInstructions({ weekStart: input.weekStart }),
        untrustedData: {
          listings: top,
          totals: {
            listings: input.listings.length,
            spendUsdThisWeek: input.spendUsdThisWeek,
            draftsThisWeek: input.draftsThisWeek,
            approvalsThisWeek: input.approvalsThisWeek,
            rejectionsThisWeek: input.rejectionsThisWeek,
          },
          decisions: { retireProductIds, followUpNicheIds, retireAfterDays },
        },
        schema: AnalystModelSchema,
        maxOutputTokens: 2500,
      },
      usage,
    );
    narrative = res.reportMarkdown.trim();
  }

  const reportMarkdown = clip(`${facts}\n\n${narrative}`, 20_000);
  const output = AnalystOutputSchema.parse({ retireProductIds, followUpNicheIds, reportMarkdown });
  return { output, llmUsage: usage };
};

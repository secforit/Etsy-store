/**
 * 1. Trend Scout: trend signals -> up to SHOP.caps.maxNichesPerScan niches.
 * Code after the model: keeps only real signal ids, normalises/dedupes keywords, drops niches that hit the
 * blocklist (settings + baseline) or repeat an existing theme, caps the count.
 */
import {
  TrendScoutOutputSchema,
  type RunTrendScout,
  type TrendScoutInput,
  type TrendScoutOutput,
} from './contracts.ts';
import type { LlmUsage } from '../llm/types.ts';
import { AGENT_DEFAULT_TIERS } from '../llm/tiers.ts';
import { askModel } from './common.ts';
import { trendScoutInstructions, trendScoutSystem } from './prompts.ts';
import { clip, collapseSpaces, effectiveBlocklist, findBlocklistHits, normalizeText, sameTerm } from './rules.ts';

/** Signals sent to the model (highest score first). Keeps the prompt well inside 16k tokens. */
export const MAX_SIGNALS_IN_PROMPT = 80;

export const TrendScoutModelSchema = TrendScoutOutputSchema;

export const runTrendScout: RunTrendScout = async (input, deps) => {
  const usage: LlmUsage[] = [];
  const maxNiches = deps.shop.caps.maxNichesPerScan;
  if (input.signals.length === 0) return { output: { niches: [] }, llmUsage: usage };

  const blocklist = effectiveBlocklist(input.blocklist);
  const signals = [...input.signals]
    .sort((a, b) => b.score - a.score || a.keyword.localeCompare(b.keyword))
    .slice(0, MAX_SIGNALS_IN_PROMPT)
    .map((s) => ({ id: s.id, source: s.source, keyword: s.keyword, region: s.region, score: s.score, growth: s.growth }));

  const raw = await askModel(
    deps.llm,
    {
      agent: 'trend_scout',
      tier: AGENT_DEFAULT_TIERS.trend_scout,
      system: trendScoutSystem(maxNiches),
      instructions: trendScoutInstructions({ today: deps.today, productTypes: input.productTypes, blocklist }),
      untrustedData: {
        signals,
        recentWinners: input.recentWinners.slice(0, 20),
        existingThemes: input.existingThemes.slice(0, 200),
      },
      schema: TrendScoutModelSchema,
      maxOutputTokens: 3000,
    },
    usage,
  );

  return { output: postProcessNiches(raw, input, blocklist, maxNiches), llmUsage: usage };
};

export function postProcessNiches(
  raw: TrendScoutOutput,
  input: TrendScoutInput,
  blocklist: string[],
  maxNiches: number,
): TrendScoutOutput {
  const validIds = new Set(input.signals.map((s) => s.id));
  const taken = [...input.existingThemes];
  const niches: TrendScoutOutput['niches'] = [];

  for (const n of raw.niches) {
    const theme = clip(collapseSpaces(n.theme), 120);
    const keywords = [...new Set(n.keywords.map((k) => clip(collapseSpaces(k.toLowerCase()), 60)).filter((k) => k.length >= 2))];
    const brief = clip(collapseSpaces(n.brief), 1200);
    const hits = findBlocklistHits({ theme, keywords, brief }, blocklist);
    if (hits.length > 0) continue;
    if (!normalizeText(theme) || taken.some((t) => sameTerm(t, theme))) continue;

    const candidate = {
      theme,
      keywords: keywords.slice(0, 8),
      brief,
      season: n.season ? clip(collapseSpaces(n.season), 60) || null : null,
      sourceSignalIds: [...new Set(n.sourceSignalIds.filter((id) => validIds.has(id)))].slice(0, 30),
    };
    const ok = TrendScoutOutputSchema.shape.niches.element.safeParse(candidate);
    if (!ok.success) continue;
    niches.push(ok.data);
    taken.push(theme);
    if (niches.length >= maxNiches) break;
  }
  return TrendScoutOutputSchema.parse({ niches });
}

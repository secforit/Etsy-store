/**
 * 2. Niche Validator: code gathers evidence (Etsy competition per keyword, Printify unit costs), the model
 * decides accept/reject and proposes up to 3 products. Code then: keeps evidence from code only, enforces
 * score >= 50 for accept, allowed product types, dedupe, max products, and price rules (min margin, x.99).
 * expectedMarginShare is computed by code, never by the model.
 */
import { z } from 'zod';
import { PRODUCT_TYPES, type ProductType } from '../domain/types.ts';
import type { LlmUsage } from '../llm/types.ts';
import { AGENT_DEFAULT_TIERS } from '../llm/tiers.ts';
import { NicheValidatorOutputSchema, type NicheValidatorOutput, type RunNicheValidator } from './contracts.ts';
import { askModel } from './common.ts';
import type { NicheValidatorDepsExt } from './extensions.ts';
import { DEFAULT_EUR_TO_USD, applyPriceRules, costBasisFromCatalog, finalizePrice, marginFor, minPriceEur, type UnitCostUsd } from './pricing.ts';
import { NICHE_VALIDATOR_SYSTEM, nicheValidatorInstructions } from './prompts.ts';
import { clip, collapseSpaces, normalizeText, uniqueBy } from './rules.ts';

export const MAX_KEYWORDS_CHECKED = 5;
export const ACCEPT_MIN_SCORE = 50;
/** The model may price up to this multiple of the margin floor. */
export const MAX_PRICE_OVER_FLOOR = 2;

export function nicheValidatorModelSchema(types: readonly [ProductType, ...ProductType[]]) {
  return z.object({
    decision: z.enum(['accept', 'reject']),
    score: z.number().int().min(0).max(100),
    reasoning: z.string().min(10).max(1500),
    products: z
      .array(
        z.object({
          productType: z.enum(types),
          conceptTitle: z.string().min(3).max(120),
          designPhrase: z.string().max(80).nullable(),
          styleNotes: z.string().max(600),
          targetPriceEur: z.number().positive().max(1000),
        }),
      )
      .max(3),
  });
}

function median(values: number[]): number {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

interface ProductOption {
  productType: ProductType;
  cost: UnitCostUsd;
  floorEur: number;
}

export const runNicheValidator: RunNicheValidator = async (input, baseDeps) => {
  const deps = baseDeps as NicheValidatorDepsExt;
  const usage: LlmUsage[] = [];
  const eurToUsd = deps.eurToUsd ?? DEFAULT_EUR_TO_USD;
  const shop = deps.shop;

  // Evidence: Etsy competition (code only).
  const keywords = uniqueBy(
    input.niche.keywords.map((k) => collapseSpaces(k.toLowerCase())).filter((k) => normalizeText(k).length >= 2),
    normalizeText,
  ).slice(0, MAX_KEYWORDS_CHECKED);
  const competition: NicheValidatorOutput['competition'] = [];
  const samples: { keyword: string; titles: string[] }[] = [];
  for (const keyword of keywords) {
    const res = await deps.etsy.searchActiveListings({ keywords: keyword, limit: 25 });
    competition.push({
      keyword,
      activeListings: Math.max(0, Math.trunc(res.count)),
      medianFavorites: Math.max(0, median(res.results.map((r) => r.numFavorers))),
    });
    samples.push({ keyword, titles: res.results.slice(0, 5).map((r) => clip(r.title, 140)) });
  }

  // Evidence: Printify unit costs -> margin floor per enabled product type.
  const options: ProductOption[] = [];
  let firstCatalogError: unknown = null;
  for (const productType of PRODUCT_TYPES) {
    if (!shop.products[productType].enabled) continue;
    try {
      const cost = costBasisFromCatalog(await deps.printify.getCatalogEntry(productType));
      options.push({ productType, cost, floorEur: minPriceEur(cost, eurToUsd, shop) });
    } catch (err) {
      firstCatalogError ??= err;
    }
  }
  if (options.length === 0) {
    throw new Error(
      `Niche Validator: no Printify catalog entry is available (run setup-catalog): ${(firstCatalogError as Error | null)?.message ?? 'no product type enabled'}`,
    );
  }
  const types = options.map((o) => o.productType) as [ProductType, ...ProductType[]];

  const raw = await askModel(
    deps.llm,
    {
      agent: 'niche_validator',
      tier: AGENT_DEFAULT_TIERS.niche_validator,
      system: NICHE_VALIDATOR_SYSTEM,
      instructions: nicheValidatorInstructions({
        minPrices: options.map((o) => ({ productType: o.productType, minPriceEur: finalizePrice(o.floorEur, shop) })),
      }),
      untrustedData: {
        niche: { theme: input.niche.theme, keywords: input.niche.keywords, brief: input.niche.brief },
        competition,
        competitorTitleSamples: samples,
      },
      schema: nicheValidatorModelSchema(types),
      maxOutputTokens: 2000,
    },
    usage,
  );

  const accepted = raw.decision === 'accept' && raw.score >= ACCEPT_MIN_SCORE;
  const products: NicheValidatorOutput['products'] = [];
  if (accepted) {
    const candidates = uniqueBy(raw.products, (p) => normalizeText(p.conceptTitle));
    for (const p of candidates) {
      const option = options.find((o) => o.productType === p.productType);
      if (!option) continue;
      const conceptTitle = clip(collapseSpaces(p.conceptTitle), 120);
      if (conceptTitle.length < 3) continue;
      const phrase = p.designPhrase ? clip(collapseSpaces(p.designPhrase), 80) : '';
      const targetPriceEur = applyPriceRules(
        { proposedEur: p.targetPriceEur, floorEur: option.floorEur, ceilingEur: option.floorEur * MAX_PRICE_OVER_FLOOR },
        shop,
      );
      const share = marginFor(targetPriceEur, option.cost, eurToUsd, shop).marginShare;
      products.push({
        productType: p.productType,
        conceptTitle,
        designPhrase: phrase || null,
        styleNotes: clip(collapseSpaces(p.styleNotes), 600),
        targetPriceEur,
        expectedMarginShare: Math.min(1, Math.max(0, share)),
      });
      if (products.length >= shop.caps.maxProductsPerNiche) break;
    }
  }

  let reasoning = collapseSpaces(raw.reasoning);
  if (raw.decision === 'accept' && !accepted) reasoning += ` [code: score ${raw.score} is below ${ACCEPT_MIN_SCORE}, rejected]`;
  if (accepted && products.length === 0) reasoning += ' [code: no valid products, rejected]';
  const decision = accepted && products.length > 0 ? 'accept' : 'reject';

  const output = NicheValidatorOutputSchema.parse({
    decision,
    score: raw.score,
    reasoning: clip(reasoning, 2000),
    competition,
    products: decision === 'accept' ? products : [],
  });
  return { output, llmUsage: usage };
};

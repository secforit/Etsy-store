/**
 * 3. Compliance Guard (concept and final stage).
 *
 * Code first gathers evidence: blocklist hits (settings + baseline) in every product text, and USPTO
 * trademark search results for the design phrase, concept title, keywords and (final) listing title/tags.
 * HARD RULES (code decides, the model cannot override):
 *  - any blocklist hit -> block
 *  - a LIVE mark in the product's Nice class (SHOP.trademarkClasses) -> block when the mark equals one of the
 *    checked terms (exact / plural / case / punctuation / spacing variants) or, for marks of 2+ words, when
 *    the mark appears anywhere in the product text.
 * The model adds judgement (brands not in the lists, characters, slogans, policy, and at the final stage the
 * design image). The model can add a block, never remove one. If the model is unavailable but code already
 * blocks, the result is still a block.
 */
import { z } from 'zod';
import type { TrademarkHit } from '../domain/types.ts';
import type { LlmImage, LlmUsage } from '../llm/types.ts';
import {
  ComplianceGuardOutputSchema,
  type ComplianceGuardDeps,
  type ComplianceGuardInput,
  type ComplianceGuardOutput,
  type RunComplianceGuard,
} from './contracts.ts';
import { askModel, toVisionImage } from './common.ts';
import { COMPLIANCE_GUARD_SYSTEM, complianceInstructions } from './prompts.ts';
import { clip, collapseSpaces, containsTerm, effectiveBlocklist, findBlocklistHits, normalizeText, sameTerm, tokenize, uniqueBy } from './rules.ts';

export const ComplianceModelSchema = z.object({
  verdict: z.enum(['pass', 'block']),
  reasons: z.array(z.string().max(300)).max(10),
  flaggedTerms: z.array(z.string().max(80)).max(20),
});

export const MAX_TRADEMARK_SEARCHES = 30;
const MAX_HITS_KEPT = 50;
const MAX_HITS_FOR_MODEL = 15;

/** Terms sent to the trademark search, most important first, deduped by normalised form. */
export function trademarkSearchTerms(input: ComplianceGuardInput): string[] {
  const raw = [
    input.designPhrase ?? '',
    input.conceptTitle,
    ...input.keywords,
    ...(input.listing?.tags ?? []),
    input.listing?.title ?? '',
  ];
  return uniqueBy(
    raw.map((t) => collapseSpaces(t)).filter((t) => normalizeText(t).length >= 2),
    normalizeText,
  ).slice(0, MAX_TRADEMARK_SEARCHES);
}

/** Live marks in the product's classes that the hard rule blocks on. */
export function blockingTrademarks(hits: TrademarkHit[], classes: readonly number[], checkedTerms: string[], texts: string[]): TrademarkHit[] {
  return hits.filter((h) => {
    if (h.status !== 'live') return false;
    if (!h.classes.some((c) => classes.includes(c))) return false;
    if (checkedTerms.some((t) => sameTerm(t, h.mark))) return true;
    return tokenize(h.mark).length >= 2 && texts.some((t) => containsTerm(t, h.mark));
  });
}

function stripOwnDisclosures(description: string, shop: ComplianceGuardDeps['shop']): string {
  return description.split(shop.listing.aiDisclosure).join(' ').split(shop.listing.productionPartnerDisclosure).join(' ');
}

export const runComplianceGuard: RunComplianceGuard = async (input, deps) => {
  const usage: LlmUsage[] = [];
  const classes = deps.shop.trademarkClasses[input.productType];
  const blocklist = effectiveBlocklist(deps.blocklist);

  const fields: Record<string, string | string[] | null | undefined> = {
    'concept title': input.conceptTitle,
    'design phrase': input.designPhrase,
    keywords: input.keywords,
    'listing title': input.listing?.title,
    tags: input.listing?.tags,
    description: input.listing ? stripOwnDisclosures(input.listing.description, deps.shop) : undefined,
  };
  const texts = Object.values(fields).flatMap((v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]));

  // 1. Blocklist (code).
  const termHits = findBlocklistHits(fields, blocklist);
  const blocklistHits = [...new Set(termHits.map((h) => h.term))];

  // 2. Trademarks (code). Search errors propagate: never pass a product without the check.
  const searchTerms = trademarkSearchTerms(input);
  const allHits: TrademarkHit[] = [];
  for (const term of searchTerms) allHits.push(...(await deps.trademark.search(term)));
  const hits = uniqueBy(allHits, (h) => `${h.serial}|${normalizeText(h.mark)}`);
  const blocking = blockingTrademarks(hits, classes, searchTerms, texts);
  const codeBlocks = blocklistHits.length > 0 || blocking.length > 0;

  // 3. Final stage: the edited design is looked at by the vision model.
  const images: LlmImage[] = [];
  if (input.stage === 'final' && input.designKey) {
    const file = await deps.storage.get(input.designKey);
    if (!file) throw new Error(`Compliance Guard: design file not found: ${input.designKey}`);
    images.push(await toVisionImage(file.bytes));
  }

  // 4. Model judgement.
  const inClass = (h: TrademarkHit) => h.classes.some((c) => classes.includes(c));
  const evidence = [...hits]
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, MAX_HITS_FOR_MODEL)
    .map((h) => ({
      mark: h.mark,
      status: h.status,
      classes: h.classes,
      inProductClass: inClass(h),
      matchesProductWords: blocking.includes(h),
    }));
  function rank(h: TrademarkHit): number {
    return (blocking.includes(h) ? 4 : 0) + (h.status === 'live' ? 2 : 0) + (inClass(h) ? 1 : 0);
  }

  let model: z.infer<typeof ComplianceModelSchema> | null = null;
  let modelError: string | null = null;
  try {
    model = await askModel(
      deps.llm,
      {
        agent: 'compliance_guard',
        tier: 'large',
        system: COMPLIANCE_GUARD_SYSTEM,
        instructions: complianceInstructions({
          stage: input.stage,
          productType: input.productType,
          classes,
          blocklistHits,
          hasImage: images.length > 0,
        }),
        untrustedData: {
          product: {
            conceptTitle: input.conceptTitle,
            designPhrase: input.designPhrase,
            keywords: input.keywords,
            listing: input.listing ?? null,
          },
          trademarkEvidence: evidence,
        },
        ...(images.length ? { images } : {}),
        schema: ComplianceModelSchema,
        maxOutputTokens: 1200,
      },
      usage,
    );
  } catch (err) {
    if (!codeBlocks) throw err; // no decision without the model unless code already blocks
    modelError = (err as Error).message;
  }

  // 5. Combine: code blocks win.
  const reasons: string[] = [];
  for (const term of blocklistHits) {
    const where = termHits.filter((h) => h.term === term).map((h) => h.field);
    reasons.push(`Blocked term "${term}" found in ${[...new Set(where)].join(', ')}.`);
  }
  for (const h of blocking) {
    reasons.push(`Live US trademark "${h.mark}" (serial ${h.serial}, class ${h.classes.join('/')}) matches the product's words.`);
  }
  if (model) reasons.push(...model.reasons.map((r) => collapseSpaces(r)).filter(Boolean));
  if (modelError) reasons.push(`Model review unavailable (${clip(modelError, 200)}); blocked by code rules.`);

  const flaggedTerms = uniqueBy(
    [...blocklistHits, ...blocking.map((h) => h.mark), ...(model?.flaggedTerms ?? [])]
      .map((t) => clip(collapseSpaces(t), 80))
      .filter(Boolean),
    normalizeText,
  );

  const verdict: ComplianceGuardOutput['verdict'] = codeBlocks || model?.verdict === 'block' ? 'block' : 'pass';
  if (verdict === 'block' && reasons.length === 0) reasons.push('Blocked by the compliance model without a stated reason.');

  const output = ComplianceGuardOutputSchema.parse({
    verdict,
    reasons: reasons.slice(0, 20).map((r) => clip(r, 500)),
    flaggedTerms: flaggedTerms.slice(0, 50),
    trademarkHits: [...hits]
      .sort((a, b) => rank(b) - rank(a))
      .slice(0, MAX_HITS_KEPT)
      .map((h) => ({ mark: h.mark, serial: h.serial, status: h.status, classes: h.classes, owner: h.owner })),
    blocklistHits,
  });
  return { output, llmUsage: usage };
};

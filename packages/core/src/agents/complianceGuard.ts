/**
 * 3. Compliance Guard (concept and final stage).
 *
 * Code first gathers evidence: blocklist hits (settings + baseline) in every product text, and USPTO
 * trademark search results for the design phrase, concept title, keywords and (final) listing title/tags.
 * Marker only returns marks that EQUAL a query or START with it (`term*`), never a mark inside a longer
 * phrase, so besides each whole phrase the guard searches every 2-4 word sub-phrase (exact only) of the design
 * phrase, concept title, listing title, tags and keywords ("Life Is Good At The Lake" -> "life is good", ...),
 * design phrase first, plus a few distinctive single words as evidence for the model.
 * HARD RULES (code decides, the model cannot override):
 *  - any blocklist hit -> block
 *  - a LIVE mark in the product's Nice class (SHOP.trademarkClasses) -> block when the mark equals one of the
 *    checked phrases / sub-phrases (exact / plural / case / punctuation / spacing variants) or, for marks of
 *    2+ words, when the mark appears anywhere in the product text. Single-word marks inside a longer phrase
 *    are left to the model (nearly every common English word is a live class-25 mark).
 * The model adds judgement (brands not in the lists, characters, slogans, policy, and at the final stage the
 * design image). The model can add a block, never remove one. If the model is unavailable but code already
 * blocks, the result is still a block.
 */
import { z } from 'zod';
import type { TrademarkHit } from '../domain/types.ts';
import { searchTrademark } from '../integrations/trademark.ts';
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

/**
 * Max trademark searches per compliance check. A whole-phrase search costs 2 Marker queries (exact + `term*`),
 * a sub-phrase or single word 1. The most important terms come first (design phrase and its sub-phrases), so
 * the cap only ever cuts the least important ones; typical checks use 30-80. Results are cached by the live
 * client, so the final check reuses most of the concept check's and the Listing Writer's queries.
 */
export const MAX_TRADEMARK_SEARCHES = 100;
const NGRAM_MIN_WORDS = 2;
const NGRAM_MAX_WORDS = 4;
const MAX_SINGLE_WORDS = 8;
const MIN_SINGLE_WORD_LETTERS = 4;
const MAX_HITS_KEPT = 50;
const MAX_HITS_FOR_MODEL = 15;

/** Function words: a sub-phrase made only of these (and product words) is never searched. */
const STOPWORDS = new Set(
  (
    'a an the and or but nor of in on at to for with without from by as into onto over under up down out off about ' +
    'is are was were be been am im i me my mine you your yours we us our ours he him his she her hers they them ' +
    'their it its this that these those so if than then too very s t ll re ve d'
  ).split(' '),
);

/** Product nouns and listing filler: never a mark on their own in our context. */
const PRODUCT_WORDS = new Set(
  (
    'shirt shirts tshirt tshirts tee tees top tops tank hoodie sweatshirt mug mugs cup cups poster posters print ' +
    'prints printable wall art artwork decor design designs graphic gift gifts present presents idea ideas unisex ' +
    'men mens women womens kids youth adult oz 11oz 15oz ceramic cotton frame framed'
  ).split(' '),
);

/** Common print-on-demand words: not searched as single words (sub-phrases with them still are). */
const GENERIC_WORDS = new Set(
  (
    'funny cute cool vintage retro classic aesthetic minimalist minimal boho trendy perfect best great awesome ' +
    'love lover lovers life live happy birthday christmas halloween thanksgiving easter valentine valentines ' +
    'mother mothers father fathers mama dad daddy papa grandma grandpa nana sister brother family friend friends ' +
    'teacher nurse wife husband girl girls baby team club crew squad season summer winter spring autumn fall ' +
    'holiday holidays party night time year years world home house camp camping camper campers campfire ' +
    'outdoor outdoors adventure mountain mountains forest lake river beach ocean sunset sunrise nature hiking ' +
    'hike travel wild flower flowers floral garden plant plants coffee book books reading lovers animal animals ' +
    'badge style lettering quote saying sayings slogan humor humour sarcastic sarcasm matching original custom ' +
    'personalized personalised good better little never always every everything nothing only just first last ' +
    'real true free more less today tomorrow weekend people things thing stuff made make need want like moms dads ' +
    'kind nice sweet happy lucky magic dream dreams vibes mood energy spirit soul heart hearts heartbeat'
  ).split(' '),
);

export interface TrademarkQuery {
  term: string;
  /** Also search marks that START with the term (`term*`). Whole phrases only; sub-phrases and words are exact. */
  prefix: boolean;
  /** 'phrase' and 'ngram' terms feed the code-side block rule; 'word' hits are evidence for the model only. */
  kind: 'phrase' | 'ngram' | 'word';
}

/** Every contiguous 2-4 word sub-phrase (normalised), shortest first, skipping all-filler ones. */
export function wordNgrams(text: string | null | undefined): string[] {
  const tokens = tokenize(text ?? '');
  const out: string[] = [];
  for (let n = NGRAM_MIN_WORDS; n <= Math.min(NGRAM_MAX_WORDS, tokens.length); n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const gram = tokens.slice(i, i + n);
      if (gram.every((w) => STOPWORDS.has(w) || PRODUCT_WORDS.has(w))) continue;
      out.push(gram.join(' '));
    }
  }
  return out;
}

/** Words of 4+ letters that are not filler or common print-on-demand vocabulary ("patagonia", "yeti"). */
export function distinctiveWords(texts: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    for (const w of tokenize(text ?? '')) {
      if ((w.match(/[a-z]/g)?.length ?? 0) < MIN_SINGLE_WORD_LETTERS) continue;
      if (STOPWORDS.has(w) || PRODUCT_WORDS.has(w) || GENERIC_WORDS.has(w)) continue;
      out.push(w);
    }
  }
  return [...new Set(out)];
}

/**
 * The trademark searches for one check, most important first, deduped by normalised form (a duplicate keeps
 * the earlier position but the wider search: prefix on, and 'phrase' over 'ngram' over 'word').
 */
export function trademarkSearchPlan(input: ComplianceGuardInput): TrademarkQuery[] {
  const phrase = (t: string | null | undefined): TrademarkQuery[] => {
    const term = collapseSpaces(t ?? '');
    return normalizeText(term).length >= 2 ? [{ term, prefix: true, kind: 'phrase' }] : [];
  };
  const grams = (t: string | null | undefined): TrademarkQuery[] => wordNgrams(t).map((term) => ({ term, prefix: false, kind: 'ngram' }));
  const listing = input.listing;
  const ordered: TrademarkQuery[] = [
    ...phrase(input.designPhrase),
    ...grams(input.designPhrase),
    ...phrase(input.conceptTitle),
    ...grams(input.conceptTitle),
    ...(listing?.tags ?? []).flatMap(phrase),
    ...grams(listing?.title),
    ...input.keywords.flatMap(phrase),
    ...phrase(listing?.title),
    ...(listing?.tags ?? []).flatMap(grams),
    ...input.keywords.flatMap(grams),
    ...distinctiveWords([input.designPhrase, input.conceptTitle, listing?.title])
      .slice(0, MAX_SINGLE_WORDS)
      .map((term): TrademarkQuery => ({ term, prefix: false, kind: 'word' })),
  ];
  const strength = { word: 0, ngram: 1, phrase: 2 } as const;
  const byKey = new Map<string, TrademarkQuery>();
  for (const q of ordered) {
    const key = normalizeText(q.term);
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { ...q });
    else {
      seen.prefix ||= q.prefix;
      if (strength[q.kind] > strength[seen.kind]) seen.kind = q.kind;
    }
  }
  return [...byKey.values()].slice(0, MAX_TRADEMARK_SEARCHES);
}

/** Terms sent to the trademark search, most important first (see trademarkSearchPlan). */
export function trademarkSearchTerms(input: ComplianceGuardInput): string[] {
  return trademarkSearchPlan(input).map((q) => q.term);
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
  const plan = trademarkSearchPlan(input);
  const allHits: TrademarkHit[] = [];
  for (const q of plan) allHits.push(...(await searchTrademark(deps.trademark, q.term, { prefix: q.prefix })));
  const hits = uniqueBy(allHits, (h) => `${h.serial}|${normalizeText(h.mark)}`);
  const checkedTerms = plan.filter((q) => q.kind !== 'word').map((q) => q.term);
  const blocking = blockingTrademarks(hits, classes, checkedTerms, texts);
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

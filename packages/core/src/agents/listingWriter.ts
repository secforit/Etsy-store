/**
 * 5. Listing Writer: the model drafts title, tags, description and a price; code enforces every Etsy rule:
 *  - strips any model-written disclosure / AI / production text, links and emails, then appends
 *    SHOP.listing.aiDisclosure and SHOP.listing.productionPartnerDisclosure (always, verbatim)
 *  - tags: lowercase, Etsy characters only, 2..20 chars, deduped, blocklist-free, max 13 (filled from niche
 *    keywords and product defaults up to 13)
 *  - title: <= 140 chars cut at a word boundary, no emoji, Etsy's once-only characters, max 3 ALL-CAPS words
 *  - re-runs the blocklist (settings + baseline): blocked tags dropped, blocked sentences removed, a blocked
 *    title replaced by a title built from the concept (which already passed compliance)
 *  - price: never below targetPriceEur or the Printify min-margin price, at most +25 % over target, x.99
 *  - optional (deps.trademark): tags that exactly match a live mark in the product's class are dropped
 */
import { z } from 'zod';
import type { ProductType } from '../domain/types.ts';
import type { LlmUsage } from '../llm/types.ts';
import { ListingWriterOutputSchema, type ListingWriterInput, type RunListingWriter } from './contracts.ts';
import { PRODUCT_NOUN, askModel } from './common.ts';
import type { ListingWriterDepsExt } from './extensions.ts';
import { DEFAULT_EUR_TO_USD, applyPriceRules, costBasisFromCatalog, minPriceEur } from './pricing.ts';
import { LISTING_WRITER_SYSTEM, listingWriterInstructions } from './prompts.ts';
import { collapseSpaces, containsTerm, effectiveBlocklist, findBlocklistHits, normalizeText, removeSentencesWithTerms, sameTerm, uniqueBy } from './rules.ts';
import type { TrademarkClient } from '../integrations/types.ts';
import { AGENT_DEFAULT_TIERS } from '../llm/tiers.ts';

export const ListingWriterModelSchema = z.object({
  title: z.string().min(10).max(200),
  tags: z.array(z.string().min(1).max(40)).min(5).max(20),
  description: z.string().min(50).max(4000),
  priceEur: z.number().positive().max(1000),
});

export const MAX_PRICE_OVER_TARGET = 1.25;

/** Generic fillers so a listing always has 13 tags (Etsy's maximum), after the model's and the niche's own. */
const DEFAULT_TAGS: Record<ProductType, string[]> = {
  tshirt: ['graphic tee', 'unisex t-shirt', 'gift shirt', 'cotton tee', 'funny shirt', 'gift for her', 'gift for him', 'birthday gift', 'casual tee', 'trendy shirt', 'gift idea', 'everyday tee', 'unique tee'],
  mug: ['coffee mug', 'ceramic mug', 'gift mug', 'tea mug', 'coffee lover gift', 'gift for her', 'gift for him', 'birthday gift', 'office mug', 'cute mug', 'gift idea', 'kitchen decor', 'unique mug'],
  poster: ['wall art', 'art print', 'poster print', 'home decor', 'room decor', 'gift for her', 'gift for him', 'birthday gift', 'living room art', 'bedroom decor', 'gift idea', 'art poster', 'unique poster'],
};

/** Sentences mentioning AI, generation tools, production or fulfilment: the shop's own lines replace them. */
const DISCLOSURE_LIKE =
  /\b(ai|a\.i|artificial intelligence|generated|generative|midjourney|dall ?e|stable diffusion|flux|printify|print providers?|production partner|made to order|printed and shipped|ships? from|about this design)\b/i;

const URL_OR_EMAIL = /(https?:\/\/\S+|www\.\S+|\b\S+@\S+\.[a-z]{2,}\b)/gi;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

export function stripModelDisclosures(text: string, shop: ListingWriterDepsExt['shop']): string {
  const withoutOwn = text.split(shop.listing.aiDisclosure).join('\n').split(shop.listing.productionPartnerDisclosure).join('\n');
  return withoutOwn
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(URL_OR_EMAIL, '')
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !DISCLOSURE_LIKE.test(sentence))
        .join(' ')
        .replace(/[ \t]+/g, ' ')
        .trim(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildDescription(body: string, shop: ListingWriterDepsExt['shop'], fallback: string): string {
  const disclosures = `${shop.listing.aiDisclosure}\n${shop.listing.productionPartnerDisclosure}`;
  const maxBody = 5000 - disclosures.length - 2;
  let text = body.trim();
  if (text.length > maxBody) {
    const cut = text.slice(0, maxBody);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('\n'));
    text = (lastStop > maxBody * 0.5 ? cut.slice(0, lastStop + 1) : cut).trim();
  }
  if (text.length < 20) text = fallback;
  return `${text}\n\n${disclosures}`;
}

export function cleanTag(tag: string): string | null {
  const s = tag
    .replace(/[\u2122\u00A9\u00AE]/g, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9 '\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length >= 2 && s.length <= 20 ? s : null;
}

/** Ordered, cleaned, deduped, blocklist-free tag candidates (model tags first, then fillers). */
export function tagCandidates(modelTags: string[], fillers: string[], blocklist: string[]): string[] {
  const clean = (list: string[]) =>
    list
      .map(cleanTag)
      .filter((t): t is string => t !== null)
      .filter((t) => !blocklist.some((term) => containsTerm(t, term)));
  return uniqueBy([...clean(modelTags), ...clean(fillers)], normalizeText);
}

export function enforceTags(modelTags: string[], fillers: string[], blocklist: string[], maxTags: number): string[] {
  return tagCandidates(modelTags, fillers, blocklist).slice(0, maxTags);
}

/**
 * Optional pre-check (deps.trademark): drops tags that ARE a live US mark in the product's class, so the
 * final compliance check does not block an already-edited product over a tag. Stops at maxTags accepted.
 */
async function trademarkSafeTags(
  candidates: string[],
  trademark: TrademarkClient,
  classes: readonly number[],
  maxTags: number,
): Promise<{ tags: string[]; dropped: string[] }> {
  const tags: string[] = [];
  const dropped: string[] = [];
  for (const tag of candidates) {
    if (tags.length >= maxTags) break;
    const hits = await trademark.search(tag);
    const conflict = hits.some((h) => h.status === 'live' && h.classes.some((c) => classes.includes(c)) && sameTerm(h.mark, tag));
    if (conflict) dropped.push(tag);
    else tags.push(tag);
  }
  return { tags, dropped };
}

/** Cuts at a word boundary, keeps Etsy's once-only characters (% : & +) once, limits ALL-CAPS words to 3. */
export function enforceTitle(raw: string, maxChars: number): string {
  let s = collapseSpaces(raw.replace(URL_OR_EMAIL, ' ').replace(EMOJI, ' ').replace(/[^\p{L}\p{N} \-,.'!?()/|&:%+]/gu, ' '));
  for (const ch of ['%', ':', '&', '+']) {
    const first = s.indexOf(ch);
    if (first >= 0) s = s.slice(0, first + 1) + s.slice(first + 1).split(ch).join(' ');
  }
  let caps = 0;
  s = s
    .split(' ')
    .map((w) => {
      if (w.length >= 2 && /^[^a-z]*[A-Z][^a-z]*$/.test(w) && /[A-Z]{2}/.test(w)) {
        caps++;
        if (caps > 3) return w.charAt(0) + w.slice(1).toLowerCase();
      }
      return w;
    })
    .join(' ');
  s = collapseSpaces(s);
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars + 1);
    const lastSpace = cut.lastIndexOf(' ');
    s = (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : s.slice(0, maxChars)).replace(/[\s,\-|/:&+]+$/, '');
  }
  return s;
}

function fallbackTitle(input: ListingWriterInput, maxChars: number): string {
  const parts = [input.conceptTitle, PRODUCT_NOUN[input.productType]];
  if (input.nicheKeywords[0]) parts.push(`- ${input.nicheKeywords[0]}`);
  return enforceTitle(parts.join(' '), maxChars);
}

export const runListingWriter: RunListingWriter = async (input, baseDeps) => {
  const deps = baseDeps as ListingWriterDepsExt;
  const usage: LlmUsage[] = [];
  const shop = deps.shop;
  const blocklist = effectiveBlocklist(deps.blocklist ?? []);

  const raw = await askModel(
    deps.llm,
    {
      agent: 'listing_writer',
      tier: AGENT_DEFAULT_TIERS.listing_writer,
      system: LISTING_WRITER_SYSTEM,
      instructions: listingWriterInstructions({
        productType: input.productType,
        targetPriceEur: input.targetPriceEur,
        blocklist,
        avoidRules: input.avoidRules.slice(0, 20),
      }),
      untrustedData: {
        conceptTitle: input.conceptTitle,
        designPhrase: input.designPhrase,
        styleNotes: input.styleNotes,
        nicheKeywords: input.nicheKeywords,
        nicheBrief: input.nicheBrief,
      },
      schema: ListingWriterModelSchema,
      maxOutputTokens: 2000,
    },
    usage,
  );

  // Title
  let title = enforceTitle(raw.title, shop.listing.titleMaxChars);
  if (title.length < 10 || findBlocklistHits({ title }, blocklist).length > 0) title = fallbackTitle(input, shop.listing.titleMaxChars);

  // Tags
  const candidates = tagCandidates(raw.tags, [...input.nicheKeywords, ...DEFAULT_TAGS[input.productType]], blocklist);
  const tags = deps.trademark
    ? (await trademarkSafeTags(candidates, deps.trademark, shop.trademarkClasses[input.productType], shop.listing.maxTags)).tags
    : candidates.slice(0, shop.listing.maxTags);

  // Description: model body without disclosures/links/blocked sentences + the shop's two disclosure lines.
  const blockedInBody = findBlocklistHits({ d: raw.description }, blocklist).map((h) => h.term);
  const body = removeSentencesWithTerms(stripModelDisclosures(raw.description, shop), blockedInBody);
  const fallbackBody = `${collapseSpaces(input.conceptTitle)}: an original ${PRODUCT_NOUN[input.productType].toLowerCase()} design.`;
  const description = buildDescription(body, shop, fallbackBody);

  // Price
  let floorEur = input.targetPriceEur;
  if (deps.printify) {
    const cost = costBasisFromCatalog(await deps.printify.getCatalogEntry(input.productType));
    floorEur = Math.max(floorEur, minPriceEur(cost, deps.eurToUsd ?? DEFAULT_EUR_TO_USD, shop));
  }
  const priceEur = applyPriceRules(
    { proposedEur: raw.priceEur, floorEur, ceilingEur: input.targetPriceEur * MAX_PRICE_OVER_TARGET },
    shop,
  );

  const output = ListingWriterOutputSchema.parse({ title, tags, description, priceEur });
  return { output, llmUsage: usage };
};

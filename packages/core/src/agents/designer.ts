/**
 * 4. Designer: the model writes an image prompt; code fixes the request and generates the raw art.
 *  - size: product printSpec x SHOP.imageGen.generationScale, rounded to multiples of 16, max 2048 per side
 *    (aspect ratio kept); without a printSpec: the Printify print area when deps.printify is passed, else
 *    SHOP.imageGen.defaultSizePx
 *  - transparent background for tshirt/mug, opaque for poster
 *  - the design phrase is forced into the prompt verbatim; sentences with blocked terms are dropped
 *  - deterministic seed from productId + attempt; art stored at designs/<productId>/art-<n>.png (never overwritten)
 */
import { z } from 'zod';
import type { ShopConfig } from '../config/shop.ts';
import type { ProductType } from '../domain/types.ts';
import type { LlmUsage } from '../llm/types.ts';
import { DesignerOutputSchema, type DesignerInput, type RunDesigner } from './contracts.ts';
import { askModel, isPng, safeKeySegment, stableSeed } from './common.ts';
import type { DesignerDepsExt } from './extensions.ts';
import { DESIGNER_SYSTEM, designerInstructions } from './prompts.ts';
import { clip, collapseSpaces, effectiveBlocklist, removeSentencesWithTerms } from './rules.ts';

export const DesignerModelSchema = z.object({
  prompt: z.string().min(20).max(1500),
  style: z.enum(['vector_illustration', 'typography', 'hand_drawn', 'retro']),
});

/** Sidecar limits: dimensions multiples of 16, max 2048; prompt max 2000 chars. */
export const MAX_IMAGE_SIDE = 2048;
export const MAX_PROMPT_CHARS = 1900;
const MAX_ART_VERSIONS = 50;

/** Short side never below this, so wide mug wraps still get usable detail (long side still capped at 2048). */
export const MIN_SHORT_SIDE = 512;

/** print size x generationScale, aspect kept, long side <= 2048, short side >= 512 when possible, multiples of 16. */
export function scaleToRequest(printWidthPx: number, printHeightPx: number, generationScale: number): { widthPx: number; heightPx: number } {
  let w = printWidthPx * generationScale;
  let h = printHeightPx * generationScale;
  const under = MIN_SHORT_SIDE / Math.min(w, h);
  if (under > 1) {
    const room = MAX_IMAGE_SIDE / Math.max(w, h);
    const k = Math.min(under, room);
    w *= k;
    h *= k;
  }
  const over = Math.max(w, h) / MAX_IMAGE_SIDE;
  if (over > 1) {
    w /= over;
    h /= over;
  }
  const to16 = (x: number) => Math.min(MAX_IMAGE_SIDE, Math.max(16, Math.round(x / 16) * 16));
  return { widthPx: to16(w), heightPx: to16(h) };
}

export function designRequestSize(productType: ProductType, shop: Pick<ShopConfig, 'products' | 'imageGen'>): { widthPx: number; heightPx: number } {
  const spec = shop.products[productType].printSpec;
  if (!spec) return { widthPx: shop.imageGen.defaultSizePx.widthPx, heightPx: shop.imageGen.defaultSizePx.heightPx };
  return scaleToRequest(spec.widthPx, spec.heightPx, shop.imageGen.generationScale);
}

/**
 * When the shop has no print spec for the product (mug/poster) and the orchestrator passes `printify`, the art is
 * sized to the Printify print area (the same area QA prints to), so its aspect ratio matches. Otherwise as above.
 */
async function resolveRequestSize(productType: ProductType, deps: DesignerDepsExt): Promise<{ widthPx: number; heightPx: number }> {
  if (deps.shop.products[productType].printSpec || !deps.printify) return designRequestSize(productType, deps.shop);
  try {
    const area = (await deps.printify.getCatalogEntry(productType)).printArea;
    if (area.widthPx > 0 && area.heightPx > 0) return scaleToRequest(area.widthPx, area.heightPx, deps.shop.imageGen.generationScale);
  } catch {
    /* catalog not available: default size */
  }
  return designRequestSize(productType, deps.shop);
}

export function isTransparentProduct(productType: ProductType): boolean {
  return productType !== 'poster';
}

export function composeImagePrompt(a: {
  modelPrompt: string;
  input: Pick<DesignerInput, 'conceptTitle' | 'designPhrase' | 'styleNotes'>;
  transparent: boolean;
  blocklist: string[];
}): string {
  let body = collapseSpaces(removeSentencesWithTerms(a.modelPrompt, a.blocklist));
  if (body.length < 20) {
    // The model's prompt was all blocked terms: fall back to the concept, which passed compliance.
    body = collapseSpaces(`Original flat vector artwork for the concept "${a.input.conceptTitle}". ${a.input.styleNotes}`);
  }
  const tail: string[] = [];
  const phrase = a.input.designPhrase?.trim();
  if (phrase) {
    if (!body.includes(phrase)) tail.push(`Bold, clear lettering that reads exactly "${phrase}".`);
  } else {
    tail.push('No text, no letters, no words.');
  }
  tail.push(
    a.transparent
      ? 'Single centered artwork isolated on a plain white background, clean edges, print-ready.'
      : 'Full-bleed poster composition from edge to edge, print-ready.',
  );
  tail.push('Original artwork, no logos, no watermark.');
  const suffix = tail.join(' ');
  const room = MAX_PROMPT_CHARS - suffix.length - 1;
  return `${clip(body, Math.max(0, room)).trim()} ${suffix}`;
}

export const runDesigner: RunDesigner = async (input, baseDeps) => {
  const deps = baseDeps as DesignerDepsExt;
  const usage: LlmUsage[] = [];
  const productSeg = safeKeySegment(input.productId);
  const transparent = isTransparentProduct(input.productType);
  const size = await resolveRequestSize(input.productType, deps);
  const blocklist = effectiveBlocklist(deps.blocklist ?? []);

  const model = await askModel(
    deps.llm,
    {
      agent: 'designer',
      tier: 'small',
      system: DESIGNER_SYSTEM,
      instructions: designerInstructions({
        productType: input.productType,
        designPhrase: input.designPhrase,
        avoidRules: input.avoidRules.slice(0, 20),
        transparent,
      }),
      untrustedData: {
        conceptTitle: input.conceptTitle,
        designPhrase: input.designPhrase,
        styleNotes: input.styleNotes,
        nicheBrief: input.nicheBrief,
        qaNotes: input.qaNotes.slice(0, 10),
      },
      schema: DesignerModelSchema,
      maxOutputTokens: 800,
    },
    usage,
  );

  const prompt = composeImagePrompt({ modelPrompt: model.prompt, input, transparent, blocklist });

  // Next free art slot: designs/<productId>/art-<n>.png (QA redesigns keep the earlier art).
  let n = 1;
  while (n <= MAX_ART_VERSIONS && (await deps.storage.get(`designs/${productSeg}/art-${n}.png`))) n++;
  if (n > MAX_ART_VERSIONS) throw new Error(`Designer: too many art versions for product ${productSeg}`);
  const artKey = `designs/${productSeg}/art-${n}.png`;

  const image = await deps.imageGen.generate({
    prompt,
    style: model.style,
    transparentBackground: transparent,
    widthPx: size.widthPx,
    heightPx: size.heightPx,
    seed: stableSeed(`${productSeg}:${n}`),
  });
  if (!isPng(image.bytes)) throw new Error('Designer: image generator did not return a PNG');
  await deps.storage.put(artKey, image.bytes, 'image/png');

  const output = DesignerOutputSchema.parse({ prompt, model: image.model, seed: image.seed, artKey });
  return { output, llmUsage: usage };
};

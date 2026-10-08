/**
 * 6. QA & Publisher.
 *  1. Load Razvan's edited PNG; resolve the print spec (SHOP printSpec, else the Printify print area @300 DPI).
 *  2. If it is smaller than the print spec: AI upscale x2/x4 with deps.upscaler (sharp-only when null, max 4x),
 *     then exact resize with imageTools.toPrintFile. Needs more than 4x -> qa_failed.
 *  3. Inspect the print file: size, DPI, sRGB, alpha (tshirt/mug), semi-transparent share.
 *  4. Printify, idempotent: reuse input.existingPrintifyProductId when set (already published -> done;
 *     publishing -> wait), else upload + create with per-variant min-margin prices. A new product's id is handed
 *     to deps.onPrintifyProductCreated at once, so a run that dies later never leads to a duplicate product.
 *  5. Vision check of up to 3 Printify mockups (fetched with the SSRF-safe deps.fetchImage) BEFORE publishing,
 *     so a failed check never leaves an Etsy draft behind. Nothing is published unless the model looked at
 *     least at one mockup: no mockup yet -> retry later (PrintifyProductPendingError), or qa_failed on the
 *     job's final attempt.
 *  6. Publish, then poll getProduct (bounded) until external.id is set -> drafted.
 * Any failure after a Printify product exists is rethrown as PrintifyProductPendingError carrying the id,
 * so the orchestrator can store it and the retry reuses the product instead of creating a duplicate.
 * qa_failed never carries a product id (see `fail`), so a redesign always gets a fresh Printify product.
 */
import { z } from 'zod';
import type { PrintSpec, ShopConfig } from '../config/shop.ts';
import type { ProductType } from '../domain/types.ts';
import type { ImageInspection, PrintifyCatalogEntry, PrintifyProduct } from '../integrations/types.ts';
import type { LlmImage, LlmUsage } from '../llm/types.ts';
import { AGENT_DEFAULT_TIERS } from '../llm/tiers.ts';
import { QaPublisherOutputSchema, type QaPublisherOutput, type RunQaPublisher } from './contracts.ts';
import { askModel, isPng, safeKeySegment, toVisionImage } from './common.ts';
import { isTransparentProduct } from './designer.ts';
import type { QaPublisherDepsExt } from './extensions.ts';
import { variantPrices } from './pricing.ts';
import { QA_VISION_SYSTEM, qaVisionInstructions } from './prompts.ts';
import { clip, collapseSpaces } from './rules.ts';

export const QaVisionModelSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  issues: z.array(z.string().max(300)).max(8),
});

export const MAX_SEMI_TRANSPARENT_SHARE = 0.1;
export const MAX_ASPECT_MISMATCH = 0.05;
export const MAX_MOCKUPS_CHECKED = 3;
export const DEFAULT_MOCKUP_LOAD_ATTEMPTS = 3;
export const DEFAULT_PUBLISH_POLL_ATTEMPTS = 20;
export const DEFAULT_PUBLISH_POLL_INTERVAL_MS = 6000;
export const DEFAULT_PRINT_DPI = 300;

/** Thrown when something fails after a Printify product exists; persist `printifyProductId` before retrying. */
export class PrintifyProductPendingError extends Error {
  readonly retryable = true;
  constructor(
    public readonly printifyProductId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PrintifyProductPendingError';
  }
}

export function resolvePrintSpec(productType: ProductType, shop: Pick<ShopConfig, 'products'>, catalog: PrintifyCatalogEntry): PrintSpec {
  const fromShop = shop.products[productType].printSpec;
  if (fromShop) return fromShop;
  return {
    widthPx: catalog.printArea.widthPx,
    heightPx: catalog.printArea.heightPx,
    dpi: DEFAULT_PRINT_DPI,
    transparentBackground: isTransparentProduct(productType),
  };
}

/** 1 = big enough, 2/4 = upscale factor, null = would need more than 4x. */
export function upscaleFactorFor(size: { widthPx: number; heightPx: number }, spec: { widthPx: number; heightPx: number }): 1 | 2 | 4 | null {
  if (size.widthPx <= 0 || size.heightPx <= 0) return null;
  const need = Math.max(spec.widthPx / size.widthPx, spec.heightPx / size.heightPx);
  if (need <= 1) return 1;
  if (need <= 2) return 2;
  if (need <= 4) return 4;
  return null;
}

/** Failure notes for a print file (empty = OK). */
export function checkPrintFile(insp: ImageInspection, spec: PrintSpec, transparent: boolean): string[] {
  const issues: string[] = [];
  if (insp.format.toLowerCase() !== 'png') issues.push(`Print file is ${insp.format}, expected PNG.`);
  if (insp.widthPx !== spec.widthPx || insp.heightPx !== spec.heightPx) {
    issues.push(`Print file is ${insp.widthPx}x${insp.heightPx} px, expected ${spec.widthPx}x${spec.heightPx} px.`);
  }
  if (insp.dpi === null || Math.abs(insp.dpi - spec.dpi) > 0.5) issues.push(`Print file DPI is ${insp.dpi ?? 'missing'}, expected ${spec.dpi}.`);
  if (insp.colorSpace.toLowerCase() !== 'srgb') issues.push(`Print file colour space is ${insp.colorSpace}, expected sRGB.`);
  if (transparent && !insp.hasAlpha) issues.push('Print file has no transparency; this product needs a transparent background.');
  if (transparent && insp.semiTransparentShare > MAX_SEMI_TRANSPARENT_SHARE) {
    issues.push(
      `${(insp.semiTransparentShare * 100).toFixed(1)}% of pixels are semi-transparent (max ${MAX_SEMI_TRANSPARENT_SHARE * 100}%); soft edges and glows print badly. Use solid edges.`,
    );
  }
  return issues;
}

export const runQaPublisher: RunQaPublisher = async (input, baseDeps) => {
  const deps = baseDeps as QaPublisherDepsExt;
  const usage: LlmUsage[] = [];
  const notes: string[] = [];
  const productSeg = safeKeySegment(input.productId);
  const transparent = isTransparentProduct(input.productType);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollAttempts = deps.publishPollAttempts ?? DEFAULT_PUBLISH_POLL_ATTEMPTS;
  const pollIntervalMs = deps.publishPollIntervalMs ?? DEFAULT_PUBLISH_POLL_INTERVAL_MS;

  const result = (output: QaPublisherOutput) => ({ output: QaPublisherOutputSchema.parse(output), llmUsage: usage });
  /**
   * qa_failed always returns printifyProductId null: the product goes back to `designed` for a new upload, so a
   * Printify product made from the old file must never be reused. Any such product is named in the notes.
   */
  const fail = (issues: string[], orphanPrintifyId: string | null) => {
    const orphan = orphanPrintifyId
      ? [`Printify product ${orphanPrintifyId} was made from this file and will not be reused; delete it in Printify (and its Etsy draft, if any).`]
      : [];
    return result({ status: 'qa_failed', qaNotes: [...issues, ...notes, ...orphan].map((n) => clip(n, 500)), printifyProductId: null });
  };

  // 1. Edited file + print spec.
  const catalog = await deps.printify.getCatalogEntry(input.productType);
  const spec = resolvePrintSpec(input.productType, deps.shop, catalog);
  const edited = await deps.storage.get(input.editedKey);
  if (!edited) return fail(['The edited design file is missing. Upload it again.'], input.existingPrintifyProductId);
  if (!isPng(edited.bytes)) return fail(['The edited design is not a PNG file.'], input.existingPrintifyProductId);
  const editedInfo = await deps.imageTools.inspect(edited.bytes);

  const editedAspect = editedInfo.widthPx / editedInfo.heightPx;
  const specAspect = spec.widthPx / spec.heightPx;
  const mismatch = Math.abs(editedAspect - specAspect) / specAspect;
  if (mismatch > MAX_ASPECT_MISMATCH) {
    const msg = `The edited design's aspect ratio (${editedInfo.widthPx}x${editedInfo.heightPx}) differs from the print area (${spec.widthPx}x${spec.heightPx}) by ${(mismatch * 100).toFixed(0)}%.`;
    if (!transparent) return fail([`${msg} Crop it to the print area's shape.`], input.existingPrintifyProductId);
    notes.push(`${msg} It is fitted with transparent margins.`);
  }

  // 2. Upscale if needed, then exact print size.
  const factor = upscaleFactorFor(editedInfo, spec);
  if (factor === null) {
    return fail(
      [
        `The edited design is ${editedInfo.widthPx}x${editedInfo.heightPx} px; it must be at least ${Math.ceil(spec.widthPx / 4)}x${Math.ceil(spec.heightPx / 4)} px (max 4x upscale).`,
      ],
      input.existingPrintifyProductId,
    );
  }
  let working = edited.bytes;
  if (factor !== 1 && deps.upscaler) {
    working = await deps.upscaler.upscale(working, factor);
    notes.push(`Upscaled ${factor}x with the AI upscaler before the print resize.`);
  } else if (factor > 1) {
    notes.push('Resized up with sharp only (no AI upscaler configured).');
  }
  const printBytes = await deps.imageTools.toPrintFile(working, { widthPx: spec.widthPx, heightPx: spec.heightPx, dpi: spec.dpi });

  // 3. Print-file checks.
  const printInfo = await deps.imageTools.inspect(printBytes);
  const problems = checkPrintFile(printInfo, spec, transparent);
  if (!transparent && printInfo.hasAlpha) notes.push('Print file has an alpha channel; transparent areas will print white.');
  if (problems.length > 0) return fail(problems, input.existingPrintifyProductId);
  const printKey = `designs/${productSeg}/print.png`;
  await deps.storage.put(printKey, printBytes, 'image/png');

  // 4. Printify product: reuse or create.
  let productId: string;
  let createdNow = false;
  if (input.existingPrintifyProductId) {
    productId = input.existingPrintifyProductId;
    notes.push('Reused the existing Printify product (no duplicate created).');
  } else {
    const upload = await deps.printify.uploadImage({
      fileName: `${productSeg}.png`,
      contentsBase64: Buffer.from(printBytes).toString('base64'),
    });
    const variants = variantPrices(input.listing.priceEur, catalog, input.eurToUsd, deps.shop).map((v) => ({
      id: v.id,
      priceCents: v.priceCents,
      isEnabled: v.isEnabled,
    }));
    const created = await deps.printify.createProduct({
      title: input.listing.title,
      description: input.listing.description,
      tags: input.listing.tags,
      blueprintId: catalog.blueprintId,
      printProviderId: catalog.printProviderId,
      variants,
      imageId: upload.id,
      printPosition: catalog.printArea.position,
    });
    productId = created.id;
    createdNow = true;
  }

  try {
    // Persist the new id before anything else (publish, polling, the vision call) can fail or be cut short.
    if (createdNow && deps.onPrintifyProductCreated) await deps.onPrintifyProductCreated(productId);
    let product: PrintifyProduct = await deps.printify.getProduct(productId);
    if (!product.external?.id) {
      if (product.isLocked) {
        notes.push('Printify is already publishing this product; waiting for the Etsy draft.');
      } else {
        // 5. Vision check before publishing.
        const issues = await visionCheck(product);
        if (issues) return fail(issues, productId);
        await deps.printify.publishProduct(productId);
      }
      // 6. Bounded poll for the Etsy listing id.
      for (let i = 0; i < pollAttempts && !product.external?.id; i++) {
        if (i > 0 || product.isLocked) await sleep(pollIntervalMs);
        product = await deps.printify.getProduct(productId);
      }
      if (!product.external?.id) {
        throw new PrintifyProductPendingError(productId, `Printify did not report the Etsy listing after ${pollAttempts} checks`);
      }
    } else if (input.existingPrintifyProductId) {
      notes.push('The Printify product was already published to Etsy.');
    }
    const etsyListingId = Number(product.external.id);
    if (!Number.isSafeInteger(etsyListingId) || etsyListingId <= 0) {
      throw new PrintifyProductPendingError(productId, `Printify returned an unexpected Etsy listing id: ${clip(product.external.id, 40)}`);
    }
    return result({ status: 'drafted', printKey, printifyProductId: productId, etsyListingId, qaNotes: notes.map((n) => clip(n, 500)) });
  } catch (err) {
    if (err instanceof PrintifyProductPendingError) throw err;
    throw new PrintifyProductPendingError(productId, `QA & Publisher failed after the Printify product existed: ${(err as Error)?.message ?? String(err)}`, {
      cause: err,
    });
  }

  async function loadMockups(product: PrintifyProduct): Promise<{ images: LlmImage[]; errors: string[] }> {
    const images: LlmImage[] = [];
    const errors: string[] = [];
    for (const url of product.mockupUrls.slice(0, MAX_MOCKUPS_CHECKED)) {
      try {
        const img = await deps.fetchImage(url);
        images.push(await toVisionImage(img.bytes, 768));
      } catch (err) {
        errors.push(clip((err as Error)?.message ?? 'error', 120));
      }
    }
    return { images, errors };
  }

  /**
   * Issues (-> qa_failed) or null (passed). Fails closed: publishing happens only after the model has looked at
   * least at one mockup. Printify renders mockups shortly after create, so a few in-run retries come first.
   */
  async function visionCheck(first: PrintifyProduct): Promise<string[] | null> {
    let product = first;
    let { images, errors } = await loadMockups(product);
    const tries = Math.max(1, deps.mockupLoadAttempts ?? DEFAULT_MOCKUP_LOAD_ATTEMPTS);
    for (let i = 1; i < tries && images.length === 0; i++) {
      await sleep(pollIntervalMs);
      product = await deps.printify.getProduct(productId);
      ({ images, errors } = await loadMockups(product));
    }
    for (const e of errors) notes.push(`A mockup could not be loaded for the vision check (${e}).`);
    if (images.length === 0) {
      const why =
        product.mockupUrls.length === 0 ? 'Printify has not generated mockup images yet' : 'none of the mockup images could be loaded';
      if (deps.finalAttempt) {
        return [
          `The mockup check could not run (${why}), so the product was not published. Check the mockups of this product in Printify, then upload the design again.`,
        ];
      }
      throw new PrintifyProductPendingError(productId, `Vision check not possible yet (${why}); not publishing, will retry`);
    }
    const verdict = await askModel(
      deps.llm,
      {
        agent: 'qa_publisher',
        tier: AGENT_DEFAULT_TIERS.qa_publisher,
        system: QA_VISION_SYSTEM,
        instructions: qaVisionInstructions({ productType: input.productType, transparent, imageCount: images.length }),
        untrustedData: { listingTitle: input.listing.title },
        images,
        schema: QaVisionModelSchema,
        maxOutputTokens: 600,
      },
      usage,
    );
    if (verdict.verdict === 'pass') {
      notes.push(`Vision check passed on ${images.length} mockup(s).`);
      return null;
    }
    const issues = verdict.issues.map((i) => collapseSpaces(i)).filter(Boolean);
    return issues.length ? issues.map((i) => `Mockup check: ${i}`) : ['Mockup check failed without details.'];
  }
};

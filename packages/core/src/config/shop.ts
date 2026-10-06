/**
 * Business decisions (Razvan, 2026-10-06). Change values here, not in code.
 * CONTRACT FILE: owned by the foundation. Builders may read; do not change values.
 */
import type { ProductType } from '../domain/types.ts';

export interface PrintSpec {
  widthPx: number;
  heightPx: number;
  dpi: number;
  transparentBackground: boolean;
}

export interface ProductConfig {
  enabled: boolean;
  /** Printify catalog ids; filled in by `setup` from the live catalog. null = not set up yet. */
  printifyBlueprintId: number | null;
  printifyPrintProviderId: number | null;
  /**
   * Print file spec. T-shirt is Printify's documented 4500x5400 @300 DPI, transparent.
   * Mug/poster: null until read from the Printify blueprint's print areas during setup.
   */
  printSpec: PrintSpec | null;
}

export const SHOP = {
  newShop: true,
  /** Listing currency. Payment account assumed EUR, so no 2.5% conversion fee. */
  currency: 'EUR' as const,
  /** Buyers targeted first: US print providers, US shipping profile, USPTO checks. */
  market: 'US' as const,
  printifyPlan: 'free' as const,
  /** Free trend sources only: Etsy search, Pinterest (if a token exists), seasonal calendar. */
  trendSources: ['etsy_search', 'pinterest', 'seasonal'] as const,
  /** Razvan edits EVERY design before it can move on (state `designed` waits for his upload). */
  requireHumanDesignEdit: true,

  products: {
    tshirt: {
      enabled: true,
      printifyBlueprintId: null,
      printifyPrintProviderId: null,
      printSpec: { widthPx: 4500, heightPx: 5400, dpi: 300, transparentBackground: true },
    },
    mug: { enabled: true, printifyBlueprintId: null, printifyPrintProviderId: null, printSpec: null },
    poster: { enabled: true, printifyBlueprintId: null, printifyPrintProviderId: null, printSpec: null },
  } satisfies Record<ProductType, ProductConfig>,

  imageGen: {
    /**
     * Raw art is generated on the RTX 3060 at about 1/3 of the print size (dimensions rounded to multiples of 16),
     * Razvan edits it, then QA upscales it to the print spec with Real-ESRGAN.
     */
    generationScale: 1 / 3,
    /** Used when a product's printSpec is not known yet. */
    defaultSizePx: { widthPx: 1536, heightPx: 1536 },
  },

  pricing: {
    /** Minimum share of the sale price kept after Printify cost and Etsy fees. */
    minMarginShare: 0.25,
    /** Etsy fees used by the margin model. Source: Etsy fee pages, Oct 2026. */
    etsyTransactionFeeShare: 0.065,
    paymentProcessingShare: 0.04, // Romania: 4% + EUR 0.30
    paymentProcessingFixedEur: 0.3,
    listingFeeUsd: 0.2,
    /** Charm pricing: round final price up to x.99 */
    roundTo99: true,
  },

  caps: {
    /** Pilot: 5 drafts/day. Raise to 10 after Gate 2. */
    dailyDraftCap: 5,
    dailySpendCapUsd: 10,
    maxQaRedesigns: 2,
    retireAfterDays: 60,
    maxNichesPerScan: 10,
    maxProductsPerNiche: 3,
  },

  listing: {
    titleMaxChars: 140,
    maxTags: 13,
    tagMaxChars: 20,
    whoMade: 'i_did' as const,
    whenMade: 'made_to_order' as const,
    /** Appended by code to EVERY description. Never left to the model. */
    aiDisclosure:
      'About this design: the artwork was created with AI image tools from my own prompts and then edited by hand by me.',
    productionPartnerDisclosure:
      'Made to order: printed and shipped by my production partner, Printify, and its print providers.',
  },

  /** Nice classes checked per product type (live marks in these classes block). */
  trademarkClasses: {
    tshirt: [25],
    mug: [21],
    poster: [16],
  } satisfies Record<ProductType, number[]>,
} as const;

export type ShopConfig = typeof SHOP;

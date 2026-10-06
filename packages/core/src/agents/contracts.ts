/**
 * Inputs and outputs of the seven agents. The orchestrator loads inputs from the DB, calls the agent,
 * validates the output with these schemas, and persists it. Agents never touch the DB.
 * CONTRACT FILE: owned by the foundation. Builders may ADD optional fields, never change existing ones.
 */
import { z } from 'zod';
import type { ShopConfig } from '../config/shop.ts';
import type { ProductType, TrademarkHit } from '../domain/types.ts';
import type {
  AllowlistedImageFetcher,
  BlobStorage,
  EtsyClient,
  ImageGenClient,
  ImageTools,
  ImageUpscaler,
  PrintifyClient,
  TrademarkClient,
  TrendSignalInput,
} from '../integrations/types.ts';
import type { LlmClient, LlmUsage } from '../llm/types.ts';

export const ProductTypeSchema = z.enum(['tshirt', 'mug', 'poster']);

/** Every agent returns its output plus the LLM usage it consumed (for agent_runs + spend caps). */
export interface AgentResult<T> {
  output: T;
  llmUsage: LlmUsage[];
}

export interface BaseDeps {
  llm: LlmClient;
  shop: ShopConfig;
  /** ISO date (YYYY-MM-DD) injected for determinism. */
  today: string;
}

/* ------------------------------ 1. Trend Scout ---------------------------- */

export interface TrendScoutInput {
  signals: (TrendSignalInput & { id: string })[];
  productTypes: ProductType[];
  /** Niches that produced sales recently: lean toward these themes (new designs, never copies). */
  recentWinners: { theme: string; keywords: string[] }[];
  /** Themes already in the pipeline: avoid duplicates. */
  existingThemes: string[];
  blocklist: string[];
}

export const TrendScoutOutputSchema = z.object({
  niches: z
    .array(
      z.object({
        theme: z.string().min(3).max(120),
        keywords: z.array(z.string().min(2).max(60)).min(1).max(8),
        brief: z.string().min(20).max(1200),
        season: z.string().max(60).nullable(),
        sourceSignalIds: z.array(z.string()).max(30),
      }),
    )
    .max(10),
});
export type TrendScoutOutput = z.infer<typeof TrendScoutOutputSchema>;

export type RunTrendScout = (input: TrendScoutInput, deps: BaseDeps) => Promise<AgentResult<TrendScoutOutput>>;

/* ---------------------------- 2. Niche Validator -------------------------- */

export interface NicheValidatorInput {
  niche: { id: string; theme: string; keywords: string[]; brief: string };
}

export interface NicheValidatorDeps extends BaseDeps {
  etsy: EtsyClient;
  printify: PrintifyClient;
}

export const NicheValidatorOutputSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  score: z.number().int().min(0).max(100),
  reasoning: z.string().min(10).max(2000),
  /** Evidence gathered by code, echoed for the audit trail. */
  competition: z.array(
    z.object({ keyword: z.string(), activeListings: z.number().int().min(0), medianFavorites: z.number().min(0) }),
  ),
  products: z
    .array(
      z.object({
        productType: ProductTypeSchema,
        conceptTitle: z.string().min(3).max(120),
        designPhrase: z.string().max(80).nullable(),
        styleNotes: z.string().max(600),
        targetPriceEur: z.number().positive(),
        expectedMarginShare: z.number().min(0).max(1),
      }),
    )
    .max(3),
});
export type NicheValidatorOutput = z.infer<typeof NicheValidatorOutputSchema>;

export type RunNicheValidator = (
  input: NicheValidatorInput,
  deps: NicheValidatorDeps,
) => Promise<AgentResult<NicheValidatorOutput>>;

/* ---------------------------- 3. Compliance Guard ------------------------- */

export interface ComplianceGuardInput {
  stage: 'concept' | 'final';
  productType: ProductType;
  conceptTitle: string;
  designPhrase: string | null;
  keywords: string[];
  /** Final stage only. */
  listing?: { title: string; tags: string[]; description: string };
  /** Final stage only: key of Razvan's edited design, inspected visually. */
  designKey?: string;
}

export interface ComplianceGuardDeps extends BaseDeps {
  trademark: TrademarkClient;
  storage: BlobStorage;
  blocklist: string[];
}

export const ComplianceGuardOutputSchema = z.object({
  verdict: z.enum(['pass', 'block']),
  reasons: z.array(z.string().max(500)).max(20),
  flaggedTerms: z.array(z.string().max(80)).max(50),
  /** Code-side evidence; any blocklist hit or LIVE mark in the product's class forces 'block'. */
  trademarkHits: z.array(
    z.object({
      mark: z.string(),
      serial: z.string(),
      status: z.enum(['live', 'dead']),
      classes: z.array(z.number().int()),
      owner: z.string().nullable(),
    }),
  ),
  blocklistHits: z.array(z.string()),
});
export type ComplianceGuardOutput = z.infer<typeof ComplianceGuardOutputSchema>;

export type RunComplianceGuard = (
  input: ComplianceGuardInput,
  deps: ComplianceGuardDeps,
) => Promise<AgentResult<ComplianceGuardOutput>>;

/* ------------------------------- 4. Designer ------------------------------ */

export interface DesignerInput {
  productId: string;
  productType: ProductType;
  conceptTitle: string;
  designPhrase: string | null;
  styleNotes: string;
  nicheBrief: string;
  /** Rules learned from Razvan's rejections ("avoid ..."). */
  avoidRules: string[];
  /** Present when QA sent the design back. */
  qaNotes: string[];
}

export interface DesignerDeps extends BaseDeps {
  imageGen: ImageGenClient;
  storage: BlobStorage;
}

export const DesignerOutputSchema = z.object({
  prompt: z.string().min(10).max(4000),
  model: z.string(),
  seed: z.number().int().nullable(),
  /** Blob key where the raw art was stored: designs/<productId>/art-<n>.png */
  artKey: z.string(),
});
export type DesignerOutput = z.infer<typeof DesignerOutputSchema>;

export type RunDesigner = (input: DesignerInput, deps: DesignerDeps) => Promise<AgentResult<DesignerOutput>>;

/* ---------------------------- 5. Listing Writer --------------------------- */

export interface ListingWriterInput {
  productType: ProductType;
  conceptTitle: string;
  designPhrase: string | null;
  styleNotes: string;
  nicheKeywords: string[];
  nicheBrief: string;
  targetPriceEur: number;
  avoidRules: string[];
}

export const ListingWriterOutputSchema = z.object({
  title: z.string().min(10).max(140),
  tags: z.array(z.string().min(2).max(20)).min(5).max(13),
  /** Final description INCLUDING the two disclosure lines (code appends them; model never writes them). */
  description: z.string().min(50).max(5000),
  priceEur: z.number().positive(),
});
export type ListingWriterOutput = z.infer<typeof ListingWriterOutputSchema>;

export type RunListingWriter = (
  input: ListingWriterInput,
  deps: BaseDeps,
) => Promise<AgentResult<ListingWriterOutput>>;

/* --------------------------- 6. QA and Publisher -------------------------- */

export interface QaPublisherInput {
  productId: string;
  productType: ProductType;
  editedKey: string;
  listing: { title: string; tags: string[]; description: string; priceEur: number };
  /** Idempotency: if set, reuse this Printify product instead of creating another. */
  existingPrintifyProductId: string | null;
  /** EUR->USD rate used only to convert Etsy EUR price to Printify variant price cents (Printify bills USD). */
  eurToUsd: number;
}

export interface QaPublisherDeps extends BaseDeps {
  printify: PrintifyClient;
  storage: BlobStorage;
  imageTools: ImageTools;
  /** AI upscaler for edited files smaller than the print spec; null = sharp-only resize (max 4x). */
  upscaler: ImageUpscaler | null;
  /** SSRF-safe fetcher for Printify mockup URLs (vision check). */
  fetchImage: AllowlistedImageFetcher;
}

export const QaPublisherOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('drafted'),
    printKey: z.string(),
    printifyProductId: z.string(),
    etsyListingId: z.number().int().positive(),
    qaNotes: z.array(z.string()),
  }),
  z.object({
    status: z.literal('qa_failed'),
    qaNotes: z.array(z.string()).min(1),
    printifyProductId: z.string().nullable(),
  }),
]);
export type QaPublisherOutput = z.infer<typeof QaPublisherOutputSchema>;

export type RunQaPublisher = (
  input: QaPublisherInput,
  deps: QaPublisherDeps,
) => Promise<AgentResult<QaPublisherOutput>>;

/* ------------------------------- 7. Analyst ------------------------------- */

export interface AnalystInput {
  listings: {
    productId: string;
    etsyListingId: number;
    nicheId: string;
    theme: string;
    ageDays: number;
    views: number;
    favorites: number;
    orders: number;
    revenueEur: number;
  }[];
  weekStart: string; // YYYY-MM-DD (Monday)
  spendUsdThisWeek: number;
  draftsThisWeek: number;
  approvalsThisWeek: number;
  rejectionsThisWeek: number;
}

export const AnalystOutputSchema = z.object({
  /** Decided by code rules (no favorites + bottom-quartile views after retireAfterDays). */
  retireProductIds: z.array(z.string()),
  /** Niches with sales: queue new designs (never copies). */
  followUpNicheIds: z.array(z.string()),
  reportMarkdown: z.string().min(20).max(20000),
});
export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;

export type RunAnalyst = (input: AnalystInput, deps: BaseDeps) => Promise<AgentResult<AnalystOutput>>;

/* ----------------------------- Registry ----------------------------------- */

export interface AgentRegistry {
  trendScout: RunTrendScout;
  nicheValidator: RunNicheValidator;
  complianceGuard: RunComplianceGuard;
  designer: RunDesigner;
  listingWriter: RunListingWriter;
  qaPublisher: RunQaPublisher;
  analyst: RunAnalyst;
}

export type { TrademarkHit };

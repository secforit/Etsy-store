/**
 * Everything the approval desk (apps/desk) may do. Implemented by the orchestrator builder in
 * packages/core/src/desk/service.ts; consumed by the desk. The desk never touches the DB or
 * external APIs directly.
 * CONTRACT FILE: owned by the foundation. Builders may ADD members, never change existing ones.
 */
import type { RolloutScorecard } from '../domain/rollout.ts';
import type {
  ComplianceCheck,
  Design,
  Listing,
  Niche,
  Product,
  ProductState,
  Settings,
} from '../domain/types.ts';

export interface ProductSummary {
  id: string;
  productType: Product['productType'];
  conceptTitle: string;
  state: ProductState;
  theme: string;
  targetPriceEur: number;
  updatedAt: string;
  /** True when Razvan must act: `designed` (upload edit) or `drafted` (approve/reject). */
  needsAction: boolean;
}

export interface ProductDetail {
  product: Product;
  niche: Niche;
  design: Design | null;
  listing: Listing | null;
  complianceChecks: ComplianceCheck[];
  /** Margin estimate for the target price, from the shop fee model. */
  estimatedMarginEur: number | null;
}

export interface DashboardStats {
  paused: boolean;
  countsByState: Record<ProductState, number>;
  draftsToday: number;
  dailyDraftCap: number;
  spendTodayUsd: number;
  dailySpendCapUsd: number;
  latestReportMarkdown: string | null;
}

export type AssetKind = 'art' | 'edited' | 'print';

export interface RejectOptions {
  /** The reason is an IP / trademark problem the Compliance Guard missed (counts against rollout Gate 2). */
  ipMiss?: boolean;
}

export interface UploadedFile {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

/** Thrown for anything the user can fix (wrong state, bad file). Message is safe to show. */
export class DeskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeskError';
  }
}

export interface DeskService {
  getDashboard(): Promise<DashboardStats>;
  listProducts(filter?: { states?: ProductState[]; limit?: number }): Promise<ProductSummary[]>;
  getProduct(productId: string): Promise<ProductDetail | null>;
  /** Only PNG; validated (magic bytes, size, dimensions) before storing. designed -> edited. */
  uploadEditedDesign(productId: string, file: UploadedFile, actor: string): Promise<void>;
  /** drafted -> live: activates the Etsy listing. */
  approve(productId: string, actor: string): Promise<void>;
  /** drafted -> rejected; reason (required, <= 500 chars) becomes an avoid-rule. */
  reject(productId: string, reason: string, actor: string, opts?: RejectOptions): Promise<void>;
  getAsset(productId: string, kind: AssetKind): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  /** Rollout gates (Gate 2, Gate 3) and the all-time metrics behind them. Read-only, no external calls. */
  getRollout(): Promise<RolloutScorecard>;
  getSettings(): Promise<Settings>;
  updateSettings(
    patch: Partial<Pick<Settings, 'paused' | 'dailyDraftCap' | 'dailySpendCapUsd' | 'blocklist'>>,
    actor: string,
  ): Promise<Settings>;
}

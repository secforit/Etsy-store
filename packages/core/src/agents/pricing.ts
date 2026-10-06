/**
 * Price rules (code, never the model). Margin model per SHOP.pricing:
 *   margin = price - price * (Etsy transaction fee + payment processing share) - payment fixed fee
 *            - listing fee - (Printify base cost + shipping to the target market)
 * Shipping is counted as our cost (free-shipping assumption for US buyers), which is conservative.
 * Listing prices are EUR; Printify costs are USD and converted with `eurToUsd` (USD per 1 EUR).
 * Final prices are rounded UP to x.99 when SHOP.pricing.roundTo99, otherwise up to whole cents.
 */
import type { ShopConfig } from '../config/shop.ts';
import type { PrintifyCatalogEntry } from '../integrations/types.ts';

/**
 * Used only when the caller does not pass `eurToUsd`. Deliberately low (a lower rate makes USD costs
 * look larger in EUR, so prices err on the safe side).
 */
export const DEFAULT_EUR_TO_USD = 1.1;

export interface UnitCostUsd {
  productUsd: number;
  shippingUsd: number;
}

export interface MarginBreakdown {
  priceEur: number;
  feesEur: number;
  costEur: number;
  marginEur: number;
  marginShare: number;
}

type Pricing = Pick<ShopConfig, 'pricing'>;

export function roundCents(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/** 17.20 -> 17.99, 17.99 -> 17.99, 18.00 -> 18.99. */
export function roundUpTo99(price: number): number {
  const cents = Math.round(price * 100);
  const target = Math.floor(cents / 100) * 100 + 99;
  return (cents <= target ? target : target + 100) / 100;
}

export function roundUpToCents(price: number): number {
  return Math.ceil(price * 100 - 1e-6) / 100;
}

export function finalizePrice(priceEur: number, shop: Pricing): number {
  return shop.pricing.roundTo99 ? roundUpTo99(priceEur) : roundUpToCents(priceEur);
}

function assertRate(eurToUsd: number): void {
  if (!Number.isFinite(eurToUsd) || eurToUsd <= 0) throw new Error(`invalid eurToUsd rate: ${eurToUsd}`);
}

export function marginFor(priceEur: number, cost: UnitCostUsd, eurToUsd: number, shop: Pricing): MarginBreakdown {
  assertRate(eurToUsd);
  const p = shop.pricing;
  const feesEur =
    priceEur * (p.etsyTransactionFeeShare + p.paymentProcessingShare) + p.paymentProcessingFixedEur + p.listingFeeUsd / eurToUsd;
  const costEur = (cost.productUsd + cost.shippingUsd) / eurToUsd;
  const marginEur = priceEur - feesEur - costEur;
  return {
    priceEur: roundCents(priceEur),
    feesEur: roundCents(feesEur),
    costEur: roundCents(costEur),
    marginEur: roundCents(marginEur),
    marginShare: priceEur > 0 ? Math.round((marginEur / priceEur) * 10_000) / 10_000 : 0,
  };
}

/** Lowest (unrounded) EUR price that keeps SHOP.pricing.minMarginShare. */
export function minPriceEur(cost: UnitCostUsd, eurToUsd: number, shop: Pricing): number {
  assertRate(eurToUsd);
  const p = shop.pricing;
  const variableShare = p.etsyTransactionFeeShare + p.paymentProcessingShare + p.minMarginShare;
  if (variableShare >= 1) throw new Error('pricing config: fee shares + minimum margin must be below 100%');
  const fixedEur = p.paymentProcessingFixedEur + p.listingFeeUsd / eurToUsd + (cost.productUsd + cost.shippingUsd) / eurToUsd;
  return fixedEur / (1 - variableShare);
}

/**
 * Final listing price: the model's proposal, raised to the floor (min margin and any extra floor),
 * capped at `ceilingEur` when given, then rounded up to x.99. Rounding up never breaks the floor.
 */
export function applyPriceRules(
  args: { proposedEur: number; floorEur: number; ceilingEur?: number },
  shop: Pricing,
): number {
  const proposed = Number.isFinite(args.proposedEur) && args.proposedEur > 0 ? args.proposedEur : args.floorEur;
  let price = Math.max(proposed, args.floorEur);
  if (args.ceilingEur !== undefined) price = Math.min(price, Math.max(args.ceilingEur, args.floorEur));
  return finalizePrice(price, shop);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Typical unit cost of a catalog entry: median variant cost + first-item shipping. */
export function costBasisFromCatalog(entry: PrintifyCatalogEntry): UnitCostUsd {
  const costs = entry.variants.map((v) => v.costUsd).filter((c) => Number.isFinite(c) && c > 0);
  if (costs.length === 0) throw new Error(`Printify catalog entry for ${entry.productType} has no priced variants`);
  return { productUsd: median(costs), shippingUsd: Math.max(0, entry.shippingFirstItemUsd) };
}

/** Printify enables at most this many variants per product we create (keeps Etsy listings manageable). */
export const MAX_ENABLED_VARIANTS = 100;

/**
 * Per-variant Printify prices in USD cents: each variant gets max(listing price, its own min-margin price),
 * rounded to x.99 EUR, then converted to USD. Every enabled variant keeps the minimum margin.
 */
export function variantPrices(
  listingPriceEur: number,
  entry: PrintifyCatalogEntry,
  eurToUsd: number,
  shop: Pricing,
): { id: number; priceCents: number; isEnabled: boolean; priceEur: number }[] {
  assertRate(eurToUsd);
  return entry.variants.map((v, index) => {
    const floor = minPriceEur({ productUsd: v.costUsd, shippingUsd: entry.shippingFirstItemUsd }, eurToUsd, shop);
    const priceEur = finalizePrice(Math.max(listingPriceEur, floor), shop);
    return {
      id: v.variantId,
      priceEur,
      priceCents: Math.round(priceEur * eurToUsd * 100),
      isEnabled: index < MAX_ENABLED_VARIANTS,
    };
  });
}

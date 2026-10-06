import { describe, expect, it } from 'vitest';
import { SHOP } from '../config/shop.ts';
import { applyPriceRules, costBasisFromCatalog, finalizePrice, marginFor, minPriceEur, roundUpTo99, variantPrices } from './pricing.ts';
import { catalogEntry } from './testing/fakes.ts';

describe('pricing', () => {
  it('rounds up to x.99', () => {
    expect(roundUpTo99(17.2)).toBe(17.99);
    expect(roundUpTo99(17.99)).toBe(17.99);
    expect(roundUpTo99(18)).toBe(18.99);
    expect(roundUpTo99(18.995)).toBe(19.99);
    expect(roundUpTo99(0.4)).toBe(0.99);
  });

  it('computes the margin with Etsy fees, payment fees, listing fee and Printify cost + shipping', () => {
    const m = marginFor(24.99, { productUsd: 11, shippingUsd: 4.75 }, 1.1, SHOP);
    // fees: 24.99*(0.065+0.04) + 0.30 + 0.20/1.1 = 2.62395 + 0.3 + 0.18182 = 3.10577
    // cost: 15.75/1.1 = 14.31818 ; margin = 24.99 - 3.10577 - 14.31818 = 7.56605
    expect(m.feesEur).toBe(3.11);
    expect(m.costEur).toBe(14.32);
    expect(m.marginEur).toBe(7.57);
    expect(m.marginShare).toBeCloseTo(0.3028, 3);
  });

  it('min price keeps exactly the minimum margin share; rounding up keeps it above', () => {
    const cost = { productUsd: 12, shippingUsd: 4.75 };
    const min = minPriceEur(cost, 1.1, SHOP);
    expect(marginFor(min, cost, 1.1, SHOP).marginShare).toBeCloseTo(SHOP.pricing.minMarginShare, 3);
    const final = finalizePrice(min, SHOP);
    expect(final % 1).toBeCloseTo(0.99, 5);
    expect(marginFor(final, cost, 1.1, SHOP).marginShare).toBeGreaterThanOrEqual(SHOP.pricing.minMarginShare);
  });

  it('applies floor, ceiling and x.99', () => {
    expect(applyPriceRules({ proposedEur: 10, floorEur: 21.3 }, SHOP)).toBe(21.99);
    expect(applyPriceRules({ proposedEur: 99, floorEur: 20, ceilingEur: 30 }, SHOP)).toBe(30.99);
    expect(applyPriceRules({ proposedEur: Number.NaN, floorEur: 20 }, SHOP)).toBe(20.99);
    expect(applyPriceRules({ proposedEur: 25, floorEur: 20, ceilingEur: 10 }, SHOP)).toBe(20.99); // ceiling never below floor
  });

  it('uses the median variant cost as cost basis', () => {
    expect(costBasisFromCatalog(catalogEntry('tshirt'))).toEqual({ productUsd: 11.5, shippingUsd: 4.75 });
    expect(() => costBasisFromCatalog(catalogEntry('mug', { variants: [] }))).toThrow();
  });

  it('prices every Printify variant at or above its own min-margin price, in USD cents', () => {
    const entry = catalogEntry('tshirt');
    const prices = variantPrices(24.99, entry, 1.1, SHOP);
    expect(prices.map((p) => p.id)).toEqual([1, 2, 3]);
    for (const p of prices) {
      const v = entry.variants.find((x) => x.variantId === p.id)!;
      expect(marginFor(p.priceEur, { productUsd: v.costUsd, shippingUsd: entry.shippingFirstItemUsd }, 1.1, SHOP).marginShare).toBeGreaterThanOrEqual(0.25);
      expect(p.priceCents).toBe(Math.round(p.priceEur * 1.1 * 100));
      expect(p.isEnabled).toBe(true);
    }
    // the 2XL costs more, so its price is raised above the listing price
    expect(prices[2]!.priceEur).toBeGreaterThan(prices[0]!.priceEur);
  });

  it('rejects a bad FX rate', () => {
    expect(() => minPriceEur({ productUsd: 1, shippingUsd: 1 }, 0, SHOP)).toThrow();
  });
});

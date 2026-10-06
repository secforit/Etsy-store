import { describe, expect, it } from 'vitest';
import type { NicheValidatorInput } from './contracts.ts';
import { runNicheValidator } from './nicheValidator.ts';
import { finalizePrice, marginFor, minPriceEur } from './pricing.ts';
import { FakeEtsy, FakePrintify, ScriptedLlm, TODAY, listing, shop } from './testing/fakes.ts';

const input: NicheValidatorInput = {
  niche: { id: 'n1', theme: 'Retro Camping Humor', keywords: ['Camping Shirt', 'camping shirt', 'funny camper gift'], brief: 'Campers who like jokes.' },
};

const product = (over: Record<string, unknown> = {}) => ({
  productType: 'tshirt',
  conceptTitle: 'Campfire Club Badge',
  designPhrase: 'Campfire Club',
  styleNotes: 'Vintage badge, warm colours.',
  targetPriceEur: 10,
  ...over,
});

function setup(model: Record<string, unknown>) {
  const llm = new ScriptedLlm({ niche_validator: () => ({ decision: 'accept', score: 70, reasoning: 'Good demand and room to compete.', products: [product()], ...model }) });
  const etsy = new FakeEtsy((kw) => ({ count: kw.length * 100, results: [listing(`${kw} tee`, 10), listing(`${kw} mug`, 30), listing(`${kw} top`, 20)] }));
  const printify = new FakePrintify();
  return { llm, etsy, printify, deps: { llm, etsy, printify, shop, today: TODAY, eurToUsd: 1.1 } };
}

describe('Niche Validator', () => {
  it('gathers competition by code (deduped keywords) and echoes it', async () => {
    const s = setup({});
    const { output } = await runNicheValidator(input, s.deps);
    expect(s.etsy.searches).toEqual(['camping shirt', 'funny camper gift']);
    expect(output.competition).toEqual([
      { keyword: 'camping shirt', activeListings: 1300, medianFavorites: 20 },
      { keyword: 'funny camper gift', activeListings: 1700, medianFavorites: 20 },
    ]);
  });

  it('raises prices to the min-margin floor, rounds to x.99 and computes the margin share in code', async () => {
    const s = setup({});
    const { output } = await runNicheValidator(input, s.deps);
    const p = output.products[0]!;
    const cost = { productUsd: 11.5, shippingUsd: 4.75 };
    expect(p.targetPriceEur).toBe(finalizePrice(minPriceEur(cost, 1.1, shop), shop));
    expect(p.expectedMarginShare).toBeCloseTo(marginFor(p.targetPriceEur, cost, 1.1, shop).marginShare, 4);
    expect(p.expectedMarginShare).toBeGreaterThanOrEqual(shop.pricing.minMarginShare);
  });

  it('caps prices at twice the floor', async () => {
    const s = setup({ products: [product({ targetPriceEur: 500 })] });
    const { output } = await runNicheValidator(input, s.deps);
    const floor = minPriceEur({ productUsd: 11.5, shippingUsd: 4.75 }, 1.1, shop);
    expect(output.products[0]!.targetPriceEur).toBeLessThanOrEqual(finalizePrice(floor * 2, shop));
  });

  it('rejects when the score is below 50 even if the model accepts', async () => {
    const { output } = await runNicheValidator(input, setup({ score: 40 }).deps);
    expect(output.decision).toBe('reject');
    expect(output.products).toEqual([]);
    expect(output.reasoning).toContain('below 50');
  });

  it('returns no products on reject', async () => {
    const { output } = await runNicheValidator(input, setup({ decision: 'reject', score: 20 }).deps);
    expect(output).toMatchObject({ decision: 'reject', products: [] });
  });

  it('dedupes concepts and drops empty phrases', async () => {
    const s = setup({
      products: [product(), product({ conceptTitle: 'campfire club badge!' }), product({ conceptTitle: 'Tent Life', designPhrase: '  ' })],
    });
    const { output } = await runNicheValidator(input, s.deps);
    expect(output.products.map((p) => p.conceptTitle)).toEqual(['Campfire Club Badge', 'Tent Life']);
    expect(output.products[1]!.designPhrase).toBeNull();
  });

  it('caps products at SHOP.caps.maxProductsPerNiche', async () => {
    const s = setup({
      products: [product(), product({ conceptTitle: 'Tent Life' }), product({ conceptTitle: 'Mug Idea', productType: 'mug' })],
    });
    const capped = { ...shop, caps: { ...shop.caps, maxProductsPerNiche: 2 } };
    const { output } = await runNicheValidator(input, { ...s.deps, shop: capped as never });
    expect(output.products.map((p) => p.conceptTitle)).toEqual(['Campfire Club Badge', 'Tent Life']);
  });

  it('limits the product types to those with a Printify catalog entry', async () => {
    const s = setup({});
    s.printify.catalogFails = ['mug', 'poster'];
    await runNicheValidator(input, s.deps);
    const schema = s.llm.last('niche_validator')!.schema;
    expect(schema.safeParse({ decision: 'accept', score: 70, reasoning: 'Good demand here.', products: [product({ productType: 'mug' })] }).success).toBe(false);
    expect(s.llm.last('niche_validator')!.instructions).toContain('tshirt (minimum');
  });

  it('throws when no catalog entry is available', async () => {
    const s = setup({});
    s.printify.catalogFails = ['tshirt', 'mug', 'poster'];
    await expect(runNicheValidator(input, s.deps)).rejects.toThrow('setup-catalog');
  });

  it('passes competitor titles as untrusted data', async () => {
    const s = setup({});
    await runNicheValidator(input, s.deps);
    const r = s.llm.last('niche_validator')!;
    expect(JSON.stringify(r.untrustedData)).toContain('camping shirt tee');
    expect(r.instructions).not.toContain('camping shirt tee');
  });
});

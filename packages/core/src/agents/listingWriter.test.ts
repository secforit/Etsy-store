import { describe, expect, it } from 'vitest';
import type { ListingWriterInput } from './contracts.ts';
import { cleanTag, enforceTitle, runListingWriter, stripModelDisclosures } from './listingWriter.ts';
import { marginFor } from './pricing.ts';
import { FakePrintify, ScriptedLlm, TODAY, shop } from './testing/fakes.ts';

const input: ListingWriterInput = {
  productType: 'tshirt',
  conceptTitle: 'Retro Campfire Club Badge',
  designPhrase: 'Campfire Club',
  styleNotes: 'Vintage badge',
  nicheKeywords: ['camping shirt', 'campfire gift', 'camper tee'],
  nicheBrief: 'Campers who like vintage badges.',
  targetPriceEur: 24.99,
  avoidRules: ['avoid neon colours'],
};

const good = {
  title: 'Campfire Club Retro Camping T-Shirt, Vintage Badge Camper Gift for Outdoor Lovers',
  tags: ['camping shirt', 'Campfire Tee', 'camper gift', 'camping shirt', 'outdoor lover gift', 'vintage badge tee'],
  description: 'A vintage badge design for people who love campfires.\n\nA fun gift for campers and hikers.',
  priceEur: 24.99,
};

function run(model: Record<string, unknown>, extra: Record<string, unknown> = {}, inp: ListingWriterInput = input) {
  const llm = new ScriptedLlm({ listing_writer: () => ({ ...good, ...model }) });
  return runListingWriter(inp, { llm, shop, today: TODAY, ...extra } as never).then((r) => ({ ...r, llm }));
}

describe('Listing Writer disclosures', () => {
  it('appends both shop disclosures verbatim, exactly once, at the end', async () => {
    const { output } = await run({});
    const { aiDisclosure, productionPartnerDisclosure } = shop.listing;
    expect(output.description.endsWith(`${aiDisclosure}\n${productionPartnerDisclosure}`)).toBe(true);
    expect(output.description.split(aiDisclosure)).toHaveLength(2);
    expect(output.description.split(productionPartnerDisclosure)).toHaveLength(2);
  });

  it('strips model-written disclosures, AI mentions, production text, links and emails', async () => {
    const { output } = await run({
      description:
        'A vintage badge design for campers. This artwork was generated with AI. Printed by Printify partners!\n' +
        `${shop.listing.aiDisclosure}\nVisit https://evil.example.com or mail me at a@b.co for deals. Great gift for hikers.`,
    });
    const body = output.description.split(shop.listing.aiDisclosure)[0]!;
    expect(body).toContain('A vintage badge design for campers.');
    expect(body).toContain('Great gift for hikers.');
    expect(body).not.toMatch(/generated|Printify|https?:|evil|a@b\.co/i);
    expect(output.description.split(shop.listing.aiDisclosure)).toHaveLength(2);
  });

  it('falls back to a short body when the model wrote only disclosure text', async () => {
    const { output } = await run({ description: 'This design was made with AI image tools. Printed and shipped by Printify.' });
    expect(output.description.startsWith('Retro Campfire Club Badge: an original t-shirt design.')).toBe(true);
  });

  it('keeps unrelated text when stripping', () => {
    expect(stripModelDisclosures('Soft colours. Made to order by our partner.', shop)).toBe('Soft colours.');
  });
});

describe('Listing Writer tags and title', () => {
  it('lowercases, dedupes, drops >20 chars, and fills to 13 tags', async () => {
    const { output } = await run({ tags: ['Camping Shirt', 'camping shirt', 'CAMPFIRE TEE', 'this tag is far too long for etsy', 'Tent Life!', 'a'] });
    expect(output.tags).toHaveLength(13);
    expect(new Set(output.tags).size).toBe(13);
    for (const t of output.tags) {
      expect(t).toBe(t.toLowerCase());
      expect(t.length).toBeLessThanOrEqual(20);
      expect(t.length).toBeGreaterThanOrEqual(2);
    }
    expect(output.tags.slice(0, 3)).toEqual(['camping shirt', 'campfire tee', 'tent life']);
    expect(output.tags).not.toContain('this tag is far too long for etsy');
  });

  it('never returns more than 13 tags', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `camp tag ${i}`);
    const { output } = await run({ tags: many });
    expect(output.tags).toHaveLength(13);
  });

  it('cuts the title to 140 chars at a word boundary', async () => {
    const long = 'Campfire Club Retro Camping T-Shirt '.repeat(5);
    const { output } = await run({ title: long });
    expect(output.title.length).toBeLessThanOrEqual(140);
    expect(long.startsWith(output.title)).toBe(true);
  });

  it('cleans emoji, once-only characters and shouting', () => {
    expect(enforceTitle('🔥 CAMP FIRE CLUB SHIRT NOW: 100% cotton: soft & warm & cosy', 140)).toBe('CAMP FIRE CLUB Shirt Now: 100% cotton soft & warm cosy');
    expect(cleanTag('Camp™ Life')).toBe('camp life');
  });
});

describe('Listing Writer blocklist re-run', () => {
  it('drops blocked tags, replaces a blocked title, removes blocked sentences', async () => {
    const { output } = await run(
      {
        title: 'Taco Tuesday Campfire Club Retro Camping Shirt',
        tags: ['camping shirt', 'taco tuesday tee', 'disney camp', 'camper gift', 'campfire tee'],
        description: 'A vintage badge design. Perfect for Taco Tuesday fans! Great gift for hikers and campers.',
      },
      { blocklist: ['taco tuesday'] },
    );
    expect(output.title).toBe('Retro Campfire Club Badge T-Shirt - camping shirt');
    expect(output.tags).not.toContain('taco tuesday tee');
    expect(output.tags).not.toContain('disney camp'); // baseline list
    expect(output.description).not.toMatch(/taco/i);
    expect(output.description).toContain('Great gift for hikers and campers.');
  });

  it('puts the blocklist and avoid rules in trusted instructions and product text in untrusted data', async () => {
    const { llm } = await run({}, { blocklist: ['taco tuesday'] });
    const r = llm.last('listing_writer')!;
    expect(r.instructions).toContain('taco tuesday');
    expect(r.instructions).toContain('avoid neon colours');
    expect(r.instructions).not.toContain('Campers who like vintage badges.');
    expect(JSON.stringify(r.untrustedData)).toContain('Campers who like vintage badges.');
  });
});

describe('Listing Writer price rules', () => {
  it('never goes below the target price and rounds to x.99', async () => {
    expect((await run({ priceEur: 9.5 })).output.priceEur).toBe(24.99);
  });

  it('caps the model at +25% over target', async () => {
    expect((await run({ priceEur: 99 })).output.priceEur).toBe(31.99); // 24.99 * 1.25 = 31.24 -> 31.99
  });

  it('raises the price to the Printify min-margin floor when the catalog is available', async () => {
    const printify = new FakePrintify();
    const cheap = { ...input, targetPriceEur: 12.99 };
    const { output } = await run({ priceEur: 12.99 }, { printify, eurToUsd: 1.1 }, cheap);
    const m = marginFor(output.priceEur, { productUsd: 11.5, shippingUsd: 4.75 }, 1.1, shop);
    expect(m.marginShare).toBeGreaterThanOrEqual(shop.pricing.minMarginShare);
    expect(Math.round((output.priceEur % 1) * 100)).toBe(99);
  });
});

describe('Listing Writer trademark pre-check (optional)', () => {
  it('drops tags that are live marks in the product class and refills from candidates', async () => {
    const { FakeTrademark, mark } = await import('./testing/fakes.ts');
    const trademark = new FakeTrademark((t) => (t === 'campfire tee' ? [mark('CAMPFIRE TEES', 'live', [25])] : t === 'camper gift' ? [mark('CAMPER GIFT', 'live', [21])] : []));
    const { output } = await run({}, { trademark });
    expect(output.tags).not.toContain('campfire tee');
    expect(output.tags).toContain('camper gift'); // class 21 does not apply to t-shirts
    expect(output.tags).toHaveLength(13);
    expect(trademark.searched.length).toBe(14);
  });
});

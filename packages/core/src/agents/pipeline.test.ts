/**
 * Smoke test: MockLlm (MODE=mock) + local fakes drive all seven agents through one product's life,
 * proving the mock outputs satisfy every agent's schema and the contract output schemas.
 */
import { describe, expect, it } from 'vitest';
import { MockLlm } from '../llm/mock.ts';
import {
  AnalystOutputSchema,
  ComplianceGuardOutputSchema,
  DesignerOutputSchema,
  ListingWriterOutputSchema,
  NicheValidatorOutputSchema,
  QaPublisherOutputSchema,
  TrendScoutOutputSchema,
} from './contracts.ts';
import { createAgentRegistry } from './registry.ts';
import {
  FakeEtsy,
  FakeImageGen,
  FakeImageTools,
  FakePrintify,
  FakeTrademark,
  FakeUpscaler,
  MemoryStorage,
  TODAY,
  listing,
  realPng,
  shop,
} from './testing/fakes.ts';

describe('mock pipeline', () => {
  it('runs trend scan -> validate -> concept check -> design -> write -> final check -> QA/publish -> analyze', async () => {
    const agents = createAgentRegistry();
    const llm = new MockLlm();
    const base = { llm, shop, today: TODAY };
    const storage = new MemoryStorage();
    const printify = new FakePrintify();
    const etsy = new FakeEtsy((kw) => ({ count: 340, results: [listing(`${kw} shirt`, 12)] }));

    const scout = await agents.trendScout(
      {
        signals: [
          { id: 's1', source: 'etsy_search', keyword: 'camping humor', region: 'US', score: 90, growth: 0.2 },
          { id: 's2', source: 'seasonal', keyword: 'halloween cats', region: 'US', score: 70, growth: null },
        ],
        productTypes: ['tshirt', 'mug', 'poster'],
        recentWinners: [],
        existingThemes: [],
        blocklist: [],
      },
      base,
    );
    TrendScoutOutputSchema.parse(scout.output);
    expect(scout.output.niches.length).toBeGreaterThan(0);
    const niche = scout.output.niches[0]!;

    const validated = await agents.nicheValidator(
      { niche: { id: 'n1', theme: niche.theme, keywords: niche.keywords, brief: niche.brief } },
      { ...base, etsy, printify },
    );
    NicheValidatorOutputSchema.parse(validated.output);
    expect(validated.output.decision).toBe('accept');
    const product = validated.output.products[0]!;
    expect(product.productType).toBe('tshirt');

    const concept = await agents.complianceGuard(
      { stage: 'concept', productType: product.productType, conceptTitle: product.conceptTitle, designPhrase: product.designPhrase, keywords: niche.keywords },
      { ...base, trademark: new FakeTrademark(), storage, blocklist: [] },
    );
    ComplianceGuardOutputSchema.parse(concept.output);
    expect(concept.output.verdict).toBe('pass');

    const productId = '7f1c2a9e-0000-4000-8000-0000000000aa';
    const design = await agents.designer(
      { productId, productType: product.productType, conceptTitle: product.conceptTitle, designPhrase: product.designPhrase, styleNotes: product.styleNotes, nicheBrief: niche.brief, avoidRules: [], qaNotes: [] },
      { ...base, imageGen: new FakeImageGen(), storage },
    );
    DesignerOutputSchema.parse(design.output);

    // Razvan's edit (a real PNG for the vision check, fake-size info for QA)
    const editedKey = `designs/${productId}/edited-1.png`;
    await storage.put(editedKey, await realPng(), 'image/png');

    const written = await agents.listingWriter(
      { productType: product.productType, conceptTitle: product.conceptTitle, designPhrase: product.designPhrase, styleNotes: product.styleNotes, nicheKeywords: niche.keywords, nicheBrief: niche.brief, targetPriceEur: product.targetPriceEur, avoidRules: [] },
      base,
    );
    ListingWriterOutputSchema.parse(written.output);
    expect(written.output.description).toContain(shop.listing.aiDisclosure);

    const final = await agents.complianceGuard(
      { stage: 'final', productType: product.productType, conceptTitle: product.conceptTitle, designPhrase: product.designPhrase, keywords: niche.keywords, listing: written.output, designKey: editedKey },
      { ...base, trademark: new FakeTrademark(), storage, blocklist: [] },
    );
    expect(final.output.verdict).toBe('pass');
    expect(llm.calls.at(-1)).toEqual({ agent: 'compliance_guard', hasImages: true });

    // QA works on fake-inspected bytes: swap the edited file for a fake image with real dimensions
    const { fakeImage } = await import('./testing/fakes.ts');
    await storage.put(editedKey, fakeImage({ widthPx: 1504, heightPx: 1808 }), 'image/png');
    const qa = await agents.qaPublisher(
      { productId, productType: product.productType, editedKey, listing: written.output, existingPrintifyProductId: null, eurToUsd: 1.1 },
      { ...base, printify, storage, imageTools: new FakeImageTools(), upscaler: new FakeUpscaler(), fetchImage: async () => ({ bytes: await realPng(), mimeType: 'image/png' }), sleep: async () => {} } as never,
    );
    QaPublisherOutputSchema.parse(qa.output);
    expect(qa.output.status).toBe('drafted');

    const report = await agents.analyst(
      {
        listings: [{ productId, etsyListingId: 1234567890, nicheId: 'n1', theme: niche.theme, ageDays: 3, views: 40, favorites: 2, orders: 1, revenueEur: written.output.priceEur }],
        weekStart: '2026-10-05',
        spendUsdThisWeek: 0,
        draftsThisWeek: 1,
        approvalsThisWeek: 1,
        rejectionsThisWeek: 0,
      },
      base,
    );
    AnalystOutputSchema.parse(report.output);
    expect(report.output.followUpNicheIds).toEqual(['n1']);

    const agentsCalled = new Set(llm.calls.map((c) => c.agent));
    expect([...agentsCalled].sort()).toEqual(['analyst', 'compliance_guard', 'designer', 'listing_writer', 'niche_validator', 'qa_publisher', 'trend_scout']);
  });
});

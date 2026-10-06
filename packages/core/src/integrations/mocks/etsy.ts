/**
 * Deterministic offline Etsy. Search results are synthesised from the keywords (stable across runs); the shop's
 * own listings live in memory: MockPrintifyClient.publishProduct creates a DRAFT here, `updateListing` flips it.
 */
import type { EtsyClient, EtsyListingSummary, EtsyReceiptLine, EtsySearchResult } from '../types.ts';
import { HttpError } from '../http.ts';
import { hash32, prng, roundCents } from '../util.ts';

const VOCAB = [
  'cat lover',
  'dog mom',
  'retro',
  'vintage style',
  'minimalist',
  'boho',
  'halloween',
  'spooky season',
  'fall vibes',
  'coffee lover',
  'book lover',
  'teacher gift',
  'nurse life',
  'camping',
  'plant lady',
  'funny quote',
  'sarcastic',
  'christmas gift',
  'mama',
  'dad jokes',
  'mushroom',
  'frog',
  'cottagecore',
  'gamer',
  'fishing',
  'hiking',
  'introvert',
  'gardening',
  'astrology',
  'skeleton',
];
const NOUNS = ['Shirt', 'T-Shirt', 'Mug', 'Poster', 'Sweatshirt', 'Tee'];
const ADJ = ['Funny', 'Cute', 'Retro', 'Vintage', 'Minimalist', 'Cozy', 'Sarcastic', 'Aesthetic'];
const BASE_EPOCH = Date.UTC(2026, 0, 1);

interface OwnListing {
  summary: EtsyListingSummary;
  shouldAutoRenew: boolean;
}

export interface MockEtsyOptions {
  now?: () => Date;
  firstListingId?: number;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export class MockEtsyClient implements EtsyClient {
  private readonly own = new Map<number, OwnListing>();
  private nextId: number;
  private readonly now: () => Date;
  /** Every updateListing call, for assertions and the demo summary. */
  readonly updates: { listingId: number; patch: { state?: 'active' | 'inactive'; shouldAutoRenew?: boolean } }[] = [];

  constructor(opts: MockEtsyOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.nextId = opts.firstListingId ?? 4_100_000_001;
  }

  private synthListing(keywords: string, index: number): EtsyListingSummary {
    const seed = hash32(`listing:${keywords}:${index}`);
    const rnd = prng(seed);
    const words = keywords.toLowerCase().split(/\s+/).filter(Boolean);
    const tags = new Set<string>([keywords.toLowerCase().slice(0, 20)]);
    const n = 4 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) tags.add(VOCAB[Math.floor(rnd() * VOCAB.length)]!);
    if (words[0]) tags.add(`${words[0]} gift`.slice(0, 20));
    const favorers = Math.floor(rnd() ** 2 * 2000);
    return {
      listingId: 1_000_000_000 + (seed % 900_000_000),
      title: `${ADJ[Math.floor(rnd() * ADJ.length)]} ${titleCase(keywords)} ${NOUNS[Math.floor(rnd() * NOUNS.length)]}`.slice(0, 140),
      tags: [...tags].slice(0, 13),
      price: { amount: roundCents(16.99 + Math.floor(rnd() * 18)), currency: 'USD' },
      numFavorers: favorers,
      views: Math.floor(favorers * (8 + rnd() * 20)),
      createdAt: new Date(BASE_EPOCH - Math.floor(rnd() * 365) * 86_400_000).toISOString(),
      state: 'active',
    };
  }

  async searchActiveListings(q: { keywords: string; limit?: number; offset?: number }): Promise<EtsySearchResult> {
    const keywords = q.keywords.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!keywords) return { count: 0, results: [] };
    const limit = Math.min(100, Math.max(1, Math.floor(q.limit ?? 25)));
    const offset = Math.min(12_000, Math.max(0, Math.floor(q.offset ?? 0)));
    const rnd = prng(hash32(`search:${keywords}`));
    const count = 40 + Math.floor(rnd() ** 1.5 * 45_000);
    const n = Math.max(0, Math.min(limit, count - offset));
    const results = Array.from({ length: n }, (_, i) => this.synthListing(keywords, offset + i));
    return { count, results };
  }

  async getListing(listingId: number): Promise<EtsyListingSummary> {
    const own = this.own.get(listingId);
    if (own) return { ...own.summary, tags: [...own.summary.tags] };
    return { ...this.synthListing(`listing ${listingId % 97}`, listingId % 1000), listingId };
  }

  async listShopListings(q: { state: 'active' | 'draft' | 'inactive'; limit?: number }): Promise<EtsyListingSummary[]> {
    const limit = Math.min(100, Math.max(1, Math.floor(q.limit ?? 100)));
    return [...this.own.values()]
      .filter((l) => l.summary.state === q.state)
      .slice(0, limit)
      .map((l) => ({ ...l.summary, tags: [...l.summary.tags] }));
  }

  async updateListing(
    listingId: number,
    patch: { state?: 'active' | 'inactive'; shouldAutoRenew?: boolean },
  ): Promise<void> {
    const own = this.own.get(listingId);
    if (!own) throw new HttpError({ service: 'etsy', operation: 'updateListing', kind: 'status', status: 404 });
    this.updates.push({ listingId, patch: { ...patch } });
    if (patch.state) own.summary.state = patch.state;
    if (patch.shouldAutoRenew !== undefined) own.shouldAutoRenew = patch.shouldAutoRenew;
  }

  async getReceiptLines(q: { minCreated: number }): Promise<EtsyReceiptLine[]> {
    const nowSec = Math.floor(this.now().getTime() / 1000);
    const lines: EtsyReceiptLine[] = [];
    for (const { summary } of this.own.values()) {
      if (summary.state !== 'active') continue;
      const h = hash32(`sales:${summary.listingId}`);
      if (h % 3 === 0) continue; // a third of live listings never sell
      const created = Math.floor(Date.parse(summary.createdAt) / 1000);
      const at = Math.min(nowSec, Math.max(q.minCreated, created) + 3600 + (h % 7200));
      if (at < q.minCreated) continue;
      lines.push({
        receiptId: 3_000_000_000 + (h % 900_000_000),
        listingId: summary.listingId,
        quantity: 1 + (h % 2),
        priceAmount: summary.price.amount,
        currency: summary.price.currency,
        createdAt: new Date(at * 1000).toISOString(),
      });
    }
    return lines.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.listingId - b.listingId);
  }

  /* ------------------------------- mock-only -------------------------------- */

  /** What Printify's publish does on the real platform: a DRAFT listing in the connected shop. */
  createDraftListing(input: { title: string; tags: string[]; priceAmount: number; currency: string }): EtsyListingSummary {
    const listingId = this.nextId++;
    const summary: EtsyListingSummary = {
      listingId,
      title: input.title.slice(0, 140),
      tags: input.tags.slice(0, 13),
      price: { amount: roundCents(input.priceAmount), currency: input.currency },
      numFavorers: 0,
      views: 0,
      createdAt: this.now().toISOString(),
      state: 'draft',
    };
    this.own.set(listingId, { summary, shouldAutoRenew: true });
    return { ...summary, tags: [...summary.tags] };
  }

  /** Current state of a shop listing (mock-only inspection). */
  peek(listingId: number): { state: EtsyListingSummary['state']; shouldAutoRenew: boolean } | null {
    const own = this.own.get(listingId);
    return own ? { state: own.summary.state, shouldAutoRenew: own.shouldAutoRenew } : null;
  }
}

/**
 * Etsy Open API v3 (https://api.etsy.com/v3/application).
 * - Every request: `x-api-key: <keystring>:<shared_secret>` (Etsy now requires the shared secret in the header).
 * - Shop-scoped calls add `Authorization: Bearer <access token>` (scopes listings_r, listings_w, transactions_r).
 * - Access tokens last 1 h; they are refreshed with the refresh-token grant
 *   (POST https://api.etsy.com/v3/public/oauth/token, form: grant_type=refresh_token, client_id, refresh_token).
 *   Etsy returns a NEW refresh token each time; it is persisted through a RefreshTokenStore (file, mode 0600).
 * Operations: findAllListingsActive, getListing, getListingsByShop, updateListing, getShopReceipts.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from '../orchestrator/contracts.ts';
import {
  HttpClient,
  HttpError,
  createServiceBucket,
  isHttpError,
  systemClock,
  type Clock,
  type FetchLike,
  type HttpRequest,
} from './http.ts';
import type { EtsyClient, EtsyListingSummary, EtsyReceiptLine, EtsySearchResult } from './types.ts';
import { decodeEntities, noopLogger, sha256Hex } from './util.ts';

export const ETSY_API_BASE = 'https://api.etsy.com/v3/application';
export const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
/** Etsy caps search offsets at 12,000. */
export const ETSY_MAX_OFFSET = 12_000;

/* --------------------------- refresh-token storage ------------------------- */

export interface RefreshTokenStore {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
}

export class MemoryRefreshTokenStore implements RefreshTokenStore {
  constructor(private token: string | null = null) {}
  async load(): Promise<string | null> {
    return this.token;
  }
  async save(token: string): Promise<void> {
    this.token = token;
  }
}

/**
 * Persists the rotated refresh token in a 0600 file. The file remembers a fingerprint of the env token it
 * descends from: when Razvan re-authorises and sets a NEW `ETSY_REFRESH_TOKEN`, the env token wins again.
 */
export class FileRefreshTokenStore implements RefreshTokenStore {
  private readonly seed: string;

  constructor(
    readonly filePath: string,
    envRefreshToken: string,
  ) {
    this.seed = sha256Hex(`etsy-refresh:${envRefreshToken}`).slice(0, 32);
  }

  async load(): Promise<string | null> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as { seed?: unknown; refreshToken?: unknown };
      if (raw.seed === this.seed && typeof raw.refreshToken === 'string' && raw.refreshToken.length > 0)
        return raw.refreshToken;
      return null;
    } catch {
      return null;
    }
  }

  async save(token: string): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ seed: this.seed, refreshToken: token }), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }
}

/* ------------------------------ token manager ------------------------------ */

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
});

export class EtsyTokenManager {
  private access: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  private readonly http: HttpClient;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(
    private readonly opts: {
      clientId: string;
      initialRefreshToken: string;
      store?: RefreshTokenStore;
      fetch?: FetchLike;
      clock?: Clock;
      logger?: Logger;
      tokenUrl?: string;
    },
  ) {
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? noopLogger;
    this.http = new HttpClient({
      service: 'etsy-oauth',
      fetch: opts.fetch,
      clock: this.clock,
      maxRetries: 2,
      logger: opts.logger,
    });
  }

  /** Valid access token (refreshes when missing or within 2 minutes of expiry). Single-flight. */
  async getAccessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - 120_000 > this.clock.now()) return this.access.token;
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Forget the cached access token (after a 401). */
  invalidate(): void {
    this.access = null;
  }

  private async refresh(): Promise<string> {
    const stored = this.opts.store ? await this.opts.store.load() : null;
    const refreshToken = stored ?? this.opts.initialRefreshToken;
    const res = await this.http.request({
      method: 'POST',
      url: this.opts.tokenUrl ?? ETSY_TOKEN_URL,
      form: { grant_type: 'refresh_token', client_id: this.opts.clientId, refresh_token: refreshToken },
      headers: { accept: 'application/json' },
      operation: 'refresh token',
      exposeErrorBody: false, // never echo token endpoint bodies
    });
    let parsed: z.infer<typeof TokenResponseSchema>;
    try {
      parsed = TokenResponseSchema.parse(JSON.parse(new TextDecoder().decode(res.bytes)));
    } catch {
      throw new HttpError({ service: 'etsy-oauth', operation: 'refresh token', kind: 'invalid_response' });
    }
    this.access = { token: parsed.access_token, expiresAt: this.clock.now() + parsed.expires_in * 1000 };
    if (parsed.refresh_token && parsed.refresh_token !== refreshToken && this.opts.store) {
      try {
        await this.opts.store.save(parsed.refresh_token);
      } catch (e) {
        this.logger.error({ err: (e as Error).message }, 'etsy: could not persist rotated refresh token');
      }
    }
    this.logger.debug({ expiresIn: parsed.expires_in }, 'etsy: access token refreshed');
    return parsed.access_token;
  }
}

/* ------------------------------ response shapes ---------------------------- */

const MoneySchema = z.object({
  amount: z.number(),
  divisor: z.number(),
  currency_code: z.string(),
});

const ListingSchema = z.object({
  listing_id: z.number().int().positive(),
  title: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  price: MoneySchema.nullish(),
  num_favorers: z.number().nullish(),
  views: z.number().nullish(),
  created_timestamp: z.number().nullish(),
  creation_timestamp: z.number().nullish(),
  state: z.string().nullish(),
});

const ListingsSchema = z.object({ count: z.number().int().min(0), results: z.array(ListingSchema) });

const ReceiptsSchema = z.object({
  count: z.number().int().min(0).nullish(),
  results: z.array(
    z.object({
      receipt_id: z.number().int().positive(),
      created_timestamp: z.number().nullish(),
      create_timestamp: z.number().nullish(),
      transactions: z
        .array(
          z.object({
            listing_id: z.number().int().nullish(),
            quantity: z.number().int().min(0),
            price: MoneySchema.nullish(),
          }),
        )
        .nullish(),
    }),
  ),
});

const LISTING_STATES = new Set(['active', 'draft', 'inactive', 'sold_out', 'expired']);

export function moneyToMajor(m: { amount: number; divisor: number }): number {
  const divisor = m.divisor > 0 ? m.divisor : 100;
  return Math.round((m.amount / divisor) * 100) / 100;
}

function isoFromEpoch(sec: number | null | undefined): string {
  return new Date((sec ?? 0) * 1000).toISOString();
}

export function mapEtsyListing(raw: z.infer<typeof ListingSchema>): EtsyListingSummary {
  const state = raw.state && LISTING_STATES.has(raw.state) ? (raw.state as EtsyListingSummary['state']) : 'inactive';
  return {
    listingId: raw.listing_id,
    title: decodeEntities(raw.title ?? ''),
    tags: (raw.tags ?? []).map((t) => decodeEntities(t)),
    price: raw.price
      ? { amount: moneyToMajor(raw.price), currency: raw.price.currency_code }
      : { amount: 0, currency: 'USD' },
    numFavorers: raw.num_favorers ?? 0,
    views: typeof raw.views === 'number' ? raw.views : null,
    createdAt: isoFromEpoch(raw.created_timestamp ?? raw.creation_timestamp),
    state,
  };
}

function parseOr<T>(schema: z.ZodType<T>, value: unknown, operation: string): T {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new HttpError({ service: 'etsy', operation, kind: 'invalid_response', detail: r.error.issues[0]?.message ?? '' });
  return r.data;
}

/* --------------------------------- client ---------------------------------- */

export interface LiveEtsyOptions {
  apiKey: string;
  /** Etsy requires `keystring:shared_secret` in x-api-key; without it only legacy keys work. */
  sharedSecret?: string | null;
  shopId: string;
  tokens: EtsyTokenManager | null;
  fetch?: FetchLike;
  logger?: Logger;
  clock?: Clock;
  baseUrl?: string;
}

export class LiveEtsyClient implements EtsyClient {
  private readonly http: HttpClient;
  private readonly shopId: string;
  private readonly tokens: EtsyTokenManager | null;

  constructor(opts: LiveEtsyOptions) {
    if (!/^\d+$/.test(opts.shopId)) throw new Error('etsy: ETSY_SHOP_ID must be numeric');
    const apiKeyHeader = opts.sharedSecret ? `${opts.apiKey}:${opts.sharedSecret}` : opts.apiKey;
    if (!opts.sharedSecret) (opts.logger ?? noopLogger).warn({}, 'etsy: ETSY_SHARED_SECRET not set; Etsy expects keystring:shared_secret');
    this.shopId = opts.shopId;
    this.tokens = opts.tokens;
    this.http = new HttpClient({
      service: 'etsy',
      baseUrl: opts.baseUrl ?? ETSY_API_BASE,
      fetch: opts.fetch,
      clock: opts.clock,
      bucket: createServiceBucket('etsy', opts.clock),
      defaultHeaders: () => ({ 'x-api-key': apiKeyHeader }),
      logger: opts.logger,
    });
  }

  private async shopCall<T>(req: HttpRequest): Promise<T> {
    if (!this.tokens) throw new Error('etsy: OAuth refresh token not configured (ETSY_REFRESH_TOKEN)');
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.getAccessToken();
      try {
        return await this.http.json<T>({ ...req, headers: { ...(req.headers ?? {}), authorization: `Bearer ${token}` } });
      } catch (e) {
        if (attempt === 0 && isHttpError(e) && e.status === 401) {
          this.tokens.invalidate();
          continue;
        }
        throw e;
      }
    }
  }

  async searchActiveListings(q: { keywords: string; limit?: number; offset?: number }): Promise<EtsySearchResult> {
    const keywords = q.keywords.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!keywords) return { count: 0, results: [] };
    const limit = Math.min(100, Math.max(1, Math.floor(q.limit ?? 25)));
    const offset = Math.min(ETSY_MAX_OFFSET, Math.max(0, Math.floor(q.offset ?? 0)));
    const res = await this.http.json({
      url: '/listings/active',
      query: { keywords, limit, offset, sort_on: 'score' },
      operation: 'findAllListingsActive',
    });
    const parsed = parseOr(ListingsSchema, res, 'findAllListingsActive');
    return { count: parsed.count, results: parsed.results.map(mapEtsyListing) };
  }

  async getListing(listingId: number): Promise<EtsyListingSummary> {
    assertId(listingId);
    const res = await this.http.json({ url: `/listings/${listingId}`, operation: 'getListing' });
    return mapEtsyListing(parseOr(ListingSchema, res, 'getListing'));
  }

  async listShopListings(q: { state: 'active' | 'draft' | 'inactive'; limit?: number }): Promise<EtsyListingSummary[]> {
    const limit = Math.min(100, Math.max(1, Math.floor(q.limit ?? 100)));
    const res = await this.shopCall({
      url: `/shops/${this.shopId}/listings`,
      query: { state: q.state, limit },
      operation: 'getListingsByShop',
    });
    return parseOr(ListingsSchema, res, 'getListingsByShop').results.map(mapEtsyListing);
  }

  async updateListing(
    listingId: number,
    patch: { state?: 'active' | 'inactive'; shouldAutoRenew?: boolean },
  ): Promise<void> {
    assertId(listingId);
    const form: Record<string, string> = {};
    if (patch.state !== undefined) {
      if (patch.state !== 'active' && patch.state !== 'inactive') throw new Error('etsy: invalid state');
      form.state = patch.state;
    }
    if (patch.shouldAutoRenew !== undefined) form.should_auto_renew = patch.shouldAutoRenew ? 'true' : 'false';
    if (Object.keys(form).length === 0) return;
    await this.shopCall({
      method: 'PATCH',
      url: `/shops/${this.shopId}/listings/${listingId}`,
      form,
      operation: 'updateListing',
    });
  }

  async getReceiptLines(q: { minCreated: number }): Promise<EtsyReceiptLine[]> {
    const lines: EtsyReceiptLine[] = [];
    const limit = 100;
    const maxPages = 50;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.shopCall({
        url: `/shops/${this.shopId}/receipts`,
        query: {
          min_created: Math.max(946_684_800, Math.floor(q.minCreated)),
          was_canceled: false,
          sort_on: 'created',
          sort_order: 'asc',
          limit,
          offset: page * limit,
        },
        operation: 'getShopReceipts',
      });
      const parsed = parseOr(ReceiptsSchema, res, 'getShopReceipts');
      for (const r of parsed.results) {
        const createdAt = isoFromEpoch(r.created_timestamp ?? r.create_timestamp);
        for (const t of r.transactions ?? []) {
          if (!t.listing_id || !t.price) continue;
          lines.push({
            receiptId: r.receipt_id,
            listingId: t.listing_id,
            quantity: t.quantity,
            // Unit price of the transaction (Etsy semantics); line revenue = priceAmount * quantity.
            priceAmount: moneyToMajor(t.price),
            currency: t.price.currency_code,
            createdAt,
          });
        }
      }
      if (parsed.results.length < limit) break;
    }
    return lines;
  }
}

function assertId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('etsy: invalid listing id');
}

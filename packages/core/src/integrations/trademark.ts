/**
 * USPTO word-mark search through the Marker API v2 (https://markerapi.com).
 * GET https://markerapi.com/api/v2/trademarks/trademark/{term}/status/{active|all}/start/{n}/username/{u}/password/{p}
 * Credentials travel in the URL PATH (Marker's design), so URLs are never logged and HTTP errors carry only an
 * operation label. Each search runs an exact query and, unless `{prefix: false}`, a trailing-wildcard query
 * (`term*`), deduped by serial. Marker never returns a mark that is SHORTER than the term: a mark inside a longer
 * phrase is only found by searching the phrase's sub-phrases (see agents/complianceGuard.ts).
 * Response: {count, trademarks: [{serialnumber, wordmark, code, description, registrationdate, status?, ...}], next?}.
 */
import type { TrademarkHit } from '../domain/types.ts';
import type { Logger } from '../orchestrator/contracts.ts';
import { HttpClient, createServiceBucket, systemClock, type Clock, type FetchLike } from './http.ts';
import type { TrademarkClient } from './types.ts';
import { noopLogger } from './util.ts';

export const MARKER_BASE_URL = 'https://markerapi.com/api/v2/trademarks/trademark';

/** Optional second argument of `TrademarkClient.search` (the contract keeps the one-argument form). */
export interface TrademarkSearchOptions {
  /** Also run the trailing-wildcard query `term*` (marks that START with the term). Default true. */
  prefix?: boolean;
}

type SearchWithOptions = (term: string, opts?: TrademarkSearchOptions) => Promise<TrademarkHit[]>;

/**
 * `client.search(term, opts)`. A client that ignores the options runs its default search, which is a superset of
 * the exact-only one, so passing options can only narrow the query, never hide a mark the default would find.
 */
export function searchTrademark(client: TrademarkClient, term: string, opts: TrademarkSearchOptions = {}): Promise<TrademarkHit[]> {
  return (client.search as SearchWithOptions).call(client, term, opts);
}

/** Successful query results are reused for this long: concept check, Listing Writer and final check share terms. */
export const DEFAULT_TRADEMARK_CACHE_TTL_MS = 12 * 3600_000;
const DEFAULT_TRADEMARK_CACHE_MAX_ENTRIES = 2000;

/** Lowercase, collapse whitespace, keep letters/digits/space/&'- only (no path characters). */
export function normaliseTrademarkTerm(term: string): string {
  return term
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s&'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

/**
 * Nice classes from Marker's goods/services `code` (e.g. "GS0251" = class 025, or "025", "IC 025")
 * and, as a fallback, "IC 025" mentions in the description.
 */
export function parseNiceClasses(code: unknown, description: unknown): number[] {
  const out = new Set<number>();
  const add = (n: number) => {
    if (n >= 1 && n <= 45) out.add(n);
  };
  if (typeof code === 'string') {
    // USPTO goods/services codes: "GS" + 3-digit class + sequence digit(s).
    for (const m of code.matchAll(/GS(\d{3})/gi)) add(Number(m[1]));
    if (out.size === 0) for (const m of code.matchAll(/\b(?:IC\s*)?0*(\d{1,3})\b/gi)) add(Number(m[1]));
  } else if (typeof code === 'number') add(code);
  if (out.size === 0 && typeof description === 'string')
    for (const m of description.matchAll(/\bIC\s*0*(\d{1,3})\b/g)) add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

/** Dead = abandoned/cancelled/expired; everything else (registered, pending, published) counts as live. */
export function markerStatus(raw: { status?: unknown; statusdescription?: unknown; code?: unknown }): 'live' | 'dead' {
  const text = `${String(raw.status ?? '')} ${String(raw.statusdescription ?? '')}`.toLowerCase();
  if (/dead|abandon|cancel|expire|inactive/.test(text)) return 'dead';
  return 'live';
}

interface MarkerRow {
  serialnumber?: unknown;
  wordmark?: unknown;
  code?: unknown;
  description?: unknown;
  status?: unknown;
  statusdescription?: unknown;
  owner?: unknown;
}

export function mapMarkerRow(row: MarkerRow): TrademarkHit | null {
  const serial = row.serialnumber === undefined || row.serialnumber === null ? '' : String(row.serialnumber).trim();
  const mark = typeof row.wordmark === 'string' ? row.wordmark.trim() : '';
  if (!serial || !mark) return null;
  let owner: string | null = null;
  if (typeof row.owner === 'string' && row.owner.trim()) owner = row.owner.trim();
  else if (row.owner && typeof row.owner === 'object' && typeof (row.owner as { name?: unknown }).name === 'string')
    owner = String((row.owner as { name: string }).name);
  return { mark, serial, status: markerStatus(row), classes: parseNiceClasses(row.code, row.description), owner };
}

export class LiveTrademarkClient implements TrademarkClient {
  private readonly http: HttpClient;
  private readonly logger: Logger;
  private readonly clock: Clock;
  /** Query string -> hits of a SUCCESSFUL query (errors are never cached, so a failed search always fails). */
  private readonly cache = new Map<string, { at: number; hits: TrademarkHit[] }>();

  constructor(
    private readonly opts: {
      username: string;
      password: string;
      fetch?: FetchLike;
      logger?: Logger;
      clock?: Clock;
      baseUrl?: string;
      /** Also run `term*` (default true). Each query costs one Marker search (1K/month on the free tier). */
      wildcard?: boolean;
      /** Pages per query (100 rows each; default 2). */
      maxPages?: number;
      /** Reuse a query's result for this long (default 12 h; 0 disables the cache). */
      cacheTtlMs?: number;
      cacheMaxEntries?: number;
    },
  ) {
    if (!opts.username || !opts.password) throw new Error('marker: MARKER_API_USERNAME/PASSWORD required');
    this.logger = opts.logger ?? noopLogger;
    this.clock = opts.clock ?? systemClock;
    this.http = new HttpClient({
      service: 'marker',
      fetch: opts.fetch,
      clock: opts.clock,
      bucket: createServiceBucket('marker', opts.clock),
      logger: opts.logger,
    });
  }

  private url(term: string, start: number): string {
    const base = (this.opts.baseUrl ?? MARKER_BASE_URL).replace(/\/+$/, '');
    const seg = (s: string) => encodeURIComponent(s);
    return `${base}/${seg(term)}/status/all/start/${start}/username/${seg(this.opts.username)}/password/${seg(this.opts.password)}`;
  }

  private async query(term: string): Promise<TrademarkHit[]> {
    const hits: TrademarkHit[] = [];
    let start = 1;
    for (let page = 0; page < (this.opts.maxPages ?? 2); page++) {
      const res = await this.http.json<{ count?: unknown; trademarks?: unknown; next?: unknown } | null>({
        url: this.url(term, start),
        operation: 'trademark search',
        exposeErrorBody: false,
      });
      const rows = Array.isArray(res?.trademarks) ? (res.trademarks as MarkerRow[]) : [];
      for (const r of rows) {
        const hit = mapMarkerRow(r);
        if (hit) hits.push(hit);
      }
      const next = typeof res?.next === 'number' ? res.next : typeof res?.next === 'string' && /^\d+$/.test(res.next) ? Number(res.next) : null;
      if (next === null || next <= start) break;
      start = next;
    }
    return hits;
  }

  private async cachedQuery(q: string): Promise<TrademarkHit[]> {
    const ttl = this.opts.cacheTtlMs ?? DEFAULT_TRADEMARK_CACHE_TTL_MS;
    const now = this.clock.now();
    const hit = this.cache.get(q);
    if (hit && ttl > 0 && now - hit.at < ttl) return hit.hits.map((h) => ({ ...h, classes: [...h.classes] }));
    const hits = await this.query(q);
    if (ttl > 0) {
      this.cache.delete(q);
      this.cache.set(q, { at: now, hits });
      const max = this.opts.cacheMaxEntries ?? DEFAULT_TRADEMARK_CACHE_MAX_ENTRIES;
      while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value as string);
    }
    return hits.map((h) => ({ ...h, classes: [...h.classes] }));
  }

  async search(term: string, opts: TrademarkSearchOptions = {}): Promise<TrademarkHit[]> {
    const t = normaliseTrademarkTerm(term);
    if (t.length < 2) return [];
    const queries = [t];
    if (this.opts.wildcard !== false && opts.prefix !== false) queries.push(`${t}*`);
    const bySerial = new Map<string, TrademarkHit>();
    for (const q of queries) for (const hit of await this.cachedQuery(q)) bySerial.set(hit.serial, hit);
    this.logger.debug({ term: t, prefix: queries.length > 1, hits: bySerial.size }, 'marker: search done');
    return [...bySerial.values()];
  }
}

/** Alias matching the provider name. */
export { LiveTrademarkClient as MarkerTrademarkClient };

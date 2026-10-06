/**
 * USPTO word-mark search through the Marker API v2 (https://markerapi.com).
 * GET https://markerapi.com/api/v2/trademarks/trademark/{term}/status/{active|all}/start/{n}/username/{u}/password/{p}
 * Credentials travel in the URL PATH (Marker's design), so URLs are never logged and HTTP errors carry only an
 * operation label. Each search runs an exact query and a trailing-wildcard query (`term*`), deduped by serial.
 * Response: {count, trademarks: [{serialnumber, wordmark, code, description, registrationdate, status?, ...}], next?}.
 */
import type { TrademarkHit } from '../domain/types.ts';
import type { Logger } from '../orchestrator/contracts.ts';
import { HttpClient, createServiceBucket, type Clock, type FetchLike } from './http.ts';
import type { TrademarkClient } from './types.ts';
import { noopLogger } from './util.ts';

export const MARKER_BASE_URL = 'https://markerapi.com/api/v2/trademarks/trademark';

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
    },
  ) {
    if (!opts.username || !opts.password) throw new Error('marker: MARKER_API_USERNAME/PASSWORD required');
    this.logger = opts.logger ?? noopLogger;
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

  async search(term: string): Promise<TrademarkHit[]> {
    const t = normaliseTrademarkTerm(term);
    if (t.length < 2) return [];
    const queries = [t];
    if (this.opts.wildcard !== false) queries.push(`${t}*`);
    const bySerial = new Map<string, TrademarkHit>();
    for (const q of queries) for (const hit of await this.query(q)) bySerial.set(hit.serial, hit);
    this.logger.debug({ term: t, hits: bySerial.size }, 'marker: search done');
    return [...bySerial.values()];
  }
}

/** Alias matching the provider name. */
export { LiveTrademarkClient as MarkerTrademarkClient };

/**
 * Free trend sources (SHOP.trendSources): Etsy search, Pinterest trends (only with a token), US seasonal calendar.
 * Every source returns [] instead of throwing (TrendSource contract). Keywords are UNTRUSTED data downstream.
 */
import type { Logger } from '../orchestrator/contracts.ts';
import { HttpClient, createServiceBucket, isHttpError, type Clock, type FetchLike } from './http.ts';
import calendarJson from './seasonal-us.json' with { type: 'json' };
import type { EtsyClient, TrendSignalInput, TrendSource } from './types.ts';
import { noopLogger } from './util.ts';

/* ------------------------------ seasonal (US) ------------------------------ */

export type SeasonalDateRule =
  | { type: 'fixed'; month: number; day: number }
  | { type: 'nth_weekday'; month: number; weekday: number; n: number }
  | { type: 'last_weekday'; month: number; weekday: number }
  | { type: 'easter'; offsetDays: number };

export interface SeasonalEvent {
  id: string;
  name: string;
  date: SeasonalDateRule;
  keywords: string[];
}

export interface SeasonalCalendar {
  region: string;
  events: SeasonalEvent[];
}

export const US_SEASONAL_CALENDAR = calendarJson as SeasonalCalendar;

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

/** Gregorian Easter Sunday (anonymous algorithm). */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

export function eventDate(rule: SeasonalDateRule, year: number): Date {
  switch (rule.type) {
    case 'fixed':
      return utc(year, rule.month, rule.day);
    case 'nth_weekday': {
      const first = utc(year, rule.month, 1);
      const shift = (rule.weekday - first.getUTCDay() + 7) % 7;
      return utc(year, rule.month, 1 + shift + (rule.n - 1) * 7);
    }
    case 'last_weekday': {
      const last = utc(year, rule.month + 1, 0);
      const shift = (last.getUTCDay() - rule.weekday + 7) % 7;
      return utc(year, rule.month, last.getUTCDate() - shift);
    }
    case 'easter': {
      const e = easterSunday(year);
      return new Date(e.getTime() + rule.offsetDays * 86_400_000);
    }
  }
}

function parseDay(today: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error('seasonal: today must be YYYY-MM-DD');
  return new Date(`${today}T00:00:00Z`);
}

/** Next occurrence on/after `today` and the days until it. */
export function nextOccurrence(rule: SeasonalDateRule, today: string): { date: string; daysUntil: number } {
  const t = parseDay(today);
  const y = t.getUTCFullYear();
  let d = eventDate(rule, y);
  if (d.getTime() < t.getTime()) d = eventDate(rule, y + 1);
  return { date: d.toISOString().slice(0, 10), daysUntil: Math.round((d.getTime() - t.getTime()) / 86_400_000) };
}

export interface SeasonalOptions {
  calendar?: SeasonalCalendar;
  /** Signal window in days before the event (POD needs lead time for listing + shipping). */
  minLeadDays?: number;
  maxLeadDays?: number;
  /** Lead time scoring highest. */
  idealLeadDays?: number;
}

/** Upcoming events inside the lead window, best first. */
export function upcomingEvents(
  today: string,
  opts: SeasonalOptions = {},
): { event: SeasonalEvent; date: string; daysUntil: number; score: number }[] {
  const cal = opts.calendar ?? US_SEASONAL_CALENDAR;
  const min = opts.minLeadDays ?? 10;
  const max = opts.maxLeadDays ?? 100;
  const ideal = opts.idealLeadDays ?? 45;
  const out: { event: SeasonalEvent; date: string; daysUntil: number; score: number }[] = [];
  for (const event of cal.events) {
    const { date, daysUntil } = nextOccurrence(event.date, today);
    if (daysUntil < min || daysUntil > max) continue;
    const span = Math.max(ideal - min, max - ideal);
    const score = Math.max(10, Math.round(100 * (1 - Math.abs(daysUntil - ideal) / span)));
    out.push({ event, date, daysUntil, score });
  }
  return out.sort((a, b) => b.score - a.score || a.daysUntil - b.daysUntil);
}

export class SeasonalTrendSource implements TrendSource {
  readonly name = 'seasonal';
  constructor(private readonly opts: SeasonalOptions = {}) {}

  async fetchSignals(q: { market: 'US'; today: string }): Promise<TrendSignalInput[]> {
    try {
      const signals: TrendSignalInput[] = [];
      for (const u of upcomingEvents(q.today, this.opts)) {
        u.event.keywords.forEach((keyword, i) => {
          signals.push({ source: this.name, keyword, region: q.market, score: Math.max(5, u.score - i * 5), growth: null });
        });
      }
      return signals;
    } catch {
      return [];
    }
  }
}

/* --------------------------------- Etsy search ------------------------------ */

const GENERIC_TAGS = new Set([
  'gift',
  'gifts',
  'gift idea',
  'gift for her',
  'gift for him',
  'shirt',
  'tshirt',
  't-shirt',
  't shirt',
  'tee',
  'tees',
  'unisex',
  'unisex shirt',
  'graphic tee',
  'graphic shirt',
  'mug',
  'coffee mug',
  'mugs',
  'cup',
  'poster',
  'print',
  'art print',
  'wall art',
  'wall decor',
  'home decor',
  'funny',
  'funny shirt',
  'funny mug',
  'cute',
  'trendy',
  'aesthetic',
]);

export const DEFAULT_ETSY_SEEDS = ['funny shirt', 'graphic tee', 'funny mug', 'coffee mug', 'wall art print', 'poster print'];

export interface EtsySearchTrendOptions {
  seeds?: string[];
  /** Add the first keyword of the top N upcoming seasonal events as extra seeds (default 2). */
  seasonalSeeds?: number;
  maxSignals?: number;
  logger?: Logger;
}

/**
 * Tag frequency in the top Etsy search results for seed queries, weighted by favourites.
 * Score is relative (0..100) within this source.
 */
export class EtsySearchTrendSource implements TrendSource {
  readonly name = 'etsy_search';
  private readonly logger: Logger;

  constructor(
    private readonly etsy: EtsyClient,
    private readonly opts: EtsySearchTrendOptions = {},
  ) {
    this.logger = opts.logger ?? noopLogger;
  }

  async fetchSignals(q: { market: 'US'; today: string }): Promise<TrendSignalInput[]> {
    const seeds = [...(this.opts.seeds ?? DEFAULT_ETSY_SEEDS)];
    try {
      for (const u of upcomingEvents(q.today).slice(0, this.opts.seasonalSeeds ?? 2)) {
        const kw = u.event.keywords[0];
        if (kw && !seeds.includes(kw)) seeds.push(kw);
      }
    } catch {
      // bad date: base seeds only
    }
    const weights = new Map<string, number>();
    let ok = 0;
    for (const seed of seeds) {
      try {
        const res = await this.etsy.searchActiveListings({ keywords: seed, limit: 100 });
        ok++;
        const seedNorm = seed.toLowerCase();
        for (const l of res.results) {
          const w = 1 + Math.log1p(Math.max(0, l.numFavorers));
          const seen = new Set<string>();
          for (const raw of l.tags) {
            const tag = raw.toLowerCase().replace(/\s+/g, ' ').trim();
            if (tag.length < 3 || tag.length > 40 || seen.has(tag) || tag === seedNorm || GENERIC_TAGS.has(tag)) continue;
            seen.add(tag);
            weights.set(tag, (weights.get(tag) ?? 0) + w);
          }
        }
      } catch (e) {
        this.logger.warn({ seed, err: (e as Error).message }, 'etsy_search trend: seed query failed');
      }
    }
    if (ok === 0 || weights.size === 0) return [];
    const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = ranked.slice(0, this.opts.maxSignals ?? 30);
    const max = top[0]![1];
    return top.map(([keyword, w]) => ({
      source: this.name,
      keyword,
      region: q.market,
      score: Math.max(1, Math.round((100 * w) / max)),
      growth: null,
    }));
  }
}

/* --------------------------------- Pinterest -------------------------------- */

export const PINTEREST_API_BASE = 'https://api.pinterest.com/v5';
export type PinterestTrendType = 'growing' | 'monthly' | 'yearly' | 'seasonal';
/** Pinterest L1 interests relevant to apparel, mugs and wall art. */
export const DEFAULT_PINTEREST_INTERESTS = ['art', 'design', 'quotes', 'home_decor', 'animals', 'entertainment'];

export interface PinterestTrendOptions {
  token?: string | null;
  fetch?: FetchLike;
  logger?: Logger;
  clock?: Clock;
  trendType?: PinterestTrendType;
  interests?: string[];
  limit?: number;
  baseUrl?: string;
}

/**
 * GET /v5/trends/keywords/{region}/top/{trend_type} (scope user_accounts:read).
 * Returns [] without a token, on 401/403 (no Trends access), or on any error.
 */
export class PinterestTrendSource implements TrendSource {
  readonly name = 'pinterest';
  private readonly http: HttpClient | null;
  private readonly logger: Logger;

  constructor(private readonly opts: PinterestTrendOptions = {}) {
    this.logger = opts.logger ?? noopLogger;
    const token = opts.token ?? null;
    this.http = token
      ? new HttpClient({
          service: 'pinterest',
          baseUrl: opts.baseUrl ?? PINTEREST_API_BASE,
          fetch: opts.fetch,
          clock: opts.clock,
          bucket: createServiceBucket('pinterest', opts.clock),
          maxRetries: 2,
          defaultHeaders: () => ({ authorization: `Bearer ${token}` }),
          logger: opts.logger,
        })
      : null;
  }

  async fetchSignals(q: { market: 'US'; today: string }): Promise<TrendSignalInput[]> {
    if (!this.http) return [];
    const trendType = this.opts.trendType ?? 'growing';
    try {
      const res = await this.http.json<{ trends?: unknown } | null>({
        url: `/trends/keywords/${encodeURIComponent(q.market)}/top/${trendType}`,
        query: {
          interests: this.opts.interests ?? DEFAULT_PINTEREST_INTERESTS,
          limit: Math.min(50, Math.max(1, this.opts.limit ?? 50)),
        },
        operation: 'trending keywords',
      });
      const trends = Array.isArray(res?.trends) ? (res.trends as { keyword?: unknown; pct_growth_mom?: unknown }[]) : [];
      const rows = trends.filter((t): t is { keyword: string; pct_growth_mom?: unknown } => typeof t.keyword === 'string' && t.keyword.trim().length > 0);
      const n = rows.length;
      return rows.map((t, i) => ({
        source: this.name,
        keyword: t.keyword.trim().slice(0, 100),
        region: q.market,
        score: Math.max(1, Math.round((100 * (n - i)) / n)),
        growth: typeof t.pct_growth_mom === 'number' ? t.pct_growth_mom / 100 : null,
      }));
    } catch (e) {
      if (isHttpError(e) && (e.status === 401 || e.status === 403)) {
        this.logger.info({ status: e.status }, 'pinterest trends: no access, skipping');
      } else {
        this.logger.warn({ err: (e as Error).message }, 'pinterest trends: failed, skipping');
      }
      return [];
    }
  }
}

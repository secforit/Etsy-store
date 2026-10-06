import { describe, expect, it } from 'vitest';
import { MockEtsyClient } from './mocks/etsy.ts';
import { fakeClock, jsonResponse, stubFetch } from './testing.ts';
import {
  EtsySearchTrendSource,
  PinterestTrendSource,
  SeasonalTrendSource,
  US_SEASONAL_CALENDAR,
  easterSunday,
  eventDate,
  nextOccurrence,
  upcomingEvents,
} from './trends.ts';
import type { EtsyClient } from './types.ts';

describe('seasonal calendar', () => {
  it('computes moveable US dates', () => {
    expect(easterSunday(2026).toISOString().slice(0, 10)).toBe('2026-04-05');
    expect(easterSunday(2027).toISOString().slice(0, 10)).toBe('2027-03-28');
    expect(eventDate({ type: 'nth_weekday', month: 11, weekday: 4, n: 4 }, 2026).toISOString().slice(0, 10)).toBe('2026-11-26'); // Thanksgiving
    expect(eventDate({ type: 'nth_weekday', month: 5, weekday: 0, n: 2 }, 2026).toISOString().slice(0, 10)).toBe('2026-05-10'); // Mother's Day
    expect(eventDate({ type: 'last_weekday', month: 5, weekday: 1 }, 2026).toISOString().slice(0, 10)).toBe('2026-05-25'); // Memorial Day
    expect(eventDate({ type: 'nth_weekday', month: 6, weekday: 0, n: 3 }, 2026).toISOString().slice(0, 10)).toBe('2026-06-21'); // Father's Day
  });

  it('rolls over to next year', () => {
    expect(nextOccurrence({ type: 'fixed', month: 2, day: 14 }, '2026-10-06')).toEqual({ date: '2027-02-14', daysUntil: 131 });
    expect(nextOccurrence({ type: 'fixed', month: 10, day: 6 }, '2026-10-06').daysUntil).toBe(0);
  });

  it('every calendar event has keywords and a valid rule', () => {
    for (const e of US_SEASONAL_CALENDAR.events) {
      expect(e.keywords.length).toBeGreaterThan(0);
      expect(() => nextOccurrence(e.date, '2026-01-01')).not.toThrow();
    }
  });

  it('emits signals for events in the lead window, best lead time first', async () => {
    const ups = upcomingEvents('2026-10-06');
    expect(ups.map((u) => [u.event.id, u.daysUntil, u.score])).toEqual([
      ['thanksgiving', 51, 89],
      ['christmas', 80, 36],
      ['halloween', 25, 64],
      ['new_year', 87, 24],
    ].sort((a, b) => (b[2] as number) - (a[2] as number)));
    const signals = await new SeasonalTrendSource().fetchSignals({ market: 'US', today: '2026-10-06' });
    expect(signals[0]).toEqual({ source: 'seasonal', keyword: 'thanksgiving', region: 'US', score: 89, growth: null });
    expect(signals.every((s) => s.score >= 5 && s.score <= 100)).toBe(true);
    expect(signals.some((s) => s.keyword === 'valentines day')).toBe(false);
  });

  it('never throws on a bad date', async () => {
    expect(await new SeasonalTrendSource().fetchSignals({ market: 'US', today: 'garbage' })).toEqual([]);
  });
});

describe('EtsySearchTrendSource', () => {
  it('ranks non-generic tags from seed searches (deterministic with the mock)', async () => {
    const src = new EtsySearchTrendSource(new MockEtsyClient());
    const a = await src.fetchSignals({ market: 'US', today: '2026-10-06' });
    const b = await src.fetchSignals({ market: 'US', today: '2026-10-06' });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(5);
    expect(a.length).toBeLessThanOrEqual(30);
    expect(a[0]!.score).toBe(100);
    expect(a.every((s) => s.source === 'etsy_search' && s.region === 'US')).toBe(true);
    expect(a.some((s) => s.keyword === 'gift' || s.keyword === 'funny shirt')).toBe(false);
  });

  it('returns [] when Etsy fails', async () => {
    const failing: EtsyClient = {
      searchActiveListings: async () => Promise.reject(new Error('down')),
      getListing: async () => Promise.reject(new Error('down')),
      listShopListings: async () => [],
      updateListing: async () => undefined,
      getReceiptLines: async () => [],
    };
    expect(await new EtsySearchTrendSource(failing).fetchSignals({ market: 'US', today: '2026-10-06' })).toEqual([]);
  });
});

describe('PinterestTrendSource', () => {
  it('returns [] without a token and makes no request', async () => {
    const fetch = stubFetch(() => jsonResponse({}));
    expect(await new PinterestTrendSource({ token: null, fetch }).fetchSignals({ market: 'US', today: '2026-10-06' })).toEqual([]);
    expect(fetch.calls).toHaveLength(0);
  });

  it('returns [] on 403 (no Trends access) and on errors', async () => {
    for (const status of [401, 403, 500]) {
      const fetch = stubFetch(() => jsonResponse({ code: 3, message: 'no access' }, { status }));
      const src = new PinterestTrendSource({ token: 'pina_x', fetch, clock: fakeClock() });
      expect(await src.fetchSignals({ market: 'US', today: '2026-10-06' })).toEqual([]);
    }
  });

  it('calls /v5/trends/keywords/US/top/growing and maps rank + MoM growth', async () => {
    const fetch = stubFetch(() =>
      jsonResponse({
        trends: [
          { keyword: 'halloween nails', pct_growth_wow: 40, pct_growth_mom: 250, pct_growth_yoy: 10, time_series: {} },
          { keyword: 'fall decor', pct_growth_mom: 50 },
          { keyword: '' },
        ],
      }),
    );
    const src = new PinterestTrendSource({ token: 'pina_x', fetch, interests: ['art', 'quotes'], limit: 20 });
    const signals = await src.fetchSignals({ market: 'US', today: '2026-10-06' });
    const call = fetch.calls[0]!;
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe('https://api.pinterest.com/v5/trends/keywords/US/top/growing');
    expect(url.searchParams.getAll('interests')).toEqual(['art', 'quotes']);
    expect(url.searchParams.get('limit')).toBe('20');
    expect(call.headers.authorization).toBe('Bearer pina_x');
    expect(signals).toEqual([
      { source: 'pinterest', keyword: 'halloween nails', region: 'US', score: 100, growth: 2.5 },
      { source: 'pinterest', keyword: 'fall decor', region: 'US', score: 50, growth: 0.5 },
    ]);
  });
});

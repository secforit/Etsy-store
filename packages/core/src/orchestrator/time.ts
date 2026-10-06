/**
 * Calendar helpers. All "days" and "weeks" are UTC (caps reset at 00:00 UTC = 02:00/03:00 in Bucharest).
 * Never read the system clock here: callers pass the injected `now`.
 */

const DAY_MS = 86_400_000;

/** YYYY-MM-DD (UTC). */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 00:00:00.000 UTC of the day containing `d`. */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Monday 00:00 UTC of the ISO week containing `d`. */
export function startOfUtcWeek(d: Date): Date {
  const day = startOfUtcDay(d);
  const dow = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - dow * DAY_MS);
}

/** YYYY-MM-DDTHH (UTC), used for hourly idempotency keys. */
export function isoHour(d: Date): string {
  return d.toISOString().slice(0, 13);
}

export function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

export { DAY_MS };

/**
 * Periodic jobs, idempotent by key:
 *  - `trend_scan` once per UTC day   (key trend_scan:YYYY-MM-DD, due at TREND_SCAN_HOUR_UTC)
 *  - `analyze`    once per UTC hour  (key analyze:YYYY-MM-DDTHH)
 * A new periodic job is not added while one of the same kind is still queued or running, so a long pause does
 * not pile up a backlog of hourly analyses. Safe to call as often as you like (the worker calls it every minute).
 */
import type { Queryable } from '../db/db.ts';
import type { JobKind } from '../domain/types.ts';
import { isoDate, isoHour, startOfUtcDay } from './time.ts';

export interface SchedulerOptions {
  /** UTC hour at which the daily trend scan becomes due (default 4 = 06:00/07:00 in Bucharest). */
  trendScanHourUtc?: number;
}

export interface ScheduledJob {
  kind: JobKind;
  idempotencyKey: string;
  runAfter: Date;
}

export function dueJobs(now: Date, opts: SchedulerOptions = {}): ScheduledJob[] {
  const hour = Math.min(23, Math.max(0, Math.floor(opts.trendScanHourUtc ?? 4)));
  const scanAt = new Date(startOfUtcDay(now).getTime() + hour * 3600_000);
  const jobs: ScheduledJob[] = [];
  if (now.getTime() >= scanAt.getTime()) {
    jobs.push({ kind: 'trend_scan', idempotencyKey: `trend_scan:${isoDate(now)}`, runAfter: scanAt });
  }
  jobs.push({ kind: 'analyze', idempotencyKey: `analyze:${isoHour(now)}`, runAfter: now });
  return jobs;
}

/** Enqueues the periodic jobs that are due now. Returns the keys that were newly created. */
export async function scheduleDue(q: Queryable, now: Date, opts: SchedulerOptions = {}): Promise<string[]> {
  const created: string[] = [];
  for (const job of dueJobs(now, opts)) {
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO jobs (kind, status, attempts, max_attempts, run_after, idempotency_key, created_at, updated_at)
       SELECT $1, 'queued', 0, 3, $2, $3, $4, $4
       WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE kind = $1 AND status IN ('queued', 'running'))
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [job.kind, job.runAfter, job.idempotencyKey, now],
    );
    if (rows.length > 0) created.push(job.idempotencyKey);
  }
  return created;
}

import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/db.ts';
import { claimNext, markDone } from './queue.ts';
import { dueJobs, scheduleDue } from './scheduler.ts';
import { TestClock, jobsOf, sharedTestDb } from './testing/fakes.ts';
import { isoDate, isoHour, startOfUtcWeek } from './time.ts';

let db: Db;
beforeEach(async () => {
  db = await sharedTestDb();
});

describe('scheduler', () => {
  it('schedules the daily trend scan only after its hour, and analyze every hour', () => {
    expect(dueJobs(new Date('2026-10-06T03:59:00Z')).map((j) => j.idempotencyKey)).toEqual(['analyze:2026-10-06T03']);
    const due = dueJobs(new Date('2026-10-06T04:00:00Z'));
    expect(due.map((j) => j.idempotencyKey)).toEqual(['trend_scan:2026-10-06', 'analyze:2026-10-06T04']);
    expect(due[0]!.runAfter.toISOString()).toBe('2026-10-06T04:00:00.000Z');
    expect(dueJobs(new Date('2026-10-06T01:00:00Z'), { trendScanHourUtc: 0 })[0]!.kind).toBe('trend_scan');
  });

  it('is idempotent and never stacks a second periodic job while one is pending', async () => {
    const clock = new TestClock('2026-10-06T10:00:00.000Z');
    expect(await scheduleDue(db, clock.now())).toEqual(['trend_scan:2026-10-06', 'analyze:2026-10-06T10']);
    expect(await scheduleDue(db, clock.now())).toEqual([]);
    clock.advance(3600_000);
    expect(await scheduleDue(db, clock.now())).toEqual([]); // analyze from 10:00 still queued
    const job = await claimNext(db, clock.now(), { excludeKinds: ['trend_scan'] });
    await markDone(db, job!.id, clock.now());
    expect(await scheduleDue(db, clock.now())).toEqual(['analyze:2026-10-06T11']);
    expect(await jobsOf(db, { kind: 'trend_scan' })).toHaveLength(1);
  });

  it('computes UTC calendar helpers', () => {
    const d = new Date('2026-10-11T23:30:00Z'); // Sunday
    expect(isoDate(startOfUtcWeek(d))).toBe('2026-10-05');
    expect(isoDate(startOfUtcWeek(new Date('2026-10-05T00:00:00Z')))).toBe('2026-10-05');
    expect(isoHour(d)).toBe('2026-10-11T23');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import type { Db, Queryable } from '../db/db.ts';
import { backoffMs, claimNext, enqueue, enqueueNextStep, markDone, productStepKey, recordFailure, recoverStaleJobs } from './queue.ts';
import { getJob } from './repo.ts';
import { TestClock, auditActions, seedProduct, sharedTestDb } from './testing/fakes.ts';

let db: Db;
let clock: TestClock;

beforeEach(async () => {
  db = await sharedTestDb();
  clock = new TestClock();
});

describe('enqueue', () => {
  it('is idempotent on the idempotency key', async () => {
    const a = await enqueue(db, { kind: 'trend_scan', idempotencyKey: 'trend_scan:2026-10-06' }, clock.now());
    const b = await enqueue(db, { kind: 'trend_scan', idempotencyKey: 'trend_scan:2026-10-06' }, clock.now());
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    const { rows } = await db.query<{ n: unknown }>('SELECT count(*) AS n FROM jobs');
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('enqueues the next automated step for a product and nothing for human-wait states', async () => {
    const id = await seedProduct(db, clock.now(), { state: 'proposed' });
    const next = await enqueueNextStep(db, { id, state: 'proposed', attempt: 0 }, clock.now());
    expect(next?.kind).toBe('concept_check');
    expect(await enqueueNextStep(db, { id, state: 'designed', attempt: 0 }, clock.now())).toBeNull();
    expect(await enqueueNextStep(db, { id, state: 'drafted', attempt: 0 }, clock.now())).toBeNull();
    const again = await enqueueNextStep(db, { id, state: 'proposed', attempt: 0 }, clock.now());
    expect(again?.created).toBe(false);
    expect(productStepKey('write', id, 2)).toBe(`write:${id}:2`);
  });

  it('rejects empty keys', async () => {
    await expect(enqueue(db, { kind: 'analyze', idempotencyKey: '' }, clock.now())).rejects.toThrow(/idempotencyKey/);
  });
});

describe('claimNext', () => {
  it('claims due jobs oldest first, marks them running, never hands out a running job twice', async () => {
    await enqueue(db, { kind: 'analyze', idempotencyKey: 'a1' }, clock.now());
    clock.advance(1000);
    await enqueue(db, { kind: 'trend_scan', idempotencyKey: 't1' }, clock.now());
    await enqueue(db, { kind: 'analyze', idempotencyKey: 'future', runAfter: new Date(clock.now().getTime() + 60_000) }, clock.now());

    const first = await claimNext(db, clock.now());
    expect(first?.idempotencyKey).toBe('a1');
    expect(first?.status).toBe('running');
    expect(first?.attempts).toBe(1);
    expect(first?.lockedAt).toBe(clock.now().toISOString());

    const second = await claimNext(db, clock.now());
    expect(second?.idempotencyKey).toBe('t1');
    expect(await claimNext(db, clock.now())).toBeNull(); // 'future' is not due yet

    clock.advance(61_000);
    expect((await claimNext(db, clock.now()))?.idempotencyKey).toBe('future');
  });

  it('skips excluded kinds (caps)', async () => {
    await enqueue(db, { kind: 'qa_publish', idempotencyKey: 'q' }, clock.now());
    await enqueue(db, { kind: 'analyze', idempotencyKey: 'a' }, clock.now());
    const job = await claimNext(db, clock.now(), { excludeKinds: ['qa_publish'] });
    expect(job?.kind).toBe('analyze');
    expect(await claimNext(db, clock.now(), { excludeKinds: ['qa_publish'] })).toBeNull();
  });

  it('claims with a single FOR UPDATE SKIP LOCKED statement', async () => {
    const seen: string[] = [];
    const spy: Queryable = {
      query: async (sql, params) => {
        seen.push(sql);
        return db.query(sql, params);
      },
      exec: (sql) => db.exec(sql),
    };
    await enqueue(db, { kind: 'analyze', idempotencyKey: 'x' }, clock.now());
    await claimNext(spy, clock.now());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(seen[0]).toMatch(/^\s*UPDATE jobs/);
  });
});

describe('failures, backoff and stale locks', () => {
  it('backs off exponentially with a cap', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(3)).toBe(480_000);
    expect(backoffMs(10)).toBe(3_600_000);
  });

  it('requeues with backoff, then fails and audits when attempts are used up', async () => {
    const { id } = await enqueue(db, { kind: 'analyze', idempotencyKey: 'k', maxAttempts: 2 }, clock.now());
    let job = (await claimNext(db, clock.now()))!;
    expect(await recordFailure(db, job, 'boom 1', clock.now())).toBe('retry');
    let row = (await getJob(db, id))!;
    expect(row.status).toBe('queued');
    expect(row.lastError).toBe('boom 1');
    expect(Date.parse(row.runAfter) - clock.now().getTime()).toBe(30_000);
    expect(await claimNext(db, clock.now())).toBeNull(); // backoff not elapsed

    clock.advance(30_000);
    job = (await claimNext(db, clock.now()))!;
    expect(job.attempts).toBe(2);
    expect(await recordFailure(db, job, 'boom 2', clock.now())).toBe('failed');
    row = (await getJob(db, id))!;
    expect(row.status).toBe('failed');
    expect(row.lockedAt).toBeNull();
    expect(await auditActions(db, id)).toEqual(['job.failed']);
  });

  it('fails permanent errors immediately', async () => {
    const { id } = await enqueue(db, { kind: 'analyze', idempotencyKey: 'p' }, clock.now());
    const job = (await claimNext(db, clock.now()))!;
    expect(await recordFailure(db, job, 'bad schema', clock.now(), { permanent: true })).toBe('failed');
    expect((await getJob(db, id))!.status).toBe('failed');
  });

  it('recovers stale running jobs after 15 minutes', async () => {
    const a = await enqueue(db, { kind: 'analyze', idempotencyKey: 'stale', maxAttempts: 3 }, clock.now());
    const b = await enqueue(db, { kind: 'trend_scan', idempotencyKey: 'stale-last', maxAttempts: 1 }, clock.now());
    await claimNext(db, clock.now());
    await claimNext(db, clock.now());

    clock.advance(14 * 60_000);
    expect(await recoverStaleJobs(db, clock.now())).toEqual({ requeued: [], failed: [] });

    clock.advance(2 * 60_000);
    const res = await recoverStaleJobs(db, clock.now());
    expect(res.requeued).toEqual([a.id]);
    expect(res.failed).toEqual([b.id]);
    expect((await getJob(db, a.id))!.status).toBe('queued');
    expect((await getJob(db, b.id))!.status).toBe('failed');
    expect(await auditActions(db, a.id)).toEqual(['job.stale_recovered']);
    expect(await auditActions(db, b.id)).toEqual(['job.failed']);
    const again = await claimNext(db, clock.now());
    expect(again?.id).toBe(a.id);
    expect(again?.attempts).toBe(2);
  });

  it('markDone clears the lock', async () => {
    const { id } = await enqueue(db, { kind: 'analyze', idempotencyKey: 'd' }, clock.now());
    await claimNext(db, clock.now());
    await markDone(db, id, clock.now());
    const row = (await getJob(db, id))!;
    expect(row.status).toBe('done');
    expect(row.lockedAt).toBeNull();
  });
});

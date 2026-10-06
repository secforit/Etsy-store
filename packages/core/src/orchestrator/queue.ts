/**
 * Postgres job queue.
 *  - enqueue is idempotent on `idempotency_key` (INSERT ... ON CONFLICT DO NOTHING)
 *  - claim takes ONE due job with `FOR UPDATE SKIP LOCKED` in a single UPDATE statement (safe with several workers)
 *  - failures retry with exponential backoff until max_attempts, then `failed` + audit row
 *  - jobs stuck in `running` (worker crashed) are recovered after 15 minutes
 */
import type { Db, Queryable } from '../db/db.ts';
import { stepForState } from '../domain/stateMachine.ts';
import type { Job, JobKind, Product } from '../domain/types.ts';
import { insertAudit, mapJob } from './repo.ts';
import { addMs } from './time.ts';

type Row = Record<string, unknown>;

export const DEFAULT_MAX_ATTEMPTS = 3;
export const STALE_LOCK_MS = 15 * 60_000;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 60 * 60_000;

export interface EnqueueInput {
  kind: JobKind;
  idempotencyKey: string;
  productId?: string | null;
  nicheId?: string | null;
  runAfter?: Date;
  maxAttempts?: number;
}

/** Inserts the job unless one with the same idempotency key exists. Returns the job id either way. */
export async function enqueue(q: Queryable, input: EnqueueInput, now: Date): Promise<{ id: string; created: boolean }> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 300) throw new Error('enqueue: idempotencyKey must be 1..300 chars');
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO jobs (kind, product_id, niche_id, status, attempts, max_attempts, run_after, idempotency_key, created_at, updated_at)
     VALUES ($1, $2, $3, 'queued', 0, $4, $5, $6, $7, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.kind,
      input.productId ?? null,
      input.nicheId ?? null,
      input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      input.runAfter ?? now,
      input.idempotencyKey,
      now,
    ],
  );
  if (rows[0]) return { id: String(rows[0].id), created: true };
  const existing = await q.query<{ id: string }>('SELECT id FROM jobs WHERE idempotency_key = $1', [input.idempotencyKey]);
  if (!existing.rows[0]) throw new Error(`enqueue: job ${input.idempotencyKey} vanished`);
  return { id: String(existing.rows[0].id), created: false };
}

/** Idempotency key of a product step: one job per kind per product per QA redesign attempt. */
export function productStepKey(kind: JobKind, productId: string, attempt: number): string {
  return `${kind}:${productId}:${attempt}`;
}

/** Enqueues the automated step that moves the product out of its current state (none for human/terminal states). */
export async function enqueueNextStep(
  q: Queryable,
  product: Pick<Product, 'id' | 'state' | 'attempt'>,
  now: Date,
): Promise<{ id: string; created: boolean; kind: JobKind } | null> {
  const kind = stepForState(product.state);
  if (!kind) return null;
  const res = await enqueue(
    q,
    { kind, productId: product.id, idempotencyKey: productStepKey(kind, product.id, product.attempt) },
    now,
  );
  return { ...res, kind };
}

/**
 * Atomically claims the oldest due queued job (skipping kinds in `excludeKinds`) and marks it running.
 * `FOR UPDATE SKIP LOCKED` lets concurrent workers claim different jobs without blocking each other.
 */
export async function claimNext(q: Queryable, now: Date, opts: { excludeKinds?: readonly JobKind[] } = {}): Promise<Job | null> {
  const { rows } = await q.query<Row>(
    `UPDATE jobs SET status = 'running', locked_at = $1, attempts = attempts + 1, updated_at = $1
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'queued' AND run_after <= $1 AND NOT (kind = ANY($2::text[]))
       ORDER BY run_after ASC, created_at ASC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [now, [...(opts.excludeKinds ?? [])]],
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

/** Marks a claimed job done (call inside the step's transaction so persist + done commit together). */
export async function markDone(q: Queryable, jobId: string, now: Date, note: string | null = null): Promise<void> {
  await q.query(
    `UPDATE jobs SET status = 'done', locked_at = NULL, last_error = $2, updated_at = $3 WHERE id = $1`,
    [jobId, note, now],
  );
}

/** 30 s, 2 min, 8 min, 32 min, then 1 h (attempts = attempts already used, >= 1). Deterministic. */
export function backoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 4 ** (n - 1));
}

export type FailureOutcome = 'retry' | 'failed';

/**
 * Records a failed run of a claimed job: requeue with backoff, or mark `failed` (and audit) when attempts are
 * used up or the error is permanent.
 */
export async function recordFailure(
  db: Db,
  job: Job,
  error: string,
  now: Date,
  opts: { permanent?: boolean } = {},
): Promise<FailureOutcome> {
  const exhausted = job.attempts >= job.maxAttempts;
  if (opts.permanent || exhausted) {
    await db.tx(async (q) => {
      await q.query(
        `UPDATE jobs SET status = 'failed', locked_at = NULL, last_error = $2, updated_at = $3 WHERE id = $1`,
        [job.id, error, now],
      );
      await insertAudit(
        q,
        {
          actor: 'system',
          action: 'job.failed',
          entity: 'job',
          entityId: job.id,
          details: {
            kind: job.kind,
            productId: job.productId,
            nicheId: job.nicheId,
            attempts: job.attempts,
            permanent: Boolean(opts.permanent),
            error,
          },
        },
        now,
      );
    });
    return 'failed';
  }
  await db.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, last_error = $2, run_after = $3, updated_at = $4 WHERE id = $1`,
    [job.id, error, addMs(now, backoffMs(job.attempts)), now],
  );
  return 'retry';
}

/**
 * Jobs left `running` longer than `staleAfterMs` belong to a crashed worker: requeue them (the claim already
 * counted the attempt) or fail them when attempts are used up.
 */
export async function recoverStaleJobs(
  db: Db,
  now: Date,
  staleAfterMs = STALE_LOCK_MS,
): Promise<{ requeued: string[]; failed: string[] }> {
  const cutoff = addMs(now, -staleAfterMs);
  return db.tx(async (q) => {
    const { rows } = await q.query<Row>(
      `SELECT * FROM jobs WHERE status = 'running' AND locked_at < $1 ORDER BY locked_at ASC FOR UPDATE SKIP LOCKED`,
      [cutoff],
    );
    const requeued: string[] = [];
    const failed: string[] = [];
    for (const job of rows.map(mapJob)) {
      const msg = `stale lock: worker stopped while running (locked at ${job.lockedAt})`;
      if (job.attempts >= job.maxAttempts) {
        await q.query(`UPDATE jobs SET status = 'failed', locked_at = NULL, last_error = $2, updated_at = $3 WHERE id = $1`, [
          job.id,
          msg,
          now,
        ]);
        await insertAudit(
          q,
          {
            actor: 'system',
            action: 'job.failed',
            entity: 'job',
            entityId: job.id,
            details: { kind: job.kind, productId: job.productId, attempts: job.attempts, error: msg },
          },
          now,
        );
        failed.push(job.id);
      } else {
        await q.query(
          `UPDATE jobs SET status = 'queued', locked_at = NULL, last_error = $2, run_after = $3, updated_at = $3 WHERE id = $1`,
          [job.id, msg, now],
        );
        await insertAudit(
          q,
          { actor: 'system', action: 'job.stale_recovered', entity: 'job', entityId: job.id, details: { kind: job.kind } },
          now,
        );
        requeued.push(job.id);
      }
    }
    return { requeued, failed };
  });
}

/** Counts per status (worker status line, demo summary). */
export async function jobCounts(q: Queryable): Promise<Record<string, number>> {
  const { rows } = await q.query<{ status: string; n: unknown }>('SELECT status, count(*) AS n FROM jobs GROUP BY status');
  const out: Record<string, number> = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

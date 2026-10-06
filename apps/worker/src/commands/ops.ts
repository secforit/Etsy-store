/**
 * Small operator commands: `status` (caps, counts, queue) and `retry-failed` (requeue failed jobs after fixing
 * the cause, e.g. a Printify outage). Both are audited where they change state.
 */
import type { Db } from '@etsy-agents/core/db/db.ts';
import { JOB_KINDS, type AgentName, type JobKind } from '@etsy-agents/core/domain/types.ts';
import { checkCaps } from '@etsy-agents/core/orchestrator/caps.ts';
import { jobCounts } from '@etsy-agents/core/orchestrator/queue.ts';
import { countsByState, insertAudit, isUuid } from '@etsy-agents/core/orchestrator/repo.ts';
import type { Io } from '../io.ts';

export async function printStatus(db: Db, now: Date, cloudAgents: readonly AgentName[], io: Io): Promise<void> {
  const caps = await checkCaps(db, now, cloudAgents);
  const states = await countsByState(db);
  const jobs = await jobCounts(db);
  const failed = await db.query<{ kind: string; id: string; last_error: string | null }>(
    `SELECT kind, id, last_error FROM jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 10`,
  );
  io.out(`Paused            : ${caps.paused ? 'YES' : 'no'}`);
  io.out(`Drafts today      : ${caps.draftsToday} / ${caps.settings.dailyDraftCap}${caps.draftCapReached ? ' (cap reached)' : ''}`);
  io.out(`Cloud spend today : $${caps.spendTodayUsd.toFixed(2)} / $${caps.settings.dailySpendCapUsd.toFixed(2)}${caps.spendCapReached ? ' (cap reached)' : ''}`);
  io.out(`Held job kinds    : ${caps.excludedKinds.join(', ') || 'none'}`);
  io.out(`Products          : ${Object.entries(states).filter(([, n]) => n > 0).map(([s, n]) => `${s}=${n}`).join(', ') || 'none'}`);
  io.out(`Jobs              : ${Object.entries(jobs).map(([s, n]) => `${s}=${n}`).join(', ')}`);
  for (const f of failed.rows) io.out(`  failed ${f.kind} ${f.id}: ${(f.last_error ?? '').slice(0, 160)}`);
}

export async function retryFailed(db: Db, now: Date, io: Io, filter: { kind?: string; jobId?: string } = {}): Promise<number> {
  if (filter.kind && !(JOB_KINDS as readonly string[]).includes(filter.kind)) throw new Error(`unknown job kind ${filter.kind}`);
  if (filter.jobId && !isUuid(filter.jobId)) throw new Error('job id must be a UUID');
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: string; kind: JobKind }>(
      `UPDATE jobs SET status = 'queued', attempts = 0, run_after = $1, locked_at = NULL, updated_at = $1
       WHERE status = 'failed' AND ($2::text IS NULL OR kind = $2) AND ($3::uuid IS NULL OR id = $3)
       RETURNING id, kind`,
      [now, filter.kind ?? null, filter.jobId ?? null],
    );
    for (const r of rows) {
      await insertAudit(q, { actor: 'cli', action: 'job.requeued', entity: 'job', entityId: r.id, details: { kind: r.kind } }, now);
    }
    io.out(`Requeued ${rows.length} failed job(s).`);
    return rows.length;
  });
}

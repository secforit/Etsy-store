/**
 * The orchestrator runs ONE job per `runOnce()`:
 *   1. recover stale locks (worker crashed mid-job)
 *   2. check settings.paused, the daily draft cap and the daily cloud spend cap
 *   3. claim the next due job that the caps allow (FOR UPDATE SKIP LOCKED)
 *   4. run its step handler; failures retry with backoff, then `failed` + audit
 * The worker calls runOnce() in a loop, one job at a time, so the single GPU is never contended inside the worker.
 */
import { AGENT_NAMES, type AgentName, type Job, type JobKind } from '../domain/types.ts';
import { checkCaps, type CapStatus } from './caps.ts';
import type { OrchestratorDeps } from './contracts.ts';
import { errorMessage } from './logger.ts';
import { claimNext, markDone, recordFailure, recoverStaleJobs, STALE_LOCK_MS, type FailureOutcome } from './queue.ts';
import { StaleStateError } from './repo.ts';
import {
  DEFAULT_STEP_OPTIONS,
  STEP_HANDLERS,
  createStepContext,
  isPermanentError,
  type StepHandler,
  type StepOptions,
} from './steps.ts';

export interface OrchestratorOptions extends Partial<StepOptions> {
  /**
   * Agents routed to a cloud model. The spend cap holds back only their jobs. Default: every agent
   * (conservative); the runtime passes the real list from LLM_ROUTES / LLM_DEFAULT_PROVIDER.
   */
  cloudAgents?: readonly AgentName[];
  /** Running jobs older than this are treated as abandoned. Default 15 min. */
  staleLockMs?: number;
  /** Override step handlers (tests). */
  handlers?: Partial<Record<JobKind, StepHandler>>;
}

export type RunOnceResult =
  | { status: 'paused'; caps: CapStatus }
  | { status: 'idle'; caps: CapStatus }
  | {
      status: 'ran';
      caps: CapStatus;
      job: Pick<Job, 'id' | 'kind' | 'productId' | 'nicheId' | 'attempts'>;
      outcome: 'done' | 'skipped' | FailureOutcome;
      note?: string;
      error?: string;
    };

export class Orchestrator {
  private readonly cloudAgents: readonly AgentName[];
  private readonly staleLockMs: number;
  private readonly stepOptions: StepOptions;
  private readonly handlers: Record<JobKind, StepHandler>;

  constructor(
    private readonly deps: OrchestratorDeps,
    options: OrchestratorOptions = {},
  ) {
    this.cloudAgents = options.cloudAgents ?? AGENT_NAMES;
    this.staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
    this.stepOptions = {
      ...DEFAULT_STEP_OPTIONS,
      ...(options.reportIntervalMs !== undefined ? { reportIntervalMs: options.reportIntervalMs } : {}),
      ...(options.maxSignalsPerScan !== undefined ? { maxSignalsPerScan: options.maxSignalsPerScan } : {}),
      ...(options.imageGenCostUsd !== undefined ? { imageGenCostUsd: Math.max(0, options.imageGenCostUsd) } : {}),
      ...(options.imageBackgroundCostUsd !== undefined ? { imageBackgroundCostUsd: Math.max(0, options.imageBackgroundCostUsd) } : {}),
      ...(options.upscaleCostUsd !== undefined ? { upscaleCostUsd: Math.max(0, options.upscaleCostUsd) } : {}),
      ...(options.qaPublish ? { qaPublish: options.qaPublish } : {}),
    };
    this.handlers = { ...STEP_HANDLERS, ...(options.handlers ?? {}) };
  }

  async runOnce(): Promise<RunOnceResult> {
    const { db, logger } = this.deps;
    const recovered = await recoverStaleJobs(db, this.deps.now(), this.staleLockMs);
    if (recovered.requeued.length || recovered.failed.length) {
      logger.warn({ requeued: recovered.requeued.length, failed: recovered.failed.length }, 'recovered stale jobs');
    }

    const caps = await checkCaps(db, this.deps.now(), this.cloudAgents);
    if (caps.paused) return { status: 'paused', caps };

    const job = await claimNext(db, this.deps.now(), { excludeKinds: caps.excludedKinds });
    if (!job) return { status: 'idle', caps };

    const summary = { id: job.id, kind: job.kind, productId: job.productId, nicheId: job.nicheId, attempts: job.attempts };
    const started = Date.now();
    const ctx = createStepContext(this.deps, job, this.stepOptions);
    try {
      const res = await this.handlers[job.kind](ctx);
      if (!ctx.committed) await markDone(db, job.id, this.deps.now(), res.status === 'skipped' ? (res.note ?? 'skipped') : null);
      logger.info({ job: summary, outcome: res.status, note: res.note, ms: Date.now() - started }, 'job finished');
      return { status: 'ran', caps, job: summary, outcome: res.status, ...(res.note ? { note: res.note } : {}) };
    } catch (err) {
      const msg = errorMessage(err);
      if (err instanceof StaleStateError) {
        // Someone else (a human action or a duplicate job) moved the product first: nothing left to do.
        await markDone(db, job.id, this.deps.now(), `skipped: ${msg}`);
        logger.warn({ job: summary, err: msg }, 'job skipped: product state changed');
        return { status: 'ran', caps, job: summary, outcome: 'skipped', note: msg };
      }
      const outcome = await recordFailure(db, job, msg, this.deps.now(), { permanent: isPermanentError(err) });
      const log = outcome === 'failed' ? logger.error.bind(logger) : logger.warn.bind(logger);
      log({ job: summary, outcome, err: msg, ms: Date.now() - started }, outcome === 'failed' ? 'job failed' : 'job will retry');
      return { status: 'ran', caps, job: summary, outcome, error: msg };
    }
  }

  /**
   * Runs jobs until nothing is due (or `maxJobs`). Used by the demo and tests; the worker loop calls runOnce().
   */
  async runUntilIdle(maxJobs = 1000): Promise<RunOnceResult[]> {
    const results: RunOnceResult[] = [];
    for (let i = 0; i < maxJobs; i++) {
      const r = await this.runOnce();
      results.push(r);
      if (r.status !== 'ran') break;
    }
    return results;
  }
}

export function createOrchestrator(deps: OrchestratorDeps, options: OrchestratorOptions = {}): Orchestrator {
  return new Orchestrator(deps, options);
}

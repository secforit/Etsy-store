/**
 * `run`: the worker loop. One job at a time (the RTX 3060 is shared by Ollama and the imagegen sidecar, and the
 * GpuCoordinator serialises inside this process). SIGTERM/SIGINT stop the loop after the current job; a job
 * killed mid-way is recovered by the stale-lock check after 15 minutes.
 */
import { writeFile } from 'node:fs/promises';
import type { Logger } from '@etsy-agents/core/orchestrator/contracts.ts';
import type { RunOnceResult } from '@etsy-agents/core/orchestrator/orchestrator.ts';
import { errorMessage } from '@etsy-agents/core/orchestrator/logger.ts';

export interface WorkerLoopOptions {
  orchestrator: { runOnce(): Promise<RunOnceResult> };
  /** Enqueues periodic jobs (scheduler); called at start and then every `scheduleEveryMs`. */
  schedule: () => Promise<string[]>;
  pollMs: number;
  scheduleEveryMs?: number;
  signal: AbortSignal;
  logger: Logger;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  clock?: () => number;
  /** Stop after this many loop iterations (tests). */
  maxIterations?: number;
}

/** Resolves after `ms` or as soon as the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function runWorkerLoop(o: WorkerLoopOptions): Promise<{ jobsRun: number; iterations: number }> {
  const sleep = o.sleep ?? abortableSleep;
  const clock = o.clock ?? Date.now;
  const scheduleEvery = o.scheduleEveryMs ?? 60_000;
  let lastSchedule = Number.NEGATIVE_INFINITY;
  let lastStatus: string | null = null;
  let jobsRun = 0;
  let iterations = 0;
  while (!o.signal.aborted && (o.maxIterations === undefined || iterations < o.maxIterations)) {
    iterations++;
    try {
      if (clock() - lastSchedule >= scheduleEvery) {
        lastSchedule = clock();
        const created = await o.schedule();
        if (created.length) o.logger.info({ created }, 'scheduled periodic jobs');
      }
      const r = await o.orchestrator.runOnce();
      if (r.status === 'ran') {
        jobsRun++;
        lastStatus = 'ran';
        continue; // more work may be due: no sleep between jobs
      }
      if (r.status !== lastStatus) {
        o.logger.info(
          { status: r.status, draftsToday: r.caps.draftsToday, spendTodayUsd: r.caps.spendTodayUsd, held: r.caps.excludedKinds },
          r.status === 'paused' ? 'paused from the desk; waiting' : 'idle; waiting for work',
        );
        lastStatus = r.status;
      }
    } catch (err) {
      // DB unreachable etc.: log and back off, never crash-loop the container.
      o.logger.error({ err: errorMessage(err) }, 'worker loop error');
      lastStatus = 'error';
    }
    await sleep(o.pollMs, o.signal);
  }
  return { jobsRun, iterations };
}

/** Touches the heartbeat file every 30 s while the process is alive (container healthcheck reads its age). */
export function startHeartbeat(file: string, logger: Logger, everyMs = 30_000): () => void {
  const beat = () =>
    writeFile(file, new Date().toISOString()).catch((err) => logger.warn({ err: errorMessage(err) }, 'heartbeat write failed'));
  void beat();
  const t = setInterval(beat, everyMs);
  t.unref();
  return () => clearInterval(t);
}

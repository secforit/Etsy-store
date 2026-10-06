import { describe, expect, it } from 'vitest';
import type { RunOnceResult } from '@etsy-agents/core/orchestrator/orchestrator.ts';
import type { CapStatus } from '@etsy-agents/core/orchestrator/caps.ts';
import { MemoryLogger } from '@etsy-agents/core/orchestrator/testing/fakes.ts';
import { abortableSleep, runWorkerLoop } from './run.ts';

const caps = { draftsToday: 0, spendTodayUsd: 0, excludedKinds: [] } as unknown as CapStatus;
const ran = (): RunOnceResult => ({ status: 'ran', caps, job: { id: 'j', kind: 'analyze', productId: null, nicheId: null, attempts: 1 }, outcome: 'done' });
const idle = (): RunOnceResult => ({ status: 'idle', caps });

describe('worker loop', () => {
  it('runs jobs back to back, sleeps only when idle, schedules periodically, stops on abort', async () => {
    const controller = new AbortController();
    const script = [ran(), ran(), idle(), ran(), idle()];
    let schedules = 0;
    const sleeps: number[] = [];
    let t = 0;
    const res = await runWorkerLoop({
      orchestrator: {
        runOnce: async () => {
          const r = script.shift();
          if (!r) {
            controller.abort();
            return idle();
          }
          return r;
        },
      },
      schedule: async () => {
        schedules++;
        return [];
      },
      pollMs: 5000,
      scheduleEveryMs: 60_000,
      signal: controller.signal,
      logger: new MemoryLogger(),
      clock: () => (t += 20_000),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(res.jobsRun).toBe(3);
    expect(sleeps).toEqual([5000, 5000, 5000]);
    expect(schedules).toBeGreaterThanOrEqual(2);
  });

  it('logs loop errors and keeps going', async () => {
    const controller = new AbortController();
    const logger = new MemoryLogger();
    let calls = 0;
    await runWorkerLoop({
      orchestrator: {
        runOnce: async () => {
          calls++;
          if (calls === 1) throw new Error('connection refused');
          controller.abort();
          return idle();
        },
      },
      schedule: async () => [],
      pollMs: 1,
      signal: controller.signal,
      logger,
      sleep: async () => {},
    });
    expect(calls).toBe(2);
    expect(logger.lines.some((l) => l.level === 'error' && l.obj.err === 'Error: connection refused')).toBe(true);
  });

  it('abortable sleep resolves early on abort', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const p = abortableSleep(10_000, controller.signal);
    controller.abort();
    await p;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

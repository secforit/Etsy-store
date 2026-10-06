import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@etsy-agents/core/db/db.ts';
import { createHarness, sharedTestDb } from '@etsy-agents/core/orchestrator/testing/fakes.ts';
import { latestAvoidRules } from '@etsy-agents/core/orchestrator/avoidRules.ts';
import { MemoryIo } from '../io.ts';
import { DEMO_REJECT_REASON, runDemo } from './demo.ts';

let db: Db;
beforeEach(async () => {
  db = await sharedTestDb();
});

describe('demo (with local fakes; the real mocks are exercised end to end separately)', () => {
  it('drives trend scan -> upload -> draft -> approve/reject -> analyze and prints a summary', async () => {
    const h = await createHarness({ db, agents: { productsPerNiche: 1 } });
    const io = new MemoryIo();
    const summary = await runDemo({ io, deps: h.deps, orchestratorOptions: { cloudAgents: [], qaPublish: { sleep: async () => {} } } });

    expect(summary.uploads).toBe(2);
    expect(summary.drafted).toBe(2);
    expect(summary.approved).toHaveLength(1);
    expect(summary.rejected).toHaveLength(1);
    expect(summary.productsByState).toEqual({ live: 1, rejected: 1 });
    expect(summary.failedJobs).toEqual([]);
    expect(summary.agentRuns.costUsd).toBe(0);
    expect(summary.externalWrites).toEqual(expect.arrayContaining(['etsy.listing.activate', 'product.drafted']));
    expect(summary.reportExcerpt).toMatch(/Weekly report/);
    expect(await latestAvoidRules(db)).toEqual([DEMO_REJECT_REASON]);
    expect(io.text()).toMatch(/== Summary ==/);
    expect(io.text()).toMatch(/Cloud spend\s+: \$0\.00/);
  });

  it('reports drafts held back by the daily draft cap', async () => {
    const h = await createHarness({ db, agents: { productsPerNiche: 3 } });
    await db.query('UPDATE settings SET daily_draft_cap = 2');
    const io = new MemoryIo();
    const summary = await runDemo({ io, deps: h.deps, orchestratorOptions: { cloudAgents: [], qaPublish: { sleep: async () => {} } } });
    expect(summary.drafted).toBe(2);
    expect(summary.heldByDraftCap).toBe(4);
    expect(io.text()).toMatch(/4 held by the daily draft cap \(2\/day\)/);
  });

  it('refuses to run outside mock mode', async () => {
    await expect(runDemo({ io: new MemoryIo(), env: { MODE: 'live' } as never })).rejects.toThrow(/MODE=mock only/);
  });
});

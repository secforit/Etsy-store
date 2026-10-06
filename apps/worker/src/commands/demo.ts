/**
 * `demo`: the whole pipeline offline. MODE=mock, in-memory PGlite, in-memory blobs, mock integrations, mock LLM.
 *   trend scan -> niches -> products -> concept check -> design -> (simulated upload of Razvan's edit)
 *   -> listing copy -> final check -> QA & Printify draft (daily draft cap applies) -> approve / reject -> analyze
 * Prints a summary. Nothing leaves the machine and nothing is written to disk.
 */
import sharp from 'sharp';
import { loadEnv, type Env } from '@etsy-agents/core/config/env.ts';
import { createPgliteDb, migrate } from '@etsy-agents/core/db/db.ts';
import { createDeskService } from '@etsy-agents/core/desk/service.ts';
import { PRODUCT_STATES } from '@etsy-agents/core/domain/types.ts';
import type { OrchestratorDeps } from '@etsy-agents/core/orchestrator/contracts.ts';
import { createLogger } from '@etsy-agents/core/orchestrator/logger.ts';
import { Orchestrator, type OrchestratorOptions } from '@etsy-agents/core/orchestrator/orchestrator.ts';
import { enqueue, jobCounts } from '@etsy-agents/core/orchestrator/queue.ts';
import { countsByState } from '@etsy-agents/core/orchestrator/repo.ts';
import { buildRuntime } from '@etsy-agents/core/orchestrator/runtime.ts';
import { isoDate, isoHour } from '@etsy-agents/core/orchestrator/time.ts';
import type { Io } from '../io.ts';
import { InMemoryBlobStorage } from '../memoryStorage.ts';

export const DEMO_ACTOR = 'razvan (demo)';
export const DEMO_REJECT_REASON = 'Demo: the lettering sits too close to the edge; keep a wider margin around text.';

export interface DemoSummary {
  productsByState: Record<string, number>;
  jobs: Record<string, number>;
  agentRuns: { calls: number; costUsd: number; byAgent: Record<string, number> };
  uploads: number;
  drafted: number;
  approved: string[];
  rejected: string[];
  heldByDraftCap: number;
  auditEntries: number;
  externalWrites: string[];
  reportExcerpt: string | null;
  failedJobs: { kind: string; error: string | null }[];
}

export interface DemoOptions {
  io: Io;
  /** Injected wiring (tests). Default: real factories in MODE=mock with in-memory PGlite and blobs. */
  deps?: OrchestratorDeps;
  orchestratorOptions?: OrchestratorOptions;
  /** Raw env for the mock run (defaults to MODE=mock, quiet logs). */
  env?: Env;
}

/** Simulates Razvan's hand edit: same size, slightly warmer colours, re-encoded PNG. */
export async function simulateEdit(png: Uint8Array): Promise<Uint8Array> {
  const out = await sharp(png).modulate({ saturation: 1.1, brightness: 1.02 }).png().toBuffer();
  return new Uint8Array(out);
}

async function buildDemoDeps(env: Env): Promise<{ deps: OrchestratorDeps; options: OrchestratorOptions; close: () => Promise<void> }> {
  const db = await createPgliteDb();
  await migrate(db);
  const runtime = await buildRuntime(env, {
    component: 'demo',
    db,
    storage: new InMemoryBlobStorage(),
    logger: createLogger(env.LOG_LEVEL, 'demo'),
    rawEnv: {},
  });
  return {
    deps: runtime.deps,
    options: { ...runtime.orchestratorOptions, qaPublish: { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) } },
    close: () => db.close(),
  };
}

export async function runDemo(opts: DemoOptions): Promise<DemoSummary> {
  const { io } = opts;
  const env = opts.env ?? loadEnv({ MODE: 'mock', LOG_LEVEL: 'warn' });
  if (env.MODE !== 'mock') throw new Error('demo runs in MODE=mock only');
  let close = async () => {};
  let deps = opts.deps;
  let orchOptions = opts.orchestratorOptions ?? {};
  if (!deps) {
    const built = await buildDemoDeps(env);
    deps = built.deps;
    orchOptions = { ...built.options, ...orchOptions };
    close = built.close;
  }
  const { db } = deps;
  try {
    const orch = new Orchestrator(deps, orchOptions);
    const desk = createDeskService(deps);
    const now = deps.now();

    io.out('== Etsy agent team: offline demo (MODE=mock, in-memory database, nothing is published) ==');
    io.out('1. Trend Scout -> Niche Validator -> Compliance Guard -> Designer');
    await enqueue(db, { kind: 'trend_scan', idempotencyKey: `trend_scan:${isoDate(now)}` }, now);
    await orch.runUntilIdle();
    const designed = await desk.listProducts({ states: ['designed'] });
    io.out(`   ${designed.length} design(s) wait for Razvan's edit`);

    io.out("2. Razvan edits each design and uploads it on the desk (simulated)");
    let uploads = 0;
    for (const p of designed) {
      const art = await desk.getAsset(p.id, 'art');
      if (!art) {
        io.err(`   no raw art for ${p.id}; skipped`);
        continue;
      }
      const edited = await simulateEdit(art.bytes);
      await desk.uploadEditedDesign(p.id, { bytes: edited, filename: 'edited.png', mimeType: 'image/png' }, DEMO_ACTOR);
      uploads++;
    }
    io.out(`   ${uploads} edited file(s) uploaded`);

    io.out('3. Listing Writer -> Compliance Guard (final) -> QA & Publisher (Printify -> Etsy draft)');
    const last = (await orch.runUntilIdle()).at(-1);
    const drafted = await desk.listProducts({ states: ['drafted'] });
    const held = (await desk.listProducts({ states: ['final_cleared'] })).length;
    io.out(`   ${drafted.length} Etsy draft(s) created${held ? `; ${held} held by the daily draft cap (${last?.caps.settings.dailyDraftCap}/day)` : ''}`);

    io.out('4. Razvan approves or rejects each draft on the desk (simulated)');
    const approved: string[] = [];
    const rejected: string[] = [];
    for (const [i, p] of drafted.entries()) {
      if (drafted.length > 1 && i === drafted.length - 1) {
        await desk.reject(p.id, DEMO_REJECT_REASON, DEMO_ACTOR);
        rejected.push(p.id);
      } else {
        await desk.approve(p.id, DEMO_ACTOR);
        approved.push(p.id);
      }
    }
    io.out(`   approved ${approved.length}, rejected ${rejected.length} (the reason becomes an avoid-rule)`);

    io.out('5. Analyst: metrics, retirements, weekly report');
    const later = deps.now();
    await enqueue(db, { kind: 'analyze', idempotencyKey: `analyze:${isoHour(later)}:demo` }, later);
    await orch.runUntilIdle();

    const summary = await summarise(deps, { uploads, drafted: drafted.length, approved, rejected, held });
    printSummary(io, summary);
    return summary;
  } finally {
    await close();
  }
}

async function summarise(
  deps: OrchestratorDeps,
  s: { uploads: number; drafted: number; approved: string[]; rejected: string[]; held: number },
): Promise<DemoSummary> {
  const { db } = deps;
  const byState = await countsByState(db);
  const runs = await db.query<{ agent: string; n: unknown; cost: unknown }>(
    'SELECT agent, count(*) AS n, COALESCE(sum(cost_usd), 0) AS cost FROM agent_runs GROUP BY agent ORDER BY agent',
  );
  const audit = await db.query<{ n: unknown }>('SELECT count(*) AS n FROM audit_log');
  const writes = await db.query<{ action: string }>(
    `SELECT DISTINCT action FROM audit_log WHERE action LIKE 'etsy.%' OR action LIKE 'printify.%' OR action = 'product.drafted' ORDER BY action`,
  );
  const report = await db.query<{ markdown: string }>('SELECT markdown FROM weekly_reports ORDER BY week_start DESC LIMIT 1');
  const failed = await db.query<{ kind: string; last_error: string | null }>(`SELECT kind, last_error FROM jobs WHERE status = 'failed'`);
  const byAgent: Record<string, number> = {};
  let calls = 0;
  let cost = 0;
  for (const r of runs.rows) {
    byAgent[r.agent] = Number(r.n);
    calls += Number(r.n);
    cost += Number(r.cost);
  }
  return {
    productsByState: Object.fromEntries(PRODUCT_STATES.filter((st) => byState[st] > 0).map((st) => [st, byState[st]])),
    jobs: await jobCounts(db),
    agentRuns: { calls, costUsd: Math.round(cost * 10_000) / 10_000, byAgent },
    uploads: s.uploads,
    drafted: s.drafted,
    approved: s.approved,
    rejected: s.rejected,
    heldByDraftCap: s.held,
    auditEntries: Number(audit.rows[0]?.n ?? 0),
    externalWrites: writes.rows.map((r) => r.action),
    reportExcerpt: report.rows[0]?.markdown.split('\n').slice(0, 12).join('\n') ?? null,
    failedJobs: failed.rows.map((r) => ({ kind: r.kind, error: r.last_error })),
  };
}

function printSummary(io: Io, s: DemoSummary): void {
  io.out('');
  io.out('== Summary ==');
  io.out(`Products by state : ${Object.entries(s.productsByState).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
  io.out(`Jobs              : ${Object.entries(s.jobs).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  io.out(`LLM calls         : ${s.agentRuns.calls} (${Object.entries(s.agentRuns.byAgent).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  io.out(`Cloud spend       : $${s.agentRuns.costUsd.toFixed(2)} (local models cost $0)`);
  io.out(`Uploads / drafts  : ${s.uploads} edited upload(s), ${s.drafted} Etsy draft(s), ${s.heldByDraftCap} held by the draft cap`);
  io.out(`Decisions         : ${s.approved.length} approved (live), ${s.rejected.length} rejected`);
  io.out(`Audit log         : ${s.auditEntries} entries; external writes: ${s.externalWrites.join(', ') || 'none'}`);
  if (s.failedJobs.length) {
    io.out(`Failed jobs       : ${s.failedJobs.length}`);
    for (const f of s.failedJobs) io.out(`  - ${f.kind}: ${f.error ?? ''}`);
  }
  if (s.reportExcerpt) {
    io.out('');
    io.out('-- Weekly report (excerpt) --');
    for (const line of s.reportExcerpt.split('\n')) io.out(line);
  }
}

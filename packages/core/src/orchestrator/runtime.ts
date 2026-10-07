/**
 * Wires the real dependencies from the environment (worker `run`, `demo`, and the desk):
 *   db (Postgres, or PGlite in mock mode) -> createIntegrations(env) -> createLlm(env, { gpu }) -> createAgentRegistry().
 * External writes reported by the integrations go to audit_log; Printify catalog ids come from setup-catalog.
 */
import { createAgentRegistry } from '../agents/registry.ts';
import type { Env } from '../config/env.ts';
import { SHOP } from '../config/shop.ts';
import { createPgDb, createPgliteDb, migrate, type Db } from '../db/db.ts';
import { createIntegrations } from '../integrations/factory.ts';
import type { BlobStorage } from '../integrations/types.ts';
import { createLlm } from '../llm/factory.ts';
import type { LlmClient } from '../llm/types.ts';
import { externalWriteAuditHook } from './audit.ts';
import { cloudAgentsFor } from './caps.ts';
import { dbCatalogResolver } from './catalog.ts';
import { cloudModelsWithoutPrice, loadOrchestratorEnv, type OrchestratorEnv } from './config.ts';
import type { Logger, OrchestratorDeps } from './contracts.ts';
import { createLogger } from './logger.ts';
import type { OrchestratorOptions } from './orchestrator.ts';

export interface RuntimeOptions {
  /** Component name in log lines. */
  component?: string;
  db?: Db;
  logger?: Logger;
  now?: () => Date;
  /** Override blob storage (the demo uses in-memory storage). */
  storage?: BlobStorage;
  /** Run migrations after opening the database (always done for PGlite). */
  migrate?: boolean;
  /** Raw process environment for the non-contract worker settings. */
  rawEnv?: Record<string, string | undefined>;
  /**
   * 'desk': the approval desk's runtime (least privilege). Only db, Etsy, Printify, storage and image tools are
   * real; the model client and the worker-only integrations throw if used, and no cloud-LLM key or price is
   * needed (the desk never calls a model). Load its env with `loadEnv(source, { scope: 'desk' })`.
   */
  scope?: 'all' | 'desk';
}

export interface Runtime {
  deps: OrchestratorDeps;
  orchestratorOptions: OrchestratorOptions;
  settings: OrchestratorEnv;
  close(): Promise<void>;
}

/** Postgres when DATABASE_URL is set; otherwise PGlite (PGLITE_DIR or in-memory) - mock mode only. */
export async function openDb(env: Env): Promise<{ db: Db; engine: 'postgres' | 'pglite' }> {
  if (env.DATABASE_URL) return { db: await createPgDb(env.DATABASE_URL), engine: 'postgres' };
  if (env.MODE === 'live') throw new Error('DATABASE_URL is required when MODE=live');
  return { db: await createPgliteDb(env.PGLITE_DIR), engine: 'pglite' };
}

/**
 * Live mode refuses to start when a configured cloud model has no price in LLM_PRICES_JSON: its calls could not
 * be counted correctly against the daily cloud spend cap. The error names the model ids, never any secret.
 */
export function assertCloudModelsPriced(env: Env, raw: Record<string, string | undefined>): void {
  const unpriced = cloudModelsWithoutPrice(env, raw);
  if (unpriced.length === 0) return;
  throw new Error(
    `LLM_PRICES_JSON has no price for the cloud model(s) ${unpriced.join(', ')}. Without it the daily cloud spend cap ` +
      'cannot count their calls, so the service will not start. Add every ANTHROPIC_MODEL_* id to LLM_PRICES_JSON ' +
      'in .env.worker (see .env.worker.example), or route those agents back to ollama.',
  );
}

/** The desk never calls a model; a call would mean a bug, so it fails instead of reaching Ollama or a cloud API. */
const noModelInDesk: LlmClient = {
  async generate() {
    throw new Error('the approval desk does not call language models');
  },
};

export async function buildRuntime(env: Env, opts: RuntimeOptions = {}): Promise<Runtime> {
  const desk = opts.scope === 'desk';
  const settings = loadOrchestratorEnv(opts.rawEnv ?? process.env);
  if (!desk) assertCloudModelsPriced(env, opts.rawEnv ?? process.env);
  const logger = opts.logger ?? createLogger(env.LOG_LEVEL, opts.component ?? 'worker');
  const now = opts.now ?? (() => new Date());
  let db = opts.db;
  let ownsDb = false;
  if (!db) {
    const opened = await openDb(env);
    db = opened.db;
    ownsDb = true;
    if (opened.engine === 'pglite') await migrate(db);
  }
  if (opts.migrate) await migrate(db);

  const integrations = await createIntegrations(env, {
    logger,
    now,
    printifyCatalog: dbCatalogResolver(db),
    onExternalWrite: externalWriteAuditHook(db, now, logger),
    ...(opts.storage ? { storage: opts.storage } : {}),
    ...(desk ? { scope: 'desk' as const } : {}),
  });
  const llm: LlmClient = desk ? noModelInDesk : createLlm(env, { gpu: integrations.gpu, logger });
  const agents = createAgentRegistry();

  const deps: OrchestratorDeps = {
    db,
    integrations,
    llm,
    agents,
    shop: SHOP,
    now,
    logger,
    eurToUsd: settings.EUR_TO_USD,
  };
  const finalDb = db;
  return {
    deps,
    settings,
    orchestratorOptions: {
      cloudAgents: cloudAgentsFor(env),
      reportIntervalMs: settings.ANALYST_REPORT_INTERVAL_HOURS * 3600_000,
      imageGenCostUsd: env.MODE === 'live' && env.IMAGEGEN_PROVIDER === 'recraft' ? settings.RECRAFT_COST_PER_IMAGE_USD : 0,
    },
    async close() {
      if (ownsDb) await finalDb.close();
    },
  };
}

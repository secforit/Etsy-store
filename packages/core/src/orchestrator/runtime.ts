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
import { externalWriteAuditHook } from './audit.ts';
import { cloudAgentsFor } from './caps.ts';
import { dbCatalogResolver } from './catalog.ts';
import { loadOrchestratorEnv, type OrchestratorEnv } from './config.ts';
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

export async function buildRuntime(env: Env, opts: RuntimeOptions = {}): Promise<Runtime> {
  const settings = loadOrchestratorEnv(opts.rawEnv ?? process.env);
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
  });
  const llm = createLlm(env, { gpu: integrations.gpu, logger });
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
    },
    async close() {
      if (ownsDb) await finalDb.close();
    },
  };
}

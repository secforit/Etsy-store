/**
 * Dependencies handed to the orchestrator and the desk service. Everything is injected so tests can
 * swap any part. CONTRACT FILE: owned by the foundation.
 */
import type { AgentRegistry } from '../agents/contracts.ts';
import type { ShopConfig } from '../config/shop.ts';
import type { Db } from '../db/db.ts';
import type { Integrations } from '../integrations/types.ts';
import type { LlmClient } from '../llm/types.ts';

export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
}

export interface OrchestratorDeps {
  db: Db;
  integrations: Integrations;
  llm: LlmClient;
  agents: AgentRegistry;
  shop: ShopConfig;
  /** Injected clock for determinism in tests. */
  now: () => Date;
  logger: Logger;
  /** EUR -> USD conversion used for Printify variant prices. Config, not live FX. */
  eurToUsd: number;
}

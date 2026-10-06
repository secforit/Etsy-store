/**
 * Optional extra dependencies the agents accept on top of the contract types in contracts.ts.
 * All are optional, so the contract signatures (RunX) still type-check; the orchestrator can pass them
 * to get tighter rules. See the agents builder's contractIssues for why each exists.
 */
import type { BaseDeps, DesignerDeps, NicheValidatorDeps, QaPublisherDeps } from './contracts.ts';
import type { PrintifyClient, TrademarkClient } from '../integrations/types.ts';

export interface FxDeps {
  /** USD per 1 EUR (OrchestratorDeps.eurToUsd). Defaults to pricing.DEFAULT_EUR_TO_USD. */
  eurToUsd?: number;
}

export type NicheValidatorDepsExt = NicheValidatorDeps & FxDeps;

export type ListingWriterDepsExt = BaseDeps &
  FxDeps & {
    /** Settings blocklist; the built-in baseline list is always applied. */
    blocklist?: string[];
    /** When given, the Printify catalog cost is used for the min-margin floor (otherwise targetPriceEur is the floor). */
    printify?: PrintifyClient;
    /** When given, tags that ARE a live mark in the product's class are dropped before final compliance. */
    trademark?: TrademarkClient;
  };

export type QaPublisherDepsExt = QaPublisherDeps & {
  /** Injected sleep between publish polls (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Max getProduct polls after publish. Default 20. */
  publishPollAttempts?: number;
  /** Delay between polls. Default 6000 ms. */
  publishPollIntervalMs?: number;
};

export type DesignerDepsExt = DesignerDeps & {
  /** Settings blocklist, used to drop blocked words from the image prompt. Baseline always applies. */
  blocklist?: string[];
  /** When given, mug/poster art is sized to the Printify print area (shop printSpec is null for them). */
  printify?: PrintifyClient;
};

/**
 * Agents builder's public surface (contract types live in contracts.ts and are exported from src/index.ts).
 * Orchestrator: `createAgentRegistry()`, optional extra deps (extensions.ts), and PrintifyProductPendingError.
 * Desk: `marginFor` / `minPriceEur` for the margin estimate.
 */
export { createAgentRegistry } from './registry.ts';
export type { DesignerDepsExt, FxDeps, ListingWriterDepsExt, NicheValidatorDepsExt, QaPublisherDepsExt } from './extensions.ts';
export {
  DEFAULT_EUR_TO_USD,
  applyPriceRules,
  costBasisFromCatalog,
  finalizePrice,
  marginFor,
  minPriceEur,
  roundUpTo99,
  variantPrices,
  type MarginBreakdown,
  type UnitCostUsd,
} from './pricing.ts';
export { PrintifyProductPendingError } from './qaPublisher.ts';
export { BASELINE_BLOCKLIST, containsTerm, effectiveBlocklist, normalizeText, sameTerm } from './rules.ts';

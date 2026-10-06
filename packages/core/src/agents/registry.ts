/**
 * The seven agents. Each is a pure async function (input, deps) -> { output, llmUsage }:
 * no DB access, no clock, every external write done by code (never by the model).
 */
import type { AgentRegistry } from './contracts.ts';
import { runAnalyst } from './analyst.ts';
import { runComplianceGuard } from './complianceGuard.ts';
import { runDesigner } from './designer.ts';
import { runListingWriter } from './listingWriter.ts';
import { runNicheValidator } from './nicheValidator.ts';
import { runQaPublisher } from './qaPublisher.ts';
import { runTrendScout } from './trendScout.ts';

export function createAgentRegistry(): AgentRegistry {
  return {
    trendScout: runTrendScout,
    nicheValidator: runNicheValidator,
    complianceGuard: runComplianceGuard,
    designer: runDesigner,
    listingWriter: runListingWriter,
    qaPublisher: runQaPublisher,
    analyst: runAnalyst,
  };
}

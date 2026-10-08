/**
 * The model size each agent's text calls ask for. LLM_TIERS (env) overrides it per agent; calls with images always
 * use the provider's vision model. `check-cloud` prints the resulting agent -> model map.
 *  - large: judgement and decisions (trend reading, niche go/no-go, compliance, listing copy, weekly analysis)
 *  - small: high-volume, tightly specified work (image prompts, the QA checklist)
 */
import type { ModelTier } from '../config/env.ts';
import type { AgentName } from '../domain/types.ts';

export const AGENT_DEFAULT_TIERS: Readonly<Record<AgentName, ModelTier>> = {
  trend_scout: 'large',
  niche_validator: 'large',
  compliance_guard: 'large',
  designer: 'small',
  listing_writer: 'large',
  qa_publisher: 'small',
  analyst: 'large',
};

/** The tier `agent`'s text calls use with this configuration. */
export function tierFor(env: { LLM_TIERS: Partial<Record<string, ModelTier>> }, agent: AgentName): ModelTier {
  return env.LLM_TIERS[agent] ?? AGENT_DEFAULT_TIERS[agent];
}

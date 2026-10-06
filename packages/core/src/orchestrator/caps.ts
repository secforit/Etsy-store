/**
 * Caps checked BEFORE every job claim:
 *  - settings.paused: nothing runs
 *  - daily draft cap: `qa_publish` (the step that creates an Etsy draft) waits until the next UTC day
 *  - daily spend cap: jobs whose agent is routed to a CLOUD model wait until the next UTC day. Local Ollama calls
 *    are recorded with cost 0, so they never move the spend total and local jobs are never held back.
 * Gated jobs simply stay queued; they are not claimed, so they do not use up attempts.
 */
import type { Queryable } from '../db/db.ts';
import { AGENT_NAMES, JOB_KINDS, type AgentName, type JobKind, type Settings } from '../domain/types.ts';
import { countDraftsSince, getSettings, spendSince } from './repo.ts';
import { startOfUtcDay } from './time.ts';

/** The agent each job kind runs (for spend gating and agent_runs). */
export const AGENT_FOR_JOB: Readonly<Record<JobKind, AgentName>> = {
  trend_scan: 'trend_scout',
  validate_niche: 'niche_validator',
  concept_check: 'compliance_guard',
  design: 'designer',
  write: 'listing_writer',
  final_check: 'compliance_guard',
  qa_publish: 'qa_publisher',
  analyze: 'analyst',
};

/** Job kinds that create Etsy drafts (held back by the daily draft cap). */
export const DRAFT_CREATING_KINDS: readonly JobKind[] = ['qa_publish'];

export interface CapStatus {
  settings: Settings;
  paused: boolean;
  draftsToday: number;
  draftCapReached: boolean;
  spendTodayUsd: number;
  spendCapReached: boolean;
  /** Kinds that must not be claimed right now. */
  excludedKinds: JobKind[];
}

/**
 * @param cloudAgents agents whose LLM route is a cloud provider (from LLM_ROUTES / LLM_DEFAULT_PROVIDER).
 */
export async function checkCaps(q: Queryable, now: Date, cloudAgents: readonly AgentName[]): Promise<CapStatus> {
  const settings = await getSettings(q);
  const dayStart = startOfUtcDay(now);
  const [draftsToday, spendTodayUsd] = await Promise.all([countDraftsSince(q, dayStart), spendSince(q, dayStart)]);
  const draftCapReached = draftsToday >= settings.dailyDraftCap;
  const spendCapReached = spendTodayUsd >= settings.dailySpendCapUsd;
  const excluded = new Set<JobKind>();
  if (draftCapReached) for (const k of DRAFT_CREATING_KINDS) excluded.add(k);
  if (spendCapReached) {
    for (const k of JOB_KINDS) if (cloudAgents.includes(AGENT_FOR_JOB[k])) excluded.add(k);
  }
  return {
    settings,
    paused: settings.paused,
    draftsToday,
    draftCapReached,
    spendTodayUsd,
    spendCapReached,
    excludedKinds: [...excluded],
  };
}

/** Agents routed to a cloud provider for the given routing config (mirrors llm/router.ts selection). */
export function cloudAgentsFor(env: {
  MODE: 'mock' | 'live';
  LLM_DEFAULT_PROVIDER: 'ollama' | 'anthropic';
  LLM_ROUTES: Record<string, 'ollama' | 'anthropic'>;
}): AgentName[] {
  if (env.MODE === 'mock') return [];
  return AGENT_NAMES.filter((a) => (env.LLM_ROUTES[a] ?? env.LLM_DEFAULT_PROVIDER) === 'anthropic');
}

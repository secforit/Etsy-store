/**
 * STUB written by the foundation. OWNER: orchestrator builder — replace the bodies, keep the signatures.
 * The desk app imports ONLY these two functions plus the types in ./contracts.ts.
 */
import type { Env } from '../config/env.ts';
import type { OrchestratorDeps } from '../orchestrator/contracts.ts';
import type { DeskService } from './contracts.ts';

export function createDeskService(deps: OrchestratorDeps): DeskService {
  void deps;
  throw new Error('createDeskService: not implemented yet');
}

/** Builds db + integrations + llm + agents from the environment and returns a ready DeskService (cached per process). */
export async function createDeskServiceFromEnv(env: Env): Promise<DeskService> {
  void env;
  throw new Error('createDeskServiceFromEnv: not implemented yet');
}

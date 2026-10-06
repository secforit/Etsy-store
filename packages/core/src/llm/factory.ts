/**
 * STUB written by the foundation. OWNER: agents builder — replace the body, keep the signature.
 * MODE=mock -> MockLlm (deterministic, offline). MODE=live -> Anthropic client.
 */
import type { Env } from '../config/env.ts';
import type { LlmClient } from './types.ts';

export function createLlm(env: Env): LlmClient {
  void env;
  throw new Error('createLlm: not implemented yet');
}

/**
 * STUB written by the foundation. OWNER: agents builder — replace the body, keep the signature.
 * MODE=mock -> MockLlm (deterministic, offline).
 * MODE=live -> RoutedLlm: per agent, env.LLM_ROUTES[agent] ?? env.LLM_DEFAULT_PROVIDER picks
 *              OllamaLlm (local GPU, default) or AnthropicLlm. Ollama calls run inside gpu.withGpu('llm', ...).
 */
import type { Env } from '../config/env.ts';
import type { GpuCoordinator } from '../integrations/types.ts';
import type { LlmClient } from './types.ts';

export function createLlm(env: Env, opts: { gpu: GpuCoordinator }): LlmClient {
  void env;
  void opts;
  throw new Error('createLlm: not implemented yet');
}

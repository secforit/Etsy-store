/**
 * RoutedLlm: picks the provider per agent from env.LLM_ROUTES[agent] ?? env.LLM_DEFAULT_PROVIDER, and the model
 * size from env.LLM_TIERS[agent] ?? the tier the agent asks for.
 * Default for every agent: 'ollama' (local GPU); 'anthropic' and 'nous' are cloud APIs.
 */
import type { LlmProviderName, ModelTier } from '../config/env.ts';
import type { AgentName } from '../domain/types.ts';
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from './types.ts';

export type LlmProvider = LlmProviderName;

export interface RoutedLlmOptions {
  providers: Partial<Record<LlmProvider, LlmClient>>;
  routes: Partial<Record<string, LlmProvider>>;
  defaultProvider: LlmProvider;
  /** Per-agent model size override (LLM_TIERS). */
  tiers?: Partial<Record<string, ModelTier>>;
}

export class RoutedLlm implements LlmClient {
  constructor(private readonly opts: RoutedLlmOptions) {}

  providerFor(agent: AgentName): LlmProvider {
    return this.opts.routes[agent] ?? this.opts.defaultProvider;
  }

  generate<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    const provider = this.providerFor(req.agent);
    const client = this.opts.providers[provider];
    if (!client) {
      return Promise.reject(new LlmError(`LLM provider '${provider}' (agent ${req.agent}) is not configured`, false));
    }
    const tier = this.opts.tiers?.[req.agent];
    return client.generate(tier && tier !== req.tier ? { ...req, tier } : req);
  }
}

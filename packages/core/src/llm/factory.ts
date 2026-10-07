/**
 * createLlm(env, { gpu }):
 *  - MODE=mock -> MockLlm (deterministic, offline; calls still go through gpu.withGpu('llm', ...)).
 *  - MODE=live -> RoutedLlm: per agent, env.LLM_ROUTES[agent] ?? env.LLM_DEFAULT_PROVIDER picks
 *    OllamaLlm (local GPU, default; every call inside gpu.withGpu('llm', ...)) or AnthropicLlm (optional cloud).
 * Optional extras (all backwards compatible): logger, fetch (tests), prices (else LLM_PRICES_JSON from process env).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../config/env.ts';
import { AGENT_NAMES } from '../domain/types.ts';
import type { GpuCoordinator } from '../integrations/types.ts';
import { AnthropicLlm } from './anthropic.ts';
import { silentLogger, type LlmLogger } from './errors.ts';
import { MockLlm } from './mock.ts';
import { OllamaLlm } from './ollama.ts';
import { loadLlmPrices, type LlmPriceTable } from './prices.ts';
import { RoutedLlm, type LlmProvider } from './router.ts';
import type { LlmClient } from './types.ts';

export interface CreateLlmOptions {
  gpu: GpuCoordinator;
  logger?: LlmLogger;
  fetch?: typeof fetch;
  prices?: LlmPriceTable;
}

export function createLlm(env: Env, opts: CreateLlmOptions): LlmClient {
  if (env.MODE === 'mock') return new MockLlm(opts.gpu);
  const logger = opts.logger ?? silentLogger;

  const routes = env.LLM_ROUTES as Record<string, LlmProvider>;
  for (const key of Object.keys(routes)) {
    if (!(AGENT_NAMES as readonly string[]).includes(key)) logger.warn({ route: key }, 'LLM_ROUTES has a key that is not an agent name; it is ignored');
  }

  const providers: Partial<Record<LlmProvider, LlmClient>> = {
    ollama: new OllamaLlm({
      baseUrl: env.OLLAMA_BASE_URL,
      models: { large: env.OLLAMA_MODEL_LARGE, small: env.OLLAMA_MODEL_SMALL, vision: env.OLLAMA_MODEL_VISION },
      numCtx: env.OLLAMA_NUM_CTX,
      gpu: opts.gpu,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      logger,
    }),
  };

  const usesAnthropic = env.LLM_DEFAULT_PROVIDER === 'anthropic' || Object.values(routes).includes('anthropic');
  if (usesAnthropic) {
    if (!env.ANTHROPIC_API_KEY || !env.ANTHROPIC_MODEL_LARGE || !env.ANTHROPIC_MODEL_SMALL) {
      throw new Error('LLM routing uses anthropic but ANTHROPIC_API_KEY / ANTHROPIC_MODEL_LARGE / ANTHROPIC_MODEL_SMALL are not all set');
    }
    providers.anthropic = new AnthropicLlm({
      client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 }),
      models: { large: env.ANTHROPIC_MODEL_LARGE, small: env.ANTHROPIC_MODEL_SMALL },
      prices: opts.prices ?? loadLlmPrices(),
      logger,
    });
  }

  return new RoutedLlm({ providers, routes, defaultProvider: env.LLM_DEFAULT_PROVIDER });
}

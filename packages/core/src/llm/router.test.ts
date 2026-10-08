import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadEnv } from '../config/env.ts';
import { FakeGpu } from '../agents/testing/fakes.ts';
import { createLlm } from './factory.ts';
import { MockLlm } from './mock.ts';
import { RoutedLlm } from './router.ts';
import { LlmError, type LlmClient, type LlmRequest } from './types.ts';

const Schema = z.object({ ok: z.boolean() });
const req = (agent: LlmRequest<unknown>['agent']): LlmRequest<{ ok: boolean }> => ({
  agent,
  tier: 'large',
  system: 's',
  instructions: 'i',
  schema: Schema,
});

function named(name: string, seen: string[], tiers: string[] = []): LlmClient {
  return {
    async generate<T>(r: LlmRequest<T>) {
      seen.push(`${name}:${r.agent}`);
      tiers.push(`${r.agent}:${r.tier}`);
      return { output: { ok: true } as T, usage: { model: name, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 } };
    },
  };
}

describe('RoutedLlm', () => {
  it('routes per agent from LLM_ROUTES and falls back to the default provider', async () => {
    const seen: string[] = [];
    const llm = new RoutedLlm({
      providers: { ollama: named('ollama', seen), anthropic: named('anthropic', seen) },
      routes: { compliance_guard: 'anthropic' },
      defaultProvider: 'ollama',
    });
    await llm.generate(req('compliance_guard'));
    await llm.generate(req('designer'));
    await llm.generate(req('trend_scout'));
    expect(seen).toEqual(['anthropic:compliance_guard', 'ollama:designer', 'ollama:trend_scout']);
    expect(llm.providerFor('analyst')).toBe('ollama');
  });

  it('overrides the model size per agent from LLM_TIERS, leaving the others on the tier they ask for', async () => {
    const tiers: string[] = [];
    const llm = new RoutedLlm({
      providers: { nous: named('nous', [], tiers) },
      routes: {},
      defaultProvider: 'nous',
      tiers: { trend_scout: 'small', designer: 'large' },
    });
    const original = req('trend_scout');
    await llm.generate(original);
    await llm.generate({ ...req('designer'), tier: 'small' });
    await llm.generate(req('niche_validator'));
    expect(tiers).toEqual(['trend_scout:small', 'designer:large', 'niche_validator:large']);
    expect(original.tier).toBe('large'); // the caller's request is not mutated
  });

  it('fails clearly when the routed provider is not configured', async () => {
    const llm = new RoutedLlm({ providers: { ollama: named('ollama', []) }, routes: { analyst: 'anthropic' }, defaultProvider: 'ollama' });
    const err = await llm.generate(req('analyst')).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.retryable).toBe(false);
  });
});

const liveBase = {
  MODE: 'live',
  DATABASE_URL: 'postgres://u:p@postgres/db',
  ETSY_API_KEY: 'k',
  ETSY_SHOP_ID: '1',
  ETSY_REFRESH_TOKEN: 'r',
  PRINTIFY_API_TOKEN: 't',
  PRINTIFY_SHOP_ID: '2',
  MARKER_API_USERNAME: 'u',
  MARKER_API_PASSWORD: 'p',
  IMAGEGEN_TOKEN: 'x'.repeat(32),
};

describe('createLlm', () => {
  it('returns MockLlm in mock mode', () => {
    expect(createLlm(loadEnv({ MODE: 'mock' }), { gpu: new FakeGpu() })).toBeInstanceOf(MockLlm);
  });

  it('live mode defaults every agent to local Ollama with gemma4:12b inside withGpu', async () => {
    const gpu = new FakeGpu();
    const bodies: any[] = [];
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ message: { content: '{"ok":true}' }, prompt_eval_count: 1, eval_count: 1, total_duration: 1e6 }));
    });
    const env = loadEnv({ ...liveBase });
    const llm = createLlm(env, { gpu, fetch: fetchFn as unknown as typeof fetch });
    expect(llm).toBeInstanceOf(RoutedLlm);
    const res = await llm.generate(req('trend_scout'));
    expect(res.output).toEqual({ ok: true });
    expect(res.usage.costUsd).toBe(0);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe('http://ollama:11434/api/chat');
    expect(bodies[0].model).toBe('gemma4:12b');
    expect(bodies[0].options.num_ctx).toBe(16384);
    expect(gpu.owners).toEqual(['llm']);
  });

  it('builds the Anthropic provider only when a route needs it, and requires its config', () => {
    const env = loadEnv({ ...liveBase, LLM_ROUTES: '{"compliance_guard":"anthropic"}', ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_MODEL_LARGE: 'm-l', ANTHROPIC_MODEL_SMALL: 'm-s' });
    const llm = createLlm(env, { gpu: new FakeGpu(), prices: {} }) as RoutedLlm;
    expect(llm.providerFor('compliance_guard')).toBe('anthropic');
    expect(llm.providerFor('designer')).toBe('ollama');

    const broken = { ...env, ANTHROPIC_API_KEY: undefined };
    expect(() => createLlm(broken, { gpu: new FakeGpu(), prices: {} })).toThrow(/ANTHROPIC/);
  });

  it('all-Nous: decision agents on the large model, LLM_TIERS moves workload agents to the small one', async () => {
    const models: string[] = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }));
      models.push(JSON.parse(String(init?.body)).model);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    const env = loadEnv({
      ...liveBase,
      IMAGEGEN_TOKEN: undefined,
      IMAGEGEN_PROVIDER: 'fal',
      FAL_KEY: 'fal-test',
      LLM_DEFAULT_PROVIDER: 'nous',
      NOUS_API_KEY: 'nous-test',
      NOUS_MODEL_LARGE: 'deepseek/deepseek-v4-pro',
      NOUS_MODEL_SMALL: 'deepseek/deepseek-v4-flash',
      NOUS_MODEL_VISION: 'vendor/vision',
      LLM_TIERS: '{"trend_scout":"small","listing_writer":"small"}',
    });
    const prices = { 'deepseek/deepseek-v4-pro': { inputPerMTokUsd: 1, outputPerMTokUsd: 2 }, 'deepseek/deepseek-v4-flash': { inputPerMTokUsd: 0.1, outputPerMTokUsd: 0.2 } };
    const llm = createLlm(env, { gpu: new FakeGpu(), prices, fetch: fetchFn as unknown as typeof fetch });
    for (const agent of ['trend_scout', 'listing_writer', 'niche_validator', 'analyst'] as const) await llm.generate(req(agent));
    expect(models).toEqual(['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro']);
  });

  it('rejects an LLM_TIERS value that is not large or small', () => {
    expect(() => loadEnv({ MODE: 'mock', LLM_TIERS: '{"trend_scout":"tiny"}' })).toThrow(/LLM_TIERS/);
    expect(() => loadEnv({ MODE: 'mock', LLM_TIERS: 'not json' })).toThrow(/LLM_TIERS/);
  });
});

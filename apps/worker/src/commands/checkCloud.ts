/**
 * `check-cloud`: checks the cloud providers this configuration uses before they are needed.
 *  - Nous (any agent routed to 'nous'): the key opens the Portal catalog (GET /models); each NOUS_MODEL_* exists
 *    there and has a price (else calls are billed at the conservative fallback rate); NOUS_MODEL_VISION accepts
 *    images. Lists image-capable models when the vision model is missing or text-only.
 *  - fal (IMAGEGEN_PROVIDER=fal): FAL_KEY is set and the per-call prices the spend cap uses. fal has no free call to
 *    validate a key, so the first design job is the real test.
 *  - Which model each agent uses (provider, LLM_TIERS / built-in tier, vision model for image checks).
 * Never prints a key.
 */
import { VISION_AGENTS, llmProviderFor, usesLlmProvider, type Env } from '@etsy-agents/core/config/env.ts';
import { AGENT_NAMES } from '@etsy-agents/core/domain/types.ts';
import { NousCatalog, type NousModelInfo } from '@etsy-agents/core/llm/nousCatalog.ts';
import { tierFor } from '@etsy-agents/core/llm/tiers.ts';
import type { OrchestratorEnv } from '@etsy-agents/core/orchestrator/config.ts';
import type { Io } from '../io.ts';

type FetchLike = typeof fetch;

export interface NousModelCheck {
  role: 'large' | 'small' | 'vision';
  id: string;
  found: boolean;
  price: NousModelInfo['price'];
  acceptsImages: boolean | null;
  ok: boolean;
}

export interface CloudCheckResult {
  ok: boolean;
  nous: { used: boolean; error: string | null; models: NousModelCheck[]; visionCandidates: string[] };
  fal: { used: boolean; keySet: boolean };
}

export async function checkCloud(env: Env, fetchImpl: FetchLike = fetch): Promise<CloudCheckResult> {
  const result: CloudCheckResult = {
    ok: true,
    nous: { used: usesLlmProvider(env, 'nous'), error: null, models: [], visionCandidates: [] },
    fal: { used: env.IMAGEGEN_PROVIDER === 'fal', keySet: Boolean(env.FAL_KEY) },
  };

  if (result.nous.used) {
    const needsVision = VISION_AGENTS.some((a) => llmProviderFor(env, a) === 'nous');
    const wanted: { role: NousModelCheck['role']; id: string | undefined }[] = [
      { role: 'large', id: env.NOUS_MODEL_LARGE },
      { role: 'small', id: env.NOUS_MODEL_SMALL },
      ...(needsVision || env.NOUS_MODEL_VISION ? [{ role: 'vision' as const, id: env.NOUS_MODEL_VISION }] : []),
    ];
    if (!env.NOUS_API_KEY) {
      result.nous.error = 'NOUS_API_KEY is not set (.env.worker)';
    } else {
      try {
        const catalog = await new NousCatalog({ baseUrl: env.NOUS_BASE_URL, apiKey: env.NOUS_API_KEY, fetch: fetchImpl }).models();
        for (const w of wanted) {
          if (!w.id) {
            result.nous.models.push({ role: w.role, id: '', found: false, price: null, acceptsImages: null, ok: false });
            continue;
          }
          const m = catalog.get(w.id);
          const imagesOk = w.role !== 'vision' || m?.acceptsImages !== false;
          result.nous.models.push({ role: w.role, id: w.id, found: Boolean(m), price: m?.price ?? null, acceptsImages: m?.acceptsImages ?? null, ok: Boolean(m) && imagesOk });
        }
        const vision = result.nous.models.find((m) => m.role === 'vision');
        if (vision && !vision.ok) {
          result.nous.visionCandidates = [...catalog.values()].filter((m) => m.acceptsImages === true).map((m) => m.id).sort().slice(0, 15);
        }
      } catch (err) {
        result.nous.error = String((err as Error)?.message ?? err).slice(0, 200);
      }
    }
    if (result.nous.error || result.nous.models.some((m) => !m.ok)) result.ok = false;
  }

  if (result.fal.used && !result.fal.keySet) result.ok = false;
  return result;
}

/** The model id a provider uses for a tier ('' when not configured). */
function modelId(env: Env, provider: string, role: 'large' | 'small' | 'vision'): string {
  const ids: Record<string, Record<typeof role, string | undefined>> = {
    nous: { large: env.NOUS_MODEL_LARGE, small: env.NOUS_MODEL_SMALL, vision: env.NOUS_MODEL_VISION },
    ollama: { large: env.OLLAMA_MODEL_LARGE, small: env.OLLAMA_MODEL_SMALL, vision: env.OLLAMA_MODEL_VISION },
    anthropic: { large: env.ANTHROPIC_MODEL_LARGE, small: env.ANTHROPIC_MODEL_SMALL, vision: env.ANTHROPIC_MODEL_LARGE },
  };
  return ids[provider]?.[role] ?? '';
}

/** One line per agent: provider, tier and model id (plus the vision model for agents that send images). */
export function agentModelLines(env: Env): string[] {
  return AGENT_NAMES.map((agent) => {
    const provider = llmProviderFor(env, agent);
    const tier = tierFor(env, agent);
    const vision = (VISION_AGENTS as readonly string[]).includes(agent) ? `; images: ${modelId(env, provider, 'vision') || '(not set)'}` : '';
    return `  ${agent.padEnd(16)} ${provider} ${tier.padEnd(5)} ${modelId(env, provider, tier) || '(not set)'}${vision}`;
  });
}

const usdPerM = (p: NonNullable<NousModelInfo['price']>) => `$${p.inputPerMTokUsd} in / $${p.outputPerMTokUsd} out per M tokens`;

export function printCloudCheck(io: Io, env: Env, settings: Pick<OrchestratorEnv, 'FAL_COST_PER_IMAGE_USD' | 'FAL_COST_PER_BACKGROUND_REMOVAL_USD' | 'FAL_COST_PER_UPSCALE_USD'>, r: CloudCheckResult): void {
  if (!r.nous.used) {
    io.out(`Nous     : not used (LLM_DEFAULT_PROVIDER=${env.LLM_DEFAULT_PROVIDER})`);
  } else if (r.nous.error) {
    io.out(`Nous     ${env.NOUS_BASE_URL}: NOT ready (${r.nous.error})`);
  } else {
    io.out(`Nous     ${env.NOUS_BASE_URL}: key accepted`);
    for (const m of r.nous.models) {
      const name = `  ${m.role.padEnd(6)} ${m.id || '(NOUS_MODEL_' + m.role.toUpperCase() + ' not set)'}`;
      if (!m.id) io.out(`${name}: MISSING, set it in .env.worker`);
      else if (!m.found) io.out(`${name}: NOT in your Portal catalog (check the id)`);
      else if (m.role === 'vision' && m.acceptsImages === false) io.out(`${name}: does NOT accept images`);
      else {
        const price = m.price ? usdPerM(m.price) : 'no price in the catalog: billed at the conservative fallback rate (set LLM_PRICES_JSON)';
        const images = m.role === 'vision' && m.acceptsImages === null ? ' (the catalog does not say whether it accepts images)' : '';
        io.out(`${name}: ok, ${price}${images}`);
      }
    }
    if (r.nous.visionCandidates.length) io.out(`  image-capable models in your catalog: ${r.nous.visionCandidates.join(', ')}`);
  }

  if (!r.fal.used) {
    io.out(`fal      : not used (IMAGEGEN_PROVIDER=${env.IMAGEGEN_PROVIDER})`);
  } else if (!r.fal.keySet) {
    io.out('fal      : NOT ready (FAL_KEY is not set in .env.worker)');
  } else {
    io.out(
      `fal      : FAL_KEY set (fal has no free key check; the first design job is the real test). Spend cap counts ` +
        `$${settings.FAL_COST_PER_IMAGE_USD} per image, $${settings.FAL_COST_PER_BACKGROUND_REMOVAL_USD} per background removal, ` +
        `$${settings.FAL_COST_PER_UPSCALE_USD} per upscale`,
    );
  }
  io.out('Agents (LLM_ROUTES / LLM_TIERS):');
  for (const line of agentModelLines(env)) io.out(line);
  io.out(r.ok ? 'Cloud providers: READY' : 'Cloud providers: NOT READY');
}

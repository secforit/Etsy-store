/**
 * Orchestrator / worker settings that are not secrets and not part of config/env.ts (a contract file).
 * Read from the raw process environment; every key is optional with a safe default and documented in
 * .env.example.
 */
import { z } from 'zod';
import { usesLlmProvider, type LlmProviderName } from '../config/env.ts';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const OrchestratorEnvSchema = z.object({
  /** USD per 1 EUR, used to price Printify variants (USD) from EUR listing prices. Config, not live FX. */
  EUR_TO_USD: z.preprocess(emptyToUndefined, z.coerce.number().min(0.5).max(3).default(1.1)),
  /** Worker sleep between polls when there is nothing to do. */
  WORKER_POLL_INTERVAL_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(250).max(600_000).default(5000)),
  /** UTC hour at which the daily trend scan becomes due. */
  TREND_SCAN_HOUR_UTC: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(23).default(4)),
  /** The analyst (LLM report + retirements + follow-ups) runs at most this often; metrics are pulled hourly. */
  ANALYST_REPORT_INTERVAL_HOURS: z.preprocess(emptyToUndefined, z.coerce.number().min(1).max(168).default(24)),
  /**
   * File the worker touches every 30 s; the container healthcheck reads its age. (Not named *_FILE on purpose:
   * loadEnv reads every FOO_FILE variable as a Docker secret file.)
   */
  WORKER_HEARTBEAT_PATH: z.preprocess(emptyToUndefined, z.string().min(1).default('/tmp/worker-heartbeat')),
  /**
   * Only for the optional cloud image fallback (IMAGEGEN_PROVIDER=recraft): USD charged per generated image
   * (generation + background removal). Recorded in agent_runs so the daily cloud spend cap sees it.
   * Local FLUX.2 klein images cost 0. Set it to your Recraft plan's price.
   */
  RECRAFT_COST_PER_IMAGE_USD: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(10).default(0.08)),
  /**
   * IMAGEGEN_PROVIDER=fal: USD per call, recorded in agent_runs so the daily cloud spend cap sees them. The
   * defaults are deliberately above fal's list prices (over-counting only pauses cloud jobs early); set them to
   * the prices on your fal account for accurate cost-per-listing numbers.
   */
  FAL_COST_PER_IMAGE_USD: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(10).default(0.02)),
  FAL_COST_PER_BACKGROUND_REMOVAL_USD: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(10).default(0.01)),
  FAL_COST_PER_UPSCALE_USD: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(10).default(0.02)),
});

export type OrchestratorEnv = z.infer<typeof OrchestratorEnvSchema>;

/** Keys (and key families) defined by config/env.ts. Only these may be filled from a FOO_FILE Docker secret. */
const CORE_ENV_KEY_RE =
  /^(?:MODE|LOG_LEVEL|DATABASE_URL|PGLITE_DIR|STORAGE_DIR|(?:LLM|OLLAMA|ANTHROPIC|NOUS|IMAGEGEN|ETSY|PRINTIFY|MARKER|RECRAFT|FAL|IDEOGRAM|PINTEREST|DESK)_[A-Z0-9_]+)$/;

/**
 * Copy of the environment for loadEnv() without unrelated *_FILE variables. loadEnv reads EVERY FOO_FILE as a
 * secret file, so a variable such as SSL_CERT_FILE from a base image (or a missing file it names) would make the
 * whole configuration invalid. Same rule as the desk's lib/envScope.ts.
 */
export function scopeEnvForLoad(source: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.endsWith('_FILE')) {
      const target = key.slice(0, -'_FILE'.length);
      if (!CORE_ENV_KEY_RE.test(target) || target.endsWith('_FILE')) continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Cloud models whose price is missing from LLM_PRICES_JSON. Unknown models are billed as $0 by the LLM client,
 * which would let them run past the daily spend cap, so the worker warns about them at start-up.
 */
export function cloudModelsWithoutPrice(
  env: {
    MODE: 'mock' | 'live';
    LLM_DEFAULT_PROVIDER: LlmProviderName;
    LLM_ROUTES: Record<string, LlmProviderName>;
    ANTHROPIC_MODEL_LARGE?: string | undefined;
    ANTHROPIC_MODEL_SMALL?: string | undefined;
  },
  raw: Record<string, string | undefined>,
): string[] {
  // Nous models are priced from the Portal's own catalog at run time (llm/nousPrices.ts), so only Anthropic
  // model ids need an entry here.
  if (env.MODE !== 'live') return [];
  if (!usesLlmProvider(env, 'anthropic')) return [];
  let table: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw.LLM_PRICES_JSON ? JSON.parse(raw.LLM_PRICES_JSON) : {};
    if (parsed && typeof parsed === 'object') table = parsed as Record<string, unknown>;
  } catch {
    table = {};
  }
  const models = [env.ANTHROPIC_MODEL_LARGE, env.ANTHROPIC_MODEL_SMALL].filter((m): m is string => Boolean(m));
  return [...new Set(models)].filter((m) => !(m in table));
}

export function loadOrchestratorEnv(source: Record<string, string | undefined> = process.env): OrchestratorEnv {
  const parsed = OrchestratorEnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid worker settings: ${problems}`);
  }
  return parsed.data;
}

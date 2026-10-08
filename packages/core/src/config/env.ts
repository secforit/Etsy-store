/**
 * Environment loading and validation. Secrets come ONLY from the environment (or Docker secrets
 * mounted as files via the *_FILE convention). Never log the returned object.
 * CONTRACT FILE: owned by the foundation. Builders may add optional keys at the end.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

/** Where each agent's LLM calls go. `ollama` is local (GPU, $0); `anthropic` and `nous` are cloud APIs (paid). */
export const LLM_PROVIDERS = ['ollama', 'anthropic', 'nous'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];
export const CLOUD_LLM_PROVIDERS: readonly LlmProviderName[] = ['anthropic', 'nous'];

/** Where design art comes from. `local` is the imagegen GPU sidecar; `recraft` and `fal` are cloud APIs (paid). */
export const IMAGEGEN_PROVIDERS = ['local', 'recraft', 'fal'] as const;
export type ImagegenProviderName = (typeof IMAGEGEN_PROVIDERS)[number];

/** Model sizes an agent's text calls can use (each provider maps them to its *_MODEL_LARGE / *_MODEL_SMALL). */
export const MODEL_TIERS = ['large', 'small'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

const EnvObjectSchema = z
  .object({
    MODE: z.enum(['mock', 'live']).default('mock'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    /** Postgres URL. Unset in mock mode = in-process PGlite (PGLITE_DIR or in-memory). */
    DATABASE_URL: nonEmpty.optional(),
    PGLITE_DIR: nonEmpty.optional(),
    /** Root directory for blob storage (designs, print files, mockups). */
    STORAGE_DIR: nonEmpty.default('./data/blobs'),

    /**
     * LLM routing. Default: every agent runs on the local Ollama server on Razvan's RTX 3060.
     * LLM_ROUTES overrides per agent, e.g. {"compliance_guard":"anthropic"}.
     */
    LLM_DEFAULT_PROVIDER: z.enum(LLM_PROVIDERS).default('ollama'),
    LLM_ROUTES: z
      .string()
      .optional()
      .transform((s, ctx) => {
        if (!s) return {} as Record<string, LlmProviderName>;
        try {
          const parsed = z.record(z.string(), z.enum(LLM_PROVIDERS)).parse(JSON.parse(s));
          return parsed;
        } catch {
          ctx.addIssue({ code: 'custom', message: `LLM_ROUTES must be JSON like {"compliance_guard":"nous"} (providers: ${LLM_PROVIDERS.join(', ')})` });
          return z.NEVER;
        }
      }),

    /** Local models (Ollama, GPU). Apache-2.0 models that fit 12 GB VRAM; see docs/MODELS.md. */
    OLLAMA_BASE_URL: z.url().default('http://ollama:11434'),
    OLLAMA_MODEL_LARGE: nonEmpty.default('gemma4:12b'),
    OLLAMA_MODEL_SMALL: nonEmpty.default('gemma4:12b'),
    OLLAMA_MODEL_VISION: nonEmpty.default('gemma4:12b'),
    /** Context window requested from Ollama; 16k keeps gemma4:12b around 8 GB VRAM. */
    OLLAMA_NUM_CTX: z.coerce.number().int().min(2048).max(262144).default(16384),

    ANTHROPIC_API_KEY: nonEmpty.optional(),
    /** Only needed when a route uses 'anthropic'. Model ids are configuration, not code. */
    ANTHROPIC_MODEL_LARGE: nonEmpty.optional(),
    ANTHROPIC_MODEL_SMALL: nonEmpty.optional(),

    /** Image generation: 'local' = the imagegen GPU sidecar (FLUX.2 klein 4B + BiRefNet + Real-ESRGAN). */
    IMAGEGEN_PROVIDER: z.enum(IMAGEGEN_PROVIDERS).default('local'),
    IMAGEGEN_BASE_URL: z.url().default('http://imagegen:8000'),
    /** Shared secret the worker sends to the imagegen sidecar (internal network, defence in depth). */
    IMAGEGEN_TOKEN: z.string().min(24).optional(),

    ETSY_API_KEY: nonEmpty.optional(),
    ETSY_SHARED_SECRET: nonEmpty.optional(),
    ETSY_SHOP_ID: nonEmpty.optional(),
    ETSY_REFRESH_TOKEN: nonEmpty.optional(),

    PRINTIFY_API_TOKEN: nonEmpty.optional(),
    PRINTIFY_SHOP_ID: nonEmpty.optional(),

    MARKER_API_USERNAME: nonEmpty.optional(),
    MARKER_API_PASSWORD: nonEmpty.optional(),

    RECRAFT_API_KEY: nonEmpty.optional(),
    IDEOGRAM_API_KEY: nonEmpty.optional(),
    PINTEREST_ACCESS_TOKEN: nonEmpty.optional(),

    /** Approval desk: scrypt hash of Razvan's password, and a >=32 byte session secret. */
    DESK_PASSWORD_HASH: nonEmpty.optional(),
    DESK_SESSION_SECRET: z.string().min(32).optional(),
    /** The desk's public origin, e.g. https://secforit-home.<tailnet>.ts.net (served over Tailscale). */
    DESK_ORIGIN: z.url().optional(),

    /**
     * Nous Research inference API (Nous Portal; OpenAI-compatible, open models). Only needed when an agent routes
     * to 'nous'. Model ids are the Portal's (`<vendor>/<model>`); `check-cloud` lists the ones your key can use.
     */
    NOUS_API_KEY: nonEmpty.optional(),
    NOUS_BASE_URL: z.url().default('https://inference-api.nousresearch.com/v1'),
    NOUS_MODEL_LARGE: nonEmpty.optional(),
    NOUS_MODEL_SMALL: nonEmpty.optional(),
    /** Must accept images: the Compliance Guard (final look) and QA (mockups) send them. */
    NOUS_MODEL_VISION: nonEmpty.optional(),

    /** fal.ai (IMAGEGEN_PROVIDER=fal): FLUX.2 [klein] 4B art, BiRefNet backgrounds, Real-ESRGAN upscaling. */
    FAL_KEY: nonEmpty.optional(),

    /**
     * Per-agent model size override, e.g. {"trend_scout":"small"}: which of the provider's *_MODEL_LARGE /
     * *_MODEL_SMALL an agent's text calls use. Unset agents keep their built-in tier. Calls with images always use
     * the vision model.
     */
    LLM_TIERS: z
      .string()
      .optional()
      .transform((s, ctx) => {
        if (!s) return {} as Record<string, ModelTier>;
        try {
          return z.record(z.string(), z.enum(MODEL_TIERS)).parse(JSON.parse(s));
        } catch {
          ctx.addIssue({ code: 'custom', message: `LLM_TIERS must be JSON like {"trend_scout":"small"} (tiers: ${MODEL_TIERS.join(', ')})` });
          return z.NEVER;
        }
      }),
  });

/** The LLM provider that serves `agent` (LLM_ROUTES[agent], else LLM_DEFAULT_PROVIDER). */
export function llmProviderFor(env: Pick<EnvShape, 'LLM_DEFAULT_PROVIDER' | 'LLM_ROUTES'>, agent: string): LlmProviderName {
  return env.LLM_ROUTES[agent] ?? env.LLM_DEFAULT_PROVIDER;
}

/** True when the default or any per-agent route uses `provider`. */
export function usesLlmProvider(env: Pick<EnvShape, 'LLM_DEFAULT_PROVIDER' | 'LLM_ROUTES'>, provider: LlmProviderName): boolean {
  return env.LLM_DEFAULT_PROVIDER === provider || Object.values(env.LLM_ROUTES).includes(provider);
}

/** Agents that send images to their model (final compliance look, QA mockup check). */
export const VISION_AGENTS = ['compliance_guard', 'qa_publisher'] as const;

/**
 * Which process loads the environment (least privilege, see deploy/docker-compose.yml):
 *  - 'all' (default): the worker and its CLI; live mode needs every key the pipeline uses.
 *  - 'desk': the approval desk, which only reads the database and blobs and calls Etsy (approve) and Printify
 *    (catalog). Its container never receives the Marker, imagegen or cloud-LLM keys, so live mode does not ask
 *    for them (orchestrator/runtime.ts builds a desk runtime without those clients).
 *  - 'database': `migrate` only needs DATABASE_URL.
 */
export type EnvScope = 'all' | 'desk' | 'database';

type EnvShape = z.infer<typeof EnvObjectSchema>;

/** Keys that must be set when MODE=live, for the given scope. */
export function requiredLiveKeys(env: EnvShape, scope: EnvScope = 'all'): (keyof EnvShape)[] {
  const required: (keyof EnvShape)[] = ['DATABASE_URL'];
  if (scope === 'database') return required;
  required.push('ETSY_API_KEY', 'ETSY_SHOP_ID', 'ETSY_REFRESH_TOKEN', 'PRINTIFY_API_TOKEN', 'PRINTIFY_SHOP_ID');
  if (scope === 'desk') return required;
  required.push('MARKER_API_USERNAME', 'MARKER_API_PASSWORD');
  if (usesLlmProvider(env, 'anthropic')) required.push('ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL_LARGE', 'ANTHROPIC_MODEL_SMALL');
  if (usesLlmProvider(env, 'nous')) {
    required.push('NOUS_API_KEY', 'NOUS_MODEL_LARGE', 'NOUS_MODEL_SMALL');
    if (VISION_AGENTS.some((a) => llmProviderFor(env, a) === 'nous')) required.push('NOUS_MODEL_VISION');
  }
  if (env.IMAGEGEN_PROVIDER === 'recraft') required.push('RECRAFT_API_KEY');
  if (env.IMAGEGEN_PROVIDER === 'fal') required.push('FAL_KEY');
  if (env.IMAGEGEN_PROVIDER === 'local') required.push('IMAGEGEN_TOKEN');
  return required;
}

function envSchemaFor(scope: EnvScope) {
  return EnvObjectSchema.superRefine((env, ctx) => {
    if (env.MODE !== 'live') return;
    for (const key of requiredLiveKeys(env, scope)) {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when MODE=live` });
    }
  });
}

const EnvSchema = envSchemaFor('all');

export type Env = z.infer<typeof EnvSchema>;

/** Supports Docker secrets: FOO_FILE=/run/secrets/foo is read into FOO. */
function resolveFileVars(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...source };
  for (const [key, value] of Object.entries(source)) {
    if (key.endsWith('_FILE') && value) {
      const target = key.slice(0, -'_FILE'.length);
      if (!out[target]) out[target] = readFileSync(value, 'utf8').trim();
    }
  }
  return out;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env, opts: { scope?: EnvScope } = {}): Env {
  const schema = opts.scope && opts.scope !== 'all' ? envSchemaFor(opts.scope) : EnvSchema;
  const parsed = schema.safeParse(resolveFileVars(source));
  if (!parsed.success) {
    // Report key names only; never echo values.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${problems}`);
  }
  return parsed.data;
}

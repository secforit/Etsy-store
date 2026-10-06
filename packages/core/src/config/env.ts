/**
 * Environment loading and validation. Secrets come ONLY from the environment (or Docker secrets
 * mounted as files via the *_FILE convention). Never log the returned object.
 * CONTRACT FILE: owned by the foundation. Builders may add optional keys at the end.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

const EnvSchema = z
  .object({
    MODE: z.enum(['mock', 'live']).default('mock'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    /** Postgres URL. Unset in mock mode = in-process PGlite (PGLITE_DIR or in-memory). */
    DATABASE_URL: nonEmpty.optional(),
    PGLITE_DIR: nonEmpty.optional(),
    /** Root directory for blob storage (designs, print files, mockups). */
    STORAGE_DIR: nonEmpty.default('./data/blobs'),

    ANTHROPIC_API_KEY: nonEmpty.optional(),
    /** Model ids are configuration, not code: set them to current Claude model ids. */
    ANTHROPIC_MODEL_LARGE: nonEmpty.optional(),
    ANTHROPIC_MODEL_SMALL: nonEmpty.optional(),

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
    DESK_ORIGIN: z.url().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.MODE !== 'live') return;
    const required: (keyof typeof env)[] = [
      'DATABASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL_LARGE',
      'ANTHROPIC_MODEL_SMALL',
      'ETSY_API_KEY',
      'ETSY_SHOP_ID',
      'ETSY_REFRESH_TOKEN',
      'PRINTIFY_API_TOKEN',
      'PRINTIFY_SHOP_ID',
      'MARKER_API_USERNAME',
      'MARKER_API_PASSWORD',
      'RECRAFT_API_KEY',
    ];
    for (const key of required) {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when MODE=live` });
    }
  });

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

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(resolveFileVars(source));
  if (!parsed.success) {
    // Report key names only; never echo values.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${problems}`);
  }
  return parsed.data;
}

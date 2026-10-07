/**
 * Narrows the process environment before it reaches `loadEnv` (core config/env.ts).
 *
 * `loadEnv` resolves EVERY `FOO_FILE` variable by reading that file into `FOO` (Docker secrets
 * convention). Unrelated variables also end in `_FILE`: the worker's `WORKER_HEARTBEAT_FILE` from the
 * shared .env, or `SSL_CERT_FILE` / `PIP_CONFIG_FILE` from a base image. In the desk container those
 * files may not exist, and one missing file would make the whole desk configuration invalid.
 * So only `*_FILE` variables whose target is one of the core's own keys are passed through.
 * Pure; unit tested.
 */

/** Keys (and key families) defined by the core env schema. Secrets among them may come from *_FILE. */
const CORE_KEY_RE =
  /^(?:MODE|LOG_LEVEL|DATABASE_URL|PGLITE_DIR|STORAGE_DIR|(?:LLM|OLLAMA|ANTHROPIC|IMAGEGEN|ETSY|PRINTIFY|MARKER|RECRAFT|IDEOGRAM|PINTEREST|DESK)_[A-Z0-9_]+)$/;

export function isCoreEnvKey(key: string): boolean {
  return CORE_KEY_RE.test(key) && !key.endsWith('_FILE');
}

/** Copy of `source` without `*_FILE` variables that do not point at a core key. */
export function scopeEnvForLoad(source: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(source)) {
    if (key.endsWith('_FILE') && !isCoreEnvKey(key.slice(0, -'_FILE'.length))) continue;
    out[key] = value;
  }
  return out;
}

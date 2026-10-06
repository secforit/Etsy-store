/**
 * Orchestrator / worker settings that are not secrets and not part of config/env.ts (a contract file).
 * Read from the raw process environment; every key is optional with a safe default and documented in
 * .env.example.
 */
import { z } from 'zod';

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
  /** File the worker touches every loop; the container healthcheck reads its age. */
  WORKER_HEARTBEAT_FILE: z.preprocess(emptyToUndefined, z.string().min(1).default('/tmp/worker-heartbeat')),
});

export type OrchestratorEnv = z.infer<typeof OrchestratorEnvSchema>;

export function loadOrchestratorEnv(source: Record<string, string | undefined> = process.env): OrchestratorEnv {
  const parsed = OrchestratorEnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid worker settings: ${problems}`);
  }
  return parsed.data;
}

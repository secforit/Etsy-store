/**
 * Cloud model price table (USD per million tokens), read from env `LLM_PRICES_JSON`, e.g.
 *   LLM_PRICES_JSON={"<anthropic-model-id>":{"inputPerMTokUsd":3,"outputPerMTokUsd":15}}
 * Local Ollama calls always cost 0. Unknown cloud models cost 0 and log a warning.
 * Note: config/env.ts (a contract file) has no LLM_PRICES_JSON key, so it is read from the raw process env here.
 */
import { z } from 'zod';

const PriceSchema = z.object({
  inputPerMTokUsd: z.number().min(0),
  outputPerMTokUsd: z.number().min(0),
});
export type LlmPrice = z.infer<typeof PriceSchema>;
export type LlmPriceTable = Record<string, LlmPrice>;

const TableSchema = z.record(z.string().min(1), PriceSchema);

export function parseLlmPrices(json: string | undefined): LlmPriceTable {
  if (!json || !json.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('LLM_PRICES_JSON is not valid JSON');
  }
  const parsed = TableSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('LLM_PRICES_JSON must look like {"model-id":{"inputPerMTokUsd":3,"outputPerMTokUsd":15}}');
  }
  return parsed.data;
}

export function loadLlmPrices(source: Record<string, string | undefined> = process.env): LlmPriceTable {
  return parseLlmPrices(source.LLM_PRICES_JSON);
}

/** USD cost of one call, rounded to micro-dollars (per-call cents would hide many small calls from the cap). */
export function costUsd(price: LlmPrice, inputTokens: number, outputTokens: number): number {
  const usd = (inputTokens * price.inputPerMTokUsd + outputTokens * price.outputPerMTokUsd) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

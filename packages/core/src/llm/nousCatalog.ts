/**
 * The Nous Portal model catalog: GET {NOUS_BASE_URL}/models (Bearer key). OpenRouter-style rows:
 *   { data: [{ id, pricing?: { prompt, completion }, architecture?: { input_modalities?: string[] } }] }
 * `pricing.prompt` / `pricing.completion` are USD per token (decimal strings). Used for the price of every Nous
 * call (so the daily cloud spend cap counts it) and by `check-cloud` (does the model exist, does it take images).
 * Source of the shape (the Portal docs are not reachable from the build environment): Nous Research's own
 * Hermes Agent, hermes_cli/models_pricing.py (fetch_models_with_pricing) and hermes_cli/auth_nous.py.
 */
import { z } from 'zod';
import type { LlmPrice } from './prices.ts';
import { LlmError } from './types.ts';

export interface NousModelInfo {
  id: string;
  /** null when the catalog row has no usable price. */
  price: LlmPrice | null;
  /** null when the catalog does not say. */
  acceptsImages: boolean | null;
}

const PerToken = z.union([z.string(), z.number()]).optional().nullable();
const CatalogSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string().min(1),
        pricing: z.object({ prompt: PerToken, completion: PerToken }).partial().optional().nullable(),
        architecture: z.object({ input_modalities: z.array(z.string()).optional() }).partial().optional().nullable(),
      })
      .passthrough(),
  ),
});

/** USD per token (string or number) -> USD per million tokens; null when missing, negative or not a number. */
function perMTok(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
}

export function parseNousCatalog(json: unknown): NousModelInfo[] {
  const parsed = CatalogSchema.safeParse(json);
  if (!parsed.success) throw new LlmError('nous: /models returned an unexpected shape', false);
  return parsed.data.data.map((row) => {
    const input = perMTok(row.pricing?.prompt);
    const output = perMTok(row.pricing?.completion);
    const modalities = row.architecture?.input_modalities;
    return {
      id: row.id,
      price: input !== null && output !== null ? { inputPerMTokUsd: input, outputPerMTokUsd: output } : null,
      acceptsImages: Array.isArray(modalities) ? modalities.includes('image') : null,
    };
  });
}

export interface NousCatalogOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** How long a fetched catalog is trusted. Default 6 h (prices change rarely; a restart refreshes it). */
  ttlMs?: number;
  /** Wall clock in ms (tests). */
  now?: () => number;
}

export class NousCatalog {
  private cache: { at: number; models: Map<string, NousModelInfo> } | null = null;
  private inflight: Promise<Map<string, NousModelInfo>> | null = null;

  constructor(private readonly opts: NousCatalogOptions) {}

  async models(): Promise<Map<string, NousModelInfo>> {
    const now = (this.opts.now ?? Date.now)();
    if (this.cache && now - this.cache.at < (this.opts.ttlMs ?? 6 * 3600_000)) return this.cache.models;
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async model(id: string): Promise<NousModelInfo | null> {
    return (await this.models()).get(id) ?? null;
  }

  private async load(): Promise<Map<string, NousModelInfo>> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/models`;
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(url, {
        headers: { accept: 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      throw new LlmError(`nous: /models unreachable: ${(err as Error)?.message ?? String(err)}`.slice(0, 300), true);
    }
    if (!res.ok) throw new LlmError(`nous: /models returned HTTP ${res.status}`, res.status === 429 || res.status >= 500);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new LlmError('nous: /models returned non-JSON', true);
    }
    const models = new Map(parseNousCatalog(json).map((m) => [m.id, m]));
    this.cache = { at: (this.opts.now ?? Date.now)(), models };
    return models;
  }
}

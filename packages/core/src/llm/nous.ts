/**
 * NousLlm: cloud client for the Nous Research inference API (Nous Portal), used for agents routed to 'nous'.
 *
 * POST {NOUS_BASE_URL}/chat/completions (OpenAI-compatible), Authorization: Bearer NOUS_API_KEY.
 *  - model: NOUS_MODEL_VISION when the request carries images, else NOUS_MODEL_LARGE / _SMALL by tier
 *  - images: OpenAI `image_url` content parts with data: URLs
 *  - output: `response_format` json_schema built from the request's zod schema. The Portal serves hundreds of
 *    models and not every one implements it, so a 400 that names response_format turns it off for that model
 *    (for the life of the process) and the call is repeated once without it. Either way the prompt carries a
 *    JSON example, the reply is validated with zod, and one repair turn is sent with the validation errors.
 *  - temperature 0; retries on 429/5xx with retry-after (bounded); other 4xx fail at once
 *  - cost: LLM_PRICES_JSON entry, else the Portal catalog price (nousCatalog.ts), else the conservative fallback
 *    rate (never $0), so the daily cloud spend cap always counts the call
 * Source of the API shape (the Portal docs are not reachable from the build environment): Nous Research's own
 * Hermes Agent (github.com/NousResearch/hermes-agent): base URL, Bearer key, OpenAI-compatible routes.
 */
import { z } from 'zod';
import { LlmOutputError, LlmTransportError, silentLogger, type LlmLogger } from './errors.ts';
import type { NousModelInfo } from './nousCatalog.ts';
import { retryDelayMs } from './ollama.ts';
import { costUsd, fallbackPrice, type LlmPrice, type LlmPriceTable } from './prices.ts';
import { buildSystemPrompt, buildUserPrompt, parseAndValidate, repairInstruction, stripDataUrl, toModelJsonSchema, truncate } from './prompt.ts';
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse, type LlmUsage } from './types.ts';

export const NOUS_DEFAULT_BASE_URL = 'https://inference-api.nousresearch.com/v1';

/** Floor for max_tokens: reasoning models spend part of the budget before the JSON, and only used tokens are billed. */
export const NOUS_MIN_MAX_TOKENS = 8192;

export interface NousLlmOptions {
  baseUrl: string;
  apiKey: string;
  models: { large: string; small: string; vision: string | null };
  /** Explicit prices (LLM_PRICES_JSON); they win over the catalog. */
  prices: LlmPriceTable;
  /** Portal catalog for prices; null = explicit prices or the fallback rate only. */
  catalog: { model(id: string): Promise<NousModelInfo | null> } | null;
  fetch?: typeof fetch;
  /** Per HTTP call. Default 180 s. */
  timeoutMs?: number;
  /** Retries on 429/5xx only. Default 2. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: LlmLogger;
  /** Monotonic clock in ms for durations (performance.now by default). */
  clock?: () => number;
}

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

const ChatResponseSchema = z
  .object({
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                content: z
                  .union([z.string(), z.null(), z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())])
                  .optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
    usage: z
      .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
type ChatResponse = z.infer<typeof ChatResponseSchema>;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class NousLlm implements LlmClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: LlmLogger;
  private readonly clock: () => number;
  private readonly url: string;
  /** Models that rejected response_format json_schema in this process. */
  private readonly noSchemaModels = new Set<string>();
  private readonly warnedPrices = new Set<string>();

  constructor(private readonly opts: NousLlmOptions) {
    const base = new URL(opts.baseUrl);
    // Security rule 5: the internet is reached over HTTPS only.
    if (base.protocol !== 'https:') throw new Error('NOUS_BASE_URL must be an https:// URL');
    if (!opts.apiKey) throw new Error('nous: NOUS_API_KEY is required');
    this.url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? defaultSleep;
    this.logger = opts.logger ?? silentLogger;
    this.clock = opts.clock ?? (() => performance.now());
  }

  modelFor(req: Pick<LlmRequest<unknown>, 'tier' | 'images' | 'agent'>): string {
    if (req.images && req.images.length > 0) {
      if (!this.opts.models.vision) {
        throw new LlmError(`nous: ${req.agent} sends images but NOUS_MODEL_VISION is not set`, false);
      }
      return this.opts.models.vision;
    }
    return req.tier === 'large' ? this.opts.models.large : this.opts.models.small;
  }

  async generate<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    const model = this.modelFor(req);
    const schema = toModelJsonSchema(req.schema);
    const text = buildUserPrompt(req);
    const userContent: string | ContentPart[] =
      req.images && req.images.length > 0
        ? [
            { type: 'text', text },
            ...req.images.map((i): ContentPart => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${stripDataUrl(i.base64)}` } })),
          ]
        : text;
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(req.system) },
      { role: 'user', content: userContent },
    ];
    const maxTokens = Math.max(req.maxOutputTokens ?? 0, NOUS_MIN_MAX_TOKENS);

    const usage: LlmUsage = { model, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = this.clock();
      let res: ChatResponse;
      try {
        res = await this.complete(model, messages, schema, maxTokens);
      } catch (err) {
        // The repair call failed after the first call was already paid for: keep that usage on the error.
        if (attempt > 0 && err instanceof LlmError) {
          usage.durationMs += Math.max(0, Math.round(this.clock() - started));
          throw new LlmTransportError(err.message, err.retryable, usage);
        }
        throw err;
      }
      usage.durationMs += Math.max(0, Math.round(this.clock() - started));
      usage.inputTokens += res.usage?.prompt_tokens ?? 0;
      usage.outputTokens += res.usage?.completion_tokens ?? 0;
      usage.costUsd = await this.cost(model, usage.inputTokens, usage.outputTokens);

      const choice = res.choices[0];
      const content = contentText(choice?.message?.content);
      const result = parseAndValidate(content, req.schema);
      if (result.ok) return { output: result.value, usage };
      lastError = choice?.finish_reason === 'length' ? `${result.error} (reply was cut off at the token limit)` : result.error;
      if (attempt === 0) {
        this.logger.warn({ agent: req.agent, model, problems: truncate(lastError, 300) }, 'nous output invalid, sending repair turn');
        messages.push({ role: 'assistant', content: truncate(content, 6000) }, { role: 'user', content: repairInstruction(lastError) });
      }
    }
    throw new LlmOutputError(`nous ${model} (${req.agent}): output failed validation after repair: ${truncate(lastError, 500)}`, usage);
  }

  /** One completion; drops response_format once for a model that does not implement it. */
  private async complete(model: string, messages: ChatMessage[], schema: Record<string, unknown>, maxTokens: number): Promise<ChatResponse> {
    const body: Record<string, unknown> = { model, messages, temperature: 0, max_tokens: maxTokens };
    const withSchema = schema.type === 'object' && !this.noSchemaModels.has(model);
    if (withSchema) body.response_format = { type: 'json_schema', json_schema: { name: 'result', strict: false, schema } };
    try {
      return await this.post(body);
    } catch (err) {
      if (withSchema && err instanceof NousHttpError && err.status === 400 && /response_format|json_schema|structured/i.test(err.detail)) {
        this.noSchemaModels.add(model);
        this.logger.warn({ model }, 'nous model rejected response_format json_schema; continuing with prompt-only JSON');
        delete body.response_format;
        try {
          return await this.post(body);
        } catch (err2) {
          throw toLlmError(err2, model);
        }
      }
      throw toLlmError(err, model);
    }
  }

  /** One POST with retries on 429/5xx (retry-after respected). */
  private async post(body: Record<string, unknown>): Promise<ChatResponse> {
    const payload = JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const name = (err as Error)?.name;
        const what = name === 'TimeoutError' || name === 'AbortError' ? `timed out after ${this.timeoutMs} ms` : 'unreachable';
        throw new LlmError(`nous ${what}: ${truncate((err as Error)?.message ?? String(err), 200)}`, true);
      }
      if (res.ok) {
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          throw new LlmError('nous returned a non-JSON response', true);
        }
        const parsed = ChatResponseSchema.safeParse(json);
        if (!parsed.success) throw new LlmError('nous returned an unexpected response shape', false);
        return parsed.data;
      }
      const detail = await readErrorDetail(res);
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxRetries) throw new NousHttpError(res.status, detail);
      await this.sleep(retryDelayMs(res.headers.get('retry-after'), attempt));
    }
  }

  private async cost(model: string, inputTokens: number, outputTokens: number): Promise<number> {
    let price: LlmPrice | null = this.opts.prices[model] ?? null;
    if (!price && this.opts.catalog) {
      try {
        price = (await this.opts.catalog.model(model))?.price ?? null;
      } catch (err) {
        this.warnOnce(model, { err: truncate((err as Error)?.message ?? String(err), 200) }, 'nous catalog unavailable; billing at the conservative fallback rate');
      }
    }
    if (!price) {
      // Fail closed: an unpriced model is billed at a conservative rate, never $0, so the spend cap still sees it.
      price = fallbackPrice(this.opts.prices);
      this.warnOnce(model, { inputPerMTokUsd: price.inputPerMTokUsd, outputPerMTokUsd: price.outputPerMTokUsd }, 'no price for this nous model; billing at the conservative fallback rate');
    }
    return costUsd(price, inputTokens, outputTokens);
  }

  private warnOnce(model: string, obj: Record<string, unknown>, msg: string): void {
    if (this.warnedPrices.has(model)) return;
    this.warnedPrices.add(model);
    this.logger.warn({ model, ...obj }, msg);
  }
}

class NousHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`HTTP ${status}: ${detail}`);
  }
}

const STATUS_HINTS: Record<number, string> = {
  401: 'API key rejected (check NOUS_API_KEY)',
  402: 'payment required (check the Nous Portal balance or plan)',
  403: 'forbidden for this key',
  404: 'model or route not found (check NOUS_MODEL_*; run check-cloud)',
};

function toLlmError(err: unknown, model: string): unknown {
  if (err instanceof NousHttpError) {
    const hint = STATUS_HINTS[err.status];
    const retryable = err.status === 408 || err.status === 429 || err.status >= 500;
    return new LlmError(`nous ${model}: HTTP ${err.status}${hint ? ` ${hint}` : ''}: ${truncate(err.detail, 300)}`, retryable);
  }
  return err;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
  }
  return '';
}

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: unknown; detail?: unknown; message?: unknown };
      const e = j.error;
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
      if (typeof j.detail === 'string') return j.detail;
      if (typeof j.message === 'string') return j.message;
    } catch {
      /* not JSON */
    }
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

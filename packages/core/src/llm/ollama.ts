/**
 * OllamaLlm: the default, local LLM client (gemma4:12b on Razvan's RTX 3060).
 *
 * POST {OLLAMA_BASE_URL}/api/chat with stream:false, format = JSON schema of the request's zod schema,
 * options {temperature: 0, num_ctx}, think:false, and images (plain base64) on the user message.
 * The reply's message.content is parsed and validated; one repair turn is sent with the validation errors.
 * Every HTTP call runs inside gpu.withGpu('llm', ...) so the imagegen sidecar has released VRAM first.
 * Local calls cost 0 USD.
 *
 * API reference (checked 2026-10-06): https://docs.ollama.com/api/chat
 *  - format: "json" or a JSON schema object
 *  - messages[].images: base64 strings without a data: prefix
 *  - think: boolean | "low" | "medium" | "high"; false = no thinking output if the model permits it
 *  - response: message.content, message.thinking, done_reason, total_duration (ns),
 *    prompt_eval_count, eval_count
 */
import { z } from 'zod';
import type { GpuCoordinator } from '../integrations/types.ts';
import { LlmOutputError, silentLogger, type LlmLogger } from './errors.ts';
import {
  buildSystemPrompt,
  buildUserPrompt,
  parseAndValidate,
  repairInstruction,
  stripDataUrl,
  toModelJsonSchema,
  truncate,
} from './prompt.ts';
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse, type LlmUsage } from './types.ts';

export interface OllamaLlmOptions {
  baseUrl: string;
  models: { large: string; small: string; vision: string };
  numCtx: number;
  gpu: GpuCoordinator;
  fetch?: typeof fetch;
  /** Per HTTP call. Default 300 s (spec: Ollama up to 300 s). */
  timeoutMs?: number;
  /** Retries on 429/5xx only. Default 2. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Passed as keep_alive when set; otherwise Ollama's default applies (the GPU coordinator unloads on switch). */
  keepAlive?: string | number;
  logger?: LlmLogger;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[];
}

const OllamaChatResponseSchema = z.object({
  model: z.string().optional(),
  message: z.object({ content: z.string().default(''), thinking: z.string().optional() }).optional(),
  done: z.boolean().optional(),
  done_reason: z.string().optional(),
  total_duration: z.number().optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});
type OllamaChatResponse = z.infer<typeof OllamaChatResponseSchema>;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OllamaLlm implements LlmClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: LlmLogger;
  /** Cleared if the server rejects the `think` field for this model. */
  private sendThink = true;

  constructor(private readonly opts: OllamaLlmOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? defaultSleep;
    this.logger = opts.logger ?? silentLogger;
  }

  modelFor(req: Pick<LlmRequest<unknown>, 'tier' | 'images'>): string {
    if (req.images && req.images.length > 0) return this.opts.models.vision;
    return req.tier === 'large' ? this.opts.models.large : this.opts.models.small;
  }

  async generate<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    const model = this.modelFor(req);
    const format = toModelJsonSchema(req.schema);
    const userMessage: OllamaMessage = { role: 'user', content: buildUserPrompt(req) };
    if (req.images && req.images.length > 0) userMessage.images = req.images.map((i) => stripDataUrl(i.base64));
    const messages: OllamaMessage[] = [{ role: 'system', content: buildSystemPrompt(req.system) }, userMessage];

    const usage: LlmUsage = { model, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.chat(model, messages, format, req.maxOutputTokens);
      usage.inputTokens += res.prompt_eval_count ?? 0;
      usage.outputTokens += res.eval_count ?? 0;
      usage.durationMs += Math.round((res.total_duration ?? 0) / 1e6);
      const content = res.message?.content ?? '';
      const result = parseAndValidate(content, req.schema);
      if (result.ok) return { output: result.value, usage };
      lastError = res.done_reason === 'length' ? `${result.error} (reply was cut off at the token limit)` : result.error;
      if (attempt === 0) {
        this.logger.warn({ agent: req.agent, model, problems: truncate(lastError, 300) }, 'ollama output invalid, sending repair turn');
        messages.push({ role: 'assistant', content: truncate(content, 6000) }, { role: 'user', content: repairInstruction(lastError) });
      }
    }
    throw new LlmOutputError(`ollama ${model} (${req.agent}): output failed validation after repair: ${truncate(lastError, 500)}`, usage);
  }

  private async chat(
    model: string,
    messages: OllamaMessage[],
    format: Record<string, unknown>,
    maxOutputTokens: number | undefined,
  ): Promise<OllamaChatResponse> {
    return this.opts.gpu.withGpu('llm', async () => {
      const options: Record<string, number> = { temperature: 0, num_ctx: this.opts.numCtx };
      if (maxOutputTokens !== undefined) options.num_predict = maxOutputTokens;
      const body: Record<string, unknown> = { model, messages, stream: false, format, options };
      if (this.opts.keepAlive !== undefined) body.keep_alive = this.opts.keepAlive;
      if (this.sendThink) body.think = false;
      try {
        return await this.post(body);
      } catch (err) {
        // Some model/server combinations reject the think field entirely: retry once without it.
        if (this.sendThink && err instanceof OllamaHttpError && err.status === 400 && /think/i.test(err.detail)) {
          this.sendThink = false;
          this.logger.warn({ model }, 'ollama rejected the think field; continuing without it');
          delete body.think;
          try {
            return await this.post(body);
          } catch (err2) {
            throw toLlmError(err2, model);
          }
        }
        throw toLlmError(err, model);
      }
    });
  }

  private chatUrl(): string {
    const base = this.opts.baseUrl.endsWith('/') ? this.opts.baseUrl : `${this.opts.baseUrl}/`;
    return new URL('api/chat', base).toString();
  }

  /** One POST with retries on 429/5xx (retry-after respected). Network errors and timeouts are not retried here. */
  private async post(body: Record<string, unknown>): Promise<OllamaChatResponse> {
    const url = this.chatUrl();
    const payload = JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const name = (err as Error)?.name;
        const what = name === 'TimeoutError' || name === 'AbortError' ? `timed out after ${this.timeoutMs} ms` : 'unreachable';
        throw new LlmError(`ollama ${what}: ${truncate((err as Error)?.message ?? String(err), 200)}`, true);
      }
      if (res.ok) {
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          throw new LlmError('ollama returned a non-JSON response', true);
        }
        const parsed = OllamaChatResponseSchema.safeParse(json);
        if (!parsed.success) throw new LlmError('ollama returned an unexpected response shape', false);
        return parsed.data;
      }
      const detail = await readErrorDetail(res);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxRetries) throw new OllamaHttpError(res.status, detail);
      await this.sleep(retryDelayMs(res.headers.get('retry-after'), attempt));
    }
  }
}

class OllamaHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`HTTP ${status}: ${detail}`);
  }
}

function toLlmError(err: unknown, model: string): unknown {
  if (err instanceof OllamaHttpError) {
    return new LlmError(`ollama ${model}: HTTP ${err.status}: ${truncate(err.detail, 300)}`, err.status === 429 || err.status >= 500);
  }
  return err;
}

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: unknown };
      if (typeof j.error === 'string') return j.error;
    } catch {
      /* not JSON */
    }
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

/** retry-after (seconds or HTTP date) or exponential backoff 1 s, 2 s, 4 s...; capped at 60 s. */
export function retryDelayMs(retryAfter: string | null, attempt: number): number {
  const cap = 60_000;
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, cap);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), cap);
  }
  return Math.min(1000 * 2 ** attempt, cap);
}

/**
 * AnthropicLlm: optional cloud client, used only for agents routed to 'anthropic' via LLM_ROUTES /
 * LLM_DEFAULT_PROVIDER. Structured output via ONE forced tool call whose input_schema is the request's
 * zod schema; one repair turn (tool_result with is_error) when validation fails.
 * Retries on 429/5xx/connection errors are done by the SDK (maxRetries, retry-after respected).
 * Model ids come only from env (ANTHROPIC_MODEL_LARGE / _SMALL). Cost from the LLM_PRICES_JSON table.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { LlmOutputError, silentLogger, type LlmLogger } from './errors.ts';
import { costUsd, fallbackPrice, type LlmPriceTable } from './prices.ts';
import { buildSystemPrompt, buildUserPrompt, repairInstruction, toModelJsonSchema, truncate, validateValue } from './prompt.ts';
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse, type LlmUsage } from './types.ts';

/** The one SDK method we use; tests inject a fake. */
export interface AnthropicMessagesApi {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export interface AnthropicLlmOptions {
  client: { messages: AnthropicMessagesApi };
  models: { large: string; small: string };
  prices: LlmPriceTable;
  logger?: LlmLogger;
  /** Monotonic clock in ms (performance.now by default) for durations. */
  clock?: () => number;
  defaultMaxTokens?: number;
}

const TOOL_NAME = 'submit_result';

export class AnthropicLlm implements LlmClient {
  private readonly logger: LlmLogger;
  private readonly clock: () => number;
  private readonly warnedModels = new Set<string>();

  constructor(private readonly opts: AnthropicLlmOptions) {
    this.logger = opts.logger ?? silentLogger;
    this.clock = opts.clock ?? (() => performance.now());
  }

  async generate<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    // Vision requests use the large model (Claude models are multimodal).
    const model = req.tier === 'large' || (req.images?.length ?? 0) > 0 ? this.opts.models.large : this.opts.models.small;
    const { inputSchema, wrapped } = toToolInputSchema(req.schema as never);

    const userContent: Anthropic.ContentBlockParam[] = (req.images ?? []).map((img) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: img.mimeType, data: img.base64.replace(/^data:[^;,]+;base64,/, '') },
    }));
    userContent.push({ type: 'text', text: buildUserPrompt(req) });
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }];

    const usage: LlmUsage = { model, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = this.clock();
      const res = await this.call({
        model,
        max_tokens: req.maxOutputTokens ?? this.opts.defaultMaxTokens ?? 4096,
        temperature: 0,
        system: buildSystemPrompt(req.system),
        messages,
        tools: [
          {
            name: TOOL_NAME,
            description: 'Return your answer as structured data. This tool has no side effects.',
            input_schema: inputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: TOOL_NAME, disable_parallel_tool_use: true },
      });
      usage.durationMs += Math.max(0, Math.round(this.clock() - started));
      usage.inputTokens += res.usage?.input_tokens ?? 0;
      usage.outputTokens += res.usage?.output_tokens ?? 0;
      usage.costUsd = this.cost(model, usage.inputTokens, usage.outputTokens);

      const toolUse = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL_NAME);
      if (!toolUse) {
        lastError = `model did not call ${TOOL_NAME} (stop_reason ${res.stop_reason ?? 'unknown'})`;
        break; // a forced tool call that is missing will not be fixed by a repair turn
      }
      const value = wrapped ? (toolUse.input as { result?: unknown } | null)?.result : toolUse.input;
      const result = validateValue(value, req.schema);
      if (result.ok) return { output: result.value, usage };
      lastError = res.stop_reason === 'max_tokens' ? `${result.error} (reply was cut off at max_tokens)` : result.error;
      if (attempt === 0) {
        this.logger.warn({ agent: req.agent, model, problems: truncate(lastError, 300) }, 'anthropic output invalid, sending repair turn');
        messages.push(
          { role: 'assistant', content: res.content as unknown as Anthropic.ContentBlockParam[] },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolUse.id, is_error: true, content: repairInstruction(lastError) }],
          },
        );
      }
    }
    throw new LlmOutputError(`anthropic ${model} (${req.agent}): ${truncate(lastError, 500)}`, usage);
  }

  private async call(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    try {
      return await this.opts.client.messages.create(params);
    } catch (err) {
      const status = (err as { status?: unknown })?.status;
      const message = truncate((err as Error)?.message ?? String(err), 300);
      if (typeof status === 'number') {
        throw new LlmError(`anthropic HTTP ${status}: ${message}`, status === 408 || status === 429 || status >= 500);
      }
      // Connection errors and timeouts (the SDK already retried them).
      throw new LlmError(`anthropic request failed: ${message}`, true);
    }
  }

  private cost(model: string, inputTokens: number, outputTokens: number): number {
    const price = this.opts.prices[model];
    if (!price) {
      // Fail closed: an unpriced model is billed at a conservative rate, never $0, so the spend cap still sees it.
      const fallback = fallbackPrice(this.opts.prices);
      if (!this.warnedModels.has(model)) {
        this.warnedModels.add(model);
        this.logger.warn(
          { model, inputPerMTokUsd: fallback.inputPerMTokUsd, outputPerMTokUsd: fallback.outputPerMTokUsd },
          'no price for this model in LLM_PRICES_JSON; billing it at the conservative fallback rate',
        );
      }
      return costUsd(fallback, inputTokens, outputTokens);
    }
    return costUsd(price, inputTokens, outputTokens);
  }
}

/** Tool input must be a JSON object; non-object schemas are wrapped as {result: ...}. */
export function toToolInputSchema(schema: Parameters<typeof toModelJsonSchema>[0]): {
  inputSchema: Anthropic.Tool.InputSchema;
  wrapped: boolean;
} {
  const json = toModelJsonSchema(schema);
  if (json.type === 'object') return { inputSchema: json as Anthropic.Tool.InputSchema, wrapped: false };
  return {
    inputSchema: { type: 'object', properties: { result: json }, required: ['result'], additionalProperties: false },
    wrapped: true,
  };
}

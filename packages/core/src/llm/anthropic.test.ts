import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicLlm, toToolInputSchema } from './anthropic.ts';
import { LlmOutputError, LlmTransportError, usageFromError } from './errors.ts';
import { UNTRUSTED_DATA_RULE } from './prompt.ts';
import { costUsd, parseLlmPrices } from './prices.ts';
import { LlmError } from './types.ts';

const Schema = z.object({ answer: z.string().min(3) });

function toolReply(input: unknown, usage = { input_tokens: 1000, output_tokens: 200 }): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-test-large',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'submit_result', input, caller: { type: 'direct' } } as unknown as Anthropic.ContentBlock],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: usage as Anthropic.Usage,
  } as Anthropic.Message;
}

function setup(replies: (Anthropic.Message | Error)[], prices = { 'claude-test-large': { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } }) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const warnings: Record<string, unknown>[] = [];
  let t = 0;
  const llm = new AnthropicLlm({
    client: {
      messages: {
        async create(params) {
          calls.push(structuredClone(params));
          const r = replies.shift();
          if (!r) throw new Error('no reply');
          if (r instanceof Error) throw r;
          return r;
        },
      },
    },
    models: { large: 'claude-test-large', small: 'claude-test-small' },
    prices,
    logger: { warn: (o) => warnings.push(o), debug: () => {} },
    clock: () => (t += 100),
  });
  return { llm, calls, warnings };
}

const req = {
  agent: 'listing_writer' as const,
  tier: 'large' as const,
  system: 'You are Listing Writer.',
  instructions: 'Write it.',
  untrustedData: { kw: 'cat mom' },
  schema: Schema,
};

describe('AnthropicLlm', () => {
  it('forces one tool call with the zod schema as input_schema and wraps untrusted data', async () => {
    const { llm, calls } = setup([toolReply({ answer: 'hello' })]);
    const res = await llm.generate(req);
    expect(res.output).toEqual({ answer: 'hello' });
    const p = calls[0]!;
    expect(p.model).toBe('claude-test-large');
    expect(p.temperature).toBe(0);
    expect(p.tool_choice).toEqual({ type: 'tool', name: 'submit_result', disable_parallel_tool_use: true });
    const tool = p.tools?.[0] as Anthropic.Tool;
    expect(tool.input_schema.type).toBe('object');
    expect((tool.input_schema.properties as any).answer.minLength).toBe(3);
    expect(String(p.system)).toContain(UNTRUSTED_DATA_RULE);
    const text = (p.messages[0]!.content as Anthropic.ContentBlockParam[]).find((b) => b.type === 'text') as Anthropic.TextBlockParam;
    expect(text.text).toContain('<untrusted_data>');
  });

  it('computes cost from the price table', async () => {
    const { llm } = setup([toolReply({ answer: 'hello' })]);
    const res = await llm.generate(req);
    expect(res.usage.costUsd).toBeCloseTo(0.006, 6); // 1000*3/1e6 + 200*15/1e6
    expect(res.usage.durationMs).toBe(100);
  });

  it('bills unknown models at the conservative fallback rate (never $0) and warns once', async () => {
    const { llm, warnings } = setup([toolReply({ answer: 'hello' }), toolReply({ answer: 'again' })], {} as never);
    const a = await llm.generate(req);
    await llm.generate(req);
    expect(a.usage.costUsd).toBeCloseTo(0.03, 6); // 1000*15/1e6 + 200*75/1e6
    expect(warnings).toHaveLength(1);
  });

  it('uses the table maximum as the fallback when the table has a dearer model', async () => {
    const { llm } = setup([toolReply({ answer: 'hello' })], { 'some-other-model': { inputPerMTokUsd: 30, outputPerMTokUsd: 150 } } as never);
    expect((await llm.generate(req)).usage.costUsd).toBeCloseTo(0.06, 6); // 1000*30/1e6 + 200*150/1e6
  });

  it('sends a repair turn as an error tool_result, then succeeds', async () => {
    const { llm, calls } = setup([toolReply({ answer: 'x' }), toolReply({ answer: 'fixed' })]);
    const res = await llm.generate(req);
    expect(res.output.answer).toBe('fixed');
    const msgs = calls[1]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const tr = (msgs[2]!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(tr.type).toBe('tool_result');
    expect(tr.is_error).toBe(true);
    expect(tr.tool_use_id).toBe('toolu_1');
    expect(res.usage.inputTokens).toBe(2000);
  });

  it('throws LlmOutputError with usage after a failed repair', async () => {
    const { llm } = setup([toolReply({ answer: 'x' }), toolReply({ answer: 'y' })]);
    const err = await llm.generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmOutputError);
    expect(err.usage.costUsd).toBeGreaterThan(0);
  });

  it('keeps the paid first call in usage when the repair call fails on transport (spend cap still counts it)', async () => {
    const rate = Object.assign(new Error('rate limited'), { status: 429 });
    const { llm } = setup([toolReply({ answer: 'x' }), rate]);
    const err = await llm.generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmTransportError);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.retryable).toBe(true);
    expect(err.usage.inputTokens).toBe(1000);
    expect(err.usage.costUsd).toBeCloseTo(0.006, 6);
    expect(usageFromError(err)?.costUsd).toBeCloseTo(0.006, 6);
  });

  it('maps API errors: 429 retryable, 400 not', async () => {
    const rate = Object.assign(new Error('rate limited'), { status: 429 });
    const bad = Object.assign(new Error('bad request'), { status: 400 });
    const a = await setup([rate]).llm.generate(req).catch((e) => e);
    const b = await setup([bad]).llm.generate(req).catch((e) => e);
    expect(a).toBeInstanceOf(LlmError);
    expect(a.retryable).toBe(true);
    expect(b.retryable).toBe(false);
  });

  it('uses the large model for vision requests and sends images as base64 blocks', async () => {
    const { llm, calls } = setup([toolReply({ answer: 'looks fine' })]);
    await llm.generate({ ...req, tier: 'small', images: [{ mimeType: 'image/jpeg', base64: 'data:image/jpeg;base64,QUJD' }] });
    const p = calls[0]!;
    expect(p.model).toBe('claude-test-large');
    const img = (p.messages[0]!.content as Anthropic.ContentBlockParam[])[0] as Anthropic.ImageBlockParam;
    expect(img.source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: 'QUJD' });
  });

  it('wraps non-object schemas as {result}', () => {
    const { inputSchema, wrapped } = toToolInputSchema(z.array(z.string()));
    expect(wrapped).toBe(true);
    expect(inputSchema.required).toEqual(['result']);
  });
});

describe('price table', () => {
  it('parses LLM_PRICES_JSON and rejects bad shapes', () => {
    expect(parseLlmPrices(undefined)).toEqual({});
    expect(parseLlmPrices('{"m":{"inputPerMTokUsd":1,"outputPerMTokUsd":2}}')).toEqual({ m: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 } });
    expect(() => parseLlmPrices('{"m":{"in":1}}')).toThrow();
    expect(() => parseLlmPrices('nope')).toThrow();
    expect(costUsd({ inputPerMTokUsd: 3, outputPerMTokUsd: 15 }, 1_000_000, 0)).toBe(3);
  });
});

/**
 * LLM access for agents. Agents never get API credentials or write-capable tools: code gathers data,
 * the model returns a schema-validated object, code acts on it.
 * CONTRACT FILE: owned by the foundation.
 */
import type { z } from 'zod';
import type { AgentName } from '../domain/types.ts';

export interface LlmImage {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
}

export interface LlmRequest<T> {
  agent: AgentName;
  tier: 'large' | 'small';
  system: string;
  /** Trusted instructions written by us. */
  instructions: string;
  /**
   * Untrusted data (trend keywords, competitor titles, OCR text...). Implementations MUST wrap it in
   * clearly delimited tags and the system prompt MUST say it is data, never instructions.
   */
  untrustedData?: unknown;
  images?: LlmImage[];
  schema: z.ZodType<T>;
  maxOutputTokens?: number;
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface LlmResponse<T> {
  output: T;
  usage: LlmUsage;
}

export interface LlmClient {
  /** Returns schema-valid output or throws LlmError. Retries transient API errors internally. */
  generate<T>(req: LlmRequest<T>): Promise<LlmResponse<T>>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

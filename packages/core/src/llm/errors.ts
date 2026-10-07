/**
 * LlmError subclasses that carry the usage consumed before the failure, so the orchestrator can still
 * record agent_runs (and count cloud spend) for calls whose output never validated.
 * Plain `instanceof LlmError` checks keep working.
 */
import { LlmError, type LlmUsage } from './types.ts';

export class LlmOutputError extends LlmError {
  constructor(
    message: string,
    public readonly usage: LlmUsage,
  ) {
    super(message, false);
    this.name = 'LlmOutputError';
  }
}

/**
 * A transport failure (HTTP 429/5xx, network) on a later call of the same request, after an earlier call
 * already succeeded and was paid for. Keeps the retryable flag of the underlying error and carries the usage
 * of the calls that did complete, so the spend cap still counts them.
 */
export class LlmTransportError extends LlmError {
  constructor(
    message: string,
    retryable: boolean,
    public readonly usage: LlmUsage,
  ) {
    super(message, retryable);
    this.name = 'LlmTransportError';
  }
}

/** Usage attached to an error thrown by an LLM client, if any. */
export function usageFromError(err: unknown): LlmUsage | null {
  return err instanceof LlmOutputError || err instanceof LlmTransportError ? err.usage : null;
}

export interface LlmLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
}

export const silentLogger: LlmLogger = {
  warn() {},
  debug() {},
};

/**
 * Minimal JSON-lines logger with the orchestrator Logger shape. Never pass secrets, cookies,
 * password input or image bytes to it.
 */
import type { Logger } from '@etsy-agents/core/orchestrator/contracts.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, obj: Record<string, unknown>, msg?: string): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), service: 'desk', msg, ...obj });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log: Logger = {
  debug: (obj, msg) => {
    if (process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace') write('debug', obj, msg);
  },
  info: (obj, msg) => write('info', obj, msg),
  warn: (obj, msg) => write('warn', obj, msg),
  error: (obj, msg) => write('error', obj, msg),
};

/** Short, single-line description of an error for logs (no stack, bounded length). */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 500);
  return 'non-Error thrown';
}

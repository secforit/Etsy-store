/**
 * Logger factory. pino writes JSON lines to stdout; known secret-bearing fields are redacted as a second
 * line of defence (the code never logs secrets, tokens or image bytes on purpose).
 */
import pino from 'pino';
import type { Logger } from './contracts.ts';

export const REDACT_PATHS = [
  'password',
  'token',
  'apiKey',
  'authorization',
  'refreshToken',
  'secret',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.authorization',
  '*.refreshToken',
  '*.secret',
  '*.bytes',
  '*.base64',
];

export function createLogger(level: string, component: string): Logger {
  return pino({
    level,
    base: { component },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/** Short, single-line error text for logs and `jobs.last_error` (never includes request bodies). */
export function errorMessage(err: unknown, max = 2000): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

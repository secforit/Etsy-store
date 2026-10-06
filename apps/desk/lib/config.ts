/**
 * Desk configuration derived from the validated environment (loadEnv). Read lazily at request time,
 * never at import or build time, and cached per process. Server-side only (proxy, actions, routes).
 */
import { loadEnv } from '@etsy-agents/core/config/env.ts';
import type { Env } from '@etsy-agents/core/config/env.ts';
import { MIN_SESSION_SECRET_LENGTH, parsePasswordHash } from './auth.ts';
import { log } from './log.ts';
import { allowedOrigins, normalizeOrigin } from './origin.ts';

export interface DeskConfig {
  env: Env;
  /** null when DESK_SESSION_SECRET is missing: nobody can log in, every session is invalid. */
  sessionSecret: string | null;
  /** null when DESK_PASSWORD_HASH is missing or malformed. */
  passwordHash: string | null;
  /** Normalised DESK_ORIGIN, e.g. https://secforit-home.tailnet.ts.net */
  deskOrigin: string | null;
  allowedOrigins: string[];
}

export type DeskConfigResult = { ok: true; config: DeskConfig } | { ok: false; error: string };

const CACHE_KEY = Symbol.for('etsy-agents.desk.config');

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function build(): DeskConfig {
  const env = loadEnv(process.env);
  const deskOrigin = normalizeOrigin(env.DESK_ORIGIN);
  let passwordHash: string | null = env.DESK_PASSWORD_HASH ?? null;
  if (passwordHash && !parsePasswordHash(passwordHash)) {
    log.error({ key: 'DESK_PASSWORD_HASH' }, 'password hash is malformed or out of bounds; expected scrypt$N$r$p$saltB64$hashB64');
    passwordHash = null;
  }
  const sessionSecret =
    env.DESK_SESSION_SECRET && env.DESK_SESSION_SECRET.length >= MIN_SESSION_SECRET_LENGTH ? env.DESK_SESSION_SECRET : null;
  if (!sessionSecret) log.warn({ key: 'DESK_SESSION_SECRET' }, 'session secret missing: login disabled');
  if (!passwordHash) log.warn({ key: 'DESK_PASSWORD_HASH' }, 'password hash missing: login disabled');
  const origins = allowedOrigins(env.DESK_ORIGIN, isProduction());
  if (origins.length === 0) log.error({ key: 'DESK_ORIGIN' }, 'DESK_ORIGIN missing: every mutation will be refused');
  return { env, sessionSecret, passwordHash, deskOrigin, allowedOrigins: origins };
}

/** Never throws. Errors carry key names only (loadEnv never echoes values). */
export function tryGetDeskConfig(): DeskConfigResult {
  const g = globalThis as unknown as Record<symbol, DeskConfigResult | undefined>;
  const cached = g[CACHE_KEY];
  if (cached) return cached;
  let result: DeskConfigResult;
  try {
    result = { ok: true, config: build() };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'unknown error';
    log.error({ error }, 'desk configuration invalid');
    result = { ok: false, error };
  }
  g[CACHE_KEY] = result;
  return result;
}

export function getDeskConfig(): DeskConfig {
  const result = tryGetDeskConfig();
  if (!result.ok) throw new Error('Desk configuration is invalid. Check the server logs.');
  return result.config;
}

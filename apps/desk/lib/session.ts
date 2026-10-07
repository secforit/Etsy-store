/**
 * Request-scoped auth helpers for pages, server actions and route handlers. The proxy already
 * enforces auth and origin; these re-check (defence in depth, and Server Functions must verify
 * auth themselves).
 */
import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  revokeAllSessions,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  sessionCookieOptions,
  sessionsNotBeforeMs,
  signSession,
  verifySession,
} from './auth.ts';
import type { Session } from './auth.ts';
import { tryGetDeskConfig } from './config.ts';
import { log } from './log.ts';
import { checkOrigin } from './origin.ts';

export async function getSession(): Promise<Session | null> {
  const cfg = tryGetDeskConfig();
  if (!cfg.ok) return null;
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  return verifySession(token, cfg.config.sessionSecret, Date.now(), SESSION_MAX_AGE_MS, sessionsNotBeforeMs());
}

/** For pages: redirects to /login when there is no valid session. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

/** Throws when the request's Origin is not the desk's own origin. Server actions are POSTs. */
export async function assertSameOrigin(): Promise<void> {
  const cfg = tryGetDeskConfig();
  const h = await headers();
  const result = cfg.ok
    ? checkOrigin({ method: 'POST', origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site') }, cfg.config.allowedOrigins)
    : ({ ok: false, reason: 'configuration invalid' } as const);
  if (!result.ok) {
    log.warn({ reason: result.reason }, 'mutation refused: origin check failed');
    throw new Error('Request origin not allowed.');
  }
}

/** For server actions: valid session AND same-origin request, else redirect/throw. */
export async function requireActionAuth(): Promise<Session> {
  await assertSameOrigin();
  return requireSession();
}

export async function startSession(sessionSecret: string): Promise<void> {
  const token = signSession(sessionSecret, Date.now());
  (await cookies()).set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
}

/**
 * Sign-out. Revoking every session (all devices) is reserved for a request that carries a VALID session:
 * /login is public, so an unauthenticated POST of the logout action must not be able to sign Razvan out
 * over and over. Without a session only this browser's cookie is cleared. Returns whether sessions were revoked.
 */
export async function endSession(): Promise<boolean> {
  const session = await getSession();
  if (session) revokeAllSessions(Date.now());
  await clearSessionCookie();
  return session !== null;
}

/** Overwrites the cookie with an expired one carrying the same attributes (required by the __Host- prefix). */
export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE_NAME, '', { ...sessionCookieOptions(), maxAge: 0 });
}

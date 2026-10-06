/**
 * Request-scoped auth helpers for pages, server actions and route handlers. The proxy already
 * enforces auth and origin; these re-check (defence in depth, and Server Functions must verify
 * auth themselves).
 */
import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE_NAME, sessionCookieOptions, signSession, verifySession } from './auth.ts';
import type { Session } from './auth.ts';
import { tryGetDeskConfig } from './config.ts';
import { log } from './log.ts';
import { checkOrigin } from './origin.ts';

export async function getSession(): Promise<Session | null> {
  const cfg = tryGetDeskConfig();
  if (!cfg.ok) return null;
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  return verifySession(token, cfg.config.sessionSecret, Date.now());
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

export async function endSession(): Promise<void> {
  // Overwrite with an expired cookie carrying the same attributes (required by the __Host- prefix).
  (await cookies()).set(SESSION_COOKIE_NAME, '', { ...sessionCookieOptions(), maxAge: 0 });
}

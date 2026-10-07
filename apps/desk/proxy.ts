/**
 * Next.js 16 Proxy (formerly middleware; runs on the Node.js runtime).
 * For every request except static assets:
 *  1. Mutations (non GET/HEAD/OPTIONS, which includes every Server Action) must come from DESK_ORIGIN.
 *  2. Every path except /login and /healthz needs a valid signed session cookie.
 *  3. A fresh CSP nonce is generated and applied (strict-dynamic, no unsafe-eval in production).
 */
import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS, sessionsNotBeforeMs, verifySession } from './lib/auth.ts';
import { tryGetDeskConfig } from './lib/config.ts';
import { buildCsp } from './lib/csp.ts';
import { log } from './lib/log.ts';
import { checkOrigin, isMutationMethod } from './lib/origin.ts';

const PUBLIC_PATHS = new Set(['/login', '/healthz']);
/** Image downloads set their own stricter policy (`default-src 'none'; sandbox`); no page nonce needed there. */
const ASSET_PATH_RE = /^\/products\/[^/]+\/asset\/[^/]+$/;

function plain(status: number, body: string): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function proxy(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;
  const cfgResult = tryGetDeskConfig();
  if (!cfgResult.ok) return plain(503, 'Desk configuration is invalid. Check the desk logs.');
  const cfg = cfgResult.config;
  const mutation = isMutationMethod(req.method);

  if (mutation) {
    const check = checkOrigin(
      { method: req.method, origin: req.headers.get('origin'), secFetchSite: req.headers.get('sec-fetch-site') },
      cfg.allowedOrigins,
    );
    if (!check.ok) {
      log.warn({ method: req.method, path: pathname, reason: check.reason }, 'mutation refused: origin check failed');
      return plain(403, 'Forbidden');
    }
  }

  if (!PUBLIC_PATHS.has(pathname)) {
    const session = verifySession(
      req.cookies.get(SESSION_COOKIE_NAME)?.value,
      cfg.sessionSecret,
      Date.now(),
      SESSION_MAX_AGE_MS,
      sessionsNotBeforeMs(),
    );
    if (!session) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const login = new URL('/login', cfg.deskOrigin ?? req.nextUrl.origin);
        if (pathname !== '/') login.searchParams.set('next', `${pathname}${search}`);
        return NextResponse.redirect(login, 303);
      }
      return plain(401, 'Unauthorized');
    }
  }

  if (ASSET_PATH_RE.test(pathname)) return NextResponse.next();

  const nonce = randomBytes(16).toString('base64');
  const csp = buildCsp(nonce, { isDev: process.env.NODE_ENV !== 'production' });
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);
  if (mutation && cfg.deskOrigin) {
    // Origin was verified above. Behind `tailscale serve` the Host header may be the loopback
    // address, so tell Next's own Server Action CSRF check which host the browser used.
    requestHeaders.set('x-forwarded-host', new URL(cfg.deskOrigin).host);
  }
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set('Content-Security-Policy', csp);
  return res;
}

export const config = {
  // Everything except build assets and the public static files at the root (robots.txt, the app icon).
  // (The image optimizer is disabled in next.config and deliberately NOT excluded here.)
  matcher: ['/((?!_next/static/|favicon\\.ico$|robots\\.txt$|icon\\.svg$).*)'],
};

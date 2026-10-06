import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp.ts';
import { allowedOrigins, checkOrigin, isMutationMethod, normalizeOrigin } from './origin.ts';

const DESK = 'https://secforit-home.tail1234.ts.net';
const ALLOWED = [DESK];

describe('origin check on mutations', () => {
  it('lets safe methods through without an Origin header', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(checkOrigin({ method, origin: null }, ALLOWED)).toEqual({ ok: true });
    }
    expect(isMutationMethod('POST')).toBe(true);
    expect(isMutationMethod('DELETE')).toBe(true);
    expect(isMutationMethod('GET')).toBe(false);
  });

  it('accepts a POST from the desk origin', () => {
    expect(checkOrigin({ method: 'POST', origin: DESK }, ALLOWED)).toEqual({ ok: true });
    expect(checkOrigin({ method: 'POST', origin: DESK, secFetchSite: 'same-origin' }, ALLOWED)).toEqual({ ok: true });
  });

  it('refuses a POST without Origin, with Origin: null, or from elsewhere', () => {
    for (const origin of [null, undefined, '', 'null', 'https://evil.example', 'http://secforit-home.tail1234.ts.net']) {
      expect(checkOrigin({ method: 'POST', origin }, ALLOWED).ok).toBe(false);
    }
    // Look-alikes and non-exact header values.
    for (const origin of [`${DESK}.evil.example`, `${DESK}/`, `${DESK}:443x`, `${DESK}/path`]) {
      expect(checkOrigin({ method: 'POST', origin }, ALLOWED).ok).toBe(false);
    }
  });

  it('refuses cross-site fetch metadata even with a matching Origin', () => {
    expect(checkOrigin({ method: 'POST', origin: DESK, secFetchSite: 'cross-site' }, ALLOWED).ok).toBe(false);
    expect(checkOrigin({ method: 'POST', origin: DESK, secFetchSite: 'same-site' }, ALLOWED).ok).toBe(false);
  });

  it('fails closed when no origin is configured', () => {
    expect(checkOrigin({ method: 'POST', origin: DESK }, []).ok).toBe(false);
  });

  it('derives the allowed origins from DESK_ORIGIN, dev fallback only outside production', () => {
    expect(allowedOrigins(`${DESK}/`, true)).toEqual([DESK]);
    expect(allowedOrigins(undefined, true)).toEqual([]);
    expect(allowedOrigins(undefined, false)).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
    expect(normalizeOrigin('ftp://x.example')).toBeNull();
    expect(normalizeOrigin('https://X.example:443/a?b')).toBe('https://x.example');
  });
});

describe('CSP', () => {
  it('never allows eval in production and forbids framing', () => {
    for (const nonce of [null, 'abc123==']) {
      const csp = buildCsp(nonce, { isDev: false });
      expect(csp).not.toContain('unsafe-eval');
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("form-action 'self'");
    }
    expect(buildCsp('abc123==', { isDev: false })).toContain("script-src 'self' 'nonce-abc123==' 'strict-dynamic'");
    expect(buildCsp('abc123==', { isDev: false })).not.toContain('unsafe-inline');
  });
});

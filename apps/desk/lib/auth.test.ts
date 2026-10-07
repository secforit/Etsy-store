import { createHmac, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DESK_ACTOR,
  hashPassword,
  parsePasswordHash,
  revokeAllSessions,
  sessionsNotBeforeMs,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  sessionCookieOptions,
  signSession,
  verifyPassword,
  verifySession,
} from './auth.ts';

// Fast parameters for tests (production hashes use N=2^17).
const FAST = { N: 2 ** 14, r: 8, p: 1 };
const SECRET = 'a'.repeat(16) + 'B'.repeat(16) + '-session-secret';
const OTHER_SECRET = 'z'.repeat(40);
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

describe('password hashing (scrypt$N$r$p$saltB64$hashB64)', () => {
  it('round-trips and rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple', FAST);
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false);
    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false);
  });

  it('verifies a hash produced independently with node:crypto (CLI format compatibility)', async () => {
    const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const key = scryptSync('desk-password-123', salt, 64, { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const stored = `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
    expect(await verifyPassword('desk-password-123', stored)).toBe(true);
    expect(await verifyPassword('desk-password-124', stored)).toBe(false);
  });

  it('normalises passwords to NFC like the CLI', async () => {
    const composed = 'café-password';
    const decomposed = 'café-password';
    const stored = await hashPassword(composed, FAST);
    expect(await verifyPassword(decomposed, stored)).toBe(true);
  });

  it('accepts production-strength parameters (N=2^17)', async () => {
    const stored = await hashPassword('strong-enough-password', { N: 2 ** 17, r: 8, p: 1 });
    expect(parsePasswordHash(stored)?.N).toBe(2 ** 17);
    expect(await verifyPassword('strong-enough-password', stored)).toBe(true);
  });

  it('fails closed on malformed or out-of-bounds hashes', async () => {
    const good = await hashPassword('pw-for-malformed-tests', FAST);
    const [, , , , salt, hash] = good.split('$');
    const bad = [
      '',
      'not-a-hash',
      `bcrypt$16384$8$1$${salt}$${hash}`,
      `scrypt$16384$8$1$${salt}`, // too few parts
      `scrypt$16383$8$1$${salt}$${hash}`, // N not a power of two
      `scrypt$8192$8$1$${salt}$${hash}`, // N too small
      `scrypt$${2 ** 21}$8$1$${salt}$${hash}`, // N too large (memory DoS)
      `scrypt$16384$64$1$${salt}$${hash}`, // r too large
      `scrypt$16384$8$99$${salt}$${hash}`, // p too large
      `scrypt$16384$8$1$${salt}$***`, // bad base64
      `scrypt$16384$8$1$c2FsdA==$${hash}`, // salt too short
      `scrypt$-1$8$1$${salt}$${hash}`,
    ];
    for (const stored of bad) {
      expect(parsePasswordHash(stored)).toBeNull();
      expect(await verifyPassword('pw-for-malformed-tests', stored)).toBe(false);
    }
    expect(await verifyPassword('pw-for-malformed-tests', undefined)).toBe(false);
    expect(await verifyPassword('pw-for-malformed-tests', null)).toBe(false);
  });

  it('rejects empty and over-long passwords without hashing', async () => {
    const stored = await hashPassword('x'.repeat(20), FAST);
    expect(await verifyPassword('', stored)).toBe(false);
    expect(await verifyPassword('x'.repeat(1025), stored)).toBe(false);
  });
});

describe('session cookie (HMAC-SHA256, issued-at, 12 h)', () => {
  it('signs and verifies', () => {
    const token = signSession(SECRET, T0);
    expect(token.split('.')).toHaveLength(4);
    const session = verifySession(token, SECRET, T0 + 1000);
    expect(session).toEqual({ actor: DESK_ACTOR, issuedAtMs: T0, expiresAtMs: T0 + SESSION_MAX_AGE_MS });
  });

  it('produces a different token each time (random nonce)', () => {
    expect(signSession(SECRET, T0)).not.toBe(signSession(SECRET, T0));
  });

  it('rejects a token signed with another secret', () => {
    expect(verifySession(signSession(OTHER_SECRET, T0), SECRET, T0 + 1000)).toBeNull();
  });

  it('rejects tampering with the signature, the issued-at, the nonce or the version', () => {
    const token = signSession(SECRET, T0);
    const [v, iat, nonce, sig] = token.split('.') as [string, string, string, string];
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    expect(verifySession([v, iat, nonce, flip(sig, 5)].join('.'), SECRET, T0)).toBeNull();
    expect(verifySession([v, String(T0 + SESSION_MAX_AGE_MS), nonce, sig].join('.'), SECRET, T0)).toBeNull();
    expect(verifySession([v, iat, flip(nonce, 0), sig].join('.'), SECRET, T0)).toBeNull();
    expect(verifySession(['v2', iat, nonce, sig].join('.'), SECRET, T0)).toBeNull();
    // A forged token: correct structure, HMAC computed with a guessed key.
    const forgedSig = createHmac('sha256', 'guess').update(`v1.${iat}.${nonce}`).digest('base64url');
    expect(verifySession([v, iat, nonce, forgedSig].join('.'), SECRET, T0)).toBeNull();
  });

  it('expires after 12 hours', () => {
    const token = signSession(SECRET, T0);
    expect(verifySession(token, SECRET, T0 + SESSION_MAX_AGE_MS - 1)).not.toBeNull();
    expect(verifySession(token, SECRET, T0 + SESSION_MAX_AGE_MS)).toBeNull();
    expect(verifySession(token, SECRET, T0 + 13 * 3600_000)).toBeNull();
    expect(SESSION_MAX_AGE_MS).toBe(12 * 3600_000);
  });

  it('rejects every session issued at or before a sign-out', () => {
    const before = signSession(SECRET, T0);
    const atSignOut = signSession(SECRET, T0 + 5_000);
    const after = signSession(SECRET, T0 + 5_001);
    const now = T0 + 10_000;
    expect(verifySession(before, SECRET, now, SESSION_MAX_AGE_MS, T0 + 5_000)).toBeNull();
    expect(verifySession(atSignOut, SECRET, now, SESSION_MAX_AGE_MS, T0 + 5_000)).toBeNull();
    expect(verifySession(after, SECRET, now, SESSION_MAX_AGE_MS, T0 + 5_000)).not.toBeNull();
    expect(verifySession(before, SECRET, now, SESSION_MAX_AGE_MS, 0)).not.toBeNull();
  });

  it('keeps the latest sign-out instant process-wide', () => {
    const start = sessionsNotBeforeMs();
    revokeAllSessions(start + 2_000);
    revokeAllSessions(start + 1_000); // an older instant never moves it back
    expect(sessionsNotBeforeMs()).toBe(start + 2_000);
  });

  it('rejects an issued-at in the future beyond the clock-skew allowance', () => {
    expect(verifySession(signSession(SECRET, T0 + 30_000), SECRET, T0)).not.toBeNull();
    expect(verifySession(signSession(SECRET, T0 + 5 * 60_000), SECRET, T0)).toBeNull();
  });

  it('fails closed on garbage, missing tokens and missing/short secrets', () => {
    const token = signSession(SECRET, T0);
    for (const t of [undefined, null, '', 'abc', 'v1.1.2', 'v1.x.yyyyyyyyyyyyyyyyyyyy.zzzz', `${token}.extra`, 'a'.repeat(300)]) {
      expect(verifySession(t, SECRET, T0)).toBeNull();
    }
    expect(verifySession(token, undefined, T0)).toBeNull();
    expect(verifySession(token, 'short', T0)).toBeNull();
    expect(() => signSession('short', T0)).toThrow();
  });

  it('uses a __Host- cookie that is httpOnly, Secure, SameSite=Strict, 12 h', () => {
    expect(SESSION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    expect(sessionCookieOptions()).toEqual({ httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 43_200 });
  });
});

/**
 * Desk authentication primitives (security rule 8). Pure functions over node:crypto so they can be
 * unit-tested and used from both the proxy and server actions. No framework imports here.
 *
 * Password hash format (shared with `worker hash-password`): scrypt$N$r$p$saltB64$hashB64
 * Session cookie value: v1.<issuedAtMs>.<nonceB64url>.<hmacB64url>
 *   hmac = HMAC-SHA256(key, "v1.<issuedAtMs>.<nonceB64url>"), key derived from DESK_SESSION_SECRET.
 */
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

/** `__Host-` prefix: browser enforces Secure, Path=/ and no Domain attribute. */
export const SESSION_COOKIE_NAME = '__Host-desk_session';
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
export const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
/** Tolerated clock skew for an issued-at slightly in the future. */
const MAX_FUTURE_SKEW_MS = 60_000;
/** Single-user desk: every authenticated action is Razvan's. */
export const DESK_ACTOR = 'razvan';
export const MIN_SESSION_SECRET_LENGTH = 32;
/** Inputs longer than this are rejected before hashing (scrypt cost is fixed, but keep inputs sane). */
export const MAX_PASSWORD_LENGTH = 1024;

// Bounds on parameters read from DESK_PASSWORD_HASH so a bad value cannot exhaust memory/CPU.
const MIN_LOG_N = 14; // N >= 16384 (Node's default)
const MAX_LOG_N = 20; // N <= 1048576 (~1 GiB at r=8; refuse anything larger)
const MAX_R = 32;
const MAX_P = 16;
const MIN_SALT_BYTES = 16;
const MIN_HASH_BYTES = 16;
const MAX_HASH_BYTES = 128;
const B64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Same defaults as `worker hash-password` (packages/core/src/desk/password.ts): N=2^17, r=8, p=1, 64-byte key. */
export const DEFAULT_SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, saltBytes: 16, keyLen: 64 } as const;

/** Passwords are NFC-normalised before hashing, exactly like the CLI that writes DESK_PASSWORD_HASH. */
function scrypt(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize('NFC'), salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function scryptOptions(N: number, r: number, p: number): ScryptOptions {
  // OpenSSL needs about 128*r*(N+p+2) bytes; Node's default maxmem (32 MiB) is too small for N=2^17.
  return { N, r, p, maxmem: 256 * N * r + 16 * 1024 * 1024 };
}

export interface ParsedPasswordHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parsePositiveInt(s: string | undefined): number | null {
  if (!s || !/^[0-9]{1,8}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Parses and bounds-checks `scrypt$N$r$p$saltB64$hashB64`; null when malformed or out of bounds. */
export function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  const parts = stored.trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = parsePositiveInt(parts[1]);
  const r = parsePositiveInt(parts[2]);
  const p = parsePositiveInt(parts[3]);
  if (N === null || r === null || p === null) return null;
  if ((N & (N - 1)) !== 0) return null; // power of two
  const logN = Math.log2(N);
  if (logN < MIN_LOG_N || logN > MAX_LOG_N || r > MAX_R || p > MAX_P) return null;
  const saltB64 = parts[4] ?? '';
  const hashB64 = parts[5] ?? '';
  if (!B64_RE.test(saltB64) || !B64_RE.test(hashB64)) return null;
  const salt = Buffer.from(saltB64, 'base64');
  const hash = Buffer.from(hashB64, 'base64');
  if (salt.length < MIN_SALT_BYTES || hash.length < MIN_HASH_BYTES || hash.length > MAX_HASH_BYTES) return null;
  return { N, r, p, salt, hash };
}

/** Produces a hash in the shared format. Used by tests; the CLI (`worker hash-password`) makes the real one. */
export async function hashPassword(
  password: string,
  params: { N?: number; r?: number; p?: number; salt?: Buffer; keyLen?: number } = {},
): Promise<string> {
  const N = params.N ?? DEFAULT_SCRYPT_PARAMS.N;
  const r = params.r ?? DEFAULT_SCRYPT_PARAMS.r;
  const p = params.p ?? DEFAULT_SCRYPT_PARAMS.p;
  const salt = params.salt ?? randomBytes(DEFAULT_SCRYPT_PARAMS.saltBytes);
  const keyLen = params.keyLen ?? DEFAULT_SCRYPT_PARAMS.keyLen;
  const hash = await scrypt(password, salt, keyLen, scryptOptions(N, r, p));
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Timing-safe password check. Returns false (never throws) for a wrong password, an over-long input,
 * or a malformed/out-of-bounds stored hash.
 */
export async function verifyPassword(password: string, stored: string | undefined | null): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  if (!stored) return false;
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  let derived: Buffer;
  try {
    derived = await scrypt(password, parsed.salt, parsed.hash.length, scryptOptions(parsed.N, parsed.r, parsed.p));
  } catch {
    return false;
  }
  return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
}

// ---------------------------------------------------------------------------------------------
// Session cookie
// ---------------------------------------------------------------------------------------------

export interface Session {
  actor: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

/** Domain-separated HMAC key so the raw secret is never used directly for this purpose. */
function sessionKey(secret: string): Buffer {
  if (typeof secret !== 'string' || secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(`session secret must be at least ${MIN_SESSION_SECRET_LENGTH} characters`);
  }
  return createHmac('sha256', secret).update('etsy-agents/desk/session/v1').digest();
}

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', sessionKey(secret)).update(payload).digest();
}

/** Creates a signed session token issued at `issuedAtMs`. */
export function signSession(secret: string, issuedAtMs: number, nonce: Buffer = randomBytes(16)): string {
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) throw new Error('issuedAtMs must be a non-negative integer');
  const payload = `v1.${issuedAtMs}.${nonce.toString('base64url')}`;
  return `${payload}.${mac(secret, payload).toString('base64url')}`;
}

/**
 * Verifies signature (timing-safe), issued-at and the 12 h lifetime. Returns null for anything invalid,
 * including a missing/short secret, so callers fail closed.
 */
export function verifySession(
  token: string | undefined | null,
  secret: string | undefined | null,
  nowMs: number,
  maxAgeMs: number = SESSION_MAX_AGE_MS,
): Session | null {
  if (!token || !secret || secret.length < MIN_SESSION_SECRET_LENGTH) return null;
  if (token.length > 256) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, issuedAtRaw, nonce, sig] = parts as [string, string, string, string];
  if (version !== 'v1') return null;
  if (!/^[0-9]{1,15}$/.test(issuedAtRaw)) return null;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(sig)) return null; // 32 bytes base64url, no padding
  const expected = mac(secret, `${version}.${issuedAtRaw}.${nonce}`);
  const provided = Buffer.from(sig, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  const issuedAtMs = Number(issuedAtRaw);
  if (issuedAtMs > nowMs + MAX_FUTURE_SKEW_MS) return null;
  if (nowMs - issuedAtMs >= maxAgeMs) return null;
  return { actor: DESK_ACTOR, issuedAtMs, expiresAtMs: issuedAtMs + maxAgeMs };
}

/** Cookie attributes for the session cookie (httpOnly, Secure, SameSite=Strict, 12 h). */
export function sessionCookieOptions(): {
  httpOnly: true;
  secure: true;
  sameSite: 'strict';
  path: '/';
  maxAge: number;
} {
  return { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: SESSION_MAX_AGE_SECONDS };
}

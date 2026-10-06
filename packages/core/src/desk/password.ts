/**
 * Desk password hashing (worker `hash-password` writes DESK_PASSWORD_HASH).
 * Format: scrypt$N$r$p$saltB64$hashB64   (N = CPU/memory cost, r = block size, p = parallelism; 64-byte key)
 * Defaults follow OWASP: N = 2^17, r = 8, p = 1 (about 128 MiB per check). A verifier MUST read N/r/p from the
 * string and pass maxmem >= 128 * N * r * (p + 1) to scrypt, because Node's default maxmem is 32 MiB.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export const SCRYPT_DEFAULTS = { N: 2 ** 17, r: 8, p: 1, keyLen: 64, saltLen: 16 } as const;

function scrypt(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFC'), salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export function scryptMaxmem(N: number, r: number, p: number): number {
  return 128 * N * r * (p + 1) + 16 * 1024 * 1024;
}

function checkParams(N: number, r: number, p: number): void {
  if (!Number.isSafeInteger(N) || N < 2 ** 14 || N > 2 ** 20 || (N & (N - 1)) !== 0) throw new Error('scrypt N must be a power of two in [2^14, 2^20]');
  if (!Number.isSafeInteger(r) || r < 8 || r > 32) throw new Error('scrypt r must be in [8, 32]');
  if (!Number.isSafeInteger(p) || p < 1 || p > 4) throw new Error('scrypt p must be in [1, 4]');
}

export async function hashPassword(
  password: string,
  params: { N?: number; r?: number; p?: number; salt?: Buffer } = {},
): Promise<string> {
  if (typeof password !== 'string' || password.length < 12) throw new Error('password must be at least 12 characters');
  if (password.length > 1024) throw new Error('password is too long');
  const N = params.N ?? SCRYPT_DEFAULTS.N;
  const r = params.r ?? SCRYPT_DEFAULTS.r;
  const p = params.p ?? SCRYPT_DEFAULTS.p;
  checkParams(N, r, p);
  const salt = params.salt ?? randomBytes(SCRYPT_DEFAULTS.saltLen);
  const key = await scrypt(password, salt, SCRYPT_DEFAULTS.keyLen, { N, r, p, maxmem: scryptMaxmem(N, r, p) });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Constant-time check against a stored `scrypt$N$r$p$salt$hash` string. False for malformed input. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  try {
    checkParams(N, r, p);
  } catch {
    return false;
  }
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (salt.length < 8 || expected.length < 32) return false;
  const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: scryptMaxmem(N, r, p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.ts';

describe('desk password hashing', () => {
  it('produces scrypt$N$r$p$salt$hash and verifies it', async () => {
    const hash = await hashPassword('correct horse battery', { N: 2 ** 14 });
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false);
  });

  it('uses OWASP defaults (N=2^17, r=8, p=1)', async () => {
    const hash = await hashPassword('another long password');
    expect(hash.split('$').slice(0, 4)).toEqual(['scrypt', String(2 ** 17), '8', '1']);
    expect(await verifyPassword('another long password', hash)).toBe(true);
  });

  it('rejects short passwords and malformed hashes', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 12/);
    expect(await verifyPassword('x', 'bcrypt$whatever')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$3$8$1$AAAA$BBBB')).toBe(false);
  });
});

/**
 * logoutAction is reachable without a session (the public /login page renders the actions module), so it must
 * revoke sessions only for a caller that HAS a valid session; anyone else only gets their own cookie cleared.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://desk.example.ts.net';
const SECRET = 's'.repeat(48);

const state = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  sets: [] as { name: string; value: string; maxAge?: number }[],
  headers: new Map<string, string>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  RedirectType: { replace: 'replace', push: 'push' },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookie !== undefined && name ? { name, value: state.cookie } : undefined),
    set: (name: string, value: string, opts: { maxAge?: number } = {}) => {
      state.sets.push({ name, value, maxAge: opts.maxAge });
    },
  }),
  headers: async () => ({ get: (name: string) => state.headers.get(name.toLowerCase()) ?? null }),
}));
vi.mock('./config.ts', () => ({
  tryGetDeskConfig: () => ({
    ok: true,
    config: { env: {}, sessionSecret: SECRET, passwordHash: null, deskOrigin: ORIGIN, allowedOrigins: [ORIGIN] },
  }),
  getDeskConfig: () => ({ env: {}, sessionSecret: SECRET, passwordHash: null, deskOrigin: ORIGIN, allowedOrigins: [ORIGIN] }),
}));
vi.mock('./service.ts', () => ({ getDeskService: vi.fn() }));

const { logoutAction } = await import('./actions.ts');
const { signSession, verifySession, sessionsNotBeforeMs } = await import('./auth.ts');

beforeEach(() => {
  state.cookie = undefined;
  state.sets.length = 0;
  state.headers = new Map([['origin', ORIGIN]]);
});

describe('logoutAction', () => {
  it('without a session: clears the cookie but revokes nothing (no sign-out DoS from /login)', async () => {
    const victim = signSession(SECRET, Date.now() - 1000);
    const before = sessionsNotBeforeMs();
    await expect(logoutAction()).rejects.toThrow('REDIRECT /login');
    expect(sessionsNotBeforeMs()).toBe(before);
    expect(verifySession(victim, SECRET, Date.now(), undefined, sessionsNotBeforeMs())).not.toBeNull();
    expect(state.sets).toEqual([expect.objectContaining({ value: '', maxAge: 0 })]);
  });

  it('with a forged or invalid cookie: revokes nothing', async () => {
    state.cookie = 'v1.123.abcdefghijklmnop.' + 'A'.repeat(43);
    const before = sessionsNotBeforeMs();
    await expect(logoutAction()).rejects.toThrow('REDIRECT /login');
    expect(sessionsNotBeforeMs()).toBe(before);
  });

  it('with a valid session: revokes every session issued so far', async () => {
    const other = signSession(SECRET, Date.now() - 2000);
    state.cookie = signSession(SECRET, Date.now() - 1000);
    await expect(logoutAction()).rejects.toThrow('REDIRECT /login');
    expect(verifySession(other, SECRET, Date.now(), undefined, sessionsNotBeforeMs())).toBeNull();
    expect(state.sets).toEqual([expect.objectContaining({ value: '', maxAge: 0 })]);
  });

  it('still refuses a cross-origin request before anything else', async () => {
    state.headers = new Map([['origin', 'https://evil.example']]);
    state.cookie = signSession(SECRET, Date.now() - 1000);
    await expect(logoutAction()).rejects.toThrow('Request origin not allowed.');
    expect(state.sets).toEqual([]);
  });
});

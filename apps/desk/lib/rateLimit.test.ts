import { describe, expect, it } from 'vitest';
import {
  clientIpFromHeaders,
  createLoginLimiters,
  LOGIN_LIMIT_PER_IP,
  LOGIN_WINDOW_MS,
  SlidingWindowRateLimiter,
} from './rateLimit.ts';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('SlidingWindowRateLimiter', () => {
  it('allows 5 attempts per 15 minutes per key, then blocks', () => {
    const c = clock();
    const { perIp } = createLoginLimiters(c.now);
    expect(LOGIN_LIMIT_PER_IP).toBe(5);
    expect(LOGIN_WINDOW_MS).toBe(15 * 60_000);
    for (let i = 0; i < 5; i++) {
      expect(perIp.check('100.64.0.1').allowed).toBe(true);
      perIp.hit('100.64.0.1');
      c.advance(1000);
    }
    const blocked = perIp.check('100.64.0.1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    // Oldest hit was 5 s ago, so it leaves the window in 15 min - 5 s.
    expect(blocked.retryAfterMs).toBe(LOGIN_WINDOW_MS - 5000);
  });

  it('slides: attempts become available again as old ones leave the window', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 5, windowMs: LOGIN_WINDOW_MS, now: c.now });
    for (let i = 0; i < 5; i++) rl.hit('ip');
    expect(rl.check('ip').allowed).toBe(false);
    c.advance(LOGIN_WINDOW_MS - 1);
    expect(rl.check('ip').allowed).toBe(false);
    c.advance(1);
    const d = rl.check('ip');
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(5);
  });

  it('keeps keys independent and reset clears one key', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 2, windowMs: 60_000, now: c.now });
    rl.hit('a');
    rl.hit('a');
    expect(rl.check('a').allowed).toBe(false);
    expect(rl.check('b').allowed).toBe(true);
    rl.reset('a');
    expect(rl.check('a').allowed).toBe(true);
  });

  it('bounds memory with maxKeys', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 3, now: c.now });
    for (const k of ['a', 'b', 'c', 'd', 'e']) rl.hit(k);
    expect(rl.size).toBe(3);
    expect(rl.check('e').remaining).toBe(4);
  });

  it('rejects invalid configuration', () => {
    expect(() => new SlidingWindowRateLimiter({ limit: 0, windowMs: 1 })).toThrow();
    expect(() => new SlidingWindowRateLimiter({ limit: 1, windowMs: 0 })).toThrow();
  });
});

describe('clientIpFromHeaders', () => {
  const from = (h: Record<string, string>) => (name: string) => h[name] ?? null;

  it('uses the last X-Forwarded-For hop (appended by tailscale serve)', () => {
    expect(clientIpFromHeaders(from({ 'x-forwarded-for': '1.2.3.4, 100.101.102.103' }))).toBe('100.101.102.103');
    expect(clientIpFromHeaders(from({ 'x-forwarded-for': 'fd7a:115c:a1e0::1' }))).toBe('fd7a:115c:a1e0::1');
  });

  it('falls back to X-Real-IP, then a shared bucket', () => {
    expect(clientIpFromHeaders(from({ 'x-forwarded-for': 'not an ip', 'x-real-ip': '10.0.0.7' }))).toBe('10.0.0.7');
    expect(clientIpFromHeaders(from({}))).toBe('unknown');
    expect(clientIpFromHeaders(from({ 'x-forwarded-for': '<script>' }))).toBe('unknown');
  });
});

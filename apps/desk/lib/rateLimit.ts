/**
 * In-memory sliding-window rate limiter (login: 5 failed attempts per IP per 15 minutes).
 * Single desk process, single user: memory state is enough. Pure; clock injected for tests.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Hits left in the current window. */
  remaining: number;
  /** When blocked: ms until the oldest hit leaves the window. 0 when allowed. */
  retryAfterMs: number;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  /** Bound on tracked keys so spoofed keys cannot grow memory without limit. */
  maxKeys?: number;
  now?: () => number;
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(opts: RateLimiterOptions) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new Error('limit must be a positive integer');
    if (!(opts.windowMs > 0)) throw new Error('windowMs must be positive');
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }

  private live(key: string, now: number): number[] {
    const list = this.hits.get(key);
    if (!list) return [];
    const cutoff = now - this.windowMs;
    const kept = list.filter((t) => t > cutoff);
    if (kept.length === 0) this.hits.delete(key);
    else if (kept.length !== list.length) this.hits.set(key, kept);
    return kept;
  }

  /** Whether another attempt is allowed for `key` right now. Does not record anything. */
  check(key: string): RateLimitDecision {
    const now = this.now();
    const list = this.live(key, now);
    if (list.length < this.limit) return { allowed: true, remaining: this.limit - list.length, retryAfterMs: 0 };
    const oldest = list[list.length - this.limit] ?? now;
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
  }

  /** Records one attempt (e.g. a failed login) for `key`. */
  hit(key: string): void {
    const now = this.now();
    const list = this.live(key, now);
    list.push(now);
    // Keep only what can still matter for the decision.
    this.hits.delete(key);
    this.hits.set(key, list.slice(-this.limit));
    this.evict(now);
  }

  /** Clears `key` (e.g. after a successful login). */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Number of tracked keys (for tests). */
  get size(): number {
    return this.hits.size;
  }

  private evict(now: number): void {
    if (this.hits.size <= this.maxKeys) return;
    // Drop expired keys first, then the least recently hit (Map keeps insertion order).
    for (const key of [...this.hits.keys()]) this.live(key, now);
    while (this.hits.size > this.maxKeys) {
      const first = this.hits.keys().next();
      if (first.done) break;
      this.hits.delete(first.value);
    }
  }
}

const IP_RE = /^[0-9A-Fa-f:.]{2,45}$/;

/**
 * Client IP for rate limiting. Behind `tailscale serve` the proxy appends the real client address to
 * X-Forwarded-For, so the LAST entry is the one written by the trusted hop. Falls back to X-Real-IP,
 * then a shared bucket.
 */
export function clientIpFromHeaders(get: (name: string) => string | null | undefined): string {
  const xff = get('x-forwarded-for');
  if (xff) {
    const last = xff.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last && IP_RE.test(last)) return last;
  }
  const real = get('x-real-ip')?.trim();
  if (real && IP_RE.test(real)) return real;
  return 'unknown';
}

export const LOGIN_LIMIT_PER_IP = 5;
export const LOGIN_LIMIT_GLOBAL = 50;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export interface LoginLimiters {
  perIp: SlidingWindowRateLimiter;
  /** Ceiling across all IPs, in case forwarded addresses are spoofed by something on the host. */
  global: SlidingWindowRateLimiter;
}

export function createLoginLimiters(now?: () => number): LoginLimiters {
  return {
    perIp: new SlidingWindowRateLimiter({ limit: LOGIN_LIMIT_PER_IP, windowMs: LOGIN_WINDOW_MS, ...(now ? { now } : {}) }),
    global: new SlidingWindowRateLimiter({ limit: LOGIN_LIMIT_GLOBAL, windowMs: LOGIN_WINDOW_MS, ...(now ? { now } : {}) }),
  };
}

const LIMITERS_KEY = Symbol.for('etsy-agents.desk.loginLimiters');

/** Process-wide login limiters (survive module re-evaluation in dev). */
export function loginLimiters(): LoginLimiters {
  const g = globalThis as unknown as Record<symbol, LoginLimiters | undefined>;
  let limiters = g[LIMITERS_KEY];
  if (!limiters) {
    limiters = createLoginLimiters();
    g[LIMITERS_KEY] = limiters;
  }
  return limiters;
}

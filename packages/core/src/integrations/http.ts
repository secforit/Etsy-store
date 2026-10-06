/**
 * Shared outbound HTTP for every integration (security rule 5):
 * - HTTPS only for the internet (plain HTTP only when a client is explicitly marked internal: ollama, imagegen),
 * - explicit per-attempt timeouts (default 20 s),
 * - retries ONLY on 429 / 5xx, honouring `retry-after` (seconds or HTTP date), exponential backoff with jitter otherwise,
 * - a token bucket per service,
 * - no redirects for API clients, response size limits,
 * - `safeFetchAllowlisted` for third-party URLs (https, host allowlist, no cross-host redirects, size limit).
 *
 * Error messages carry the service + an operation label, never the URL (Marker puts credentials in the path)
 * and never request headers.
 */
import type { Logger } from '../orchestrator/contracts.ts';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type HttpErrorKind =
  | 'status' // non-2xx response
  | 'timeout'
  | 'network'
  | 'too_large'
  | 'redirect' // unexpected or disallowed redirect
  | 'blocked' // URL rejected before any request (scheme, host allowlist, credentials in URL)
  | 'invalid_response'; // body did not match the expected shape

export class HttpError extends Error {
  readonly service: string;
  readonly operation: string;
  readonly kind: HttpErrorKind;
  readonly status: number | null;
  /** True for conditions worth retrying later (429, 5xx, timeouts, network errors). */
  readonly retryable: boolean;
  /** Server-suggested wait (from retry-after), if any. */
  readonly retryAfterMs: number | null;

  constructor(args: {
    service: string;
    operation: string;
    kind: HttpErrorKind;
    status?: number | null;
    retryable?: boolean;
    retryAfterMs?: number | null;
    detail?: string;
  }) {
    const status = args.status ?? null;
    const head = `${args.service} ${args.operation} failed`;
    const what =
      args.kind === 'status' ? `HTTP ${status}` : args.kind === 'invalid_response' ? 'invalid response' : args.kind;
    super(args.detail ? `${head}: ${what}: ${args.detail}` : `${head}: ${what}`);
    this.name = 'HttpError';
    this.service = args.service;
    this.operation = args.operation;
    this.kind = args.kind;
    this.status = status;
    this.retryable = args.retryable ?? false;
    this.retryAfterMs = args.retryAfterMs ?? null;
  }
}

export function isHttpError(e: unknown): e is HttpError {
  return e instanceof HttpError;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Parses `retry-after` (delta-seconds or HTTP-date). Returns milliseconds to wait, or null. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (value == null) return null;
  const v = value.trim();
  if (v === '') return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/** Single-line, length-capped excerpt of an error body (for diagnostics only). */
export function sanitizeSnippet(text: string, max = 200): string {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, max)
    .trim();
}

/* ------------------------------ Token bucket ------------------------------ */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = { now: () => Date.now(), sleep: defaultSleep };

/**
 * Classic token bucket; `take()` waits (FIFO) until a token is available.
 * capacity = burst size, refillPerSecond = sustained rate.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly capacity: number,
    readonly refillPerSecond: number,
    private readonly clock: Clock = systemClock,
  ) {
    if (!(capacity >= 1) || !(refillPerSecond > 0)) throw new Error('TokenBucket: capacity >= 1 and refill > 0 required');
    this.tokens = capacity;
    this.last = clock.now();
  }

  /** Tokens currently available (after refill), for tests and diagnostics. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  take(): Promise<void> {
    const next = this.queue.then(() => this.takeOne());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
  }

  private async takeOne(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(1, Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000));
      await this.clock.sleep(waitMs);
    }
  }
}

/** Documented (or conservative) limits per service. */
export const SERVICE_LIMITS = {
  /** Etsy publishes per-app limits in the developer portal; stay well under the classic 10 QPS. */
  etsy: { capacity: 5, refillPerSecond: 5 },
  /** Printify: 600 requests/minute global. */
  printify: { capacity: 10, refillPerSecond: 9 },
  /** Printify catalog: 100 requests/minute (on top of the global limit). */
  printifyCatalog: { capacity: 5, refillPerSecond: 1.5 },
  /** Printify publish: 200 requests / 30 minutes. */
  printifyPublish: { capacity: 10, refillPerSecond: 190 / 1800 },
  marker: { capacity: 2, refillPerSecond: 1 },
  pinterest: { capacity: 2, refillPerSecond: 1 },
  recraft: { capacity: 2, refillPerSecond: 1 },
} as const;

export function createServiceBucket(service: keyof typeof SERVICE_LIMITS, clock: Clock = systemClock): TokenBucket {
  const l = SERVICE_LIMITS[service];
  return new TokenBucket(l.capacity, l.refillPerSecond, clock);
}

/* ------------------------------ Body reading ------------------------------ */

/** Reads a response body, aborting once it exceeds maxBytes. */
export async function readBodyLimited(
  res: Response,
  maxBytes: number,
  ctx: { service: string; operation: string },
): Promise<Uint8Array> {
  const declared = res.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpError({ ...ctx, kind: 'too_large', status: res.status, detail: `content-length > ${maxBytes}` });
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError({ ...ctx, kind: 'too_large', status: res.status, detail: `body > ${maxBytes} bytes` });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function readErrorSnippet(res: Response): Promise<string> {
  try {
    const bytes = await readBodyLimited(res, 16 * 1024, { service: '-', operation: '-' });
    return sanitizeSnippet(new TextDecoder().decode(bytes));
  } catch {
    return '';
  }
}

/* ------------------------------- HttpClient -------------------------------- */

export type RetryPolicy =
  /** Retry 429 and 5xx (safe for GET / idempotent writes). */
  | 'default'
  /** Retry only 429 (the request was not processed). Use for non-idempotent creates. */
  | 'rate_limit_only'
  | 'none';

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Absolute URL, or a path appended to the client's baseUrl. */
  url: string;
  query?: Record<string, string | number | boolean | readonly (string | number)[] | null | undefined>;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  body?: Uint8Array;
  contentType?: string;
  /** Short label used in errors and logs instead of the URL. */
  operation: string;
  timeoutMs?: number;
  retry?: RetryPolicy;
  maxRetries?: number;
  /** Extra bucket for this call only (e.g. Printify publish limit). */
  bucket?: TokenBucket;
  maxResponseBytes?: number;
  /** Include a sanitised excerpt of the error body in the error message (default true). */
  exposeErrorBody?: boolean;
  /** Skip the client's default (auth) headers. */
  skipDefaultHeaders?: boolean;
}

export interface HttpResult {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

export interface HttpClientOptions {
  service: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Static or computed headers added to every request (auth). */
  defaultHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  timeoutMs?: number;
  maxRetries?: number;
  bucket?: TokenBucket | null;
  /** Plain HTTP allowed (internal Docker-network services only: ollama, imagegen). */
  allowHttp?: boolean;
  /** Longest retry-after we are willing to sleep inside a request; longer = throw a retryable error. */
  maxRetryAfterMs?: number;
  maxResponseBytes?: number;
  clock?: Clock;
  random?: () => number;
  logger?: Logger;
}

export const DEFAULT_TIMEOUT_MS = 20_000;
export const INTERNAL_GPU_TIMEOUT_MS = 300_000;

export class HttpClient {
  readonly service: string;
  readonly timeoutMs: number;
  readonly allowHttp: boolean;
  private readonly baseUrl: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly defaultHeaders: HttpClientOptions['defaultHeaders'];
  private readonly maxRetries: number;
  private readonly bucket: TokenBucket | null;
  private readonly maxRetryAfterMs: number;
  private readonly maxResponseBytes: number;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly logger: Logger | undefined;

  constructor(opts: HttpClientOptions) {
    this.service = opts.service;
    this.baseUrl = opts.baseUrl ? opts.baseUrl.replace(/\/+$/, '') : null;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.defaultHeaders = opts.defaultHeaders;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? 3;
    this.bucket = opts.bucket ?? null;
    this.allowHttp = opts.allowHttp ?? false;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
    this.maxResponseBytes = opts.maxResponseBytes ?? 25 * 1024 * 1024;
    this.clock = opts.clock ?? systemClock;
    this.random = opts.random ?? Math.random;
    this.logger = opts.logger;
    if (this.baseUrl) this.checkScheme(new URL(this.baseUrl), 'init');
  }

  /** Exponential backoff with jitter, capped at 10 s. */
  backoffMs(attempt: number): number {
    return Math.min(10_000, 500 * 2 ** attempt) + Math.floor(this.random() * 250);
  }

  private buildUrl(req: HttpRequest): URL {
    let url: URL;
    if (/^https?:\/\//i.test(req.url)) url = new URL(req.url);
    else {
      if (!this.baseUrl) throw new Error(`${this.service}: relative URL without baseUrl`);
      url = new URL(this.baseUrl + (req.url.startsWith('/') ? req.url : `/${req.url}`));
    }
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
      else url.searchParams.set(k, String(v));
    }
    this.checkScheme(url, req.operation);
    return url;
  }

  private checkScheme(url: URL, operation: string): void {
    const ok = url.protocol === 'https:' || (this.allowHttp && url.protocol === 'http:');
    if (!ok)
      throw new HttpError({ service: this.service, operation, kind: 'blocked', detail: `scheme ${url.protocol} not allowed` });
    if (url.username || url.password)
      throw new HttpError({ service: this.service, operation, kind: 'blocked', detail: 'credentials in URL' });
  }

  async request(req: HttpRequest): Promise<HttpResult> {
    const url = this.buildUrl(req);
    const method = req.method ?? 'GET';
    const policy = req.retry ?? 'default';
    const maxRetries = policy === 'none' ? 0 : (req.maxRetries ?? this.maxRetries);
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;
    const maxBytes = req.maxResponseBytes ?? this.maxResponseBytes;
    const ctx = { service: this.service, operation: req.operation };

    for (let attempt = 0; ; attempt++) {
      if (this.bucket) await this.bucket.take();
      if (req.bucket) await req.bucket.take();

      const headers: Record<string, string> = {};
      if (!req.skipDefaultHeaders && this.defaultHeaders) Object.assign(headers, await this.defaultHeaders());
      Object.assign(headers, req.headers ?? {});
      let body: RequestInit['body'];
      if (req.json !== undefined) {
        body = JSON.stringify(req.json);
        headers['content-type'] = 'application/json';
      } else if (req.form) {
        body = new URLSearchParams(req.form).toString();
        headers['content-type'] = 'application/x-www-form-urlencoded';
      } else if (req.body) {
        body = req.body as unknown as RequestInit['body'];
        headers['content-type'] = req.contentType ?? 'application/octet-stream';
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let res: Response;
        try {
          res = await this.fetchImpl(url, { method, headers, body, redirect: 'manual', signal: controller.signal });
        } catch (e) {
          if (controller.signal.aborted)
            throw new HttpError({ ...ctx, kind: 'timeout', retryable: true, detail: `no response within ${timeoutMs} ms` });
          throw new HttpError({ ...ctx, kind: 'network', retryable: true, detail: errorCode(e) });
        }

        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel().catch(() => undefined);
          throw new HttpError({ ...ctx, kind: 'redirect', status: res.status, detail: 'redirects are not followed' });
        }

        if (!res.ok) {
          const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.clock.now());
          const transient = res.status === 429 || res.status >= 500;
          const allowed = res.status === 429 ? policy !== 'none' : res.status >= 500 && policy === 'default';
          const snippet = req.exposeErrorBody === false ? '' : await readErrorSnippet(res);
          if (req.exposeErrorBody === false) await res.body?.cancel().catch(() => undefined);
          if (allowed && attempt < maxRetries) {
            const wait = retryAfterMs ?? this.backoffMs(attempt);
            if (wait <= this.maxRetryAfterMs) {
              this.logger?.debug(
                { service: this.service, operation: req.operation, status: res.status, attempt, waitMs: wait },
                'http retry',
              );
              await this.clock.sleep(wait);
              continue;
            }
          }
          throw new HttpError({
            ...ctx,
            kind: 'status',
            status: res.status,
            retryable: transient,
            retryAfterMs,
            ...(snippet ? { detail: snippet } : {}),
          });
        }

        let bytes: Uint8Array;
        try {
          bytes = await readBodyLimited(res, maxBytes, ctx);
        } catch (e) {
          if (e instanceof HttpError) throw e;
          if (controller.signal.aborted)
            throw new HttpError({ ...ctx, kind: 'timeout', retryable: true, detail: `body not received within ${timeoutMs} ms` });
          throw new HttpError({ ...ctx, kind: 'network', retryable: true, detail: errorCode(e) });
        }
        return { status: res.status, headers: res.headers, bytes };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** request() + JSON parse. Empty bodies parse to null. */
  async json<T = unknown>(req: HttpRequest): Promise<T> {
    const res = await this.request({ ...req, headers: { accept: 'application/json', ...(req.headers ?? {}) } });
    return parseJsonBody<T>(res.bytes, { service: this.service, operation: req.operation });
  }
}

export function parseJsonBody<T>(bytes: Uint8Array, ctx: { service: string; operation: string }): T {
  if (bytes.byteLength === 0) return null as T;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new HttpError({ ...ctx, kind: 'invalid_response', detail: 'body is not JSON' });
  }
}

function errorCode(e: unknown): string {
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  if (e instanceof Error) return e.name;
  return 'error';
}

/* ------------------------- SSRF-safe third-party fetch ------------------------- */

export interface SafeFetchOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  service?: string;
  /** Retries on 429/5xx (default 1). */
  maxRetries?: number;
  clock?: Clock;
}

export interface SafeFetchResult {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  finalUrl: string;
}

/**
 * Validates a third-party URL before any request: https only, default port, no credentials,
 * hostname exactly in the allowlist (case-insensitive). Returns the parsed URL.
 */
export function assertAllowlistedUrl(raw: string, hosts: readonly string[], service = 'fetch'): URL {
  const operation = 'allowlist';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError({ service, operation, kind: 'blocked', detail: 'invalid URL' });
  }
  if (url.protocol !== 'https:') throw new HttpError({ service, operation, kind: 'blocked', detail: 'https only' });
  if (url.username || url.password)
    throw new HttpError({ service, operation, kind: 'blocked', detail: 'credentials in URL' });
  if (url.port !== '' && url.port !== '443')
    throw new HttpError({ service, operation, kind: 'blocked', detail: 'non-default port' });
  const host = url.hostname.toLowerCase();
  const allowed = new Set(hosts.map((h) => h.toLowerCase()));
  if (!allowed.has(host)) throw new HttpError({ service, operation, kind: 'blocked', detail: `host ${host} not allowlisted` });
  return url;
}

/**
 * Fetches a third-party URL safely: allowlisted host, https, no cross-host redirects (same-host https redirects
 * are followed up to maxRedirects), size limit, timeout covering the whole exchange.
 */
export async function safeFetchAllowlisted(
  rawUrl: string,
  hosts: readonly string[],
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const service = opts.service ?? 'fetch';
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? 15 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const maxRetries = opts.maxRetries ?? 1;
  const clock = opts.clock ?? systemClock;
  const origin = assertAllowlistedUrl(rawUrl, hosts, service);
  const ctx = { service, operation: 'GET' };

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let current = origin;
      for (let hop = 0; ; hop++) {
        let res: Response;
        try {
          res = await fetchImpl(current, {
            method: 'GET',
            headers: opts.headers ?? {},
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch (e) {
          if (controller.signal.aborted) throw new HttpError({ ...ctx, kind: 'timeout', retryable: true });
          throw new HttpError({ ...ctx, kind: 'network', retryable: true, detail: errorCode(e) });
        }
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel().catch(() => undefined);
          const location = res.headers.get('location');
          if (!location || hop >= maxRedirects)
            throw new HttpError({ ...ctx, kind: 'redirect', status: res.status, detail: 'too many or empty redirects' });
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            throw new HttpError({ ...ctx, kind: 'redirect', status: res.status, detail: 'invalid location' });
          }
          if (next.protocol !== 'https:' || next.hostname.toLowerCase() !== origin.hostname.toLowerCase())
            throw new HttpError({ ...ctx, kind: 'redirect', status: res.status, detail: 'cross-host or non-https redirect' });
          assertAllowlistedUrl(next.toString(), hosts, service);
          current = next;
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          const transient = res.status === 429 || res.status >= 500;
          const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), clock.now());
          throw new HttpError({ ...ctx, kind: 'status', status: res.status, retryable: transient, retryAfterMs });
        }
        let bytes: Uint8Array;
        try {
          bytes = await readBodyLimited(res, maxBytes, ctx);
        } catch (e) {
          if (e instanceof HttpError) throw e;
          if (controller.signal.aborted) throw new HttpError({ ...ctx, kind: 'timeout', retryable: true });
          throw new HttpError({ ...ctx, kind: 'network', retryable: true, detail: errorCode(e) });
        }
        return { status: res.status, headers: res.headers, bytes, finalUrl: current.toString() };
      }
    } catch (e) {
      const retry =
        e instanceof HttpError && e.kind === 'status' && e.retryable && attempt < maxRetries
          ? (e.retryAfterMs ?? 500 * 2 ** attempt)
          : null;
      if (retry === null || retry > 30_000) throw e;
      await clock.sleep(retry);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Origin check for every state-changing request (security rule 8). Pure.
 * Mutations must carry an Origin header that exactly equals the desk's origin (DESK_ORIGIN).
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isMutationMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** `scheme://host[:port]` for an http(s) URL, else null. */
export function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value || value === 'null') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Dev-only fallback when DESK_ORIGIN is unset (never used in production). */
export const DEV_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'] as const;

/**
 * Origins allowed to send mutations. Production without DESK_ORIGIN fails closed (empty list).
 */
export function allowedOrigins(deskOrigin: string | undefined, isProduction: boolean): string[] {
  const normalized = normalizeOrigin(deskOrigin);
  if (normalized) return [normalized];
  return isProduction ? [] : [...DEV_ORIGINS];
}

export type OriginCheck = { ok: true } | { ok: false; reason: string };

export interface OriginCheckInput {
  method: string;
  origin: string | null | undefined;
  /** `Sec-Fetch-Site` request header, when the browser sends it. */
  secFetchSite?: string | null | undefined;
}

export function checkOrigin(input: OriginCheckInput, allowed: readonly string[]): OriginCheck {
  if (!isMutationMethod(input.method)) return { ok: true };
  if (allowed.length === 0) return { ok: false, reason: 'DESK_ORIGIN is not configured' };
  const origin = normalizeOrigin(input.origin);
  if (!origin) return { ok: false, reason: 'missing or invalid Origin header' };
  // Exact match of the raw header too: reject values with a path or trailing slash.
  if (input.origin !== origin || !allowed.includes(origin)) return { ok: false, reason: 'origin not allowed' };
  const site = input.secFetchSite?.toLowerCase();
  if (site && site !== 'same-origin') return { ok: false, reason: `sec-fetch-site ${site}` };
  return { ok: true };
}

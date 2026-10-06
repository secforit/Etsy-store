/**
 * SSRF-safe image fetcher for Printify mockup URLs (QA vision check).
 * Only https URLs on Printify's image hosts; no cross-host redirects; size-capped; the MIME type comes from the
 * bytes (magic numbers), never from the response header. SVG and anything non-raster is refused.
 */
import { HttpError, safeFetchAllowlisted, type FetchLike } from './http.ts';
import type { AllowlistedImageFetcher } from './types.ts';
import { sniffImageMime } from './util.ts';

/**
 * Printify serves mockups from images.printify.com (documented examples) and images-api.printify.com
 * (seen in live product responses).
 */
export const PRINTIFY_IMAGE_HOSTS: readonly string[] = ['images.printify.com', 'images-api.printify.com'];

export const MAX_FETCHED_IMAGE_BYTES = 15 * 1024 * 1024;

export function createAllowlistedImageFetcher(
  opts: { hosts?: readonly string[]; fetch?: FetchLike; maxBytes?: number; timeoutMs?: number } = {},
): AllowlistedImageFetcher {
  const hosts = opts.hosts ?? PRINTIFY_IMAGE_HOSTS;
  return async (url: string) => {
    const res = await safeFetchAllowlisted(url, hosts, {
      service: 'image-fetch',
      fetch: opts.fetch,
      maxBytes: opts.maxBytes ?? MAX_FETCHED_IMAGE_BYTES,
      timeoutMs: opts.timeoutMs ?? 20_000,
      headers: { accept: 'image/png,image/jpeg,image/webp' },
    });
    const mimeType = sniffImageMime(res.bytes);
    if (!mimeType || mimeType === 'image/gif')
      throw new HttpError({ service: 'image-fetch', operation: 'GET', kind: 'invalid_response', detail: 'not a PNG/JPEG/WebP image' });
    return { bytes: res.bytes, mimeType };
  };
}

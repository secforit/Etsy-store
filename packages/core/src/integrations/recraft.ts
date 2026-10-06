/**
 * Optional cloud fallback (IMAGEGEN_PROVIDER=recraft): Recraft API v1.
 * POST https://external.api.recraft.ai/v1/images/generations   (Bearer key; response_format b64_json)
 * POST https://external.api.recraft.ai/v1/images/removeBackground (multipart `file`; for transparent art)
 * Output is converted to PNG with sharp. No GPU involvement.
 */
import sharp from 'sharp';
import type { Logger } from '../orchestrator/contracts.ts';
import { HttpClient, HttpError, createServiceBucket, parseJsonBody, type FetchLike } from './http.ts';
import type { GeneratedImage, ImageGenClient } from './types.ts';
import { fromBase64, sniffImageMime } from './util.ts';

export const RECRAFT_BASE_URL = 'https://external.api.recraft.ai/v1';
export const RECRAFT_MODEL = 'recraftv3';
const RECRAFT_MAX_PROMPT = 1000;

/** Sizes accepted by recraftv3 (WxH). */
export const RECRAFT_SIZES: readonly [number, number][] = [
  [1024, 1024],
  [1365, 1024],
  [1024, 1365],
  [1536, 1024],
  [1024, 1536],
  [1820, 1024],
  [1024, 1820],
  [1024, 2048],
  [2048, 1024],
  [1434, 1024],
  [1024, 1434],
  [1024, 1280],
  [1280, 1024],
  [1024, 1707],
  [1707, 1024],
];

/** Closest supported aspect ratio. */
export function pickRecraftSize(widthPx: number, heightPx: number): string {
  const target = Math.log(widthPx / heightPx);
  let best = RECRAFT_SIZES[0]!;
  for (const s of RECRAFT_SIZES) if (Math.abs(Math.log(s[0] / s[1]) - target) < Math.abs(Math.log(best[0] / best[1]) - target)) best = s;
  return `${best[0]}x${best[1]}`;
}

/** Vector styles return SVG; we always ask for a raster style and steer with the prompt instead. */
const RECRAFT_RASTER_STYLE = 'digital_illustration';

export class RecraftImageGenClient implements ImageGenClient {
  private readonly http: HttpClient;

  constructor(opts: { apiKey: string; fetch?: FetchLike; logger?: Logger; baseUrl?: string }) {
    if (!opts.apiKey) throw new Error('recraft: RECRAFT_API_KEY required');
    const key = opts.apiKey;
    this.http = new HttpClient({
      service: 'recraft',
      baseUrl: opts.baseUrl ?? RECRAFT_BASE_URL,
      fetch: opts.fetch,
      timeoutMs: 120_000,
      maxRetries: 2,
      bucket: createServiceBucket('recraft'),
      maxResponseBytes: 64 * 1024 * 1024,
      defaultHeaders: () => ({ authorization: `Bearer ${key}` }),
      logger: opts.logger,
    });
  }

  async generate(req: Parameters<ImageGenClient['generate']>[0]): Promise<GeneratedImage> {
    const styleHint =
      req.style === 'typography'
        ? ' Bold clean typography.'
        : req.style === 'vector_illustration'
          ? ' Flat vector look, clean shapes.'
          : '';
    const prompt = `${req.prompt.replace(/\s+/g, ' ').trim()}${styleHint}`.slice(0, RECRAFT_MAX_PROMPT);
    const gen = await this.http.json<{ data?: { b64_json?: unknown }[] }>({
      method: 'POST',
      url: '/images/generations',
      json: {
        prompt,
        model: RECRAFT_MODEL,
        style: RECRAFT_RASTER_STYLE,
        size: pickRecraftSize(req.widthPx, req.heightPx),
        n: 1,
        response_format: 'b64_json',
      },
      operation: 'generate',
      retry: 'rate_limit_only', // each generation is billed
    });
    let bytes = decodeFirst(gen, 'generate');

    if (req.transparentBackground) {
      const form = new FormData();
      form.append('file', new Blob([Buffer.from(bytes)], { type: sniffImageMime(bytes) ?? 'image/png' }), 'art.png');
      form.append('response_format', 'b64_json');
      const res = await this.postMultipart('/images/removeBackground', form, 'remove background');
      bytes = decodeFirst(res, 'remove background', true);
    }

    const png = await sharp(bytes, { limitInputPixels: 12_000 * 12_000 }).png().toBuffer();
    return { bytes: new Uint8Array(png), mimeType: 'image/png', model: RECRAFT_MODEL, seed: null };
  }

  /** multipart is sent through fetch directly (HttpClient handles JSON/form/bytes bodies). */
  private async postMultipart(path: string, form: FormData, operation: string): Promise<unknown> {
    // Re-encode as bytes with an explicit boundary so HttpClient keeps retries, timeouts and limits.
    const encoded = new Response(form);
    const contentType = encoded.headers.get('content-type') ?? 'multipart/form-data';
    const body = new Uint8Array(await encoded.arrayBuffer());
    const res = await this.http.request({
      method: 'POST',
      url: path,
      body,
      contentType,
      headers: { accept: 'application/json' },
      operation,
      retry: 'rate_limit_only',
    });
    return parseJsonBody(res.bytes, { service: 'recraft', operation });
  }
}

function decodeFirst(res: unknown, operation: string, allowImageObject = false): Uint8Array {
  const r = res as { data?: { b64_json?: unknown }[]; image?: { b64_json?: unknown } } | null;
  const b64 = r?.data?.[0]?.b64_json ?? (allowImageObject ? r?.image?.b64_json : undefined);
  if (typeof b64 !== 'string' || b64.length === 0)
    throw new HttpError({ service: 'recraft', operation, kind: 'invalid_response', detail: 'missing b64_json' });
  const bytes = fromBase64(b64);
  if (!sniffImageMime(bytes))
    throw new HttpError({ service: 'recraft', operation, kind: 'invalid_response', detail: 'not a raster image' });
  return bytes;
}

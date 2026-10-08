/**
 * fal.ai (IMAGEGEN_PROVIDER=fal): the local sidecar's models, run in the cloud.
 *  - art:        fal-ai/flux-2/klein/4b   FLUX.2 [klein] 4B, 4 steps, exact width/height, seed, PNG
 *  - background: fal-ai/birefnet/v2       BiRefNet (general) at 1024x1024: transparent art for t-shirts and mugs
 *  - upscale:    fal-ai/esrgan            Real-ESRGAN x4plus, scale 2 or 4: print files from smaller edits
 * Queue API: POST https://queue.fal.run/<endpoint> (Authorization: Key FAL_KEY) -> {request_id, status_url,
 * response_url}; GET status_url until COMPLETED; GET response_url for the output. Image inputs are sent as data:
 * URIs (nothing is uploaded to fal storage first). Outputs come back as data: URIs (sync_mode) or as an https URL
 * on fal's media CDN, fetched through the host allowlist. Prompts and sizes follow the local sidecar exactly.
 * Source of the API shapes (fal docs are not reachable from the build environment): fal's official JS client,
 * github.com/fal-ai/fal-js (libs/client/src/queue.ts, request.ts, types/common.ts, types/endpoints.ts).
 */
import sharp from 'sharp';
import type { Logger } from '../orchestrator/contracts.ts';
import { HttpClient, HttpError, assertAllowlistedUrl, createServiceBucket, safeFetchAllowlisted, systemClock, type Clock, type FetchLike } from './http.ts';
import { buildSidecarPrompt, normaliseSidecarSide } from './imagegen.ts';
import type { GeneratedImage, ImageGenClient, ImageUpscaler } from './types.ts';
import { fromBase64, sniffImageMime, toBase64 } from './util.ts';

export const FAL_QUEUE_BASE_URL = 'https://queue.fal.run';
export const FAL_QUEUE_HOSTS: readonly string[] = ['queue.fal.run'];
/** fal's media CDN hosts (seen in the endpoint defaults of fal's client types). */
export const FAL_MEDIA_HOSTS: readonly string[] = ['fal.media', 'v2.fal.media', 'v3.fal.media', 'v3b.fal.media'];

export const FAL_FLUX_KLEIN_ENDPOINT = 'fal-ai/flux-2/klein/4b';
export const FAL_BIREFNET_ENDPOINT = 'fal-ai/birefnet/v2';
export const FAL_ESRGAN_ENDPOINT = 'fal-ai/esrgan';
/** Recorded in designs.model, like the local sidecar's model id. */
export const FAL_FLUX_KLEIN_MODEL = `fal:${FAL_FLUX_KLEIN_ENDPOINT}`;

/** Same as the sidecar (apps/imagegen imaging.py): generate on plain white, then BiRefNet cuts the subject out. */
export const FAL_TRANSPARENT_SUFFIX = 'Isolated subject centered on a plain pure white background, no shadow, no frame, no border.';

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

type QueueStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED';

export interface FalQueueOptions {
  apiKey: string;
  fetch?: FetchLike;
  logger?: Logger;
  clock?: Clock;
  /** Delay between status polls. Default 1 s. */
  pollIntervalMs?: number;
  /** Longest wait for one job, queue time included. Default 5 min. */
  maxWaitMs?: number;
  baseUrl?: string;
}

/** Minimal fal queue client: submit, poll, fetch the result. */
export class FalQueue {
  private readonly http: HttpClient;
  private readonly clock: Clock;
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;

  constructor(opts: FalQueueOptions) {
    if (!opts.apiKey) throw new Error('fal: FAL_KEY required');
    const key = opts.apiKey;
    this.clock = opts.clock ?? systemClock;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.maxWaitMs = opts.maxWaitMs ?? 300_000;
    this.http = new HttpClient({
      service: 'fal',
      baseUrl: opts.baseUrl ?? FAL_QUEUE_BASE_URL,
      fetch: opts.fetch,
      timeoutMs: 60_000,
      maxRetries: 2,
      bucket: createServiceBucket('fal', this.clock),
      maxResponseBytes: MAX_IMAGE_BYTES * 2, // data: URIs are base64 (4/3 of the image)
      defaultHeaders: () => ({ authorization: `Key ${key}` }),
      clock: this.clock,
      logger: opts.logger,
    });
  }

  async run(endpoint: string, input: Record<string, unknown>, operation: string): Promise<unknown> {
    const submitted = await this.http.json<{ request_id?: unknown; status_url?: unknown; response_url?: unknown } | null>({
      method: 'POST',
      url: `/${endpoint}`,
      json: input,
      operation: `${operation} submit`,
      retry: 'rate_limit_only', // a 5xx may already have queued (and billed) the job
    });
    const statusUrl = queueUrl(submitted?.status_url, `${operation} submit`);
    const responseUrl = queueUrl(submitted?.response_url, `${operation} submit`);

    const deadline = this.clock.now() + this.maxWaitMs;
    for (;;) {
      const s = await this.http.json<{ status?: QueueStatus } | null>({ url: statusUrl, query: { logs: 0 }, operation: `${operation} status` });
      if (s?.status === 'COMPLETED') break;
      if (s?.status !== 'IN_QUEUE' && s?.status !== 'IN_PROGRESS') {
        throw new HttpError({ service: 'fal', operation: `${operation} status`, kind: 'invalid_response', detail: 'unknown queue status' });
      }
      if (this.clock.now() >= deadline) {
        throw new HttpError({ service: 'fal', operation, kind: 'timeout', retryable: true, detail: `not finished within ${this.maxWaitMs} ms` });
      }
      await this.clock.sleep(this.pollIntervalMs);
    }
    return this.http.json<unknown>({ url: responseUrl, operation: `${operation} result` });
  }

  /** Bytes of an output image: a data: URI or an https URL on fal's media CDN. */
  async image(ref: unknown, operation: string, fetchImpl?: FetchLike): Promise<Uint8Array> {
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new HttpError({ service: 'fal', operation, kind: 'invalid_response', detail: 'missing image url' });
    }
    let bytes: Uint8Array;
    const m = /^data:([^;,]+)?;base64,(.*)$/s.exec(ref);
    if (m) bytes = fromBase64(m[2]!.replace(/\s+/g, ''));
    else bytes = (await safeFetchAllowlisted(ref, FAL_MEDIA_HOSTS, { service: 'fal', fetch: fetchImpl, maxBytes: MAX_IMAGE_BYTES, timeoutMs: 60_000 })).bytes;
    if (!sniffImageMime(bytes)) throw new HttpError({ service: 'fal', operation, kind: 'invalid_response', detail: 'not a raster image' });
    return bytes;
  }
}

/** status_url / response_url from the submit reply: https on fal's queue host only (no SSRF via the reply). */
function queueUrl(raw: unknown, operation: string): string {
  if (typeof raw !== 'string' || !raw) throw new HttpError({ service: 'fal', operation, kind: 'invalid_response', detail: 'missing queue urls' });
  return assertAllowlistedUrl(raw, FAL_QUEUE_HOSTS, 'fal').toString();
}

export function pngDataUri(bytes: Uint8Array): string {
  return `data:image/png;base64,${toBase64(bytes)}`;
}

export interface FalClientOptions extends FalQueueOptions {
  /** Media downloads (tests); defaults to the global fetch through the allowlist. */
  mediaFetch?: FetchLike;
}

export class FalImageGenClient implements ImageGenClient {
  private readonly queue: FalQueue;

  constructor(private readonly opts: FalClientOptions) {
    this.queue = new FalQueue(opts);
  }

  async generate(req: Parameters<ImageGenClient['generate']>[0]): Promise<GeneratedImage> {
    const base = buildSidecarPrompt(req.prompt, req.style);
    if (!base) throw new Error('fal: empty prompt');
    const prompt = req.transparentBackground ? `${base} ${FAL_TRANSPARENT_SUFFIX}` : base;
    const out = (await this.queue.run(
      FAL_FLUX_KLEIN_ENDPOINT,
      {
        prompt,
        image_size: { width: normaliseSidecarSide(req.widthPx), height: normaliseSidecarSide(req.heightPx) },
        num_inference_steps: 4,
        num_images: 1,
        output_format: 'png',
        enable_safety_checker: true,
        sync_mode: true,
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
      },
      'generate',
    )) as { images?: { url?: unknown }[]; seed?: unknown; has_nsfw_concepts?: unknown } | null;
    if (Array.isArray(out?.has_nsfw_concepts) && out.has_nsfw_concepts[0] === true) {
      // fal returns a black image for flagged output: never pass that on as art.
      throw new Error('fal: the safety checker flagged the generated image; change the concept or prompt');
    }
    let bytes = await this.queue.image(out?.images?.[0]?.url, 'generate', this.opts.mediaFetch);

    if (req.transparentBackground) {
      const matte = (await this.queue.run(
        FAL_BIREFNET_ENDPOINT,
        { image_url: pngDataUri(bytes), model: 'General Use (Light)', operating_resolution: '1024x1024', output_format: 'png', sync_mode: true },
        'remove background',
      )) as { image?: { url?: unknown } } | null;
      bytes = await this.queue.image(matte?.image?.url, 'remove background', this.opts.mediaFetch);
    }

    const png = await sharp(bytes, { limitInputPixels: 12_000 * 12_000 }).png().toBuffer();
    const seed = typeof out?.seed === 'number' && Number.isSafeInteger(out.seed) ? out.seed : (req.seed ?? null);
    return { bytes: new Uint8Array(png), mimeType: 'image/png', model: FAL_FLUX_KLEIN_MODEL, seed };
  }
}

/** Real-ESRGAN x4plus on fal; scale 2 or 4. Alpha is kept (re-applied from the input if the output lost it). */
export class FalUpscaler implements ImageUpscaler {
  private readonly queue: FalQueue;

  constructor(private readonly opts: FalClientOptions) {
    this.queue = new FalQueue(opts);
  }

  async upscale(bytes: Uint8Array, factor: 2 | 4): Promise<Uint8Array> {
    const input = await sharp(bytes, { limitInputPixels: 12_000 * 12_000 }).png().toBuffer();
    const out = (await this.queue.run(
      FAL_ESRGAN_ENDPOINT,
      // Tiles keep large print-size outputs within the runner's GPU memory (fal's own advice for big inputs).
      { image_url: pngDataUri(input), model: 'RealESRGAN_x4plus', scale: factor, tile: 400, output_format: 'png' },
      'upscale',
    )) as { image?: { url?: unknown } } | null;
    const upscaled = await this.queue.image(out?.image?.url, 'upscale', this.opts.mediaFetch);

    const [inMeta, outMeta] = await Promise.all([sharp(input).metadata(), sharp(upscaled).metadata()]);
    if (!inMeta.hasAlpha || outMeta.hasAlpha || !outMeta.width || !outMeta.height) {
      return new Uint8Array(await sharp(upscaled).png().toBuffer());
    }
    // The output has no alpha here, so join the input's (resized) alpha as the 4th channel. (No removeAlpha():
    // sharp applies it after joinChannel and would strip the channel just added.)
    const alpha = await sharp(input).extractChannel('alpha').resize(outMeta.width, outMeta.height, { kernel: 'lanczos3' }).toBuffer();
    return new Uint8Array(await sharp(upscaled).joinChannel(alpha).png().toBuffer());
  }
}

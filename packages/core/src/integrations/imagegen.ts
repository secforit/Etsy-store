/**
 * Clients for the local imagegen GPU sidecar (FLUX.2 [klein] 4B + BiRefNet + Real-ESRGAN; apps/imagegen).
 * Sidecar contract (BUILD_SPEC):
 *   POST /generate  JSON {prompt, width, height, seed?, transparent} -> image/png bytes + header x-seed
 *   POST /upscale   body PNG, query factor=2|4                      -> PNG
 *   POST /unload                                                     -> 204
 *   GET  /healthz                                                    -> {"ok":true,"loaded":[...]}
 * All require `Authorization: Bearer <IMAGEGEN_TOKEN>`. Width/height multiples of 16, max 2048.
 * Plain HTTP on the private Docker network only; 300 s timeout. GPU work runs inside gpu.withGpu('image').
 */
import type { Logger } from '../orchestrator/contracts.ts';
import { HttpClient, HttpError, INTERNAL_GPU_TIMEOUT_MS, type Clock, type FetchLike } from './http.ts';
import type { GeneratedImage, GpuCoordinator, ImageGenClient, ImageUpscaler } from './types.ts';
import { isPng, roundToMultiple } from './util.ts';

export const FLUX_KLEIN_MODEL_ID = 'black-forest-labs/FLUX.2-klein-4B';
export const SIDECAR_MAX_SIDE = 2048;
export const SIDECAR_MIN_SIDE = 256;
export const SIDECAR_MAX_PROMPT = 2000;
export const SIDECAR_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Style hints appended to the prompt (the sidecar has no style parameter). */
const STYLE_SUFFIX: Record<string, string> = {
  vector_illustration: 'flat vector illustration, clean bold shapes, crisp edges, limited color palette, no gradients',
  typography: 'bold typographic design, clean legible lettering, centered composition, high contrast',
};

export function buildSidecarPrompt(prompt: string, style: string): string {
  const base = prompt.replace(/\s+/g, ' ').trim();
  const hint = STYLE_SUFFIX[style] ?? style.replace(/[_\s]+/g, ' ').trim();
  const full = hint ? `${base}. Style: ${hint}` : base;
  return full.slice(0, SIDECAR_MAX_PROMPT);
}

/** Sidecar sizes: multiple of 16 within [256, 2048]. */
export function normaliseSidecarSide(px: number): number {
  if (!Number.isFinite(px) || px <= 0) throw new Error('imagegen: invalid size');
  return roundToMultiple(px, 16, SIDECAR_MIN_SIDE, SIDECAR_MAX_SIDE);
}

export interface SidecarOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  logger?: Logger;
  clock?: Clock;
}

/** Raw sidecar API (no GPU coordination). */
export class ImagegenSidecar {
  private readonly http: HttpClient;

  constructor(opts: SidecarOptions) {
    if (!opts.token || opts.token.length < 24) throw new Error('imagegen: IMAGEGEN_TOKEN (>= 24 chars) is required');
    const token = opts.token;
    this.http = new HttpClient({
      service: 'imagegen',
      baseUrl: opts.baseUrl,
      fetch: opts.fetch,
      clock: opts.clock,
      allowHttp: true, // private Docker network only
      timeoutMs: opts.timeoutMs ?? INTERNAL_GPU_TIMEOUT_MS,
      maxRetries: 1, // a 503 while models load; GPU work is expensive, do not hammer
      maxResponseBytes: 256 * 1024 * 1024,
      defaultHeaders: () => ({ authorization: `Bearer ${token}` }),
      logger: opts.logger,
    });
  }

  get timeoutMs(): number {
    return this.http.timeoutMs;
  }

  async generate(req: {
    prompt: string;
    width: number;
    height: number;
    seed?: number;
    transparent: boolean;
  }): Promise<{ bytes: Uint8Array; seed: number | null }> {
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      width: req.width,
      height: req.height,
      transparent: req.transparent,
    };
    if (req.seed !== undefined) body.seed = req.seed;
    const res = await this.http.request({
      method: 'POST',
      url: '/generate',
      json: body,
      headers: { accept: 'image/png' },
      operation: 'generate',
    });
    if (!isPng(res.bytes))
      throw new HttpError({ service: 'imagegen', operation: 'generate', kind: 'invalid_response', detail: 'not a PNG' });
    const seedHeader = res.headers.get('x-seed');
    const seed = seedHeader !== null && /^-?\d+$/.test(seedHeader.trim()) ? Number(seedHeader.trim()) : null;
    return { bytes: res.bytes, seed };
  }

  async upscale(bytes: Uint8Array, factor: 2 | 4): Promise<Uint8Array> {
    if (factor !== 2 && factor !== 4) throw new Error('imagegen: factor must be 2 or 4');
    if (!isPng(bytes)) throw new Error('imagegen: upscale input must be PNG');
    if (bytes.byteLength > SIDECAR_MAX_UPLOAD_BYTES) throw new Error('imagegen: upscale input larger than 50 MB');
    const res = await this.http.request({
      method: 'POST',
      url: '/upscale',
      query: { factor },
      body: bytes,
      contentType: 'image/png',
      headers: { accept: 'image/png' },
      operation: 'upscale',
    });
    if (!isPng(res.bytes))
      throw new HttpError({ service: 'imagegen', operation: 'upscale', kind: 'invalid_response', detail: 'not a PNG' });
    return res.bytes;
  }

  async unload(): Promise<void> {
    await this.http.request({ method: 'POST', url: '/unload', operation: 'unload', timeoutMs: 60_000 });
  }

  async healthz(): Promise<{ ok: boolean; loaded: string[] }> {
    const res = await this.http.json<{ ok?: unknown; loaded?: unknown } | null>({
      url: '/healthz',
      operation: 'healthz',
      timeoutMs: 10_000,
    });
    return {
      ok: res?.ok === true,
      loaded: Array.isArray(res?.loaded) ? res.loaded.filter((x): x is string => typeof x === 'string') : [],
    };
  }
}

/** Default image generator: FLUX.2 [klein] 4B on the local sidecar. */
export class LocalImageGenClient implements ImageGenClient {
  constructor(
    private readonly sidecar: ImagegenSidecar,
    private readonly gpu: GpuCoordinator,
    private readonly model: string = FLUX_KLEIN_MODEL_ID,
  ) {}

  async generate(req: Parameters<ImageGenClient['generate']>[0]): Promise<GeneratedImage> {
    const prompt = buildSidecarPrompt(req.prompt, req.style);
    if (!prompt) throw new Error('imagegen: empty prompt');
    const width = normaliseSidecarSide(req.widthPx);
    const height = normaliseSidecarSide(req.heightPx);
    const out = await this.gpu.withGpu('image', () =>
      this.sidecar.generate({
        prompt,
        width,
        height,
        transparent: req.transparentBackground,
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
      }),
    );
    return { bytes: out.bytes, mimeType: 'image/png', model: this.model, seed: out.seed ?? req.seed ?? null };
  }
}

/** Real-ESRGAN x4plus on the sidecar (x2 = x4 then downscale, done by the sidecar). */
export class LocalUpscaler implements ImageUpscaler {
  constructor(
    private readonly sidecar: ImagegenSidecar,
    private readonly gpu: GpuCoordinator,
  ) {}

  upscale(bytes: Uint8Array, factor: 2 | 4): Promise<Uint8Array> {
    return this.gpu.withGpu('image', () => this.sidecar.upscale(bytes, factor));
  }
}

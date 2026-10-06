/**
 * Small helpers shared by the agents.
 */
import sharp from 'sharp';
import type { LlmClient, LlmImage, LlmRequest, LlmUsage } from '../llm/types.ts';
import { usageFromError } from '../llm/errors.ts';

/** Calls the model, records usage (also for failed calls that report usage), returns the validated output. */
export async function askModel<T>(llm: LlmClient, req: LlmRequest<T>, usage: LlmUsage[]): Promise<T> {
  try {
    const res = await llm.generate(req);
    usage.push(res.usage);
    return res.output;
  } catch (err) {
    const u = usageFromError(err);
    if (u) usage.push(u);
    throw err;
  }
}

/**
 * Downscales an image for a vision call (max side 1024 px, JPEG). Transparent artwork is flattened onto
 * mid-grey so both light and dark art stay visible. Never sends full-size print files to the model.
 */
export async function toVisionImage(bytes: Uint8Array, maxSide = 1024): Promise<LlmImage> {
  const out = await sharp(bytes, { limitInputPixels: 12_000 * 12_000 })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#9a9a9a' })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { mimeType: 'image/jpeg', base64: out.toString('base64') };
}

export function isPng(bytes: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
}

/** Blob keys must be [a-z0-9/_.-], no '..', no leading '/'. Product ids are UUIDs, so this rarely trips. */
export function safeKeySegment(id: string): string {
  const seg = id.trim().toLowerCase();
  if (!/^[a-z0-9_-][a-z0-9_.-]{0,127}$/.test(seg) || seg.includes('..')) {
    throw new Error(`id is not usable in a storage key: ${JSON.stringify(id.slice(0, 40))}`);
  }
  return seg;
}

/** 32-bit FNV-1a hash -> non-negative int (deterministic seeds). */
export function stableSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2_147_483_647;
}

export const PRODUCT_NOUN: Record<'tshirt' | 'mug' | 'poster', string> = {
  tshirt: 'T-Shirt',
  mug: 'Coffee Mug',
  poster: 'Poster',
};

/**
 * Upload validation (security rule 6): PNG only by magic bytes, <= 50 MB, <= 12000 x 12000 px, decoded and
 * re-encoded by sharp before storage. The filename and the browser's MIME type are never trusted.
 */
import sharp, { type Metadata, type OutputInfo } from 'sharp';
import { DeskError } from './contracts.ts';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_UPLOAD_SIDE_PX = 12_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

export interface ValidatedPng {
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
  hasAlpha: boolean;
}

/** Throws DeskError (safe to show) for anything that is not an acceptable PNG; returns the re-encoded file. */
export async function validateAndReencodePng(input: Uint8Array): Promise<ValidatedPng> {
  if (!(input instanceof Uint8Array) || input.byteLength === 0) throw new DeskError('The file is empty.');
  if (input.byteLength > MAX_UPLOAD_BYTES) throw new DeskError('The file is larger than 50 MB.');
  if (!hasPngSignature(input)) throw new DeskError('Only PNG files are accepted.');

  const limitInputPixels = MAX_UPLOAD_SIDE_PX * MAX_UPLOAD_SIDE_PX;
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels, failOn: 'error' }).metadata();
  } catch {
    throw new DeskError('The PNG could not be read. Export it again and retry.');
  }
  if (meta.format !== 'png') throw new DeskError('Only PNG files are accepted.');
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) throw new DeskError('The PNG has no image size.');
  if (width > MAX_UPLOAD_SIDE_PX || height > MAX_UPLOAD_SIDE_PX) {
    throw new DeskError(`The image is ${width}x${height} px; the maximum is ${MAX_UPLOAD_SIDE_PX}x${MAX_UPLOAD_SIDE_PX} px.`);
  }

  let out: { data: Buffer; info: OutputInfo };
  try {
    // Full decode + re-encode: drops metadata/ancillary chunks, converts to sRGB, keeps alpha.
    out = await sharp(input, { limitInputPixels, failOn: 'error' })
      .toColourspace('srgb')
      .png({ compressionLevel: 6 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new DeskError('The PNG could not be processed. Export it again and retry.');
  }
  return {
    bytes: new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength),
    widthPx: out.info.width,
    heightPx: out.info.height,
    hasAlpha: out.info.channels === 4 || out.info.channels === 2,
  };
}

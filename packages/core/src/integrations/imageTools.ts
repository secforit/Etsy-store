/**
 * sharp-backed ImageTools: inspection for QA and print-file preparation (exact size, sRGB, DPI metadata).
 */
import sharp, { type Sharp } from 'sharp';
import type { ImageInspection, ImageTools } from './types.ts';

/** Upload rule 6: max 12000 x 12000 px. Anything larger is refused before decoding. */
export const MAX_INPUT_PIXELS = 12_000 * 12_000;
/** Never upscale more than this factor in toPrintFile (AI upscaling happens before, on the sidecar). */
export const MAX_PRINT_UPSCALE = 4;

function open(bytes: Uint8Array): Sharp {
  return sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
}

export class SharpImageTools implements ImageTools {
  async inspect(bytes: Uint8Array): Promise<ImageInspection> {
    const meta = await open(bytes).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!meta.format || width <= 0 || height <= 0) throw new Error('inspect: unreadable image');
    const hasAlpha = Boolean(meta.hasAlpha);
    let semiTransparentShare = 0;
    if (hasAlpha) {
      // Normalise to 8-bit sRGB+alpha so 16-bit and grey+alpha inputs read the same way.
      const alpha = await open(bytes).ensureAlpha().toColourspace('srgb').extractChannel(3).raw({ depth: 'uchar' }).toBuffer();
      let semi = 0;
      for (let i = 0; i < alpha.length; i++) {
        const a = alpha[i]!;
        if (a > 0 && a < 255) semi++;
      }
      semiTransparentShare = alpha.length > 0 ? semi / alpha.length : 0;
    }
    return {
      format: meta.format,
      widthPx: width,
      heightPx: height,
      dpi: typeof meta.density === 'number' && meta.density > 0 ? Math.round(meta.density) : null,
      hasAlpha,
      colorSpace: meta.space ?? 'unknown',
      semiTransparentShare,
    };
  }

  async toPrintFile(bytes: Uint8Array, spec: { widthPx: number; heightPx: number; dpi: number }): Promise<Uint8Array> {
    if (!Number.isInteger(spec.widthPx) || !Number.isInteger(spec.heightPx) || spec.widthPx <= 0 || spec.heightPx <= 0)
      throw new Error('toPrintFile: invalid target size');
    if (!(spec.dpi > 0 && spec.dpi <= 2400)) throw new Error('toPrintFile: invalid dpi');
    const meta = await open(bytes).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w <= 0 || h <= 0) throw new Error('toPrintFile: unreadable image');

    const scale = Math.min(spec.widthPx / w, spec.heightPx / h);
    if (scale > MAX_PRINT_UPSCALE)
      throw new Error(`toPrintFile: would upscale ${scale.toFixed(2)}x (max ${MAX_PRINT_UPSCALE}x); upscale with AI first`);

    const hasAlpha = Boolean(meta.hasAlpha);
    // Same aspect (within 1%): stretch the last pixel instead of adding a 1-2 px border.
    const sameAspect = Math.abs(w / h / (spec.widthPx / spec.heightPx) - 1) < 0.01;
    let pipeline = open(bytes)
      .resize({
        width: spec.widthPx,
        height: spec.heightPx,
        fit: sameAspect ? 'fill' : 'contain',
        position: 'centre',
        kernel: 'lanczos3',
        background: hasAlpha ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .withIccProfile('srgb')
      .withDensity(spec.dpi);
    pipeline = hasAlpha ? pipeline.ensureAlpha() : pipeline.removeAlpha();
    const out = await pipeline.png({ compressionLevel: 6, adaptiveFiltering: false }).toBuffer();
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }
}

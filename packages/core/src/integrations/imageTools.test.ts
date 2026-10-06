import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { SharpImageTools } from './imageTools.ts';
import { renderMockArt } from './mocks/art.ts';

const tools = new SharpImageTools();

/** 10x10 RGBA: 10 semi-transparent px, 40 opaque, 50 fully transparent. */
async function craftedPng(): Promise<Uint8Array> {
  const raw = Buffer.alloc(10 * 10 * 4);
  for (let i = 0; i < 100; i++) {
    raw[i * 4] = 255;
    raw[i * 4 + 3] = i < 10 ? 128 : i < 50 ? 255 : 0;
  }
  return new Uint8Array(await sharp(raw, { raw: { width: 10, height: 10, channels: 4 } }).png().toBuffer());
}

describe('SharpImageTools.inspect', () => {
  it('measures the semi-transparent share exactly', async () => {
    const info = await tools.inspect(await craftedPng());
    expect(info).toMatchObject({ format: 'png', widthPx: 10, heightPx: 10, hasAlpha: true, colorSpace: 'srgb', dpi: null });
    expect(info.semiTransparentShare).toBeCloseTo(0.1, 6);
  });

  it('inspects generated transparent art', async () => {
    const png = await renderMockArt({ width: 480, height: 576, transparent: true, seed: 7 });
    const info = await tools.inspect(png);
    expect(info).toMatchObject({ format: 'png', widthPx: 480, heightPx: 576, hasAlpha: true, colorSpace: 'srgb' });
    expect(info.semiTransparentShare).toBeGreaterThan(0); // anti-aliased edges
    expect(info.semiTransparentShare).toBeLessThan(0.05);
  });

  it('reports opaque JPEGs without alpha and with their DPI', async () => {
    const jpg = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#ffffff' } })
      .withDensity(150)
      .jpeg()
      .toBuffer();
    const info = await tools.inspect(new Uint8Array(jpg));
    expect(info).toMatchObject({ format: 'jpeg', widthPx: 300, heightPx: 200, hasAlpha: false, semiTransparentShare: 0, dpi: 150 });
  });

  it('handles grey+alpha input', async () => {
    const raw = Buffer.alloc(4 * 4 * 2);
    for (let i = 0; i < 16; i++) {
      raw[i * 2] = 100;
      raw[i * 2 + 1] = i < 4 ? 50 : 255;
    }
    const png = await sharp(raw, { raw: { width: 4, height: 4, channels: 2 } }).png().toBuffer();
    const info = await tools.inspect(new Uint8Array(png));
    expect(info.hasAlpha).toBe(true);
    expect(info.semiTransparentShare).toBeCloseTo(0.25, 6);
  });

  it('rejects garbage', async () => {
    await expect(tools.inspect(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});

describe('SharpImageTools.toPrintFile', () => {
  it('produces the exact print spec with DPI metadata and alpha preserved', async () => {
    const art = await renderMockArt({ width: 1500, height: 1808, transparent: true, seed: 3 });
    const out = await tools.toPrintFile(art, { widthPx: 4500, heightPx: 5400, dpi: 300 });
    const info = await tools.inspect(out);
    expect(info).toMatchObject({ format: 'png', widthPx: 4500, heightPx: 5400, dpi: 300, hasAlpha: true, colorSpace: 'srgb' });
  });

  it('pads (contain) when the aspect ratio differs, keeping opaque art opaque', async () => {
    const art = await renderMockArt({ width: 800, height: 400, transparent: false, seed: 4 });
    const out = await tools.toPrintFile(art, { widthPx: 1000, heightPx: 1000, dpi: 150 });
    const info = await tools.inspect(out);
    expect(info).toMatchObject({ widthPx: 1000, heightPx: 1000, dpi: 150, hasAlpha: false });
  });

  it('never upscales more than 4x', async () => {
    const art = await renderMockArt({ width: 256, height: 256, transparent: true, seed: 5 });
    await expect(tools.toPrintFile(art, { widthPx: 4500, heightPx: 5400, dpi: 300 })).rejects.toThrow(/4x/);
  });

  it('validates the spec', async () => {
    const art = await renderMockArt({ width: 256, height: 256, transparent: true, seed: 5 });
    await expect(tools.toPrintFile(art, { widthPx: 0, heightPx: 10, dpi: 300 })).rejects.toThrow();
    await expect(tools.toPrintFile(art, { widthPx: 100, heightPx: 100, dpi: 0 })).rejects.toThrow();
  });
});

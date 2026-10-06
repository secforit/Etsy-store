/** Deterministic, fast, real image synthesis for mocks (SVG shapes rasterised by sharp; no fonts needed). */
import sharp from 'sharp';
import { hash32, prng } from '../util.ts';

const PALETTES = [
  ['#1d3557', '#e63946', '#f1faee', '#a8dadc'],
  ['#264653', '#2a9d8f', '#e9c46a', '#f4a261'],
  ['#3d405b', '#e07a5f', '#f2cc8f', '#81b29a'],
  ['#22223b', '#9a8c98', '#c9ada7', '#f2e9e4'],
  ['#003049', '#d62828', '#f77f00', '#fcbf49'],
  ['#2b2d42', '#8d99ae', '#ef233c', '#edf2f4'],
] as const;

function palette(seed: number): readonly string[] {
  return PALETTES[seed % PALETTES.length]!;
}

/** A PNG "design": shapes centred on a transparent (or solid) background. */
export async function renderMockArt(opts: {
  width: number;
  height: number;
  transparent: boolean;
  seed: number;
}): Promise<Uint8Array> {
  const { width: w, height: h } = opts;
  const rnd = prng(opts.seed);
  const [c1, c2, c3, bg] = palette(opts.seed);
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * (0.25 + rnd() * 0.1);
  const star = Array.from({ length: 10 }, (_, i) => {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rr = i % 2 === 0 ? r * 0.9 : r * 0.4;
    return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`;
  }).join(' ');
  const bandH = Math.round(h * 0.08);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
${opts.transparent ? '' : `<rect x="0" y="0" width="${w}" height="${h}" fill="${bg}"/>`}
<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${c1}"/>
<polygon points="${star}" fill="${c2}"/>
<rect x="${(w * 0.2).toFixed(1)}" y="${(cy + r * 1.15).toFixed(1)}" width="${(w * 0.6).toFixed(1)}" height="${bandH}" rx="${(bandH / 2).toFixed(1)}" fill="${c3}"/>
</svg>`;
  let img = sharp(Buffer.from(svg));
  img = opts.transparent ? img.ensureAlpha() : img.flatten({ background: bg }).removeAlpha();
  const out = await img.png({ compressionLevel: 3 }).toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** A JPEG "mockup" photo (product silhouette on a plain background). */
export async function renderMockMockup(key: string, size = 600): Promise<Uint8Array> {
  const seed = hash32(key);
  const [c1, c2, , bg] = palette(seed);
  const s = size;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">
<rect width="${s}" height="${s}" fill="${bg}"/>
<path d="M ${s * 0.3} ${s * 0.2} L ${s * 0.42} ${s * 0.15} L ${s * 0.58} ${s * 0.15} L ${s * 0.7} ${s * 0.2} L ${s * 0.82} ${s * 0.35} L ${s * 0.72} ${s * 0.42} L ${s * 0.68} ${s * 0.38} L ${s * 0.68} ${s * 0.85} L ${s * 0.32} ${s * 0.85} L ${s * 0.32} ${s * 0.38} L ${s * 0.28} ${s * 0.42} L ${s * 0.18} ${s * 0.35} Z" fill="${c1}"/>
<circle cx="${s * 0.5}" cy="${s * 0.45}" r="${s * 0.1}" fill="${c2}"/>
</svg>`;
  const out = await sharp(Buffer.from(svg)).flatten({ background: bg }).jpeg({ quality: 80 }).toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

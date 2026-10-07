/** Mock trademark search, image generation/upscaling, Pinterest trends and image fetching. */
import sharp from 'sharp';
import type { TrademarkHit } from '../../domain/types.ts';
import { PRINTIFY_IMAGE_HOSTS } from '../fetchImage.ts';
import { assertAllowlistedUrl } from '../http.ts';
import { normaliseSidecarSide } from '../imagegen.ts';
import { normaliseTrademarkTerm, type TrademarkSearchOptions } from '../trademark.ts';
import type {
  AllowlistedImageFetcher,
  GeneratedImage,
  GpuCoordinator,
  ImageGenClient,
  ImageUpscaler,
  TrademarkClient,
  TrendSignalInput,
  TrendSource,
} from '../types.ts';
import { hash32, isPng, prng } from '../util.ts';
import { renderMockArt, renderMockMockup } from './art.ts';

/* -------------------------------- trademark -------------------------------- */

/** Well-known marks (illustrative serials) plus dead marks, so compliance paths are exercised offline. */
export const MOCK_TRADEMARKS: readonly TrademarkHit[] = [
  { mark: 'NIKE', serial: '73000001', status: 'live', classes: [25], owner: 'Nike, Inc.' },
  { mark: 'JUST DO IT', serial: '74000002', status: 'live', classes: [25], owner: 'Nike, Inc.' },
  { mark: 'DISNEY', serial: '75000003', status: 'live', classes: [16, 21, 25], owner: 'Disney Enterprises, Inc.' },
  { mark: 'MARVEL', serial: '75000004', status: 'live', classes: [16, 25], owner: 'Marvel Characters, Inc.' },
  { mark: 'STAR WARS', serial: '76000005', status: 'live', classes: [16, 21, 25], owner: 'Lucasfilm Ltd. LLC' },
  { mark: 'HARRY POTTER', serial: '76000006', status: 'live', classes: [16, 21, 25], owner: 'Warner Bros. Entertainment Inc.' },
  { mark: 'POKEMON', serial: '77000007', status: 'live', classes: [16, 25], owner: 'Nintendo of America Inc.' },
  { mark: 'HELLO KITTY', serial: '77000008', status: 'live', classes: [16, 21, 25], owner: 'Sanrio Company, Ltd.' },
  { mark: 'STARBUCKS', serial: '78000009', status: 'live', classes: [21, 30], owner: 'Starbucks Corporation' },
  { mark: 'COCA-COLA', serial: '78000010', status: 'live', classes: [21, 32], owner: 'The Coca-Cola Company' },
  { mark: 'TAYLOR SWIFT', serial: '79000011', status: 'live', classes: [16, 25], owner: 'TAS Rights Management, LLC' },
  { mark: 'MAMA BEAR', serial: '86000012', status: 'live', classes: [25], owner: 'Example Apparel LLC' },
  { mark: 'COFFEE FIRST', serial: '87000013', status: 'live', classes: [21], owner: 'Example Mugs Inc.' },
  { mark: 'DOG MOM', serial: '88000014', status: 'dead', classes: [25], owner: null },
  { mark: 'SPOOKY SEASON', serial: '88000015', status: 'dead', classes: [25], owner: null },
];

/**
 * Matches exactly like Marker (and so the live client): the exact term, plus marks that START with the term
 * (`term*`) unless `{prefix: false}`. A mark inside a longer term is NOT returned, as on the real API, so mock
 * runs exercise the compliance guard's sub-phrase searches instead of hiding their absence.
 */
export class MockTrademarkClient implements TrademarkClient {
  readonly searches: string[] = [];
  constructor(private readonly marks: readonly TrademarkHit[] = MOCK_TRADEMARKS) {}

  async search(term: string, opts: TrademarkSearchOptions = {}): Promise<TrademarkHit[]> {
    const t = normaliseTrademarkTerm(term);
    this.searches.push(t);
    if (t.length < 2) return [];
    const prefix = opts.prefix !== false;
    return this.marks
      .filter((m) => {
        const mark = normaliseTrademarkTerm(m.mark);
        return mark === t || (prefix && mark.startsWith(t));
      })
      .map((m) => ({ ...m, classes: [...m.classes] }));
  }
}

/* ------------------------------ image generation ----------------------------- */

export const MOCK_IMAGE_MODEL = 'mock/FLUX.2-klein-4B';

/** Real PNGs (alpha when transparent) in milliseconds; sizes follow the sidecar rules. */
export class MockImageGenClient implements ImageGenClient {
  readonly requests: Parameters<ImageGenClient['generate']>[0][] = [];
  constructor(private readonly gpu: GpuCoordinator | null = null) {}

  async generate(req: Parameters<ImageGenClient['generate']>[0]): Promise<GeneratedImage> {
    this.requests.push({ ...req });
    const width = normaliseSidecarSide(req.widthPx);
    const height = normaliseSidecarSide(req.heightPx);
    const seed = req.seed ?? hash32(`${req.prompt}|${req.style}`) % 2_147_483_647;
    const render = () => renderMockArt({ width, height, transparent: req.transparentBackground, seed });
    const bytes = this.gpu ? await this.gpu.withGpu('image', render) : await render();
    return { bytes, mimeType: 'image/png', model: MOCK_IMAGE_MODEL, seed };
  }
}

/** Lanczos resize standing in for Real-ESRGAN (keeps alpha). */
export class MockUpscaler implements ImageUpscaler {
  readonly calls: { factor: 2 | 4 }[] = [];
  constructor(private readonly gpu: GpuCoordinator | null = null) {}

  async upscale(bytes: Uint8Array, factor: 2 | 4): Promise<Uint8Array> {
    if (factor !== 2 && factor !== 4) throw new Error('upscale: factor must be 2 or 4');
    if (!isPng(bytes)) throw new Error('upscale: input must be PNG');
    this.calls.push({ factor });
    const run = async () => {
      const meta = await sharp(bytes).metadata();
      const out = await sharp(bytes, { limitInputPixels: 12_000 * 12_000 })
        .resize({ width: (meta.width ?? 1) * factor, height: (meta.height ?? 1) * factor, kernel: 'lanczos3', fit: 'fill' })
        .png({ compressionLevel: 2 })
        .toBuffer();
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    };
    return this.gpu ? this.gpu.withGpu('image', run) : run();
  }
}

/* --------------------------------- trends ----------------------------------- */

const PINTEREST_BY_MONTH: Record<number, string[]> = {
  1: ['winter aesthetic', 'self care quotes', 'cozy reading nook', 'vision board'],
  2: ['galentines day ideas', 'valentines day gifts', 'love quotes', 'pink aesthetic'],
  3: ['spring outfits', 'st patricks day', 'garden planning', 'easter crafts'],
  4: ['spring aesthetic', 'easter brunch', 'wildflowers', 'earth day'],
  5: ['mothers day gifts', 'graduation party ideas', 'teacher appreciation', 'summer vibes'],
  6: ['fathers day gifts', 'summer aesthetic', 'beach quotes', 'pride month'],
  7: ['fourth of july', 'camping aesthetic', 'lake life', 'summer reading'],
  8: ['back to school', 'teacher outfits', 'fall decor ideas', 'dorm room decor'],
  9: ['fall aesthetic', 'pumpkin spice', 'halloween costume ideas', 'cozy fall'],
  10: ['halloween aesthetic', 'spooky season', 'witchy vibes', 'thanksgiving decor'],
  11: ['thanksgiving quotes', 'christmas gift ideas', 'friendsgiving', 'winter outfits'],
  12: ['christmas aesthetic', 'new year quotes', 'holiday gifts', 'winter wonderland'],
};

const PINTEREST_EVERGREEN = ['retro mushroom art', 'frog aesthetic', 'minimalist line art', 'funny cat quotes', 'plant mom'];

export class MockPinterestTrendSource implements TrendSource {
  readonly name = 'pinterest';
  async fetchSignals(q: { market: 'US'; today: string }): Promise<TrendSignalInput[]> {
    const month = Number(q.today.slice(5, 7));
    const keywords = [...(PINTEREST_BY_MONTH[month] ?? []), ...PINTEREST_EVERGREEN];
    const rnd = prng(hash32(`pinterest:${q.today}`));
    const n = keywords.length;
    return keywords.map((keyword, i) => ({
      source: this.name,
      keyword,
      region: q.market,
      score: Math.round((100 * (n - i)) / n),
      growth: Math.round((0.05 + rnd() * 1.5) * 100) / 100,
    }));
  }
}

/* ------------------------------ image fetching ------------------------------ */

/** Same URL rules as the live fetcher; returns a deterministic JPEG mockup. */
export function createMockImageFetcher(hosts: readonly string[] = PRINTIFY_IMAGE_HOSTS): AllowlistedImageFetcher {
  return async (url: string) => {
    const u = assertAllowlistedUrl(url, hosts, 'image-fetch');
    return { bytes: await renderMockMockup(u.toString()), mimeType: 'image/jpeg' };
  };
}

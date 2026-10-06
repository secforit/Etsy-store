/**
 * DEVELOPMENT ONLY. In-memory DeskService used when `next dev` runs with DESK_FAKE=1, so the UI can be
 * exercised without Postgres, Ollama or the GPU sidecar. lib/service.ts only imports this file behind
 * a NODE_ENV !== 'production' check, so production builds never contain it.
 */
import type {
  AssetKind,
  DashboardStats,
  DeskService,
  ProductDetail,
  ProductSummary,
  UploadedFile,
} from '@etsy-agents/core/desk/contracts.ts';
import { DeskError } from '@etsy-agents/core/desk/contracts.ts';
import { PRODUCT_STATES } from '@etsy-agents/core/domain/types.ts';
import type { ProductState, Settings } from '@etsy-agents/core/domain/types.ts';
import { hasPngSignature, MAX_UPLOAD_BYTES } from './validate.ts';

export const FAKE_DESK_SERVICE_MARKER = 'fake-desk-service-dev-only';

const PNG = {
  art: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAL0lEQVRYw+3OIQEAAAgDMOIQkcTUgBg3E/Ornb6kEhAQEBAQEBAQEBAQEBAQSAceHToUlzerXKoAAAAASUVORK5CYII=',
  edited:
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAL0lEQVRYw+3OIQEAAAgDMOIQkcTUgBg3E/Ornr2kEhAQEBAQEBAQEBAQEBAQSAceLOAUl5LRbPMAAAAASUVORK5CYII=',
  print:
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAMElEQVRYw+3OIQEAAAgDMOKQiYgEIwcxbibmV71zSSUgICAgICAgICAgICAgIJAOPKWcSHlLDChmAAAAAElFTkSuQmCC',
} as const;

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function seed(): ProductDetail[] {
  const niche = {
    id: '5a1b0f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
    keywords: ['retro camping', 'campfire', 'mountain sunset'],
    theme: 'Retro camping',
    brief: 'Warm 70s-style outdoor illustrations for US campers.',
    season: 'autumn',
    status: 'accepted' as const,
    score: 78,
    reasoning: 'Steady search volume, few original designs.',
    sourceSignalIds: [],
    createdAt: iso(5000),
  };
  const mk = (n: number, state: ProductState, extra: Partial<ProductDetail> = {}): ProductDetail => {
    const id = `00000000-0000-4000-8000-00000000000${n}`;
    const productType = (['tshirt', 'mug', 'poster'] as const)[n % 3]!;
    return {
      product: {
        id,
        nicheId: niche.id,
        productType,
        conceptTitle: `Campfire stories #${n}`,
        designPhrase: n % 2 ? 'Gather round' : null,
        styleNotes: 'Muted oranges, halftone texture, bold outline.',
        targetPriceEur: 24.99,
        state,
        blockReason: state === 'blocked' ? 'Live trademark in class 25: "GATHER ROUND"' : null,
        attempt: 0,
        createdAt: iso(3000 - n),
        updatedAt: iso(100 * n),
      },
      niche,
      design: ['proposed', 'cleared'].includes(state)
        ? null
        : {
            id: `10000000-0000-4000-8000-00000000000${n}`,
            productId: id,
            prompt: 'retro campfire under pine trees, 1970s poster style, flat colors',
            model: 'FLUX.2-klein-4B',
            seed: 1234 + n,
            artKey: `designs/${id}/art-1.png`,
            editedKey: ['designed'].includes(state) ? null : `designs/${id}/edited.png`,
            printKey: ['drafted', 'live', 'rejected'].includes(state) ? `designs/${id}/print.png` : null,
            qaNotes: state === 'drafted' ? ['Upscaled x4 to 4500x5400', 'Alpha OK'] : [],
            createdAt: iso(2000),
            updatedAt: iso(50),
          },
      listing: ['drafted', 'live', 'rejected'].includes(state)
        ? {
            id: `20000000-0000-4000-8000-00000000000${n}`,
            productId: id,
            title: 'Retro Campfire T-Shirt, Vintage Camping Shirt, Outdoor Adventure Gift',
            tags: ['retro camping', 'campfire shirt', 'camping gift', 'outdoor tee'],
            description:
              'A warm retro campfire illustration.\n\nAbout this design: the artwork was created with AI image tools from my own prompts and then edited by hand by me.',
            priceEur: 24.99,
            printifyProductId: `pf-${n}`,
            etsyListingId: 1_700_000_000 + n,
            createdAt: iso(40),
            updatedAt: iso(30),
          }
        : null,
      complianceChecks: [
        {
          id: `30000000-0000-4000-8000-00000000000${n}`,
          productId: id,
          stage: 'concept',
          verdict: state === 'blocked' ? 'block' : 'pass',
          reasons: state === 'blocked' ? ['Trademark conflict'] : ['No blocklist hits', 'No live marks in class'],
          flaggedTerms: state === 'blocked' ? ['gather round'] : [],
          trademarkHits:
            state === 'blocked'
              ? [{ mark: 'GATHER ROUND', serial: '90000000', status: 'live', classes: [25], owner: 'Example LLC' }]
              : [],
          createdAt: iso(2500),
        },
      ],
      estimatedMarginEur: ['drafted', 'live', 'written', 'final_cleared'].includes(state) ? 7.42 : null,
      ...extra,
    };
  };
  return [mk(1, 'designed'), mk(2, 'drafted'), mk(3, 'edited'), mk(4, 'live'), mk(5, 'blocked'), mk(6, 'proposed')];
}

export function createFakeDeskService(): DeskService {
  const products = seed();
  const edited = new Map<string, Uint8Array>();
  let settings: Settings = {
    paused: false,
    dailyDraftCap: 5,
    dailySpendCapUsd: 10,
    blocklist: ['disney', 'nike', 'taylor swift'],
    updatedAt: iso(600),
  };
  const draftsToday = 1;

  const find = (id: string): ProductDetail => {
    const p = products.find((d) => d.product.id === id);
    if (!p) throw new DeskError('Product not found.');
    return p;
  };
  const setState = (d: ProductDetail, state: ProductState): void => {
    d.product = { ...d.product, state, updatedAt: new Date().toISOString() };
  };

  return {
    async getDashboard(): Promise<DashboardStats> {
      const countsByState = Object.fromEntries(PRODUCT_STATES.map((s) => [s, 0])) as Record<ProductState, number>;
      for (const d of products) countsByState[d.product.state] += 1;
      return {
        paused: settings.paused,
        countsByState,
        draftsToday,
        dailyDraftCap: settings.dailyDraftCap,
        spendTodayUsd: 0,
        dailySpendCapUsd: settings.dailySpendCapUsd,
        latestReportMarkdown:
          '# Weekly report\n\n- 1 listing live, 12 views, 1 favorite\n- Retired: none\n- Suggestion: more autumn camping variants',
      };
    },
    async listProducts(filter): Promise<ProductSummary[]> {
      const states = filter?.states;
      return products
        .filter((d) => !states || states.length === 0 || states.includes(d.product.state))
        .slice(0, filter?.limit ?? 100)
        .map((d) => ({
          id: d.product.id,
          productType: d.product.productType,
          conceptTitle: d.product.conceptTitle,
          state: d.product.state,
          theme: d.niche.theme,
          targetPriceEur: d.product.targetPriceEur,
          updatedAt: d.product.updatedAt,
          needsAction: d.product.state === 'designed' || d.product.state === 'drafted',
        }));
    },
    async getProduct(id) {
      return products.find((d) => d.product.id === id) ?? null;
    },
    async uploadEditedDesign(id, file: UploadedFile) {
      const d = find(id);
      if (d.product.state !== 'designed') throw new DeskError(`Upload is only possible in state "designed" (now "${d.product.state}").`);
      if (!hasPngSignature(file.bytes)) throw new DeskError('Only PNG files are accepted.');
      if (file.bytes.length > MAX_UPLOAD_BYTES) throw new DeskError('File is larger than 50 MB.');
      edited.set(id, file.bytes);
      if (d.design) d.design = { ...d.design, editedKey: `designs/${id}/edited.png` };
      setState(d, 'edited');
    },
    async approve(id) {
      const d = find(id);
      if (d.product.state !== 'drafted') throw new DeskError(`Only drafted products can be approved (now "${d.product.state}").`);
      setState(d, 'live');
    },
    async reject(id, reason) {
      const d = find(id);
      if (d.product.state !== 'drafted') throw new DeskError(`Only drafted products can be rejected (now "${d.product.state}").`);
      if (!reason.trim() || reason.length > 500) throw new DeskError('A reason of 1-500 characters is required.');
      setState(d, 'rejected');
    },
    async getAsset(id, kind: AssetKind) {
      const d = products.find((p) => p.product.id === id);
      if (!d?.design) return null;
      if (kind === 'edited') {
        const own = edited.get(id);
        if (own) return { bytes: own, mimeType: 'image/png' };
        if (!d.design.editedKey) return null;
      }
      if (kind === 'print' && !d.design.printKey) return null;
      return { bytes: new Uint8Array(Buffer.from(PNG[kind], 'base64')), mimeType: 'image/png' };
    },
    async getSettings() {
      return settings;
    },
    async updateSettings(patch) {
      settings = { ...settings, ...patch, updatedAt: new Date().toISOString() };
      return settings;
    },
  };
}

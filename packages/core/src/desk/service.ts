/**
 * DeskService: everything the approval desk may do. The desk app imports ONLY createDeskServiceFromEnv (plus
 * loadEnv and types); it never touches the DB or external APIs directly.
 *  - approve:  drafted -> live, activates the Etsy listing (external write, audited)
 *  - reject:   drafted -> rejected, the reason becomes an avoid-rule for the Designer and Listing Writer
 *  - upload:   designed -> edited, after PNG validation + sharp re-encode (security rule 6); enqueues `write`
 * Every human action writes audit_log. Errors the user can fix are DeskError with a safe message.
 */
import { z } from 'zod';
import { costBasisFromCatalog, marginFor } from '../agents/pricing.ts';
import type { Env } from '../config/env.ts';
import { HUMAN_WAIT_STATES } from '../domain/stateMachine.ts';
import { PRODUCT_STATES, type ProductState, type Settings } from '../domain/types.ts';
import { auditExternalWrite } from '../orchestrator/audit.ts';
import { insertAvoidRule } from '../orchestrator/avoidRules.ts';
import type { OrchestratorDeps } from '../orchestrator/contracts.ts';
import { errorMessage } from '../orchestrator/logger.ts';
import { enqueueNextStep } from '../orchestrator/queue.ts';
import {
  StaleStateError,
  countDraftsSince,
  countsByState,
  getDesign,
  getListing,
  getNiche,
  getProduct,
  getSettings,
  insertAudit,
  isUuid,
  latestReport,
  listComplianceChecks,
  roundCents,
  spendSince,
  toIso,
  toNum,
  transitionProduct,
  updateSettings,
} from '../orchestrator/repo.ts';
import { startOfUtcDay } from '../orchestrator/time.ts';
import {
  DeskError,
  type AssetKind,
  type DashboardStats,
  type DeskService,
  type ProductDetail,
  type ProductSummary,
  type UploadedFile,
} from './contracts.ts';
import { validateAndReencodePng } from './upload.ts';

export const REJECT_REASON_MAX = 500;
export const BLOCKLIST_MAX_TERMS = 500;
export const BLOCKLIST_TERM_MAX = 80;

const SettingsPatchSchema = z
  .object({
    paused: z.boolean().optional(),
    dailyDraftCap: z.number().int().min(0).max(100).optional(),
    dailySpendCapUsd: z.number().min(0).max(1000).optional(),
    blocklist: z.array(z.string()).max(BLOCKLIST_MAX_TERMS).optional(),
  })
  .strict();

function cleanActor(actor: string): string {
  const a = String(actor ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
  if (!a) throw new DeskError('Unknown user.');
  return a;
}

export function normaliseBlocklist(terms: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    const t = String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!t) continue;
    if (t.length > BLOCKLIST_TERM_MAX) throw new DeskError(`Blocklist terms must be at most ${BLOCKLIST_TERM_MAX} characters.`);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function createDeskService(deps: OrchestratorDeps): DeskService {
  const { db, integrations, logger } = deps;

  async function requireProduct(productId: string) {
    const product = isUuid(productId) ? await getProduct(db, productId) : null;
    if (!product) throw new DeskError('Product not found.');
    return product;
  }

  async function estimateMargin(productType: ProductDetail['product']['productType'], priceEur: number): Promise<number | null> {
    try {
      const entry = await integrations.printify.getCatalogEntry(productType);
      return roundCents(marginFor(priceEur, costBasisFromCatalog(entry), deps.eurToUsd, deps.shop).marginEur);
    } catch (err) {
      logger.debug({ err: errorMessage(err), productType }, 'desk: margin estimate unavailable');
      return null;
    }
  }

  const service: DeskService = {
    async getDashboard(): Promise<DashboardStats> {
      const now = deps.now();
      const dayStart = startOfUtcDay(now);
      const [settings, counts, draftsToday, spendTodayUsd, report] = await Promise.all([
        getSettings(db),
        countsByState(db),
        countDraftsSince(db, dayStart),
        spendSince(db, dayStart),
        latestReport(db),
      ]);
      return {
        paused: settings.paused,
        countsByState: counts,
        draftsToday,
        dailyDraftCap: settings.dailyDraftCap,
        spendTodayUsd: roundCents(spendTodayUsd),
        dailySpendCapUsd: settings.dailySpendCapUsd,
        latestReportMarkdown: report?.markdown ?? null,
      };
    },

    async listProducts(filter = {}): Promise<ProductSummary[]> {
      const states = (filter.states ?? []).filter((s): s is ProductState => (PRODUCT_STATES as readonly string[]).includes(s));
      if (filter.states && filter.states.length > 0 && states.length === 0) return [];
      const limit = Math.min(Math.max(Math.floor(filter.limit ?? 100), 1), 500);
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT p.id, p.product_type, p.concept_title, p.state, p.target_price_eur, p.updated_at, n.theme
         FROM products p JOIN niches n ON n.id = p.niche_id
         WHERE (cardinality($1::text[]) = 0 OR p.state = ANY($1::text[]))
         ORDER BY (p.state = ANY($2::text[])) DESC, p.updated_at DESC, p.id ASC
         LIMIT $3`,
        [states, [...HUMAN_WAIT_STATES], limit],
      );
      return rows.map((r) => {
        const state = r.state as ProductState;
        return {
          id: String(r.id),
          productType: r.product_type as ProductSummary['productType'],
          conceptTitle: String(r.concept_title),
          state,
          theme: String(r.theme),
          targetPriceEur: toNum(r.target_price_eur),
          updatedAt: toIso(r.updated_at),
          needsAction: HUMAN_WAIT_STATES.includes(state),
        };
      });
    },

    async getProduct(productId: string): Promise<ProductDetail | null> {
      if (!isUuid(productId)) return null;
      const product = await getProduct(db, productId);
      if (!product) return null;
      const [niche, design, listing, complianceChecks] = await Promise.all([
        getNiche(db, product.nicheId),
        getDesign(db, product.id),
        getListing(db, product.id),
        listComplianceChecks(db, product.id),
      ]);
      if (!niche) return null;
      const estimatedMarginEur = await estimateMargin(product.productType, listing?.priceEur ?? product.targetPriceEur);
      return { product, niche, design, listing, complianceChecks, estimatedMarginEur };
    },

    async uploadEditedDesign(productId: string, file: UploadedFile, actor: string): Promise<void> {
      const who = cleanActor(actor);
      const product = await requireProduct(productId);
      if (product.state !== 'designed') {
        throw new DeskError(`Uploads are accepted only while the product waits for your edit (it is ${product.state}).`);
      }
      const design = await getDesign(db, product.id);
      if (!design) throw new DeskError('This product has no generated design yet.');
      const png = await validateAndReencodePng(file?.bytes as Uint8Array);
      const key = `designs/${product.id.toLowerCase()}/edited-${product.attempt + 1}.png`;
      await integrations.storage.put(key, png.bytes, 'image/png');
      try {
        await db.tx(async (q) => {
          const now = deps.now();
          const locked = await getProduct(q, product.id, { forUpdate: true });
          if (!locked || locked.state !== 'designed') throw new StaleStateError(product.id, 'designed');
          await q.query('UPDATE designs SET edited_key = $1, print_key = NULL, updated_at = $2 WHERE product_id = $3', [key, now, product.id]);
          const to = await transitionProduct(q, { productId: product.id, from: 'designed', event: 'edit_uploaded', actor: who, now });
          await insertAudit(
            q,
            {
              actor: who,
              action: 'design.upload',
              entity: 'product',
              entityId: product.id,
              details: { key, widthPx: png.widthPx, heightPx: png.heightPx, bytes: png.bytes.byteLength, attempt: locked.attempt },
            },
            now,
          );
          await enqueueNextStep(q, { ...locked, state: to }, now);
        });
      } catch (err) {
        if (err instanceof StaleStateError) throw new DeskError('The product changed while uploading; reload the page.');
        throw err;
      }
    },

    async approve(productId: string, actor: string): Promise<void> {
      const who = cleanActor(actor);
      const product = await requireProduct(productId);
      if (product.state !== 'drafted') throw new DeskError(`Only drafted products can be approved (it is ${product.state}).`);
      const listing = await getListing(db, product.id);
      if (!listing?.etsyListingId) throw new DeskError('No Etsy draft is linked to this product yet.');
      const etsyListingId = listing.etsyListingId;
      let etsyError: unknown = null;
      try {
        await db.tx(async (q) => {
          // Row lock held across the Etsy call: a concurrent reject (or a double click) waits here, so Etsy is
          // only activated for a product that is still `drafted`, and the DB records exactly what Etsy did.
          const locked = await getProduct(q, product.id, { forUpdate: true });
          if (!locked || locked.state !== 'drafted') throw new StaleStateError(product.id, 'drafted');
          try {
            await integrations.etsy.updateListing(etsyListingId, { state: 'active' });
          } catch (err) {
            etsyError = err;
            throw err;
          }
          const now = deps.now();
          await auditExternalWrite(
            q,
            { actor: who, service: 'etsy', action: 'etsy.listing.activate', entity: 'etsy_listing', entityId: String(etsyListingId), details: { productId: product.id, state: 'active' } },
            now,
          );
          await transitionProduct(q, { productId: product.id, from: 'drafted', event: 'approve', actor: who, now });
          await q.query('INSERT INTO approvals (product_id, decision, reason, actor, decided_at) VALUES ($1, $2, NULL, $3, $4)', [
            product.id,
            'approve',
            who,
            now,
          ]);
          await insertAudit(q, { actor: who, action: 'product.approve', entity: 'product', entityId: product.id, details: { etsyListingId } }, now);
        });
      } catch (err) {
        if (err instanceof StaleStateError) throw new DeskError('This product was already decided; reload the page.');
        if (etsyError !== null) {
          // The transaction rolled back; record the failed external write outside it.
          logger.error({ productId: product.id, etsyListingId, err: errorMessage(etsyError) }, 'desk: Etsy activation failed');
          await insertAudit(
            db,
            { actor: who, action: 'etsy.listing.activate_failed', entity: 'etsy_listing', entityId: String(etsyListingId), details: { productId: product.id, error: errorMessage(etsyError, 300) } },
            deps.now(),
          );
          throw new DeskError('Etsy did not accept the activation. Nothing was changed; try again in a minute.');
        }
        throw err;
      }
    },

    async reject(productId: string, reason: string, actor: string): Promise<void> {
      const who = cleanActor(actor);
      const text = typeof reason === 'string' ? reason.trim() : '';
      if (!text) throw new DeskError('Please give a reason; it teaches the agents what to avoid.');
      if (text.length > REJECT_REASON_MAX) throw new DeskError(`The reason must be at most ${REJECT_REASON_MAX} characters.`);
      const product = await requireProduct(productId);
      if (product.state !== 'drafted') throw new DeskError(`Only drafted products can be rejected (it is ${product.state}).`);
      try {
        await db.tx(async (q) => {
          const now = deps.now();
          await transitionProduct(q, { productId: product.id, from: 'drafted', event: 'reject', actor: who, now });
          await q.query('INSERT INTO approvals (product_id, decision, reason, actor, decided_at) VALUES ($1, $2, $3, $4, $5)', [
            product.id,
            'reject',
            text,
            who,
            now,
          ]);
          const rule = await insertAvoidRule(q, { reason: text, sourceProductId: product.id, actor: who }, now);
          await insertAudit(q, { actor: who, action: 'product.reject', entity: 'product', entityId: product.id, details: { reason: text, avoidRule: rule } }, now);
        });
      } catch (err) {
        if (err instanceof StaleStateError) throw new DeskError('This product was already decided; reload the page.');
        throw err;
      }
    },

    async getAsset(productId: string, kind: AssetKind): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
      if (!isUuid(productId) || !['art', 'edited', 'print'].includes(kind)) return null;
      const design = await getDesign(db, productId);
      if (!design) return null;
      const key = kind === 'art' ? design.artKey : kind === 'edited' ? design.editedKey : design.printKey;
      if (!key || !key.startsWith(`designs/${productId.toLowerCase()}/`)) return null;
      const blob = await integrations.storage.get(key);
      if (!blob) return null;
      return { bytes: blob.bytes, mimeType: 'image/png' };
    },

    async getSettings(): Promise<Settings> {
      return getSettings(db);
    },

    async updateSettings(patch, actor): Promise<Settings> {
      const who = cleanActor(actor);
      const parsed = SettingsPatchSchema.safeParse(patch ?? {});
      if (!parsed.success) throw new DeskError('Invalid settings: check the numbers and the blocklist.');
      const clean: Partial<Pick<Settings, 'paused' | 'dailyDraftCap' | 'dailySpendCapUsd' | 'blocklist'>> = {};
      if (parsed.data.paused !== undefined) clean.paused = parsed.data.paused;
      if (parsed.data.dailyDraftCap !== undefined) clean.dailyDraftCap = parsed.data.dailyDraftCap;
      if (parsed.data.dailySpendCapUsd !== undefined) clean.dailySpendCapUsd = roundCents(parsed.data.dailySpendCapUsd);
      if (parsed.data.blocklist !== undefined) clean.blocklist = normaliseBlocklist(parsed.data.blocklist);
      return db.tx(async (q) => {
        const now = deps.now();
        const before = await getSettings(q);
        const after = await updateSettings(q, clean, now);
        const details: Record<string, unknown> = {};
        if (clean.paused !== undefined) details.paused = { from: before.paused, to: after.paused };
        if (clean.dailyDraftCap !== undefined) details.dailyDraftCap = { from: before.dailyDraftCap, to: after.dailyDraftCap };
        if (clean.dailySpendCapUsd !== undefined) details.dailySpendCapUsd = { from: before.dailySpendCapUsd, to: after.dailySpendCapUsd };
        if (clean.blocklist !== undefined) {
          details.blocklist = {
            added: after.blocklist.filter((t) => !before.blocklist.includes(t)),
            removed: before.blocklist.filter((t) => !after.blocklist.includes(t)),
          };
        }
        await insertAudit(q, { actor: who, action: 'settings.update', entity: 'settings', entityId: '1', details }, now);
        return after;
      });
    },
  };
  return service;
}

let cached: Promise<DeskService> | null = null;

/**
 * Builds the desk runtime (db, Etsy, Printify, storage, image tools; no model, Marker or imagegen clients) from the
 * environment and returns a ready DeskService (cached per process). Load `env` with `loadEnv(source, { scope: 'desk' })`.
 */
export async function createDeskServiceFromEnv(env: Env): Promise<DeskService> {
  if (!cached) {
    cached = (async () => {
      const { buildRuntime } = await import('../orchestrator/runtime.ts');
      // Desk scope: no Marker, imagegen or model clients, so the desk container holds none of their keys.
      const runtime = await buildRuntime(env, { component: 'desk', scope: 'desk' });
      return createDeskService(runtime.deps);
    })();
    cached.catch(() => {
      cached = null; // retry on the next request (e.g. Postgres was still starting)
    });
  }
  return cached;
}

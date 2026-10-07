import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/db.ts';
import { getDesign, getSettings } from '../orchestrator/repo.ts';
import { latestAvoidRules } from '../orchestrator/avoidRules.ts';
import {
  auditActions,
  createHarness,
  jobsOf,
  makePng,
  productState,
  seedProduct,
  sharedTestDb,
  type TestHarness,
} from '../orchestrator/testing/fakes.ts';
import { DeskError, type DeskService } from './contracts.ts';
import { createDeskService } from './service.ts';
import { MAX_UPLOAD_BYTES, hasPngSignature, validateAndReencodePng } from './upload.ts';

let db: Db;
let h: TestHarness;
let desk: DeskService;

beforeEach(async () => {
  db = await sharedTestDb();
  h = await createHarness({ db });
  desk = createDeskService(h.deps);
});

const file = (bytes: Uint8Array, filename = 'edit.png', mimeType = 'image/png') => ({ bytes, filename, mimeType });

async function draftedProduct() {
  const etsyId = h.integrations.fakes.etsy.createDraft('Draft tee');
  const id = await seedProduct(db, h.clock.now(), { state: 'drafted', withDesign: true, withListing: true, etsyListingId: etsyId, printifyProductId: `pf${etsyId}` });
  return { id, etsyId };
}

describe('uploadEditedDesign', () => {
  it('validates, re-encodes, stores, moves designed -> edited, audits and enqueues write', async () => {
    const id = await seedProduct(db, h.clock.now(), { state: 'designed', withDesign: true, editedKey: null });
    const original = await sharp({ create: { width: 90, height: 108, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } })
      .withMetadata({ exif: { IFD0: { Copyright: 'secret-gps-like-metadata' } } })
      .png()
      .toBuffer();
    await desk.uploadEditedDesign(id, file(new Uint8Array(original), '../../etc/passwd', 'text/plain'), 'razvan');

    expect((await productState(db, id)).state).toBe('edited');
    const design = (await getDesign(db, id))!;
    expect(design.editedKey).toBe(`designs/${id}/edited-1.png`);
    const stored = h.integrations.fakes.storage.blobs.get(design.editedKey!)!;
    expect(hasPngSignature(stored.bytes)).toBe(true);
    expect(Buffer.from(stored.bytes).includes('secret-gps-like-metadata')).toBe(false);
    const meta = await sharp(stored.bytes).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([90, 108, true]);
    expect(await auditActions(db, id)).toEqual(['design.upload']);
    expect((await jobsOf(db, { productId: id }))[0]).toMatchObject({ kind: 'write', idempotency_key: `write:${id}:0` });
  });

  it('names the file after the redesign attempt', async () => {
    const id = await seedProduct(db, h.clock.now(), { state: 'designed', withDesign: true, attempt: 1 });
    await desk.uploadEditedDesign(id, file(await makePng(40, 48)), 'razvan');
    expect((await getDesign(db, id))!.editedKey).toBe(`designs/${id}/edited-2.png`);
    expect((await jobsOf(db, { productId: id }))[0]!.idempotency_key).toBe(`write:${id}:1`);
  });

  it('rejects non-PNG files whatever the filename and MIME type say', async () => {
    const id = await seedProduct(db, h.clock.now(), { state: 'designed', withDesign: true });
    const jpeg = new Uint8Array(await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).jpeg().toBuffer());
    await expect(desk.uploadEditedDesign(id, file(jpeg, 'edit.png', 'image/png'), 'razvan')).rejects.toThrow(/Only PNG/);
    await expect(desk.uploadEditedDesign(id, file(new Uint8Array([1, 2, 3])), 'razvan')).rejects.toBeInstanceOf(DeskError);
    await expect(desk.uploadEditedDesign(id, file(new Uint8Array(0)), 'razvan')).rejects.toThrow(/empty/);
    expect((await productState(db, id)).state).toBe('designed');
    expect(h.integrations.fakes.storage.blobs.size).toBe(0);
  });

  it('rejects oversized files before decoding them', async () => {
    const id = await seedProduct(db, h.clock.now(), { state: 'designed', withDesign: true });
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(desk.uploadEditedDesign(id, file(big), 'razvan')).rejects.toThrow(/50 MB/);
  });

  it('rejects images wider or taller than 12000 px', async () => {
    const wide = new Uint8Array(await sharp({ create: { width: 12_001, height: 2, channels: 3, background: '#000' } }).png().toBuffer());
    await expect(validateAndReencodePng(wide)).rejects.toThrow(/maximum is 12000x12000/);
  });

  it('rejects a corrupt PNG with a valid signature', async () => {
    const png = await makePng(20, 20);
    const broken = png.slice(0, 40);
    await expect(validateAndReencodePng(broken)).rejects.toBeInstanceOf(DeskError);
  });

  it('refuses uploads in the wrong state and for unknown products', async () => {
    const id = await seedProduct(db, h.clock.now(), { state: 'drafted', withDesign: true });
    await expect(desk.uploadEditedDesign(id, file(await makePng()), 'razvan')).rejects.toThrow(/only while the product waits/);
    await expect(desk.uploadEditedDesign('not-a-uuid', file(await makePng()), 'razvan')).rejects.toThrow(/not found/);
    await expect(desk.uploadEditedDesign('00000000-0000-4000-8000-000000000000', file(await makePng()), 'razvan')).rejects.toThrow(/not found/);
  });
});

describe('approve / reject', () => {
  it('approve activates the Etsy listing, goes live, records the approval and audits both writes', async () => {
    const { id, etsyId } = await draftedProduct();
    await desk.approve(id, 'razvan');
    expect((await productState(db, id)).state).toBe('live');
    expect(h.integrations.fakes.etsy.updates).toEqual([{ listingId: etsyId, patch: { state: 'active' } }]);
    const approvals = await db.query<{ decision: string; actor: string }>('SELECT decision, actor FROM approvals WHERE product_id = $1', [id]);
    expect(approvals.rows).toEqual([{ decision: 'approve', actor: 'razvan' }]);
    expect(await auditActions(db, id)).toEqual(['product.approve']);
    expect(await auditActions(db, String(etsyId))).toEqual(['etsy.listing.activate']);
    const events = await db.query<{ from_state: string; to_state: string; actor: string }>('SELECT from_state, to_state, actor FROM product_events WHERE product_id = $1', [id]);
    expect(events.rows).toEqual([{ from_state: 'drafted', to_state: 'live', actor: 'razvan' }]);
  });

  it('approve leaves the product drafted when Etsy fails, and audits the failure', async () => {
    const { id, etsyId } = await draftedProduct();
    h.integrations.fakes.etsy.failUpdates = true;
    await expect(desk.approve(id, 'razvan')).rejects.toThrow(/Etsy did not accept/);
    expect((await productState(db, id)).state).toBe('drafted');
    expect(await auditActions(db, String(etsyId))).toEqual(['etsy.listing.activate_failed']);
    const approvals = await db.query('SELECT 1 FROM approvals WHERE product_id = $1', [id]);
    expect(approvals.rows).toHaveLength(0);

    // Etsy recovers: the retry goes through.
    h.integrations.fakes.etsy.failUpdates = false;
    h.clock.advance(60_000);
    await desk.approve(id, 'razvan');
    expect((await productState(db, id)).state).toBe('live');
    expect(await auditActions(db, String(etsyId))).toEqual(['etsy.listing.activate_failed', 'etsy.listing.activate']);
  });

  it('approve holds the product while Etsy is called, so a concurrent reject cannot leave a live listing on a rejected product', async () => {
    const { id, etsyId } = await draftedProduct();
    const etsy = h.integrations.fakes.etsy;
    const original = etsy.updateListing.bind(etsy);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    etsy.updateListing = async (listingId, patch) => {
      await gate;
      return original(listingId, patch);
    };
    const approving = desk.approve(id, 'razvan');
    await new Promise((r) => setTimeout(r, 25));
    const rejecting = desk.reject(id, 'Changed my mind', 'razvan');
    release();
    await approving;
    await expect(rejecting).rejects.toBeInstanceOf(DeskError);
    expect((await productState(db, id)).state).toBe('live');
    expect(etsy.listings.get(etsyId)!.state).toBe('active');
    expect(await latestAvoidRules(db)).toEqual([]);
    expect(await auditActions(db, id)).toEqual(['product.approve']);
  });

  it('approve refuses wrong states and drafts without an Etsy listing', async () => {
    const designed = await seedProduct(db, h.clock.now(), { state: 'designed' });
    await expect(desk.approve(designed, 'razvan')).rejects.toThrow(/Only drafted/);
    const noEtsy = await seedProduct(db, h.clock.now(), { state: 'drafted', withListing: true, etsyListingId: null });
    await expect(desk.approve(noEtsy, 'razvan')).rejects.toThrow(/No Etsy draft/);
    const { id } = await draftedProduct();
    await desk.approve(id, 'razvan');
    await expect(desk.approve(id, 'razvan')).rejects.toThrow(/Only drafted/);
  });

  it('reject records the reason, turns it into an avoid-rule and audits it', async () => {
    const { id } = await draftedProduct();
    await desk.reject(id, '  Too close to an existing\nbestseller layout  ', 'razvan');
    expect((await productState(db, id)).state).toBe('rejected');
    expect(await latestAvoidRules(db)).toEqual(['Too close to an existing bestseller layout']);
    const approvals = await db.query<{ decision: string; reason: string }>('SELECT decision, reason FROM approvals WHERE product_id = $1', [id]);
    expect(approvals.rows[0]).toMatchObject({ decision: 'reject' });
    expect(await auditActions(db, id)).toEqual(['product.reject']);
    expect(h.integrations.fakes.etsy.updates).toEqual([]);
  });

  it('reject validates the reason and the state', async () => {
    const { id } = await draftedProduct();
    await expect(desk.reject(id, '   ', 'razvan')).rejects.toThrow(/give a reason/);
    await expect(desk.reject(id, 'x'.repeat(501), 'razvan')).rejects.toThrow(/at most 500/);
    const live = await seedProduct(db, h.clock.now(), { state: 'live' });
    await expect(desk.reject(live, 'nope', 'razvan')).rejects.toThrow(/Only drafted/);
    expect((await productState(db, id)).state).toBe('drafted');
  });

  it('the latest 20 rejection reasons feed the agents, newest first', async () => {
    for (let i = 0; i < 22; i++) {
      const { id } = await draftedProduct();
      await desk.reject(id, `reason ${i}`, 'razvan');
      h.clock.advance(1000);
    }
    const rules = await latestAvoidRules(db);
    expect(rules).toHaveLength(20);
    expect(rules[0]).toBe('reason 21');
    expect(rules.at(-1)).toBe('reason 2');
  });
});

describe('read models and settings', () => {
  it('lists needs-action products first and filters by state', async () => {
    const a = await seedProduct(db, h.clock.now(), { state: 'live' });
    h.clock.advance(1000);
    const b = await seedProduct(db, h.clock.now(), { state: 'designed' });
    h.clock.advance(1000);
    const c = await seedProduct(db, h.clock.now(), { state: 'proposed' });
    const all = await desk.listProducts();
    expect(all.map((p) => p.id)).toEqual([b, c, a]);
    expect(all[0]).toMatchObject({ needsAction: true, theme: 'Retro Camping Fans', targetPriceEur: 24.99 });
    expect((await desk.listProducts({ states: ['live'] })).map((p) => p.id)).toEqual([a]);
    expect(await desk.listProducts({ states: ['nonsense' as never] })).toEqual([]);
  });

  it('returns product detail with a margin estimate and assets inside the product folder only', async () => {
    const { id } = await draftedProduct();
    await h.integrations.storage.put(`designs/${id}/art-1.png`, await makePng(), 'image/png');
    const detail = (await desk.getProduct(id))!;
    expect(detail.product.id).toBe(id);
    expect(detail.listing?.etsyListingId).toBeGreaterThan(0);
    expect(typeof detail.estimatedMarginEur).toBe('number');
    expect(await desk.getProduct('not-a-uuid')).toBeNull();
    expect((await desk.getAsset(id, 'art'))?.mimeType).toBe('image/png');
    expect(await desk.getAsset(id, 'print')).toBeNull();
    await db.query('UPDATE designs SET art_key = $1 WHERE product_id = $2', ['designs/other/art-1.png', id]);
    expect(await desk.getAsset(id, 'art')).toBeNull();
  });

  it('margin estimate is null when the catalog is unavailable', async () => {
    const { id } = await draftedProduct();
    h.integrations.fakes.printify.failCatalog = true;
    expect((await desk.getProduct(id))!.estimatedMarginEur).toBeNull();
  });

  it('dashboard shows caps, spend and the latest report', async () => {
    await db.query(`INSERT INTO weekly_reports (week_start, markdown) VALUES ('2026-10-05', '# Report')`);
    await db.query(`INSERT INTO agent_runs (agent, model, cost_usd, ok, created_at) VALUES ('designer', 'cloud', 1.25, true, $1)`, [h.clock.now()]);
    const dash = await desk.getDashboard();
    expect(dash).toMatchObject({ paused: false, dailyDraftCap: 5, dailySpendCapUsd: 10, spendTodayUsd: 1.25, draftsToday: 0, latestReportMarkdown: '# Report' });
    expect(Object.keys(dash.countsByState)).toHaveLength(11);
  });

  it('updates settings with validation, normalises the blocklist and audits the change', async () => {
    const s = await desk.updateSettings({ paused: true, dailyDraftCap: 10, blocklist: [' Disney ', 'disney', 'Star  Wars', ''] }, 'razvan');
    expect(s).toMatchObject({ paused: true, dailyDraftCap: 10, blocklist: ['disney', 'star wars'] });
    expect((await getSettings(db)).paused).toBe(true);
    await expect(desk.updateSettings({ dailyDraftCap: 101 }, 'razvan')).rejects.toBeInstanceOf(DeskError);
    await expect(desk.updateSettings({ dailySpendCapUsd: -1 }, 'razvan')).rejects.toBeInstanceOf(DeskError);
    await expect(desk.updateSettings({ blocklist: ['x'.repeat(81)] }, 'razvan')).rejects.toThrow(/at most 80/);
    await expect(desk.updateSettings({ evil: true } as never, 'razvan')).rejects.toBeInstanceOf(DeskError);
    const audit = await db.query<{ details: { blocklist: { added: string[] } } }>(`SELECT details FROM audit_log WHERE action = 'settings.update'`);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.details.blocklist.added).toEqual(['disney', 'star wars']);
  });
});

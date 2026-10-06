import { beforeEach, describe, expect, it } from 'vitest';
import { SHOP } from '@etsy-agents/core/config/shop.ts';
import type { Db } from '@etsy-agents/core/db/db.ts';
import type { ProductType } from '@etsy-agents/core/domain/types.ts';
import type { PrintifyClient } from '@etsy-agents/core/integrations/types.ts';
import { dbCatalogResolver, listPinnedCatalog } from '@etsy-agents/core/orchestrator/catalog.ts';
import { FAKE_CATALOG, TestClock, auditActions, sharedTestDb } from '@etsy-agents/core/orchestrator/testing/fakes.ts';
import { MemoryIo } from '../io.ts';
import { setupCatalog } from './setupCatalog.ts';

let db: Db;
const clock = new TestClock();
beforeEach(async () => {
  db = await sharedTestDb();
});

/** A Printify fake that resolves ids through the DB resolver, like the live client does. */
function resolvingPrintify(validBlueprints: number[] = [12, 68, 282, 99]): PrintifyClient {
  const resolve = dbCatalogResolver(db);
  return {
    async getCatalogEntry(pt: ProductType) {
      const pinned = await resolve(pt);
      const base = structuredClone(FAKE_CATALOG[pt]);
      if (pinned) {
        if (!validBlueprints.includes(pinned.blueprintId)) throw new Error(`blueprint ${pinned.blueprintId} not found`);
        return { ...base, blueprintId: pinned.blueprintId, printProviderId: pinned.printProviderId };
      }
      return base;
    },
    uploadImage: async () => ({ id: 'x' }),
    createProduct: async () => ({ id: 'x' }),
    getProduct: async (id) => ({ id, title: '', mockupUrls: [], external: null, isLocked: false }),
    publishProduct: async () => {},
  };
}

describe('setup-catalog', () => {
  it('discovers and pins every enabled product type, audited', async () => {
    const io = new MemoryIo();
    const res = await setupCatalog({ db, printify: resolvingPrintify(), shop: SHOP, now: clock.now, io });
    expect(res).toEqual({ pinned: ['tshirt', 'mug', 'poster'], failed: [] });
    const rows = await listPinnedCatalog(db);
    expect(rows.map((r) => [r.productType, r.blueprintId, r.printProviderId])).toEqual([
      ['mug', 68, 1],
      ['poster', 282, 2],
      ['tshirt', 12, 29],
    ]);
    expect(rows.find((r) => r.productType === 'mug')!.details).toMatchObject({ variants: 1, printArea: { widthPx: 2475 } });
    expect(await auditActions(db, 'tshirt')).toEqual(['catalog.pin']);
    expect(io.text()).toMatch(/tshirt\s+blueprint 12, provider 29/);
  });

  it('pins explicit ids after verifying them and restores the previous pin when they are wrong', async () => {
    const io = new MemoryIo();
    await setupCatalog({ db, printify: resolvingPrintify(), shop: SHOP, now: clock.now, io, type: 'mug', blueprintId: 99, printProviderId: 7 });
    expect((await listPinnedCatalog(db)).map((r) => [r.productType, r.blueprintId])).toEqual([['mug', 99]]);

    const bad = await setupCatalog({ db, printify: resolvingPrintify(), shop: SHOP, now: clock.now, io, type: 'mug', blueprintId: 5, printProviderId: 7 });
    expect(bad.failed).toEqual(['mug']);
    expect((await listPinnedCatalog(db)).map((r) => [r.productType, r.blueprintId])).toEqual([['mug', 99]]);
    expect(io.errors.join('\n')).toMatch(/blueprint 5 not found/);
  });

  it('dry run pins nothing; partial id flags are refused', async () => {
    const io = new MemoryIo();
    await setupCatalog({ db, printify: resolvingPrintify(), shop: SHOP, now: clock.now, io, dryRun: true });
    expect(await listPinnedCatalog(db)).toEqual([]);
    await expect(setupCatalog({ db, printify: resolvingPrintify(), shop: SHOP, now: clock.now, io, blueprintId: 3 })).rejects.toThrow(/together/);
  });
});

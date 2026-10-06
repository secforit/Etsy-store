/**
 * `setup-catalog`: pins the Printify blueprint + print provider per product type in the database
 * (table printify_catalog). Without ids it asks the Printify client for the catalog entry (which auto-discovers a
 * blueprint and a US print provider in live mode) and pins what it found; with --type/--blueprint/--provider it
 * pins those ids after verifying them. Reading costs may create and delete a short-lived Printify "cost probe"
 * product; every such write is recorded in audit_log.
 */
import type { Db } from '@etsy-agents/core/db/db.ts';
import { PRODUCT_TYPES, type ProductType } from '@etsy-agents/core/domain/types.ts';
import type { PrintifyCatalogEntry, PrintifyClient } from '@etsy-agents/core/integrations/types.ts';
import { listPinnedCatalog, pinCatalog } from '@etsy-agents/core/orchestrator/catalog.ts';
import { errorMessage } from '@etsy-agents/core/orchestrator/logger.ts';
import { insertAudit } from '@etsy-agents/core/orchestrator/repo.ts';
import type { ShopConfig } from '@etsy-agents/core/config/shop.ts';
import type { Io } from '../io.ts';

export interface SetupCatalogOptions {
  db: Db;
  printify: PrintifyClient;
  shop: ShopConfig;
  now: () => Date;
  io: Io;
  type?: ProductType;
  blueprintId?: number;
  printProviderId?: number;
  dryRun?: boolean;
}

function describe(e: PrintifyCatalogEntry): Record<string, unknown> {
  const costs = e.variants.map((v) => v.costUsd);
  return {
    printArea: e.printArea,
    variants: e.variants.length,
    minCostUsd: costs.length ? Math.min(...costs) : null,
    maxCostUsd: costs.length ? Math.max(...costs) : null,
    shippingFirstItemUsd: e.shippingFirstItemUsd,
  };
}

export async function setupCatalog(o: SetupCatalogOptions): Promise<{ pinned: ProductType[]; failed: ProductType[] }> {
  const { db, printify, io } = o;
  if ((o.blueprintId !== undefined || o.printProviderId !== undefined) && (!o.type || !o.blueprintId || !o.printProviderId)) {
    throw new Error('pinning explicit ids needs --type, --blueprint and --provider together');
  }
  if (o.type && !(PRODUCT_TYPES as readonly string[]).includes(o.type)) throw new Error(`unknown product type ${o.type}`);
  const types = o.type ? [o.type] : PRODUCT_TYPES.filter((t) => o.shop.products[t].enabled);
  const pinned: ProductType[] = [];
  const failed: ProductType[] = [];

  for (const type of types) {
    const previous = (await listPinnedCatalog(db)).find((r) => r.productType === type) ?? null;
    try {
      let entry: PrintifyCatalogEntry;
      if (o.blueprintId && o.printProviderId) {
        // Pin first so the client resolves these ids, verify, and restore the previous pin on failure.
        await pinCatalog(db, { productType: type, blueprintId: o.blueprintId, printProviderId: o.printProviderId }, o.now());
        try {
          entry = await printify.getCatalogEntry(type);
        } catch (err) {
          if (previous) await pinCatalog(db, previous, o.now());
          else await db.query('DELETE FROM printify_catalog WHERE product_type = $1', [type]);
          throw err;
        }
      } else {
        entry = await printify.getCatalogEntry(type);
      }
      const details = describe(entry);
      io.out(
        `${type.padEnd(7)} blueprint ${entry.blueprintId}, provider ${entry.printProviderId}, ${entry.variants.length} variants, ` +
          `print area ${entry.printArea.widthPx}x${entry.printArea.heightPx} (${entry.printArea.position}), shipping $${entry.shippingFirstItemUsd.toFixed(2)}`,
      );
      if (o.dryRun) continue;
      await db.tx(async (q) => {
        await pinCatalog(q, { productType: type, blueprintId: entry.blueprintId, printProviderId: entry.printProviderId, details }, o.now());
        await insertAudit(
          q,
          {
            actor: 'cli',
            action: 'catalog.pin',
            entity: 'printify_catalog',
            entityId: type,
            details: { blueprintId: entry.blueprintId, printProviderId: entry.printProviderId, previous: previous ? { blueprintId: previous.blueprintId, printProviderId: previous.printProviderId } : null },
          },
          o.now(),
        );
      });
      pinned.push(type);
    } catch (err) {
      io.err(`${type.padEnd(7)} FAILED: ${errorMessage(err, 300)}`);
      failed.push(type);
    }
  }
  if (o.dryRun) io.out('Dry run: nothing was pinned.');
  else io.out(`Pinned: ${pinned.join(', ') || 'none'}${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
  return { pinned, failed };
}

/**
 * Printify catalog ids pinned by `setup-catalog` (table printify_catalog, migration 002). SHOP.products is a
 * contract file whose ids stay null, so the DB row wins and SHOP.products is the fallback.
 */
import type { Queryable } from '../db/db.ts';
import { SHOP } from '../config/shop.ts';
import { PRODUCT_TYPES, type ProductType } from '../domain/types.ts';
import { toIso, toNum } from './repo.ts';

export interface PinnedCatalogIds {
  blueprintId: number;
  printProviderId: number;
}

export interface PinnedCatalogRow extends PinnedCatalogIds {
  productType: ProductType;
  details: Record<string, unknown>;
  updatedAt: string;
}

export async function listPinnedCatalog(q: Queryable): Promise<PinnedCatalogRow[]> {
  const { rows } = await q.query<Record<string, unknown>>('SELECT * FROM printify_catalog ORDER BY product_type');
  return rows.map((r) => ({
    productType: r.product_type as ProductType,
    blueprintId: toNum(r.blueprint_id),
    printProviderId: toNum(r.print_provider_id),
    details: (r.details as Record<string, unknown>) ?? {},
    updatedAt: toIso(r.updated_at),
  }));
}

export async function pinCatalog(
  q: Queryable,
  row: { productType: ProductType; blueprintId: number; printProviderId: number; details?: Record<string, unknown> },
  now: Date,
): Promise<void> {
  if (!(PRODUCT_TYPES as readonly string[]).includes(row.productType)) throw new Error(`unknown product type ${row.productType}`);
  for (const n of [row.blueprintId, row.printProviderId]) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('blueprint and print provider ids must be positive integers');
  }
  await q.query(
    `INSERT INTO printify_catalog (product_type, blueprint_id, print_provider_id, details, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (product_type) DO UPDATE SET blueprint_id = EXCLUDED.blueprint_id,
       print_provider_id = EXCLUDED.print_provider_id, details = EXCLUDED.details, updated_at = EXCLUDED.updated_at`,
    [row.productType, row.blueprintId, row.printProviderId, JSON.stringify(row.details ?? {}), now],
  );
}

/** Resolver for createIntegrations({ printifyCatalog }): DB pin, else SHOP.products, else null (auto-discover). */
export function dbCatalogResolver(q: Queryable) {
  return async (productType: ProductType): Promise<PinnedCatalogIds | null> => {
    const { rows } = await q.query<Record<string, unknown>>(
      'SELECT blueprint_id, print_provider_id FROM printify_catalog WHERE product_type = $1',
      [productType],
    );
    const r = rows[0];
    if (r) return { blueprintId: toNum(r.blueprint_id), printProviderId: toNum(r.print_provider_id) };
    const p = SHOP.products[productType];
    return p.printifyBlueprintId !== null && p.printifyPrintProviderId !== null
      ? { blueprintId: p.printifyBlueprintId, printProviderId: p.printifyPrintProviderId }
      : null;
  };
}

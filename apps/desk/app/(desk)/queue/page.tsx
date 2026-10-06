import type { Metadata } from 'next';
import Link from 'next/link';
import type { ProductSummary } from '@etsy-agents/core/desk/contracts.ts';
import { PRODUCT_STATES } from '@etsy-agents/core/domain/types.ts';
import type { ProductState } from '@etsy-agents/core/domain/types.ts';
import { StateBadge } from '../../../components/StateBadge.tsx';
import { dateTime, eur, PRODUCT_TYPE_LABELS, STATE_LABELS } from '../../../lib/format.ts';
import { getDeskService } from '../../../lib/service.ts';
import { requireSession } from '../../../lib/session.ts';
import { parseStatesParam } from '../../../lib/validate.ts';

export const metadata: Metadata = { title: 'Queue' };

const LIMIT = 200;
const NEEDS_ACTION: ProductState[] = ['designed', 'drafted'];

/** Needs-action first, then most recently updated. */
function sortQueue(items: ProductSummary[]): ProductSummary[] {
  return [...items].sort((a, b) => {
    if (a.needsAction !== b.needsAction) return a.needsAction ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function sameStates(a: ProductState[], b: ProductState[]): boolean {
  return a.length === b.length && a.every((s) => b.includes(s));
}

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const states = parseStatesParam((await searchParams).state);
  const svc = await getDeskService();
  const items = sortQueue(await svc.listProducts({ ...(states.length ? { states } : {}), limit: LIMIT }));

  const filters: { label: string; states: ProductState[] }[] = [
    { label: 'All', states: [] },
    { label: 'Needs action', states: NEEDS_ACTION },
    ...PRODUCT_STATES.map((s) => ({ label: STATE_LABELS[s], states: [s] })),
  ];

  return (
    <>
      <div className="page-head">
        <h1>Queue</h1>
        <span className="muted small">
          {items.length} product{items.length === 1 ? '' : 's'}
          {items.length >= LIMIT ? ` (first ${LIMIT})` : ''}
        </span>
      </div>

      <nav className="filters" aria-label="Filter by state">
        {filters.map((f) => (
          <Link
            key={f.label}
            className="chip"
            href={f.states.length ? `/queue?state=${f.states.join(',')}` : '/queue'}
            aria-current={sameStates(states, f.states) ? 'page' : undefined}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        <p className="muted">Nothing here.</p>
      ) : (
        <ul className="product-list">
          {items.map((p) => (
            <li key={p.id}>
              <Link href={`/products/${p.id}`} className="product-row">
                <span className="title">{p.conceptTitle}</span>
                <StateBadge state={p.state} />
                <span className="meta">
                  {PRODUCT_TYPE_LABELS[p.productType]} · {p.theme} · {eur(p.targetPriceEur)} · updated {dateTime(p.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

import type { ProductState } from '@etsy-agents/core/domain/types.ts';
import { STATE_LABELS } from '../lib/format.ts';

const TONE: Record<ProductState, string> = {
  proposed: 'badge',
  cleared: 'badge',
  designed: 'badge badge-action',
  edited: 'badge badge-info',
  written: 'badge badge-info',
  final_cleared: 'badge badge-info',
  drafted: 'badge badge-action',
  live: 'badge badge-ok',
  retired: 'badge',
  blocked: 'badge badge-bad',
  rejected: 'badge badge-bad',
};

export function StateBadge({ state }: { state: ProductState }) {
  return <span className={TONE[state]}>{STATE_LABELS[state]}</span>;
}

import type { ProductState } from '@etsy-agents/core/domain/types.ts';

const eurFmt = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });
const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

export function eur(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? eurFmt.format(value) : '–';
}

export function usd(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? usdFmt.format(value) : '–';
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '–' : `${dateFmt.format(d)} UTC`;
}

export const STATE_LABELS: Record<ProductState, string> = {
  proposed: 'Proposed',
  cleared: 'Concept cleared',
  designed: 'Needs your edit',
  edited: 'Edited',
  written: 'Copy written',
  final_cleared: 'Final check passed',
  drafted: 'Needs approval',
  live: 'Live',
  retired: 'Retired',
  blocked: 'Blocked',
  rejected: 'Rejected',
};

export const PRODUCT_TYPE_LABELS = { tshirt: 'T-shirt', mug: 'Mug', poster: 'Poster' } as const;

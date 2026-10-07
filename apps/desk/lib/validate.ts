/**
 * Input validation for desk forms and URL parameters. Pure; the service re-validates everything.
 */
import { PRODUCT_STATES } from '@etsy-agents/core/domain/types.ts';
import type { ProductState, Settings } from '@etsy-agents/core/domain/types.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isProductState(value: unknown): value is ProductState {
  return typeof value === 'string' && (PRODUCT_STATES as readonly string[]).includes(value);
}

/** `?state=a&state=b` or `?state=a,b` -> valid states only (unknown values dropped). */
export function parseStatesParam(raw: string | string[] | undefined): ProductState[] {
  if (!raw) return [];
  const values = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => v.split(','));
  return [...new Set(values.map((v) => v.trim()).filter(isProductState))];
}

export const ASSET_KINDS = ['art', 'edited', 'print'] as const;
export type AssetKindParam = (typeof ASSET_KINDS)[number];

export function isAssetKind(value: unknown): value is AssetKindParam {
  return typeof value === 'string' && (ASSET_KINDS as readonly string[]).includes(value);
}

/**
 * Only same-site relative paths survive (prevents open redirects after login).
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (/[\u0000-\u001f\\]/.test(value)) return '/';
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login/')) return '/';
  return value;
}

/** Confirmation shown on the product page after a successful action (`?done=<key>`); fixed texts only. */
export const DONE_NOTICES = {
  uploaded: 'Edited design uploaded. The Listing Writer picks it up next.',
  approved: 'Approved. The Etsy listing is now active.',
  rejected: 'Rejected. The reason will steer future designs and listings.',
} as const;
export type DoneKey = keyof typeof DONE_NOTICES;

export function doneNotice(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && Object.hasOwn(DONE_NOTICES, value) ? DONE_NOTICES[value as DoneKey] : null;
}

export const REJECT_REASON_MAX = 500;

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

export function parseRejectReason(raw: unknown): Parsed<string> {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length === 0) return { ok: false, message: 'A reason is required to reject.' };
  if (reason.length > REJECT_REASON_MAX) {
    return { ok: false, message: `Keep the reason to ${REJECT_REASON_MAX} characters or fewer.` };
  }
  return { ok: true, value: reason };
}

export const DRAFT_CAP_MAX = 100;
export const SPEND_CAP_MAX_USD = 1000;
export const BLOCKLIST_MAX_ENTRIES = 500; // matches the DeskService limits
export const BLOCKLIST_TERM_MAX = 80;

export type SettingsPatch = Partial<Pick<Settings, 'paused' | 'dailyDraftCap' | 'dailySpendCapUsd' | 'blocklist'>>;

/** Parses the settings form. Each field is optional; only fields present in the form are patched. */
export function parseSettingsForm(form: {
  get(name: string): unknown;
  has(name: string): boolean;
}): Parsed<SettingsPatch> {
  const patch: SettingsPatch = {};

  if (form.has('dailyDraftCap')) {
    const raw = String(form.get('dailyDraftCap') ?? '').trim();
    if (!/^[0-9]{1,4}$/.test(raw) || Number(raw) > DRAFT_CAP_MAX) {
      return { ok: false, message: `Daily draft cap must be a whole number from 0 to ${DRAFT_CAP_MAX}.` };
    }
    patch.dailyDraftCap = Number(raw);
  }

  if (form.has('dailySpendCapUsd')) {
    const raw = String(form.get('dailySpendCapUsd') ?? '').trim();
    if (!/^[0-9]{1,5}(\.[0-9]{1,2})?$/.test(raw) || Number(raw) > SPEND_CAP_MAX_USD) {
      return { ok: false, message: `Daily cloud spend cap must be 0 to ${SPEND_CAP_MAX_USD} USD (max 2 decimals).` };
    }
    patch.dailySpendCapUsd = Math.round(Number(raw) * 100) / 100;
  }

  if (form.has('blocklist')) {
    const raw = String(form.get('blocklist') ?? '');
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const term = line.trim().replace(/\s+/g, ' ');
      if (!term) continue;
      if (term.length > BLOCKLIST_TERM_MAX) {
        return { ok: false, message: `Blocklist terms must be ${BLOCKLIST_TERM_MAX} characters or fewer.` };
      }
      if (/[\u0000-\u001f]/.test(term)) return { ok: false, message: 'Blocklist terms cannot contain control characters.' };
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(term);
    }
    if (terms.length > BLOCKLIST_MAX_ENTRIES) {
      return { ok: false, message: `The blocklist can hold at most ${BLOCKLIST_MAX_ENTRIES} terms.` };
    }
    patch.blocklist = terms;
  }

  if (form.has('paused')) {
    const raw = String(form.get('paused') ?? '');
    if (raw !== 'true' && raw !== 'false') return { ok: false, message: 'Invalid pause value.' };
    patch.paused = raw === 'true';
  }

  return { ok: true, value: patch };
}

/** Upload ceiling enforced by the desk before the service re-checks (rule 6: max 50 MB). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

/** Display name for an uploaded file: never used as a path, only echoed back escaped by React. */
export function cleanFilename(name: unknown): string {
  const base = typeof name === 'string' ? name.split(/[\\/]/).pop() ?? '' : '';
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120).trim();
  return cleaned || 'upload.png';
}

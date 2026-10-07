'use server';
/**
 * Every server action re-checks session + origin (requireActionAuth) even though proxy.ts already did:
 * Server Functions are reachable by POST to any page that renders them.
 * Human actions are audited by the DeskService (actor = 'razvan').
 */
import { refresh } from 'next/cache';
import { headers } from 'next/headers';
import { redirect, RedirectType } from 'next/navigation';
import { DeskError } from '@etsy-agents/core/desk/contracts.ts';
import type { ActionState } from './actionState.ts';
import { MAX_PASSWORD_LENGTH, verifyPassword } from './auth.ts';
import { tryGetDeskConfig } from './config.ts';
import { describeError, log } from './log.ts';
import { clientIpFromHeaders, loginLimiters } from './rateLimit.ts';
import { getDeskService } from './service.ts';
import { assertSameOrigin, endSession, requireActionAuth, startSession } from './session.ts';
import {
  cleanFilename,
  hasPngSignature,
  isUuid,
  MAX_UPLOAD_BYTES,
  parseRejectReason,
  parseSettingsForm,
  safeNextPath,
} from './validate.ts';
import type { DoneKey } from './validate.ts';

const GLOBAL_KEY = '*';
/** Each scrypt check (N=2^17) holds ~128 MiB; bound how many run at once. */
const MAX_CONCURRENT_LOGINS = 2;
let inFlightLogins = 0;

/**
 * After a successful product action the page re-renders without the form that was used (the state moved on),
 * so the confirmation travels as a fixed `?done=` key instead of the form's own state.
 */
function backToProduct(productId: string, done: DoneKey): never {
  redirect(`/products/${productId}?done=${done}`, RedirectType.replace);
}

function fail(message: string): ActionState {
  return { ok: false, message };
}

/** DeskError messages are written for the user; anything else is logged and replaced. */
function toUserMessage(action: string, err: unknown): ActionState {
  if (err instanceof DeskError) return fail(err.message);
  log.error({ action, error: describeError(err) }, 'desk action failed');
  return fail('Something went wrong. Details are in the desk logs.');
}

// ---------------------------------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------------------------------

export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertSameOrigin();
  const h = await headers();
  const ip = clientIpFromHeaders((name) => h.get(name));
  const { perIp, global } = loginLimiters();
  const ipDecision = perIp.check(ip);
  const globalDecision = global.check(GLOBAL_KEY);
  if (!ipDecision.allowed || !globalDecision.allowed) {
    const waitMs = Math.max(ipDecision.retryAfterMs, globalDecision.retryAfterMs);
    log.warn({ ip, scope: ipDecision.allowed ? 'global' : 'ip' }, 'login rate limited');
    return fail(`Too many attempts. Try again in ${Math.max(1, Math.ceil(waitMs / 60_000))} min.`);
  }

  const cfg = tryGetDeskConfig();
  if (!cfg.ok || !cfg.config.passwordHash || !cfg.config.sessionSecret) {
    return fail('Login is not configured on this server. See docs/RUNBOOK.md.');
  }

  const raw = formData.get('password');
  const password = typeof raw === 'string' ? raw : '';
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return fail('Wrong password.');

  // Count the attempt BEFORE the (slow, ~128 MiB) scrypt check so parallel requests cannot all slip
  // past the limiter; a success clears the per-IP counter below.
  perIp.hit(ip);
  global.hit(GLOBAL_KEY);
  if (inFlightLogins >= MAX_CONCURRENT_LOGINS) return fail('The desk is busy. Try again in a few seconds.');
  inFlightLogins += 1;
  let ok = false;
  try {
    ok = await verifyPassword(password, cfg.config.passwordHash);
  } finally {
    inFlightLogins -= 1;
  }
  if (!ok) {
    log.warn({ ip }, 'login failed');
    return fail('Wrong password.');
  }

  perIp.reset(ip);
  await startSession(cfg.config.sessionSecret);
  log.info({ ip, actor: 'razvan' }, 'login ok');
  redirect(safeNextPath(formData.get('next')));
}

/**
 * The action is reachable without a session (any page that renders it, including the public /login, accepts
 * the POST), so only a request with a valid session revokes sessions; anything else just clears its own cookie.
 */
export async function logoutAction(): Promise<void> {
  await assertSameOrigin();
  const revoked = await endSession();
  if (revoked) log.info({ actor: 'razvan' }, 'logout');
  else log.warn({}, 'logout without a valid session: cookie cleared, no session revoked');
  redirect('/login');
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

/** Plain form action for the dashboard pause toggle. */
export async function setPausedAction(formData: FormData): Promise<void> {
  const session = await requireActionAuth();
  const parsed = parseSettingsForm({
    has: (n) => n === 'paused' && formData.has('paused'),
    get: (n) => formData.get(n),
  });
  if (!parsed.ok || parsed.value.paused === undefined) throw new Error('Invalid pause value.');
  const svc = await getDeskService();
  await svc.updateSettings({ paused: parsed.value.paused }, session.actor);
  refresh();
}

export async function updateSettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireActionAuth();
  const parsed = parseSettingsForm(formData);
  if (!parsed.ok) return fail(parsed.message);
  if (Object.keys(parsed.value).length === 0) return fail('Nothing to save.');
  try {
    const svc = await getDeskService();
    await svc.updateSettings(parsed.value, session.actor);
  } catch (err) {
    return toUserMessage('updateSettings', err);
  }
  refresh();
  return { ok: true, message: 'Settings saved.' };
}

// ---------------------------------------------------------------------------------------------
// Product actions
// ---------------------------------------------------------------------------------------------

export async function uploadEditedAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireActionAuth();
  const productId = formData.get('productId');
  if (!isUuid(productId)) return fail('Unknown product.');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return fail('Choose your edited PNG file.');
  if (file.size > MAX_UPLOAD_BYTES) return fail('The file is larger than 50 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasPngSignature(bytes)) return fail('Only PNG files are accepted.');
  try {
    const svc = await getDeskService();
    await svc.uploadEditedDesign(productId, { bytes, filename: cleanFilename(file.name), mimeType: 'image/png' }, session.actor);
  } catch (err) {
    return toUserMessage('uploadEditedDesign', err);
  }
  backToProduct(productId, 'uploaded');
}

export async function approveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireActionAuth();
  const productId = formData.get('productId');
  if (!isUuid(productId)) return fail('Unknown product.');
  try {
    const svc = await getDeskService();
    await svc.approve(productId, session.actor);
  } catch (err) {
    return toUserMessage('approve', err);
  }
  backToProduct(productId, 'approved');
}

export async function rejectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireActionAuth();
  const productId = formData.get('productId');
  if (!isUuid(productId)) return fail('Unknown product.');
  const reason = parseRejectReason(formData.get('reason'));
  if (!reason.ok) return fail(reason.message);
  try {
    const svc = await getDeskService();
    await svc.reject(productId, reason.value, session.actor);
  } catch (err) {
    return toUserMessage('reject', err);
  }
  backToProduct(productId, 'rejected');
}

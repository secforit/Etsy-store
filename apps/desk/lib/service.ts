/**
 * Server-only access to the DeskService. The desk never touches the DB or external APIs itself.
 * Development-only: DESK_FAKE=1 swaps in an in-memory fake (dead code in production builds,
 * because NODE_ENV is inlined as "production" by `next build`).
 */
import 'server-only';
import { createDeskServiceFromEnv } from '@etsy-agents/core/desk/service.ts';
import type { DeskService } from '@etsy-agents/core/desk/contracts.ts';
import { getDeskConfig } from './config.ts';
import { describeError, log } from './log.ts';

const CACHE_KEY = Symbol.for('etsy-agents.desk.service');

function create(): Promise<DeskService> {
  if (process.env.NODE_ENV !== 'production' && process.env.DESK_FAKE === '1') {
    return import('./fakeService.ts').then((m) => m.createFakeDeskService());
  }
  return createDeskServiceFromEnv(getDeskConfig().env);
}

/** One DeskService per process. A failed initialisation is not cached, so the next request retries. */
export function getDeskService(): Promise<DeskService> {
  const g = globalThis as unknown as Record<symbol, Promise<DeskService> | undefined>;
  const cached = g[CACHE_KEY];
  if (cached) return cached;
  const pending = create().catch((err: unknown) => {
    if (g[CACHE_KEY] === pending) g[CACHE_KEY] = undefined;
    log.error({ error: describeError(err) }, 'desk service initialisation failed');
    throw err;
  });
  g[CACHE_KEY] = pending;
  return pending;
}

/**
 * Audit logging: every human action and every external write (Printify create/publish, Etsy activate/update)
 * lands in `audit_log`. Details never contain secrets or image bytes.
 */
import type { Db, Queryable } from '../db/db.ts';
import type { Logger } from './contracts.ts';
import { errorMessage } from './logger.ts';
import { insertAudit, type AuditInput } from './repo.ts';

export { insertAudit, type AuditInput };

/** Shape of the integrations' external-write events (integrations/printify.ts ExternalWriteEvent). */
export interface ExternalWriteLike {
  service: string;
  action: string;
  entity: string;
  entityId: string | null;
  details: Record<string, unknown>;
}

/**
 * Hook for `createIntegrations({ onExternalWrite })`: writes each external write the integrations make on
 * their own (image upload, product create/publish/delete, cost probes) to audit_log. Never throws.
 */
export function externalWriteAuditHook(db: Db, now: () => Date, logger: Logger) {
  return async (e: ExternalWriteLike): Promise<void> => {
    try {
      await insertAudit(
        db,
        {
          actor: 'system',
          action: e.action,
          entity: e.entity,
          entityId: e.entityId,
          details: { service: e.service, ...sanitizeDetails(e.details) },
        },
        now(),
      );
    } catch (err) {
      logger.error({ err: errorMessage(err), action: e.action }, 'audit: could not record external write');
    }
  };
}

/** Drops values that look like secrets or binary payloads before they reach the audit log. */
export function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (/token|secret|password|authorization|api[_-]?key|base64|bytes/i.test(k)) continue;
    if (v instanceof Uint8Array) continue;
    out[k] = typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
  }
  return out;
}

/** Audit helper for an external write done by orchestrator/desk code (Etsy activate, retire...). */
export async function auditExternalWrite(
  q: Queryable,
  a: { actor: string; service: 'etsy' | 'printify'; action: string; entity: string; entityId: string | null; details?: Record<string, unknown> },
  now: Date,
): Promise<void> {
  await insertAudit(
    q,
    {
      actor: a.actor,
      action: a.action,
      entity: a.entity,
      entityId: a.entityId,
      details: { service: a.service, ...sanitizeDetails(a.details ?? {}) },
    },
    now,
  );
}

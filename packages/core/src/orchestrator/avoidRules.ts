/**
 * Avoid-rules: Razvan's rejection reasons, kept as short rules ("avoid ...") that steer the Designer and the
 * Listing Writer. The latest 20 active rules are passed to both agents as trusted instructions written by
 * Razvan himself (never model output).
 */
import type { Queryable } from '../db/db.ts';

export const AVOID_RULES_LIMIT = 20;
export const AVOID_RULE_MAX_CHARS = 500;

/** Latest active rules, newest first. */
export async function latestAvoidRules(q: Queryable, limit = AVOID_RULES_LIMIT): Promise<string[]> {
  const { rows } = await q.query<{ rule: string }>(
    'SELECT rule FROM avoid_rules WHERE active ORDER BY created_at DESC, id DESC LIMIT $1',
    [Math.min(Math.max(Math.floor(limit), 1), 100)],
  );
  return rows.map((r) => r.rule);
}

/** One line, no control characters, <= 500 chars. Empty when nothing usable is left. */
export function avoidRuleFromReason(reason: string): string {
  const clean = reason
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, AVOID_RULE_MAX_CHARS);
}

export async function insertAvoidRule(
  q: Queryable,
  a: { reason: string; sourceProductId: string | null; actor: string },
  now: Date,
): Promise<string | null> {
  const rule = avoidRuleFromReason(a.reason);
  if (!rule) return null;
  await q.query('INSERT INTO avoid_rules (rule, source_product_id, actor, created_at) VALUES ($1, $2, $3, $4)', [
    rule,
    a.sourceProductId,
    a.actor,
    now,
  ]);
  return rule;
}

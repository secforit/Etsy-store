import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.ts';

/** What the approval desk's container receives (deploy/docker-compose.yml): no Marker, imagegen or LLM keys. */
const deskOnly = {
  MODE: 'live',
  DATABASE_URL: 'postgres://u:p@postgres:5432/db',
  ETSY_API_KEY: 'keystring',
  ETSY_SHOP_ID: '1',
  ETSY_REFRESH_TOKEN: 'r',
  PRINTIFY_API_TOKEN: 't',
  PRINTIFY_SHOP_ID: '2',
  DESK_SESSION_SECRET: 's'.repeat(40),
};

describe('loadEnv scopes (least-privilege containers)', () => {
  it('the worker (default scope) still needs every pipeline key in live mode', () => {
    expect(() => loadEnv(deskOnly)).toThrow(/MARKER_API_USERNAME.*MARKER_API_PASSWORD.*IMAGEGEN_TOKEN/);
    expect(() => loadEnv({ ...deskOnly, LLM_ROUTES: '{"compliance_guard":"anthropic"}' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('the desk scope needs only the desk keys, even when cloud routing is configured', () => {
    expect(loadEnv(deskOnly, { scope: 'desk' }).MODE).toBe('live');
    expect(() => loadEnv({ ...deskOnly, LLM_ROUTES: '{"compliance_guard":"anthropic"}' }, { scope: 'desk' })).not.toThrow();
    const { ETSY_API_KEY: _drop, ...noEtsy } = deskOnly;
    expect(() => loadEnv(noEtsy, { scope: 'desk' })).toThrow(/ETSY_API_KEY is required when MODE=live/);
  });

  it('the database scope (migrate) needs only DATABASE_URL', () => {
    expect(loadEnv({ MODE: 'live', DATABASE_URL: 'postgres://u:p@postgres:5432/db' }, { scope: 'database' }).MODE).toBe('live');
    expect(() => loadEnv({ MODE: 'live' }, { scope: 'database' })).toThrow(/DATABASE_URL is required/);
  });

  it('error messages carry key names, never values', () => {
    try {
      loadEnv({ ...deskOnly, MARKER_API_PASSWORD: 'hunter2-secret' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2-secret');
      expect((err as Error).message).not.toContain('keystring');
    }
  });
});

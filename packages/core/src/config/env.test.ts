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

  it('an all-cloud worker (Nous + fal) needs their keys instead of the GPU sidecar token', () => {
    const base = { ...deskOnly, MARKER_API_USERNAME: 'u', MARKER_API_PASSWORD: 'p', LLM_DEFAULT_PROVIDER: 'nous', IMAGEGEN_PROVIDER: 'fal' };
    expect(() => loadEnv(base)).toThrow(/NOUS_API_KEY.*NOUS_MODEL_LARGE.*NOUS_MODEL_SMALL.*NOUS_MODEL_VISION.*FAL_KEY/);
    const env = loadEnv({ ...base, NOUS_API_KEY: 'k', NOUS_MODEL_LARGE: 'a/large', NOUS_MODEL_SMALL: 'a/small', NOUS_MODEL_VISION: 'a/vl', FAL_KEY: 'f' });
    expect(env.IMAGEGEN_TOKEN).toBeUndefined();
    expect(env.NOUS_BASE_URL).toBe('https://inference-api.nousresearch.com/v1');
    // The vision model is needed only when an image-sending agent is routed to Nous.
    const textOnly = { ...base, LLM_DEFAULT_PROVIDER: 'ollama', LLM_ROUTES: '{"analyst":"nous"}', NOUS_API_KEY: 'k', NOUS_MODEL_LARGE: 'a', NOUS_MODEL_SMALL: 'b', FAL_KEY: 'f' };
    expect(() => loadEnv(textOnly)).not.toThrow();
    expect(() => loadEnv({ ...textOnly, LLM_ROUTES: '{"qa_publisher":"nous"}' })).toThrow(/NOUS_MODEL_VISION/);
    expect(() => loadEnv({ ...textOnly, LLM_ROUTES: '{"analyst":"openai"}' })).toThrow(/LLM_ROUTES must be JSON/);
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

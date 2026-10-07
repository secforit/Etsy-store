import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createPgliteDb } from '../db/db.ts';
import { loadEnv } from '../config/env.ts';
import { cloudModelsWithoutPrice, loadOrchestratorEnv, scopeEnvForLoad } from './config.ts';
import { assertCloudModelsPriced, buildRuntime } from './runtime.ts';

describe('worker settings', () => {
  it('has safe defaults and treats empty strings as unset', () => {
    const s = loadOrchestratorEnv({ EUR_TO_USD: '', TREND_SCAN_HOUR_UTC: '' });
    expect(s).toMatchObject({
      EUR_TO_USD: 1.1,
      WORKER_POLL_INTERVAL_MS: 5000,
      TREND_SCAN_HOUR_UTC: 4,
      ANALYST_REPORT_INTERVAL_HOURS: 24,
      WORKER_HEARTBEAT_PATH: '/tmp/worker-heartbeat',
      RECRAFT_COST_PER_IMAGE_USD: 0.08,
    });
  });

  it('the heartbeat setting does not trip loadEnv (no *_FILE name), and unrelated *_FILE variables are dropped', () => {
    const raw = {
      MODE: 'mock',
      WORKER_HEARTBEAT_PATH: '/nonexistent/heartbeat',
      SSL_CERT_FILE: '/nonexistent/ca.pem',
      SOME_TOOL_CONFIG_FILE: '/nonexistent/x',
      ETSY_API_KEY_FILE: '/run/secrets/etsy_api_key',
    };
    const scoped = scopeEnvForLoad(raw);
    expect(scoped).toEqual({ MODE: 'mock', WORKER_HEARTBEAT_PATH: '/nonexistent/heartbeat', ETSY_API_KEY_FILE: '/run/secrets/etsy_api_key' });
    const { ETSY_API_KEY_FILE: _secret, ...withoutSecret } = scoped;
    expect(loadEnv(withoutSecret).MODE).toBe('mock');
    expect(() => loadEnv(raw)).toThrow(/ENOENT/);
  });

  it('rejects out-of-range values with key names only', () => {
    expect(() => loadOrchestratorEnv({ TREND_SCAN_HOUR_UTC: '25' })).toThrow(/TREND_SCAN_HOUR_UTC/);
    expect(() => loadOrchestratorEnv({ EUR_TO_USD: 'abc' })).toThrow(/EUR_TO_USD/);
  });
});

describe('cloudModelsWithoutPrice', () => {
  const live = {
    MODE: 'live' as const,
    LLM_DEFAULT_PROVIDER: 'ollama' as const,
    LLM_ROUTES: { compliance_guard: 'anthropic' as const },
    ANTHROPIC_MODEL_LARGE: 'model-large',
    ANTHROPIC_MODEL_SMALL: 'model-small',
  };

  it('lists routed cloud models that have no price', () => {
    expect(cloudModelsWithoutPrice(live, {})).toEqual(['model-large', 'model-small']);
    const prices = JSON.stringify({ 'model-large': { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } });
    expect(cloudModelsWithoutPrice(live, { LLM_PRICES_JSON: prices })).toEqual(['model-small']);
    expect(cloudModelsWithoutPrice(live, { LLM_PRICES_JSON: 'not json' })).toEqual(['model-large', 'model-small']);
  });

  it('is empty for local-only routing and in mock mode', () => {
    expect(cloudModelsWithoutPrice({ ...live, LLM_ROUTES: {} }, {})).toEqual([]);
    expect(cloudModelsWithoutPrice({ ...live, MODE: 'mock' }, {})).toEqual([]);
  });
});

describe('live start-up refuses unpriced cloud models (spend cap fails closed)', () => {
  const liveEnv = {
    MODE: 'live',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
    ETSY_API_KEY: 'k',
    ETSY_SHOP_ID: '1',
    ETSY_REFRESH_TOKEN: 'r',
    PRINTIFY_API_TOKEN: 't',
    PRINTIFY_SHOP_ID: '2',
    MARKER_API_USERNAME: 'u',
    MARKER_API_PASSWORD: 'p',
    IMAGEGEN_TOKEN: 'x'.repeat(32),
    LLM_ROUTES: '{"compliance_guard":"anthropic"}',
    ANTHROPIC_API_KEY: 'sk-test',
    ANTHROPIC_MODEL_LARGE: 'model-large',
    ANTHROPIC_MODEL_SMALL: 'model-small',
  };

  it('throws naming the models before touching the database', async () => {
    const env = loadEnv(liveEnv);
    expect(() => assertCloudModelsPriced(env, liveEnv)).toThrow(/model-large, model-small/);
    // buildRuntime fails with the same message (no DB connection is attempted: DATABASE_URL points nowhere).
    await expect(buildRuntime(env, { rawEnv: liveEnv })).rejects.toThrow(/LLM_PRICES_JSON has no price/);
  });

  it('passes when every cloud model id has a price', () => {
    const prices = JSON.stringify({
      'model-large': { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
      'model-small': { inputPerMTokUsd: 1, outputPerMTokUsd: 5 },
    });
    const raw = { ...liveEnv, LLM_PRICES_JSON: prices };
    expect(() => assertCloudModelsPriced(loadEnv(raw), raw)).not.toThrow();
  });
});

describe('desk runtime (least privilege)', () => {
  it("starts without the worker's secrets and never calls a model or a worker-only client", async () => {
    // The desk container: no Marker, imagegen or Anthropic keys and no prices, even if cloud routing leaked in.
    const raw: Record<string, string> = {
      MODE: 'live',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
      STORAGE_DIR: path.join(os.tmpdir(), 'desk-runtime-test'),
      ETSY_API_KEY: 'k',
      ETSY_SHARED_SECRET: 's',
      ETSY_SHOP_ID: '1',
      ETSY_REFRESH_TOKEN: 'r',
      PRINTIFY_API_TOKEN: 't',
      PRINTIFY_SHOP_ID: '2',
      LLM_ROUTES: '{"compliance_guard":"anthropic"}',
    };
    const env = loadEnv(raw, { scope: 'desk' });
    const db = await createPgliteDb();
    try {
      const runtime = await buildRuntime(env, { scope: 'desk', db, rawEnv: raw, component: 'desk' });
      await expect(
        runtime.deps.llm.generate({ agent: 'analyst', tier: 'small', system: 's', instructions: 'i', untrustedData: {}, schema: z.object({}) }),
      ).rejects.toThrow(/does not call language models/);
      expect(() => runtime.deps.integrations.trademark.search('x')).toThrow(/not available in the approval desk/);
      await runtime.close();
    } finally {
      await db.close();
    }
  });
});

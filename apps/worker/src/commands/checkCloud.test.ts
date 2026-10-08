import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '@etsy-agents/core/config/env.ts';
import { loadOrchestratorEnv } from '@etsy-agents/core/orchestrator/config.ts';
import { MemoryIo } from '../io.ts';
import { main } from '../cli.ts';
import { agentModelLines, checkCloud, printCloudCheck } from './checkCloud.ts';

const KEY = 'nous-secret-key-123';
const settings = loadOrchestratorEnv({});

const catalog = {
  data: [
    { id: 'nousresearch/hermes-4-405b', pricing: { prompt: '0.000001', completion: '0.000003' }, architecture: { input_modalities: ['text'] } },
    { id: 'nousresearch/hermes-4-70b', pricing: { prompt: '0.00000013', completion: '0.0000004' }, architecture: { input_modalities: ['text'] } },
    { id: 'vendor/vision-a', pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { input_modalities: ['text', 'image'] } },
    { id: 'vendor/vision-b', architecture: { input_modalities: ['image', 'text'] } },
  ],
};

function stub(status = 200, body: unknown = catalog) {
  const seen: { url: string; auth: string | null }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, seen };
}

const cloudEnv = (over: Record<string, string> = {}) =>
  loadEnv({
    MODE: 'mock',
    LLM_DEFAULT_PROVIDER: 'nous',
    IMAGEGEN_PROVIDER: 'fal',
    NOUS_API_KEY: KEY,
    NOUS_MODEL_LARGE: 'nousresearch/hermes-4-405b',
    NOUS_MODEL_SMALL: 'nousresearch/hermes-4-70b',
    NOUS_MODEL_VISION: 'vendor/vision-a',
    FAL_KEY: 'fal-secret',
    ...over,
  });

describe('check-cloud', () => {
  it('is READY when every model is in the catalog, priced, and the vision model takes images', async () => {
    const { fn, seen } = stub();
    const env = cloudEnv();
    const r = await checkCloud(env, fn);
    expect(r.ok).toBe(true);
    expect(seen).toEqual([{ url: 'https://inference-api.nousresearch.com/v1/models', auth: `Bearer ${KEY}` }]);
    const io = new MemoryIo();
    printCloudCheck(io, env, settings, r);
    const text = io.text();
    expect(text).toMatch(/large {2}nousresearch\/hermes-4-405b: ok, \$1 in \/ \$3 out per M tokens/);
    expect(text).toMatch(/vision vendor\/vision-a: ok/);
    expect(text).toMatch(/fal {6}: FAL_KEY set/);
    expect(text).toMatch(/Cloud providers: READY/);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('fal-secret');
  });

  it('flags unknown ids and a text-only vision model, and lists image-capable alternatives', async () => {
    const { fn } = stub();
    const env = cloudEnv({ NOUS_MODEL_SMALL: 'typo/model', NOUS_MODEL_VISION: 'nousresearch/hermes-4-70b' });
    const r = await checkCloud(env, fn);
    expect(r.ok).toBe(false);
    expect(r.nous.visionCandidates).toEqual(['vendor/vision-a', 'vendor/vision-b']);
    const io = new MemoryIo();
    printCloudCheck(io, env, settings, r);
    expect(io.text()).toMatch(/small {2}typo\/model: NOT in your Portal catalog/);
    expect(io.text()).toMatch(/vision nousresearch\/hermes-4-70b: does NOT accept images/);
    expect(io.text()).toMatch(/image-capable models in your catalog: vendor\/vision-a, vendor\/vision-b/);
    expect(io.text()).toMatch(/NOT READY/);
  });

  it('warns that an unpriced model is billed at the fallback rate (still usable)', async () => {
    const { fn } = stub();
    const env = cloudEnv({ NOUS_MODEL_VISION: 'vendor/vision-b' });
    const r = await checkCloud(env, fn);
    expect(r.ok).toBe(true);
    const io = new MemoryIo();
    printCloudCheck(io, env, settings, r);
    expect(io.text()).toMatch(/vendor\/vision-b: ok, no price in the catalog: billed at the conservative fallback rate/);
  });

  it('reports a rejected Nous key', async () => {
    const { fn } = stub(401, { error: 'unauthorized' });
    const res = await checkCloud(cloudEnv(), fn);
    expect(res.ok).toBe(false);
    expect(res.nous.error).toMatch(/HTTP 401/);
  });

  it('reports a missing fal key (mock mode loads without it)', async () => {
    const { fn } = stub();
    const env = loadEnv({ MODE: 'mock', IMAGEGEN_PROVIDER: 'fal' });
    const res = await checkCloud(env, fn);
    expect(res.ok).toBe(false);
    const io = new MemoryIo();
    printCloudCheck(io, env, settings, res);
    expect(io.text()).toMatch(/Nous {5}: not used/);
    expect(io.text()).toMatch(/fal {6}: NOT ready \(FAL_KEY is not set/);
  });

  it('says what is not used for an all-local setup', async () => {
    const { fn, seen } = stub();
    const env = loadEnv({ MODE: 'mock' });
    const r = await checkCloud(env, fn);
    expect(r.ok).toBe(true);
    expect(seen).toEqual([]);
    const io = new MemoryIo();
    printCloudCheck(io, env, settings, r);
    expect(io.text()).toMatch(/Nous {5}: not used \(LLM_DEFAULT_PROVIDER=ollama\)/);
    expect(io.text()).toMatch(/fal {6}: not used \(IMAGEGEN_PROVIDER=local\)/);
  });

  it('prints the model each agent uses: LLM_TIERS moves agents between the large and small models', () => {
    const env = cloudEnv({
      NOUS_MODEL_LARGE: 'deepseek/deepseek-v4-pro',
      NOUS_MODEL_SMALL: 'deepseek/deepseek-v4-flash',
      LLM_TIERS: '{"trend_scout":"small","listing_writer":"small"}',
    });
    const lines = agentModelLines(env).join('\n');
    expect(lines).toMatch(/trend_scout +nous small deepseek\/deepseek-v4-flash/);
    expect(lines).toMatch(/listing_writer +nous small deepseek\/deepseek-v4-flash/);
    expect(lines).toMatch(/designer +nous small deepseek\/deepseek-v4-flash/);
    expect(lines).toMatch(/niche_validator +nous large deepseek\/deepseek-v4-pro/);
    expect(lines).toMatch(/analyst +nous large deepseek\/deepseek-v4-pro/);
    expect(lines).toMatch(/compliance_guard +nous large deepseek\/deepseek-v4-pro; images: vendor\/vision-a/);
    expect(lines).toMatch(/qa_publisher +nous small deepseek\/deepseek-v4-flash; images: vendor\/vision-a/);
  });
});

describe('check-cloud command', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('runs in live mode before the Etsy, Printify and Marker keys exist, and names a missing vision model', async () => {
    vi.stubGlobal('fetch', stub().fn);
    const io = new MemoryIo();
    const code = await main(['check-cloud'], {
      io,
      rawEnv: {
        MODE: 'live',
        LLM_DEFAULT_PROVIDER: 'nous',
        IMAGEGEN_PROVIDER: 'fal',
        NOUS_API_KEY: KEY,
        NOUS_MODEL_LARGE: 'nousresearch/hermes-4-405b',
        NOUS_MODEL_SMALL: 'nousresearch/hermes-4-70b',
        FAL_KEY: 'fal-secret',
      },
    });
    expect(code).toBe(1);
    expect(io.text()).toMatch(/vision \(NOUS_MODEL_VISION not set\): MISSING/);
    expect(io.text()).toMatch(/image-capable models in your catalog: vendor\/vision-a, vendor\/vision-b/);
    expect(io.text()).not.toContain(KEY);
  });
});

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.ts';
import { LiveEtsyClient } from './etsy.ts';
import { createIntegrations, etsyRefreshTokenPath } from './factory.ts';
import { FalImageGenClient, FalUpscaler } from './fal.ts';
import { MockGpuCoordinator, OllamaAwareGpuCoordinator } from './gpu.ts';
import { LocalImageGenClient, LocalUpscaler } from './imagegen.ts';
import { MockEtsyClient } from './mocks/etsy.ts';
import { LivePrintifyClient } from './printify.ts';
import { RecraftImageGenClient } from './recraft.ts';
import { FileBlobStorage } from './storage.ts';
import { LiveTrademarkClient } from './trademark.ts';
import { stubFetch } from './testing.ts';
import { noopLogger } from './util.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const liveEnv = (extra: Record<string, string> = {}) =>
  loadEnv({
    MODE: 'live',
    DATABASE_URL: 'postgres://u:p@postgres:5432/db',
    STORAGE_DIR: dir,
    ETSY_API_KEY: 'keystring',
    ETSY_SHARED_SECRET: 'secret',
    ETSY_SHOP_ID: '5551234',
    ETSY_REFRESH_TOKEN: '123.refresh',
    PRINTIFY_API_TOKEN: 'pfy',
    PRINTIFY_SHOP_ID: '987654',
    MARKER_API_USERNAME: 'u',
    MARKER_API_PASSWORD: 'p',
    IMAGEGEN_TOKEN: 'imagegen-token-0123456789abcdef',
    ...extra,
  });

describe('createIntegrations', () => {
  it('MODE=mock returns the offline bundle with file storage under STORAGE_DIR', async () => {
    const i = await createIntegrations(loadEnv({ MODE: 'mock', STORAGE_DIR: dir }));
    expect(i.etsy).toBeInstanceOf(MockEtsyClient);
    expect(i.gpu).toBeInstanceOf(MockGpuCoordinator);
    expect(i.storage).toBeInstanceOf(FileBlobStorage);
    expect(i.upscaler).not.toBeNull();
    await i.storage.put('designs/x/art-1.png', new Uint8Array([1]), 'image/png');
    expect(await fs.readdir(path.join(dir, 'designs', 'x'))).toEqual(['art-1.png']);
  });

  it('MODE=live wires live clients, local FLUX sidecar and the Ollama-aware GPU coordinator without network', async () => {
    const fetch = stubFetch(() => new Response('unexpected', { status: 500 }));
    const i = await createIntegrations(liveEnv(), { fetch, logger: noopLogger });
    expect(i.etsy).toBeInstanceOf(LiveEtsyClient);
    expect(i.printify).toBeInstanceOf(LivePrintifyClient);
    expect(i.trademark).toBeInstanceOf(LiveTrademarkClient);
    expect(i.imageGen).toBeInstanceOf(LocalImageGenClient);
    expect(i.upscaler).toBeInstanceOf(LocalUpscaler);
    expect(i.gpu).toBeInstanceOf(OllamaAwareGpuCoordinator);
    expect(i.trendSources.map((s) => s.name)).toEqual(['etsy_search', 'pinterest', 'seasonal']);
    expect(await i.trendSources[1]!.fetchSignals({ market: 'US', today: '2026-10-06' })).toEqual([]); // no Pinterest token
    expect(fetch.calls).toHaveLength(0); // construction makes no requests
    expect(etsyRefreshTokenPath(dir)).toBe(path.join(dir, '.secrets', 'etsy-refresh-token.json'));
  });

  it('IMAGEGEN_PROVIDER=recraft picks Recraft and keeps the sidecar upscaler when configured', async () => {
    const i = await createIntegrations(liveEnv({ IMAGEGEN_PROVIDER: 'recraft', RECRAFT_API_KEY: 'rk' }), { logger: noopLogger });
    expect(i.imageGen).toBeInstanceOf(RecraftImageGenClient);
    expect(i.upscaler).toBeInstanceOf(LocalUpscaler);
  });

  it('IMAGEGEN_PROVIDER=fal runs art and upscaling on fal; the GPU sidecar is never called, even with a token set', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 204 }));
    const env = liveEnv({
      IMAGEGEN_PROVIDER: 'fal',
      FAL_KEY: 'fk',
      LLM_DEFAULT_PROVIDER: 'nous',
      NOUS_API_KEY: 'nk',
      NOUS_MODEL_LARGE: 'a/large',
      NOUS_MODEL_SMALL: 'a/small',
      NOUS_MODEL_VISION: 'a/vl',
    });
    const i = await createIntegrations(env, { fetch, logger: noopLogger });
    expect(i.imageGen).toBeInstanceOf(FalImageGenClient);
    expect(i.upscaler).toBeInstanceOf(FalUpscaler);
    await i.gpu.withGpu('image', async () => undefined);
    await i.gpu.withGpu('llm', async () => undefined);
    expect(fetch.calls).toHaveLength(0); // no Ollama unload, no sidecar /unload: nothing local is deployed
  });

  it('live GPU coordinator skips Ollama when every agent runs on Anthropic', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 204 }));
    const env = liveEnv({
      LLM_DEFAULT_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk',
      ANTHROPIC_MODEL_LARGE: 'm-large',
      ANTHROPIC_MODEL_SMALL: 'm-small',
    });
    const i = await createIntegrations(env, { fetch, logger: noopLogger });
    await i.gpu.withGpu('image', async () => undefined);
    expect(fetch.calls.filter((c) => c.url.includes('ollama'))).toHaveLength(0);
  });

  it("desk scope builds without the worker's keys (Marker, imagegen) and refuses worker-only clients", async () => {
    const fetch = stubFetch(() => new Response('unexpected', { status: 500 }));
    const env = loadEnv(
      {
        MODE: 'live',
        DATABASE_URL: 'postgres://u:p@postgres:5432/db',
        STORAGE_DIR: dir,
        ETSY_API_KEY: 'keystring',
        ETSY_SHOP_ID: '5551234',
        ETSY_REFRESH_TOKEN: '123.refresh',
        PRINTIFY_API_TOKEN: 'pfy',
        PRINTIFY_SHOP_ID: '987654',
      },
      { scope: 'desk' },
    );
    // The full bundle cannot be built from the desk's environment...
    await expect(createIntegrations(env, { fetch, logger: noopLogger })).rejects.toThrow(/MARKER_API_USERNAME/);
    // ...the desk bundle can, and only its own clients are real.
    const i = await createIntegrations(env, { fetch, logger: noopLogger, scope: 'desk' });
    expect(i.etsy).toBeInstanceOf(LiveEtsyClient);
    expect(i.printify).toBeInstanceOf(LivePrintifyClient);
    expect(i.storage).toBeInstanceOf(FileBlobStorage);
    expect(i.upscaler).toBeNull();
    expect(i.trendSources).toEqual([]);
    expect(() => i.trademark.search('anything')).toThrow(/not available in the approval desk/);
    expect(() => i.imageGen.generate({ prompt: 'p', style: 's', transparentBackground: true, widthPx: 512, heightPx: 512 })).toThrow(
      /not available in the approval desk/,
    );
    expect(() => i.gpu.withGpu('llm', async () => 1)).toThrow(/not available in the approval desk/);
    await expect(i.fetchImage('https://images.printify.com/x.png')).rejects.toThrow(/not available in the approval desk/);
    expect(fetch.calls).toHaveLength(0);
  });
});

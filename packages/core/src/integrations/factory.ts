/**
 * Builds the integrations bundle.
 * MODE=mock -> deterministic offline mocks (blobs on disk under STORAGE_DIR so the desk can show them).
 * MODE=live -> live clients: Etsy (OAuth refresh), Printify, Marker, trend sources, filesystem storage,
 *              GPU coordinator (Ollama + imagegen sidecar on one RTX 3060, whichever this config runs), image
 *              generation from IMAGEGEN_PROVIDER (local sidecar by default; fal or Recraft in the cloud), and the
 *              upscaler that goes with it (sidecar Real-ESRGAN, fal Real-ESRGAN, or none = sharp-only resize).
 *              With `scope: 'desk'` only Etsy, Printify, storage and image tools (the desk holds no other keys).
 * Secrets are read from `env` only and never logged.
 */
import path from 'node:path';
import pino from 'pino';
import { usesLlmProvider, type Env } from '../config/env.ts';
import type { Logger } from '../orchestrator/contracts.ts';
import { EtsyTokenManager, FileRefreshTokenStore, LiveEtsyClient } from './etsy.ts';
import { FalImageGenClient, FalUpscaler } from './fal.ts';
import { createAllowlistedImageFetcher } from './fetchImage.ts';
import { OllamaAdmin, OllamaAwareGpuCoordinator } from './gpu.ts';
import type { FetchLike } from './http.ts';
import { ImagegenSidecar, LocalImageGenClient, LocalUpscaler } from './imagegen.ts';
import { SharpImageTools } from './imageTools.ts';
import { createMockIntegrations } from './mocks/index.ts';
import { LivePrintifyClient, type ExternalWriteHook, type PrintifyCatalogResolver } from './printify.ts';
import { RecraftImageGenClient } from './recraft.ts';
import { FileBlobStorage } from './storage.ts';
import { LiveTrademarkClient } from './trademark.ts';
import { EtsySearchTrendSource, PinterestTrendSource, SeasonalTrendSource } from './trends.ts';
import type { BlobStorage, GpuCoordinator, ImageGenClient, ImageUpscaler, Integrations, TrademarkClient } from './types.ts';

export interface CreateIntegrationsOptions {
  logger?: Logger;
  /** Injected fetch (tests). */
  fetch?: FetchLike;
  /** Clock for mocks (receipts, draft timestamps). */
  now?: () => Date;
  /** Printify blueprint/provider ids per product type (e.g. from setup-catalog); default SHOP.products. */
  printifyCatalog?: PrintifyCatalogResolver;
  /** Called for every external write the integrations make on their own (e.g. Printify cost probe) -> audit_log. */
  onExternalWrite?: ExternalWriteHook;
  /** Override blob storage (tests). */
  storage?: BlobStorage;
  /**
   * 'desk' (live mode): only the clients the approval desk uses (Etsy, Printify, storage, image tools). Marker,
   * image generation, the GPU stack, trend sources and the mockup fetcher are stubs that throw, so the desk
   * container needs none of their keys (see config/env.ts EnvScope). Default 'all'.
   */
  scope?: 'all' | 'desk';
}

/** Stand-in for a client the desk must never use: any call fails loudly instead of reaching a service. */
function notInDesk<T extends object>(name: string): T {
  const fail = () => {
    throw new Error(`${name} is not available in the approval desk`);
  };
  return new Proxy({} as T, {
    get: (_target, prop) => (prop === 'then' ? undefined : fail),
  });
}

function defaultLogger(env: Env): Logger {
  return pino({
    level: env.LOG_LEVEL,
    base: { component: 'integrations' },
    redact: { paths: ['*.token', '*.authorization', '*.password', '*.apiKey', '*.refreshToken'], censor: '[redacted]' },
  });
}

function required(value: string | undefined, key: string): string {
  if (!value) throw new Error(`createIntegrations: ${key} is required when MODE=live`);
  return value;
}

/** Where the rotated Etsy refresh token is kept: inside the storage volume, unreachable by blob keys. */
export function etsyRefreshTokenPath(storageDir: string): string {
  return path.join(path.resolve(storageDir), '.secrets', 'etsy-refresh-token.json');
}

export async function createIntegrations(env: Env, opts: CreateIntegrationsOptions = {}): Promise<Integrations> {
  if (env.MODE === 'mock') {
    return createMockIntegrations({
      storageDir: env.STORAGE_DIR,
      ...(opts.storage ? { storage: opts.storage } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.onExternalWrite ? { onExternalWrite: opts.onExternalWrite } : {}),
    });
  }

  const logger = opts.logger ?? defaultLogger(env);
  const fetchImpl = opts.fetch;

  const etsyKey = required(env.ETSY_API_KEY, 'ETSY_API_KEY');
  const etsyRefresh = required(env.ETSY_REFRESH_TOKEN, 'ETSY_REFRESH_TOKEN');
  const tokens = new EtsyTokenManager({
    clientId: etsyKey,
    initialRefreshToken: etsyRefresh,
    store: new FileRefreshTokenStore(etsyRefreshTokenPath(env.STORAGE_DIR), etsyRefresh),
    fetch: fetchImpl,
    logger,
  });
  const etsy = new LiveEtsyClient({
    apiKey: etsyKey,
    sharedSecret: env.ETSY_SHARED_SECRET ?? null,
    shopId: required(env.ETSY_SHOP_ID, 'ETSY_SHOP_ID'),
    tokens,
    fetch: fetchImpl,
    logger,
  });

  const printify = new LivePrintifyClient({
    token: required(env.PRINTIFY_API_TOKEN, 'PRINTIFY_API_TOKEN'),
    shopId: required(env.PRINTIFY_SHOP_ID, 'PRINTIFY_SHOP_ID'),
    fetch: fetchImpl,
    logger,
    ...(opts.printifyCatalog ? { catalog: opts.printifyCatalog } : {}),
    ...(opts.onExternalWrite ? { onExternalWrite: opts.onExternalWrite } : {}),
  });

  if (opts.scope === 'desk') {
    return {
      etsy,
      printify,
      trademark: notInDesk<TrademarkClient>('the trademark search'),
      imageGen: notInDesk<ImageGenClient>('image generation'),
      trendSources: [],
      storage: opts.storage ?? new FileBlobStorage(env.STORAGE_DIR),
      imageTools: new SharpImageTools(),
      gpu: notInDesk<GpuCoordinator>('the GPU coordinator'),
      upscaler: null,
      fetchImage: async () => {
        throw new Error('the mockup image fetcher is not available in the approval desk');
      },
    };
  }

  const trademark = new LiveTrademarkClient({
    username: required(env.MARKER_API_USERNAME, 'MARKER_API_USERNAME'),
    password: required(env.MARKER_API_PASSWORD, 'MARKER_API_PASSWORD'),
    fetch: fetchImpl,
    logger,
  });

  // The GPU sidecar exists only when this configuration runs it: local art, or Recraft art upscaled by the sidecar.
  // With fal, art, backgrounds and upscaling all run in the cloud and the sidecar is not deployed.
  const sidecar =
    env.IMAGEGEN_TOKEN && env.IMAGEGEN_PROVIDER !== 'fal'
      ? new ImagegenSidecar({ baseUrl: env.IMAGEGEN_BASE_URL, token: env.IMAGEGEN_TOKEN, fetch: fetchImpl, logger })
      : null;
  const gpu = new OllamaAwareGpuCoordinator({
    ollama: usesLlmProvider(env, 'ollama') ? new OllamaAdmin({ baseUrl: env.OLLAMA_BASE_URL, fetch: fetchImpl, logger }) : null,
    imagegen: sidecar,
    logger,
  });

  let imageGen: ImageGenClient;
  let upscaler: ImageUpscaler | null = sidecar ? new LocalUpscaler(sidecar, gpu) : null;
  if (env.IMAGEGEN_PROVIDER === 'recraft') {
    imageGen = new RecraftImageGenClient({ apiKey: required(env.RECRAFT_API_KEY, 'RECRAFT_API_KEY'), fetch: fetchImpl, logger });
  } else if (env.IMAGEGEN_PROVIDER === 'fal') {
    const falOpts = { apiKey: required(env.FAL_KEY, 'FAL_KEY'), fetch: fetchImpl, mediaFetch: fetchImpl, logger };
    imageGen = new FalImageGenClient(falOpts);
    upscaler = new FalUpscaler(falOpts);
  } else {
    if (!sidecar) throw new Error('createIntegrations: IMAGEGEN_TOKEN is required for IMAGEGEN_PROVIDER=local');
    imageGen = new LocalImageGenClient(sidecar, gpu);
  }

  return {
    etsy,
    printify,
    trademark,
    imageGen,
    trendSources: [
      new EtsySearchTrendSource(etsy, { logger }),
      new PinterestTrendSource({ token: env.PINTEREST_ACCESS_TOKEN ?? null, fetch: fetchImpl, logger }),
      new SeasonalTrendSource(),
    ],
    storage: opts.storage ?? new FileBlobStorage(env.STORAGE_DIR),
    imageTools: new SharpImageTools(),
    gpu,
    upscaler,
    fetchImage: createAllowlistedImageFetcher({ fetch: fetchImpl }),
  };
}

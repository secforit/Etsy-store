/** Mock integrations bundle (MODE=mock): deterministic, offline, realistic enough to drive the whole pipeline. */
import { EtsySearchTrendSource, SeasonalTrendSource } from '../trends.ts';
import { MockGpuCoordinator } from '../gpu.ts';
import { SharpImageTools } from '../imageTools.ts';
import { FileBlobStorage, MemoryBlobStorage } from '../storage.ts';
import type { BlobStorage, Integrations } from '../types.ts';
import { MockEtsyClient } from './etsy.ts';
import {
  MockImageGenClient,
  MockPinterestTrendSource,
  MockTrademarkClient,
  MockUpscaler,
  createMockImageFetcher,
} from './misc.ts';
import { MockPrintifyClient } from './printify.ts';

export * from './art.ts';
export * from './etsy.ts';
export * from './misc.ts';
export * from './printify.ts';

export interface MockIntegrationHandles {
  etsy: MockEtsyClient;
  printify: MockPrintifyClient;
  trademark: MockTrademarkClient;
  imageGen: MockImageGenClient;
  upscaler: MockUpscaler;
  gpu: MockGpuCoordinator;
}

export type MockIntegrations = Integrations & { mocks: MockIntegrationHandles };

export interface MockIntegrationOptions {
  /** Directory for FileBlobStorage; null = in-memory storage. */
  storageDir?: string | null;
  storage?: BlobStorage;
  now?: () => Date;
  /** getProduct polls before a published product shows its Etsy id (exercises QA polling). */
  publishPolls?: number;
  eurToUsd?: number;
}

export function createMockIntegrations(opts: MockIntegrationOptions = {}): MockIntegrations {
  const gpu = new MockGpuCoordinator();
  const etsy = new MockEtsyClient({ ...(opts.now ? { now: opts.now } : {}) });
  const printify = new MockPrintifyClient({
    etsy,
    publishPolls: opts.publishPolls ?? 0,
    ...(opts.eurToUsd ? { eurToUsd: opts.eurToUsd } : {}),
  });
  const trademark = new MockTrademarkClient();
  const imageGen = new MockImageGenClient(gpu);
  const upscaler = new MockUpscaler(gpu);
  const storage =
    opts.storage ?? (opts.storageDir ? new FileBlobStorage(opts.storageDir) : new MemoryBlobStorage());
  return {
    etsy,
    printify,
    trademark,
    imageGen,
    trendSources: [new EtsySearchTrendSource(etsy), new MockPinterestTrendSource(), new SeasonalTrendSource()],
    storage,
    imageTools: new SharpImageTools(),
    gpu,
    upscaler,
    fetchImage: createMockImageFetcher(),
    mocks: { etsy, printify, trademark, imageGen, upscaler, gpu },
  };
}

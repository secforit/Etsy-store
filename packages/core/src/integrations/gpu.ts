/**
 * One RTX 3060 (12 GB) shared by Ollama (gemma4:12b) and the imagegen sidecar (FLUX.2 klein 4B, BiRefNet,
 * Real-ESRGAN). They cannot hold VRAM together, so every GPU call runs through `withGpu(owner, fn)`:
 * - calls are serialised (FIFO), one at a time;
 * - when the owner changes, the previous owner is asked to release VRAM first:
 *     to 'image': GET {ollama}/api/ps, then POST {ollama}/api/generate {model, keep_alive: 0} per loaded model;
 *     to 'llm':   POST {imagegen}/unload (bearer token);
 * - at start-up the owner is unknown, so the first call releases the other side too;
 * - a failed release leaves the owner unknown, so the next call retries the release.
 * Nested calls with the same owner run inline; a nested call for the OTHER owner would deadlock and throws.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from '../orchestrator/contracts.ts';
import { HttpClient, isHttpError, type Clock, type FetchLike, systemClock } from './http.ts';
import type { GpuCoordinator, GpuOwner } from './types.ts';
import { noopLogger } from './util.ts';

/** Admin calls to the local Ollama server (also used by `check-gpu`). Plain HTTP on the private network. */
export class OllamaAdmin {
  private readonly http: HttpClient;

  constructor(opts: { baseUrl: string; fetch?: FetchLike; timeoutMs?: number; logger?: Logger; clock?: Clock }) {
    this.http = new HttpClient({
      service: 'ollama',
      baseUrl: opts.baseUrl,
      fetch: opts.fetch,
      clock: opts.clock,
      allowHttp: true,
      timeoutMs: opts.timeoutMs ?? 60_000,
      maxRetries: 1,
      logger: opts.logger,
    });
  }

  /** Models currently loaded in VRAM/RAM (`GET /api/ps`). */
  async listRunning(): Promise<string[]> {
    const res = await this.http.json<{ models?: { model?: unknown; name?: unknown }[] } | null>({
      url: '/api/ps',
      operation: 'list running models',
    });
    const names = new Set<string>();
    for (const m of res?.models ?? []) {
      const name = typeof m.model === 'string' && m.model ? m.model : typeof m.name === 'string' ? m.name : null;
      if (name) names.add(name);
    }
    return [...names];
  }

  /** Models available locally (`GET /api/tags`). */
  async listLocal(): Promise<string[]> {
    const res = await this.http.json<{ models?: { model?: unknown; name?: unknown }[] } | null>({
      url: '/api/tags',
      operation: 'list local models',
    });
    return (res?.models ?? [])
      .map((m) => (typeof m.name === 'string' ? m.name : typeof m.model === 'string' ? m.model : null))
      .filter((n): n is string => Boolean(n));
  }

  /** Unloads a model immediately (`POST /api/generate {model, keep_alive: 0}`). */
  async unload(model: string): Promise<void> {
    await this.http.request({
      method: 'POST',
      url: '/api/generate',
      json: { model, keep_alive: 0 },
      operation: 'unload model',
    });
  }
}

/** Anything that can free the imagegen sidecar's VRAM (`POST /unload`). */
export interface ImagegenUnloader {
  unload(): Promise<void>;
}

export interface OllamaAwareGpuOptions {
  /** null when no agent uses Ollama (all routed to a cloud provider). */
  ollama: Pick<OllamaAdmin, 'listRunning' | 'unload'> | null;
  /** null when the sidecar is not configured. */
  imagegen: ImagegenUnloader | null;
  logger?: Logger;
  clock?: Clock;
  /** After unloading Ollama models, poll /api/ps until empty (bounded). */
  confirmPolls?: number;
  confirmIntervalMs?: number;
}

abstract class SerialGpu implements GpuCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private readonly als = new AsyncLocalStorage<GpuOwner>();

  withGpu<T>(owner: GpuOwner, fn: () => Promise<T>): Promise<T> {
    if (owner !== 'llm' && owner !== 'image') return Promise.reject(new Error(`withGpu: unknown owner ${String(owner)}`));
    const inside = this.als.getStore();
    if (inside !== undefined) {
      if (inside === owner) return fn();
      return Promise.reject(new Error(`withGpu('${owner}') called inside withGpu('${inside}'): would deadlock`));
    }
    const run = async (): Promise<T> => {
      await this.acquire(owner);
      return this.als.run(owner, fn);
    };
    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  protected abstract acquire(owner: GpuOwner): Promise<void>;
}

/** Serialises GPU calls only (mock mode, tests). Records the owner sequence. */
export class MockGpuCoordinator extends SerialGpu {
  readonly history: GpuOwner[] = [];
  protected async acquire(owner: GpuOwner): Promise<void> {
    this.history.push(owner);
  }
}

export class OllamaAwareGpuCoordinator extends SerialGpu {
  private current: GpuOwner | null = null;
  private readonly logger: Logger;
  private readonly clock: Clock;

  constructor(private readonly opts: OllamaAwareGpuOptions) {
    super();
    this.logger = opts.logger ?? noopLogger;
    this.clock = opts.clock ?? systemClock;
  }

  /** Current owner (null = unknown, e.g. at start-up or after a failed release). */
  get owner(): GpuOwner | null {
    return this.current;
  }

  protected async acquire(owner: GpuOwner): Promise<void> {
    if (this.current === owner) return;
    const released = owner === 'image' ? await this.releaseOllama() : await this.releaseImagegen();
    this.current = released ? owner : null;
  }

  /** Returns true when Ollama holds no model afterwards (or is not used). */
  private async releaseOllama(): Promise<boolean> {
    const ollama = this.opts.ollama;
    if (!ollama) return true;
    try {
      const loaded = await ollama.listRunning();
      for (const model of loaded) await ollama.unload(model);
      if (loaded.length > 0) {
        const polls = this.opts.confirmPolls ?? 10;
        for (let i = 0; i < polls; i++) {
          const still = await ollama.listRunning();
          if (still.length === 0) break;
          if (i === polls - 1) {
            this.logger.warn({ models: still }, 'gpu: ollama still reports loaded models after unload');
            return false;
          }
          await this.clock.sleep(this.opts.confirmIntervalMs ?? 500);
        }
      }
      this.logger.debug({ unloaded: loaded }, 'gpu: released ollama');
      return true;
    } catch (e) {
      // Not reachable at all (container stopped): it holds no VRAM.
      if (isHttpError(e) && e.kind === 'network') return true;
      this.logger.warn({ err: (e as Error).message }, 'gpu: could not release ollama VRAM');
      return false;
    }
  }

  private async releaseImagegen(): Promise<boolean> {
    const imagegen = this.opts.imagegen;
    if (!imagegen) return true;
    try {
      await imagegen.unload();
      this.logger.debug({}, 'gpu: released imagegen');
      return true;
    } catch (e) {
      if (isHttpError(e) && e.kind === 'network') return true;
      this.logger.warn({ err: (e as Error).message }, 'gpu: could not release imagegen VRAM');
      return false;
    }
  }
}

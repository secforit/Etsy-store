import { describe, expect, it } from 'vitest';
import { MockGpuCoordinator, OllamaAdmin, OllamaAwareGpuCoordinator } from './gpu.ts';
import { ImagegenSidecar } from './imagegen.ts';
import { fakeClock, jsonResponse, stubFetch } from './testing.ts';

const TOKEN = 'imagegen-token-0123456789abcdef';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('MockGpuCoordinator', () => {
  it('serialises calls in FIFO order even when they would overlap', async () => {
    const gpu = new MockGpuCoordinator();
    const log: string[] = [];
    const gate = deferred();
    const a = gpu.withGpu('llm', async () => {
      log.push('a:start');
      await gate.promise;
      log.push('a:end');
      return 'a';
    });
    const b = gpu.withGpu('image', async () => {
      log.push('b');
      return 'b';
    });
    const c = gpu.withGpu('llm', async () => {
      log.push('c');
      return 'c';
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(log).toEqual(['a:start']);
    gate.resolve();
    expect(await Promise.all([a, b, c])).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['a:start', 'a:end', 'b', 'c']);
    expect(gpu.history).toEqual(['llm', 'image', 'llm']);
  });

  it('a failing job does not block the queue', async () => {
    const gpu = new MockGpuCoordinator();
    await expect(gpu.withGpu('llm', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(gpu.withGpu('image', async () => 1)).resolves.toBe(1);
  });

  it('runs nested same-owner calls inline and refuses cross-owner nesting (deadlock)', async () => {
    const gpu = new MockGpuCoordinator();
    await expect(gpu.withGpu('llm', () => gpu.withGpu('llm', async () => 'ok'))).resolves.toBe('ok');
    await expect(gpu.withGpu('llm', () => gpu.withGpu('image', async () => 'x'))).rejects.toThrow(/deadlock/);
  });
});

function setup(opts: { psModels?: string[][]; unloadStatus?: number } = {}) {
  const psQueue = [...(opts.psModels ?? [['gemma4:12b'], []])];
  const fetch = stubFetch((call) => {
    if (call.url.endsWith('/api/ps')) {
      const models = psQueue.length > 1 ? psQueue.shift()! : (psQueue[0] ?? []);
      return jsonResponse({ models: models.map((m) => ({ name: m, model: m, size_vram: 8e9 })) });
    }
    if (call.url.endsWith('/api/generate')) return jsonResponse({ done: true, done_reason: 'unload' });
    if (call.url.endsWith('/unload')) return new Response(null, { status: opts.unloadStatus ?? 204 });
    return new Response('?', { status: 404 });
  });
  const clock = fakeClock();
  const ollama = new OllamaAdmin({ baseUrl: 'http://ollama:11434', fetch, clock });
  const sidecar = new ImagegenSidecar({ baseUrl: 'http://imagegen:8000', token: TOKEN, fetch, clock });
  const gpu = new OllamaAwareGpuCoordinator({ ollama, imagegen: sidecar, clock, confirmIntervalMs: 10 });
  return { fetch, gpu, clock };
}

function summary(calls: { method: string; url: string; text: string }[]): string[] {
  return calls.map((c) => `${c.method} ${new URL(c.url).pathname}${c.text ? ` ${c.text}` : ''}`);
}

describe('OllamaAwareGpuCoordinator', () => {
  it('releases the other owner only on owner switches, in order', async () => {
    const { fetch, gpu } = setup({ psModels: [['gemma4:12b'], [], ['gemma4:12b'], []] });
    const order: string[] = [];

    await gpu.withGpu('llm', async () => void order.push('llm1')); // start-up: owner unknown -> unload imagegen
    await gpu.withGpu('llm', async () => void order.push('llm2')); // same owner: no calls
    await gpu.withGpu('image', async () => void order.push('img1')); // switch: unload ollama models
    await gpu.withGpu('image', async () => void order.push('img2'));
    await gpu.withGpu('llm', async () => void order.push('llm3')); // switch back: unload imagegen

    expect(order).toEqual(['llm1', 'llm2', 'img1', 'img2', 'llm3']);
    expect(summary(fetch.calls)).toEqual([
      'POST /unload',
      'GET /api/ps',
      'POST /api/generate {"model":"gemma4:12b","keep_alive":0}',
      'GET /api/ps',
      'POST /unload',
    ]);
    expect(gpu.owner).toBe('llm');
  });

  it('sends the bearer token on /unload and no token to ollama', async () => {
    const { fetch, gpu } = setup();
    await gpu.withGpu('llm', async () => undefined);
    await gpu.withGpu('image', async () => undefined);
    const unload = fetch.calls.find((c) => c.url.endsWith('/unload'))!;
    expect(unload.headers.authorization).toBe(`Bearer ${TOKEN}`);
    for (const c of fetch.calls.filter((c) => c.url.includes('ollama'))) expect(c.headers.authorization).toBeUndefined();
  });

  it('unloads every loaded model and waits until /api/ps is empty', async () => {
    const { fetch, gpu, clock } = setup({ psModels: [['gemma4:12b', 'other:1b'], ['other:1b'], []] });
    await gpu.withGpu('image', async () => undefined);
    expect(summary(fetch.calls)).toEqual([
      'GET /api/ps',
      'POST /api/generate {"model":"gemma4:12b","keep_alive":0}',
      'POST /api/generate {"model":"other:1b","keep_alive":0}',
      'GET /api/ps',
      'GET /api/ps',
    ]);
    expect(clock.sleeps).toEqual([10]);
  });

  it('serialises: the switch happens only after the running job finishes', async () => {
    const { fetch, gpu } = setup({ psModels: [['gemma4:12b'], []] });
    await gpu.withGpu('llm', async () => undefined);
    const before = fetch.calls.length;
    const gate = deferred();
    const llmJob = gpu.withGpu('llm', () => gate.promise);
    const imageJob = gpu.withGpu('image', async () => 'img');
    await new Promise((r) => setTimeout(r, 5));
    expect(fetch.calls.length).toBe(before); // no unload while the LLM job still runs
    gate.resolve();
    await llmJob;
    expect(await imageJob).toBe('img');
    expect(summary(fetch.calls.slice(before))[0]).toBe('GET /api/ps');
  });

  it('a failed release leaves the owner unknown so the next call retries it', async () => {
    const { fetch, gpu } = setup({ unloadStatus: 500 });
    await gpu.withGpu('llm', async () => undefined);
    expect(gpu.owner).toBeNull();
    await gpu.withGpu('llm', async () => undefined);
    // 1 + 1 retry (5xx) per attempt, two attempts
    expect(fetch.calls.filter((c) => c.url.endsWith('/unload')).length).toBe(4);
  });

  it('treats an unreachable service as holding no VRAM', async () => {
    const fetch = stubFetch(() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })));
    const gpu = new OllamaAwareGpuCoordinator({
      ollama: new OllamaAdmin({ baseUrl: 'http://ollama:11434', fetch }),
      imagegen: new ImagegenSidecar({ baseUrl: 'http://imagegen:8000', token: TOKEN, fetch }),
    });
    await gpu.withGpu('image', async () => undefined);
    expect(gpu.owner).toBe('image');
  });

  it('works without ollama (all agents on a cloud provider)', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 204 }));
    const gpu = new OllamaAwareGpuCoordinator({
      ollama: null,
      imagegen: new ImagegenSidecar({ baseUrl: 'http://imagegen:8000', token: TOKEN, fetch }),
    });
    await gpu.withGpu('image', async () => undefined);
    expect(fetch.calls).toHaveLength(0);
  });
});

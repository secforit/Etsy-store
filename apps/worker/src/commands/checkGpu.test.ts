import { describe, expect, it } from 'vitest';
import { loadEnv } from '@etsy-agents/core/config/env.ts';
import { MemoryIo } from '../io.ts';
import { checkGpu, normaliseModel, printGpuCheck } from './checkGpu.ts';

const TOKEN = 'x'.repeat(32);
const env = loadEnv({ MODE: 'mock', IMAGEGEN_TOKEN: TOKEN });

function stubFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const seen: { url: string; auth: string | null }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url, auth: headers.get('authorization') });
    const route = routes[url];
    if (!route) throw new TypeError('fetch failed');
    return route();
  };
  return { fn, seen };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('check-gpu', () => {
  it('reports READY when gemma4:12b is pulled and the sidecar is healthy', async () => {
    const { fn, seen } = stubFetch({
      'http://ollama:11434/api/tags': () => json({ models: [{ name: 'gemma4:12b' }] }),
      'http://ollama:11434/api/ps': () => json({ models: [{ model: 'gemma4:12b' }] }),
      'http://imagegen:8000/healthz': () => json({ ok: true, loaded: [] }),
    });
    const r = await checkGpu(env, fn);
    expect(r.ok).toBe(true);
    expect(r.ollama.loaded).toEqual(['gemma4:12b']);
    expect(seen.find((s) => s.url.endsWith('/healthz'))!.auth).toBe(`Bearer ${TOKEN}`);
    const io = new MemoryIo();
    printGpuCheck(io, env, r);
    expect(io.text()).toMatch(/GPU stack: READY/);
    expect(io.text()).not.toContain(TOKEN);
  });

  it('lists the missing model with the pull command, and an unreachable sidecar', async () => {
    const { fn } = stubFetch({
      'http://ollama:11434/api/tags': () => json({ models: [{ name: 'llama3:8b' }] }),
      'http://imagegen:8000/healthz': () => json({ detail: 'unauthorized' }, 401),
    });
    const r = await checkGpu(env, fn);
    expect(r.ok).toBe(false);
    expect(r.ollama.missing).toEqual(['gemma4:12b']);
    expect(r.imagegen.error).toBe('HTTP 401');
    const io = new MemoryIo();
    printGpuCheck(io, env, r);
    expect(io.text()).toMatch(/MISSING model gemma4:12b: .*ollama pull gemma4:12b/);
    expect(io.text()).toMatch(/GPU stack: NOT READY/);
  });

  it('handles Ollama being down and a missing token', async () => {
    const { fn } = stubFetch({});
    const r = await checkGpu(loadEnv({ MODE: 'mock' }), fn);
    expect(r.ollama.reachable).toBe(false);
    expect(r.ollama.missing).toEqual(['gemma4:12b']);
    expect(r.imagegen.error).toBe('IMAGEGEN_TOKEN is not set');
  });

  it('normalises untagged model names', () => {
    expect(normaliseModel('gemma4')).toBe('gemma4:latest');
    expect(normaliseModel('gemma4:12b')).toBe('gemma4:12b');
  });
});

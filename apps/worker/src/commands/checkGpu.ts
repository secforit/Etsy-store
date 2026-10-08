/**
 * `check-gpu`: asks the local Ollama server which models it has (`GET /api/tags`) and the imagegen sidecar
 * whether it is up (`GET /healthz`, bearer token), then prints what is missing and how to fix it.
 * Plain HTTP on the private Docker network only; never prints the token.
 */
import { usesLlmProvider, type Env } from '@etsy-agents/core/config/env.ts';
import type { Io } from '../io.ts';

export interface GpuCheckResult {
  ok: boolean;
  ollama: { required: boolean; reachable: boolean; models: string[]; missing: string[]; loaded: string[] };
  imagegen: { required: boolean; reachable: boolean; ok: boolean; loaded: string[]; error: string | null };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Ollama names without a tag mean ":latest". */
export function normaliseModel(name: string): string {
  const n = name.trim();
  return n.includes(':') ? n : `${n}:latest`;
}

const usesOllama = (env: Env): boolean => usesLlmProvider(env, 'ollama');

async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function names(body: unknown): string[] {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((m) => {
      const o = m as { name?: unknown; model?: unknown };
      return typeof o.name === 'string' ? o.name : typeof o.model === 'string' ? o.model : null;
    })
    .filter((n): n is string => Boolean(n));
}

export async function checkGpu(env: Env, fetchImpl: FetchLike = fetch, timeoutMs = 10_000): Promise<GpuCheckResult> {
  const base = env.OLLAMA_BASE_URL.replace(/\/+$/, '');
  const ollamaUsed = usesOllama(env);
  const wanted = ollamaUsed ? [...new Set([env.OLLAMA_MODEL_LARGE, env.OLLAMA_MODEL_SMALL, env.OLLAMA_MODEL_VISION])] : [];
  const ollama: GpuCheckResult['ollama'] = { required: ollamaUsed, reachable: false, models: [], missing: [], loaded: [] };
  // No agent routes to Ollama (cloud LLMs): its container is not even deployed, so it is not asked.
  if (ollamaUsed) {
    try {
      ollama.models = names(await getJson(fetchImpl, `${base}/api/tags`, {}, timeoutMs));
      ollama.reachable = true;
      try {
        ollama.loaded = names(await getJson(fetchImpl, `${base}/api/ps`, {}, timeoutMs));
      } catch {
        /* optional */
      }
    } catch {
      ollama.reachable = false;
    }
  }
  const have = new Set(ollama.models.map(normaliseModel));
  ollama.missing = ollama.reachable ? wanted.filter((m) => !have.has(normaliseModel(m))) : wanted;

  const required = env.IMAGEGEN_PROVIDER === 'local';
  const imagegen: GpuCheckResult['imagegen'] = { required, reachable: false, ok: false, loaded: [], error: null };
  if (required) {
    if (!env.IMAGEGEN_TOKEN) {
      imagegen.error = 'IMAGEGEN_TOKEN is not set';
    } else {
      try {
        const body = (await getJson(
          fetchImpl,
          `${env.IMAGEGEN_BASE_URL.replace(/\/+$/, '')}/healthz`,
          { authorization: `Bearer ${env.IMAGEGEN_TOKEN}` },
          timeoutMs,
        )) as { ok?: unknown; loaded?: unknown } | null;
        imagegen.reachable = true;
        imagegen.ok = body?.ok === true;
        imagegen.loaded = Array.isArray(body?.loaded) ? body.loaded.filter((x): x is string => typeof x === 'string') : [];
        if (!imagegen.ok) imagegen.error = 'healthz did not report ok';
      } catch (err) {
        imagegen.error = (err as Error).message.slice(0, 200);
      }
    }
  }
  const ok = (wanted.length === 0 || (ollama.reachable && ollama.missing.length === 0)) && (!required || imagegen.ok);
  return { ok, ollama, imagegen };
}

export function printGpuCheck(io: Io, env: Env, r: GpuCheckResult): void {
  if (!r.ollama.required) {
    io.out(`Ollama   : not used (no agent routes to it; LLM_DEFAULT_PROVIDER=${env.LLM_DEFAULT_PROVIDER})`);
  } else {
    io.out(`Ollama   ${env.OLLAMA_BASE_URL}: ${r.ollama.reachable ? 'reachable' : 'NOT reachable'}`);
    if (r.ollama.reachable) {
      io.out(`  models on disk : ${r.ollama.models.join(', ') || 'none'}`);
      io.out(`  loaded in VRAM : ${r.ollama.loaded.join(', ') || 'none'}`);
    }
    for (const m of r.ollama.missing) {
      io.out(`  MISSING model ${m}: ./deploy/compose.sh exec ollama ollama pull ${m}`);
    }
    if (!r.ollama.reachable) io.out('  Check: ./deploy/compose.sh ps ollama && ./deploy/compose.sh logs --tail 50 ollama');
  }
  if (r.imagegen.required) {
    io.out(`Imagegen ${env.IMAGEGEN_BASE_URL}: ${r.imagegen.ok ? 'ok' : `NOT ready (${r.imagegen.error ?? 'unknown'})`}`);
    if (r.imagegen.reachable) io.out(`  loaded models  : ${r.imagegen.loaded.join(', ') || 'none (lazy-loaded on first request)'}`);
    if (!r.imagegen.ok) io.out('  Check: ./deploy/compose.sh logs --tail 50 imagegen (the sidecar and the worker must share IMAGEGEN_TOKEN)');
  } else {
    io.out(`Imagegen : not used (IMAGEGEN_PROVIDER=${env.IMAGEGEN_PROVIDER})`);
  }
  io.out(r.ok ? 'GPU stack: READY' : 'GPU stack: NOT READY');
}

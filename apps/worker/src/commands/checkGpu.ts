/**
 * `check-gpu`: asks the local Ollama server which models it has (`GET /api/tags`) and the imagegen sidecar
 * whether it is up (`GET /healthz`, bearer token), then prints what is missing and how to fix it.
 * Plain HTTP on the private Docker network only; never prints the token.
 */
import type { Env } from '@etsy-agents/core/config/env.ts';
import type { Io } from '../io.ts';

export interface GpuCheckResult {
  ok: boolean;
  ollama: { reachable: boolean; models: string[]; missing: string[]; loaded: string[] };
  imagegen: { required: boolean; reachable: boolean; ok: boolean; loaded: string[]; error: string | null };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Ollama names without a tag mean ":latest". */
export function normaliseModel(name: string): string {
  const n = name.trim();
  return n.includes(':') ? n : `${n}:latest`;
}

function usesOllama(env: Env): boolean {
  return env.LLM_DEFAULT_PROVIDER === 'ollama' || Object.values(env.LLM_ROUTES).includes('ollama');
}

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
  const wanted = usesOllama(env) ? [...new Set([env.OLLAMA_MODEL_LARGE, env.OLLAMA_MODEL_SMALL, env.OLLAMA_MODEL_VISION])] : [];
  const ollama: GpuCheckResult['ollama'] = { reachable: false, models: [], missing: [], loaded: [] };
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
  io.out(`Ollama   ${env.OLLAMA_BASE_URL}: ${r.ollama.reachable ? 'reachable' : 'NOT reachable'}`);
  if (r.ollama.reachable) {
    io.out(`  models on disk : ${r.ollama.models.join(', ') || 'none'}`);
    io.out(`  loaded in VRAM : ${r.ollama.loaded.join(', ') || 'none'}`);
  }
  for (const m of r.ollama.missing) {
    io.out(`  MISSING model ${m}: docker compose -f deploy/docker-compose.yml exec ollama ollama pull ${m}`);
  }
  if (!r.ollama.reachable) io.out('  Check: docker compose -f deploy/docker-compose.yml ps ollama; logs: ... logs ollama');
  if (r.imagegen.required) {
    io.out(`Imagegen ${env.IMAGEGEN_BASE_URL}: ${r.imagegen.ok ? 'ok' : `NOT ready (${r.imagegen.error ?? 'unknown'})`}`);
    if (r.imagegen.reachable) io.out(`  loaded models  : ${r.imagegen.loaded.join(', ') || 'none (lazy-loaded on first request)'}`);
    if (!r.imagegen.ok) io.out('  Check: docker compose -f deploy/docker-compose.yml logs imagegen; token must match IMAGEGEN_TOKEN');
  } else {
    io.out(`Imagegen : not used (IMAGEGEN_PROVIDER=${env.IMAGEGEN_PROVIDER})`);
  }
  io.out(r.ok ? 'GPU stack: READY' : 'GPU stack: NOT READY');
}

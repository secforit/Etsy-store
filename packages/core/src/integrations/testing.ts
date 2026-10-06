/** Test helpers: a recording fetch stub and a fake clock (no network, no real waiting). */
import type { Clock, FetchLike } from './http.ts';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  /** Body decoded as UTF-8 (convenience). */
  text: string;
  signal: AbortSignal | null;
}

export type StubHandler = (call: RecordedCall, index: number) => Response | Promise<Response>;

export type StubFetch = FetchLike & { calls: RecordedCall[] };

async function bodyBytes(body: unknown): Promise<Uint8Array | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body as ConstructorParameters<typeof Response>[0]).arrayBuffer());
}

export function stubFetch(handler: StubHandler): StubFetch {
  const calls: RecordedCall[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) h.forEach((v, k) => (headers[k.toLowerCase()] = v));
    else if (Array.isArray(h)) for (const pair of h) headers[String(pair[0]).toLowerCase()] = String(pair[1]);
    else if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    const body = await bodyBytes(init?.body);
    const call: RecordedCall = {
      url: input.toString(),
      method: init?.method ?? 'GET',
      headers,
      body,
      text: body ? new TextDecoder().decode(body) : '',
      signal: init?.signal ?? null,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as StubFetch;
  fn.calls = calls;
  return fn;
}

export function jsonResponse(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

export function bytesResponse(bytes: Uint8Array, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(Buffer.from(bytes), { status: init.status ?? 200, headers: init.headers ?? {} });
}

/** A fetch that never answers until its signal aborts (timeout tests). */
export function hangingFetch(): FetchLike {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
}

export interface FakeClock extends Clock {
  sleeps: number[];
  advance(ms: number): void;
}

export function fakeClock(start = Date.UTC(2026, 9, 6, 12, 0, 0)): FakeClock {
  let t = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

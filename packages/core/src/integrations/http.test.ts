import { describe, expect, it } from 'vitest';
import {
  HttpClient,
  HttpError,
  TokenBucket,
  assertAllowlistedUrl,
  parseRetryAfter,
  readBodyLimited,
  safeFetchAllowlisted,
} from './http.ts';
import { fakeClock, hangingFetch, jsonResponse, stubFetch } from './testing.ts';

function client(fetch: ReturnType<typeof stubFetch> | ReturnType<typeof hangingFetch>, extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  const clock = fakeClock();
  const http = new HttpClient({
    service: 'svc',
    baseUrl: 'https://api.example.com/v1',
    fetch,
    clock,
    random: () => 0,
    ...extra,
  });
  return { http, clock };
}

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    const now = Date.UTC(2026, 9, 6, 12, 0, 0);
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter('1.5', now)).toBe(1500);
    expect(parseRetryAfter(new Date(now + 7000).toUTCString(), now)).toBe(7000);
    expect(parseRetryAfter(new Date(now - 7000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe('HttpClient retries', () => {
  it('retries 503 with exponential backoff, then succeeds', async () => {
    const fetch = stubFetch((_c, i) => (i < 2 ? new Response('busy', { status: 503 }) : jsonResponse({ ok: true })));
    const { http, clock } = client(fetch);
    await expect(http.json({ url: '/x', operation: 'get x' })).resolves.toEqual({ ok: true });
    expect(fetch.calls).toHaveLength(3);
    expect(clock.sleeps).toEqual([500, 1000]);
  });

  it('honours retry-after on 429 (seconds)', async () => {
    const fetch = stubFetch((_c, i) =>
      i === 0 ? new Response('', { status: 429, headers: { 'retry-after': '7' } }) : jsonResponse({ n: 1 }),
    );
    const { http, clock } = client(fetch);
    await http.json({ url: '/x', operation: 'get x' });
    expect(clock.sleeps).toEqual([7000]);
  });

  it('honours retry-after given as an HTTP date', async () => {
    const clock = fakeClock();
    const fetch = stubFetch((_c, i) =>
      i === 0
        ? new Response('', { status: 503, headers: { 'retry-after': new Date(clock.now() + 4000).toUTCString() } })
        : jsonResponse({}),
    );
    const http = new HttpClient({ service: 'svc', baseUrl: 'https://api.example.com', fetch, clock });
    await http.json({ url: '/x', operation: 'x' });
    expect(clock.sleeps).toEqual([4000]);
  });

  it('does not retry 4xx other than 429', async () => {
    const fetch = stubFetch(() => jsonResponse({ error: 'bad' }, { status: 400 }));
    const { http } = client(fetch);
    const err = await http.json({ url: '/x', operation: 'get x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).retryable).toBe(false);
    expect(fetch.calls).toHaveLength(1);
  });

  it('rate_limit_only retries 429 but not 500 (non-idempotent creates)', async () => {
    const f500 = stubFetch(() => new Response('', { status: 500 }));
    const { http: h1 } = client(f500);
    await expect(h1.request({ method: 'POST', url: '/p', json: {}, operation: 'create', retry: 'rate_limit_only' })).rejects.toMatchObject({
      status: 500,
      retryable: true,
    });
    expect(f500.calls).toHaveLength(1);

    const f429 = stubFetch((_c, i) => (i === 0 ? new Response('', { status: 429 }) : jsonResponse({ id: 'a' })));
    const { http: h2 } = client(f429);
    await h2.request({ method: 'POST', url: '/p', json: {}, operation: 'create', retry: 'rate_limit_only' });
    expect(f429.calls).toHaveLength(2);
  });

  it('gives up after maxRetries and throws a retryable error', async () => {
    const fetch = stubFetch(() => new Response('', { status: 502 }));
    const { http } = client(fetch, { maxRetries: 2 });
    await expect(http.request({ url: '/x', operation: 'x' })).rejects.toMatchObject({ status: 502, retryable: true });
    expect(fetch.calls).toHaveLength(3);
  });

  it('does not sleep through an excessive retry-after; surfaces it instead', async () => {
    const fetch = stubFetch(() => new Response('', { status: 429, headers: { 'retry-after': '3600' } }));
    const { http, clock } = client(fetch, { maxRetryAfterMs: 60_000 });
    const err = (await http.request({ url: '/x', operation: 'x' }).catch((e: unknown) => e)) as HttpError;
    expect(err.retryAfterMs).toBe(3_600_000);
    expect(clock.sleeps).toEqual([]);
  });

  it('times out a hanging request without retrying it', async () => {
    const http = new HttpClient({ service: 'svc', baseUrl: 'https://api.example.com', fetch: hangingFetch(), timeoutMs: 30 });
    const err = (await http.request({ url: '/slow', operation: 'slow' }).catch((e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
  });

  it('error messages carry the operation label, never the URL', async () => {
    const fetch = stubFetch(() => new Response('nope', { status: 404 }));
    const http = new HttpClient({ service: 'marker', fetch });
    const err = (await http
      .request({ url: 'https://markerapi.com/api/v2/x/username/u/password/SECRETPASS', operation: 'search', exposeErrorBody: false })
      .catch((e: unknown) => e)) as HttpError;
    expect(err.message).toContain('marker search failed');
    expect(err.message).not.toContain('SECRETPASS');
  });
});

describe('HttpClient safety', () => {
  it('refuses plain http unless the client is internal', async () => {
    const fetch = stubFetch(() => jsonResponse({}));
    expect(() => new HttpClient({ service: 's', baseUrl: 'http://api.example.com', fetch })).toThrow(/scheme/);
    const internal = new HttpClient({ service: 'ollama', baseUrl: 'http://ollama:11434', fetch, allowHttp: true });
    await internal.request({ url: '/api/ps', operation: 'ps' });
    expect(fetch.calls[0]!.url).toBe('http://ollama:11434/api/ps');
  });

  it('never follows redirects for API calls', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    const { http } = client(fetch);
    await expect(http.request({ url: '/x', operation: 'x' })).rejects.toMatchObject({ kind: 'redirect' });
    expect(fetch.calls).toHaveLength(1);
  });

  it('enforces the response size limit', async () => {
    const fetch = stubFetch(() => new Response(new Uint8Array(2048)));
    const { http } = client(fetch, { maxResponseBytes: 1024 });
    await expect(http.request({ url: '/x', operation: 'x' })).rejects.toMatchObject({ kind: 'too_large' });
  });

  it('builds query strings, JSON and form bodies, and default headers', async () => {
    const fetch = stubFetch(() => jsonResponse({}));
    const { http } = client(fetch, { defaultHeaders: () => ({ authorization: 'Bearer t' }) });
    await http.request({ url: '/q', query: { a: 1, b: ['x', 'y'], c: undefined }, operation: 'q' });
    await http.request({ method: 'POST', url: '/j', json: { k: 'v' }, operation: 'j' });
    await http.request({ method: 'PATCH', url: '/f', form: { state: 'active' }, operation: 'f' });
    expect(fetch.calls[0]!.url).toBe('https://api.example.com/v1/q?a=1&b=x&b=y');
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer t');
    expect(fetch.calls[1]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(fetch.calls[1]!.text)).toEqual({ k: 'v' });
    expect(fetch.calls[2]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(fetch.calls[2]!.text).toBe('state=active');
  });
});

describe('TokenBucket', () => {
  it('allows a burst, then waits for refill', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 1, clock);
    await bucket.take();
    await bucket.take();
    expect(clock.sleeps).toEqual([]);
    await bucket.take();
    expect(clock.sleeps).toEqual([1000]);
  });

  it('client takes a token per attempt', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(1, 2, clock);
    const fetch = stubFetch(() => jsonResponse({}));
    const http = new HttpClient({ service: 's', baseUrl: 'https://a.example', fetch, clock, bucket });
    await http.request({ url: '/1', operation: '1' });
    await http.request({ url: '/2', operation: '2' });
    expect(clock.sleeps).toEqual([500]);
  });
});

describe('readBodyLimited', () => {
  it('rejects by content-length before reading', async () => {
    const res = new Response('x'.repeat(10), { headers: { 'content-length': '999999' } });
    await expect(readBodyLimited(res, 100, { service: 's', operation: 'o' })).rejects.toMatchObject({ kind: 'too_large' });
  });
});

describe('safeFetchAllowlisted', () => {
  const hosts = ['images.printify.com'];

  it('rejects non-https, other hosts, credentials, odd ports and bad URLs before fetching', async () => {
    const fetch = stubFetch(() => new Response('x'));
    for (const url of [
      'http://images.printify.com/a.png',
      'https://evil.example/a.png',
      'https://images.printify.com.evil.example/a.png',
      'https://user:pw@images.printify.com/a.png',
      'https://images.printify.com:8443/a.png',
      'https://169.254.169.254/latest/meta-data',
      'file:///etc/passwd',
      'not a url',
    ]) {
      await expect(safeFetchAllowlisted(url, hosts, { fetch })).rejects.toMatchObject({ kind: 'blocked' });
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it('host matching is case-insensitive', () => {
    expect(assertAllowlistedUrl('https://IMAGES.Printify.com/x', hosts).hostname).toBe('images.printify.com');
  });

  it('follows same-host https redirects', async () => {
    const fetch = stubFetch((c) =>
      c.url.endsWith('/a.png')
        ? new Response(null, { status: 301, headers: { location: '/b.png' } })
        : new Response(new Uint8Array([1, 2, 3])),
    );
    const res = await safeFetchAllowlisted('https://images.printify.com/a.png', hosts, { fetch });
    expect(res.finalUrl).toBe('https://images.printify.com/b.png');
    expect([...res.bytes]).toEqual([1, 2, 3]);
    expect(fetch.calls.map((c) => c.url)).toEqual(['https://images.printify.com/a.png', 'https://images.printify.com/b.png']);
  });

  it('refuses cross-host and downgrade redirects', async () => {
    for (const location of ['https://evil.example/x.png', 'http://images.printify.com/x.png', 'https://169.254.169.254/']) {
      const fetch = stubFetch(() => new Response(null, { status: 302, headers: { location } }));
      await expect(safeFetchAllowlisted('https://images.printify.com/a.png', hosts, { fetch })).rejects.toMatchObject({
        kind: 'redirect',
      });
      expect(fetch.calls).toHaveLength(1);
    }
  });

  it('caps redirect chains', async () => {
    const fetch = stubFetch((_c, i) => new Response(null, { status: 302, headers: { location: `/r${i}` } }));
    await expect(safeFetchAllowlisted('https://images.printify.com/a', hosts, { fetch, maxRedirects: 2 })).rejects.toMatchObject({
      kind: 'redirect',
    });
    expect(fetch.calls).toHaveLength(3);
  });

  it('enforces the size limit while streaming', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(100));
        controller.close();
      },
    });
    const fetch = stubFetch(() => new Response(stream));
    await expect(safeFetchAllowlisted('https://images.printify.com/a', hosts, { fetch, maxBytes: 500 })).rejects.toMatchObject({
      kind: 'too_large',
    });
  });

  it('times out', async () => {
    await expect(
      safeFetchAllowlisted('https://images.printify.com/a', hosts, { fetch: hangingFetch(), timeoutMs: 20, maxRetries: 0 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('retries a 503 once, honouring retry-after', async () => {
    const clock = fakeClock();
    const fetch = stubFetch((_c, i) =>
      i === 0 ? new Response('', { status: 503, headers: { 'retry-after': '2' } }) : new Response(new Uint8Array([9])),
    );
    const res = await safeFetchAllowlisted('https://images.printify.com/a', hosts, { fetch, clock });
    expect([...res.bytes]).toEqual([9]);
    expect(clock.sleeps).toEqual([2000]);
  });
});

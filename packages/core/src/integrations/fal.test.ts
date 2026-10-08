import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  FAL_FLUX_KLEIN_MODEL,
  FAL_TRANSPARENT_SUFFIX,
  FalImageGenClient,
  FalUpscaler,
  pngDataUri,
  type FalClientOptions,
} from './fal.ts';
import { HttpError } from './http.ts';
import { renderMockArt } from './mocks/art.ts';
import { bytesResponse, fakeClock, jsonResponse, stubFetch, type RecordedCall } from './testing.ts';
import { isPng } from './util.ts';

const Q = 'https://queue.fal.run';

async function png(width = 64, height = 64, alpha = true): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 200, g: 40, b: 40, alpha: 0.5 } : { r: 200, g: 40, b: 40 } } })
      .png()
      .toBuffer(),
  );
}

/**
 * A fake fal queue: each endpoint id gets one request id; status is IN_QUEUE for `pendingPolls` polls, then
 * COMPLETED; the result is whatever `results[endpoint]` returns.
 */
function fakeFal(results: Record<string, (input: any) => unknown>, opts: { pendingPolls?: number; statusUrl?: (id: string) => string; media?: Record<string, Uint8Array> } = {}) {
  const inputs: Record<string, any> = {};
  const polls: Record<string, number> = {};
  const fetch = stubFetch((call: RecordedCall) => {
    const url = new URL(call.url);
    if (url.hostname.endsWith('fal.media')) {
      const bytes = opts.media?.[call.url];
      return bytes ? bytesResponse(bytes) : new Response('missing', { status: 404 });
    }
    if (call.method === 'POST') {
      const endpoint = url.pathname.slice(1);
      inputs[endpoint] = JSON.parse(call.text);
      const id = `req-${endpoint.replace(/\W+/g, '-')}`;
      const owner = endpoint.split('/').slice(0, 2).join('/');
      return jsonResponse({
        status: 'IN_QUEUE',
        request_id: id,
        status_url: opts.statusUrl ? opts.statusUrl(id) : `${Q}/${owner}/requests/${id}/status`,
        response_url: `${Q}/${owner}/requests/${id}`,
      });
    }
    const m = /^\/(.+)\/requests\/([^/]+)(\/status)?$/.exec(url.pathname)!;
    const id = m[2]!;
    const endpoint = Object.keys(inputs).find((e) => `req-${e.replace(/\W+/g, '-')}` === id)!;
    if (m[3]) {
      polls[id] = (polls[id] ?? 0) + 1;
      return jsonResponse({ status: polls[id]! > (opts.pendingPolls ?? 1) ? 'COMPLETED' : 'IN_QUEUE', request_id: id });
    }
    return jsonResponse(results[endpoint]!(inputs[endpoint]));
  });
  return { fetch, inputs, polls };
}

function client<T>(Ctor: new (o: FalClientOptions) => T, fetch: ReturnType<typeof stubFetch>, over: Partial<FalClientOptions> = {}) {
  const clock = fakeClock();
  return { c: new Ctor({ apiKey: 'fal-key-123', fetch, mediaFetch: fetch, clock, pollIntervalMs: 500, ...over }), clock };
}

describe('FalImageGenClient', () => {
  it('runs FLUX.2 klein 4B through the queue with the sidecar prompt, exact size, seed and Key auth', async () => {
    const art = await renderMockArt({ width: 96, height: 128, transparent: false, seed: 1 });
    const fal = fakeFal({ 'fal-ai/flux-2/klein/4b': () => ({ images: [{ url: pngDataUri(art) }], seed: 4242, has_nsfw_concepts: [false] }) }, { pendingPolls: 2 });
    const { c, clock } = client(FalImageGenClient, fal.fetch);
    const out = await c.generate({ prompt: 'a  retro campfire', style: 'vector_illustration', transparentBackground: false, widthPx: 1500, heightPx: 1800, seed: 7 });

    expect(out).toMatchObject({ mimeType: 'image/png', model: FAL_FLUX_KLEIN_MODEL, seed: 4242 });
    expect(isPng(out.bytes)).toBe(true);
    const input = fal.inputs['fal-ai/flux-2/klein/4b'];
    expect(input).toMatchObject({
      image_size: { width: 1504, height: 1808 },
      num_inference_steps: 4,
      num_images: 1,
      output_format: 'png',
      enable_safety_checker: true,
      sync_mode: true,
      seed: 7,
    });
    expect(input.prompt).toMatch(/^a retro campfire\. Style: flat vector illustration/);
    expect(input.prompt).not.toContain(FAL_TRANSPARENT_SUFFIX);
    expect(fal.inputs['fal-ai/birefnet/v2']).toBeUndefined(); // opaque art: no background removal
    const post = fal.fetch.calls[0]!;
    expect(post.url).toBe(`${Q}/fal-ai/flux-2/klein/4b`);
    expect(post.headers.authorization).toBe('Key fal-key-123');
    expect(clock.sleeps).toEqual([500, 500]); // two IN_QUEUE polls, then COMPLETED
  });

  it('cuts the subject out with BiRefNet for transparent products', async () => {
    const art = await png(64, 64, false);
    const cut = await png(64, 64, true);
    const fal = fakeFal({
      'fal-ai/flux-2/klein/4b': () => ({ images: [{ url: pngDataUri(art) }], seed: 1, has_nsfw_concepts: [false] }),
      'fal-ai/birefnet/v2': () => ({ image: { url: pngDataUri(cut) } }),
    });
    const { c } = client(FalImageGenClient, fal.fetch);
    const out = await c.generate({ prompt: 'a cat', style: 'typography', transparentBackground: true, widthPx: 512, heightPx: 512 });
    expect(fal.inputs['fal-ai/flux-2/klein/4b'].prompt).toContain(FAL_TRANSPARENT_SUFFIX);
    expect(fal.inputs['fal-ai/birefnet/v2']).toMatchObject({ model: 'General Use (Light)', operating_resolution: '1024x1024', sync_mode: true });
    expect(fal.inputs['fal-ai/birefnet/v2'].image_url).toMatch(/^data:image\/png;base64,/);
    expect((await sharp(out.bytes).metadata()).hasAlpha).toBe(true);
  });

  it('never returns art the safety checker flagged (fal sends a black image)', async () => {
    const flagged = fakeFal({ 'fal-ai/flux-2/klein/4b': () => ({ images: [{ url: pngDataUri(new Uint8Array([1])) }], seed: 1, has_nsfw_concepts: [true] }) });
    const { c } = client(FalImageGenClient, flagged.fetch);
    await expect(c.generate({ prompt: 'x', style: '', transparentBackground: true, widthPx: 512, heightPx: 512 })).rejects.toThrow(/safety checker/);
    expect(flagged.inputs['fal-ai/birefnet/v2']).toBeUndefined();
  });

  it('refuses queue URLs that are not on queue.fal.run (no SSRF through the submit reply)', async () => {
    const fal = fakeFal({ 'fal-ai/flux-2/klein/4b': () => ({}) }, { statusUrl: (id) => `https://evil.example/${id}/status` });
    const { c } = client(FalImageGenClient, fal.fetch);
    const err = await c.generate({ prompt: 'x', style: '', transparentBackground: false, widthPx: 512, heightPx: 512 }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.kind).toBe('blocked');
    expect(fal.fetch.calls.every((call) => !call.url.includes('evil.example'))).toBe(true);
  });

  it('gives up with a retryable timeout when the job never finishes', async () => {
    const fal = fakeFal({ 'fal-ai/flux-2/klein/4b': () => ({}) }, { pendingPolls: 1_000 });
    const { c } = client(FalImageGenClient, fal.fetch, { maxWaitMs: 3000 });
    const err = await c.generate({ prompt: 'x', style: '', transparentBackground: false, widthPx: 512, heightPx: 512 }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
  });

  it('does not resubmit after a 5xx (the job may already be queued and billed), but retries 429', async () => {
    const five = stubFetch(() => new Response('boom', { status: 500 }));
    const a = client(FalImageGenClient, five).c;
    await expect(a.generate({ prompt: 'x', style: '', transparentBackground: false, widthPx: 512, heightPx: 512 })).rejects.toBeInstanceOf(HttpError);
    expect(five.calls).toHaveLength(1);
    const art = await png(32, 32, false);
    const fal = fakeFal({ 'fal-ai/flux-2/klein/4b': () => ({ images: [{ url: pngDataUri(art) }], seed: 1, has_nsfw_concepts: [false] }) });
    let first = true;
    const rate = stubFetch((call, i) => {
      if (first && call.method === 'POST') {
        first = false;
        return new Response('slow', { status: 429, headers: { 'retry-after': '1' } });
      }
      return (fal.fetch as any)(call.url, { method: call.method, headers: call.headers, body: call.text || undefined }) as Promise<Response>;
    });
    const b = client(FalImageGenClient, rate).c;
    expect(isPng((await b.generate({ prompt: 'x', style: '', transparentBackground: false, widthPx: 512, heightPx: 512 })).bytes)).toBe(true);
  });

  it('requires FAL_KEY', () => {
    expect(() => new FalImageGenClient({ apiKey: '' })).toThrow(/FAL_KEY/);
  });
});

describe('FalUpscaler', () => {
  it('runs Real-ESRGAN x4plus at the requested scale and downloads the result from the fal CDN', async () => {
    const out = await png(256, 256, true);
    const media = { 'https://v3.fal.media/files/up.png': out };
    const fal = fakeFal({ 'fal-ai/esrgan': () => ({ image: { url: 'https://v3.fal.media/files/up.png' } }) }, { media });
    const { c } = client(FalUpscaler, fal.fetch);
    const res = await c.upscale(await png(64, 64, true), 4);
    expect(fal.inputs['fal-ai/esrgan']).toMatchObject({ model: 'RealESRGAN_x4plus', scale: 4, tile: 400, output_format: 'png' });
    expect(fal.inputs['fal-ai/esrgan'].image_url).toMatch(/^data:image\/png;base64,/);
    const meta = await sharp(res).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([256, 256, true]);
  });

  it('re-applies the transparency when the upscaled output came back without alpha', async () => {
    const media = { 'https://v3.fal.media/files/rgb.png': await png(128, 128, false) };
    const fal = fakeFal({ 'fal-ai/esrgan': () => ({ image: { url: 'https://v3.fal.media/files/rgb.png' } }) }, { media });
    const { c } = client(FalUpscaler, fal.fetch);
    const res = await c.upscale(await png(64, 64, true), 2);
    const meta = await sharp(res).metadata();
    expect([meta.width, meta.height, meta.hasAlpha, meta.channels]).toEqual([128, 128, true, 4]);
    const { data } = await sharp(res).extractChannel('alpha').raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(100); // the input's 50% alpha, not opaque
    expect(data[0]).toBeLessThan(160);
  });

  it('refuses result URLs outside the fal media hosts', async () => {
    const fal = fakeFal({ 'fal-ai/esrgan': () => ({ image: { url: 'https://evil.example/x.png' } }) });
    const { c } = client(FalUpscaler, fal.fetch);
    const err = await c.upscale(await png(), 2).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.kind).toBe('blocked');
  });
});

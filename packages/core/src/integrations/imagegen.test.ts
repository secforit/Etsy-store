import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MockGpuCoordinator } from './gpu.ts';
import {
  FLUX_KLEIN_MODEL_ID,
  ImagegenSidecar,
  LocalImageGenClient,
  LocalUpscaler,
  buildSidecarPrompt,
  normaliseSidecarSide,
} from './imagegen.ts';
import { renderMockArt } from './mocks/art.ts';
import { RecraftImageGenClient, pickRecraftSize } from './recraft.ts';
import { bytesResponse, fakeClock, jsonResponse, stubFetch } from './testing.ts';
import { isPng } from './util.ts';

const TOKEN = 'imagegen-token-0123456789abcdef';

async function png(transparent = true): Promise<Uint8Array> {
  return renderMockArt({ width: 256, height: 256, transparent, seed: 1 });
}

describe('sidecar helpers', () => {
  it('normalises sizes to multiples of 16 within [256, 2048]', () => {
    expect(normaliseSidecarSide(1500)).toBe(1504);
    expect(normaliseSidecarSide(1800)).toBe(1808);
    expect(normaliseSidecarSide(4500)).toBe(2048);
    expect(normaliseSidecarSide(10)).toBe(256);
    expect(() => normaliseSidecarSide(0)).toThrow();
  });

  it('appends style hints and caps the prompt at 2000 chars', () => {
    expect(buildSidecarPrompt('  a  cat ', 'vector_illustration')).toMatch(/^a cat\. Style: flat vector illustration/);
    expect(buildSidecarPrompt('a cat', 'watercolor_soft')).toBe('a cat. Style: watercolor soft');
    expect(buildSidecarPrompt('x'.repeat(5000), 'typography')).toHaveLength(2000);
  });

  it('requires a real token', () => {
    expect(() => new ImagegenSidecar({ baseUrl: 'http://imagegen:8000', token: 'short' })).toThrow(/IMAGEGEN_TOKEN/);
  });
});

describe('LocalImageGenClient', () => {
  it('shapes the /generate request, sends the bearer token and runs inside withGpu("image")', async () => {
    const art = await png();
    const fetch = stubFetch(() => bytesResponse(art, { headers: { 'content-type': 'image/png', 'x-seed': '424242' } }));
    const gpu = new MockGpuCoordinator();
    const sidecar = new ImagegenSidecar({ baseUrl: 'http://imagegen:8000/', token: TOKEN, fetch });
    expect(sidecar.timeoutMs).toBe(300_000);
    const client = new LocalImageGenClient(sidecar, gpu);
    const out = await client.generate({
      prompt: 'retro frog on a mushroom',
      style: 'vector_illustration',
      transparentBackground: true,
      widthPx: 1500,
      heightPx: 1800,
      seed: 7,
    });

    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('http://imagegen:8000/generate');
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers['content-type']).toBe('application/json');
    const body = JSON.parse(call.text) as Record<string, unknown>;
    expect(body).toEqual({
      prompt: expect.stringContaining('retro frog on a mushroom. Style: flat vector illustration'),
      width: 1504,
      height: 1808,
      transparent: true,
      seed: 7,
    });
    expect(gpu.history).toEqual(['image']);
    expect(out).toMatchObject({ mimeType: 'image/png', model: FLUX_KLEIN_MODEL_ID, seed: 424242 });
    expect(isPng(out.bytes)).toBe(true);
  });

  it('omits seed when not given and falls back to null without x-seed', async () => {
    const art = await png(false);
    const fetch = stubFetch(() => bytesResponse(art));
    const client = new LocalImageGenClient(new ImagegenSidecar({ baseUrl: 'http://imagegen:8000', token: TOKEN, fetch }), new MockGpuCoordinator());
    const out = await client.generate({ prompt: 'p', style: 'typography', transparentBackground: false, widthPx: 512, heightPx: 512 });
    expect(JSON.parse(fetch.calls[0]!.text)).not.toHaveProperty('seed');
    expect(JSON.parse(fetch.calls[0]!.text).transparent).toBe(false);
    expect(out.seed).toBeNull();
  });

  it('rejects a non-PNG response', async () => {
    const fetch = stubFetch(() => bytesResponse(new TextEncoder().encode('<html>oops</html>')));
    const client = new LocalImageGenClient(new ImagegenSidecar({ baseUrl: 'http://imagegen:8000', token: TOKEN, fetch }), new MockGpuCoordinator());
    await expect(client.generate({ prompt: 'p', style: 's', transparentBackground: true, widthPx: 512, heightPx: 512 })).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('retries once on 503 (models loading), honouring retry-after', async () => {
    const art = await png();
    const clock = fakeClock();
    const fetch = stubFetch((_c, i) => (i === 0 ? new Response('loading', { status: 503, headers: { 'retry-after': '5' } }) : bytesResponse(art)));
    const client = new LocalImageGenClient(new ImagegenSidecar({ baseUrl: 'http://imagegen:8000', token: TOKEN, fetch, clock }), new MockGpuCoordinator());
    await client.generate({ prompt: 'p', style: 's', transparentBackground: true, widthPx: 512, heightPx: 512 });
    expect(clock.sleeps).toEqual([5000]);
    expect(fetch.calls).toHaveLength(2);
  });

  it('surfaces 401 from a wrong token without retrying', async () => {
    const fetch = stubFetch(() => new Response('unauthorized', { status: 401 }));
    const client = new LocalImageGenClient(new ImagegenSidecar({ baseUrl: 'http://imagegen:8000', token: TOKEN, fetch }), new MockGpuCoordinator());
    await expect(client.generate({ prompt: 'p', style: 's', transparentBackground: true, widthPx: 512, heightPx: 512 })).rejects.toMatchObject({
      status: 401,
    });
    expect(fetch.calls).toHaveLength(1);
  });
});

describe('LocalUpscaler', () => {
  it('posts PNG bytes with factor in the query, inside withGpu("image")', async () => {
    const input = await png();
    const output = await png(false);
    const fetch = stubFetch(() => bytesResponse(output, { headers: { 'content-type': 'image/png' } }));
    const gpu = new MockGpuCoordinator();
    const up = new LocalUpscaler(new ImagegenSidecar({ baseUrl: 'http://imagegen:8000', token: TOKEN, fetch }), gpu);
    const out = await up.upscale(input, 4);
    const call = fetch.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('http://imagegen:8000/upscale?factor=4');
    expect(call.headers['content-type']).toBe('image/png');
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toEqual(input);
    expect(out).toEqual(output);
    expect(gpu.history).toEqual(['image']);
  });

  it('validates input and factor before calling the sidecar', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 500 }));
    const up = new LocalUpscaler(new ImagegenSidecar({ baseUrl: 'http://imagegen:8000', token: TOKEN, fetch }), new MockGpuCoordinator());
    const jpg = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).jpeg().toBuffer());
    await expect(up.upscale(jpg, 2)).rejects.toThrow(/PNG/);
    await expect(up.upscale(await png(), 3 as 2)).rejects.toThrow(/factor/);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('ImagegenSidecar admin', () => {
  it('healthz and unload', async () => {
    const fetch = stubFetch((c) =>
      c.url.endsWith('/healthz') ? jsonResponse({ ok: true, loaded: ['flux2-klein-4b', 7] }) : new Response(null, { status: 204 }),
    );
    const s = new ImagegenSidecar({ baseUrl: 'http://imagegen:8000', token: TOKEN, fetch });
    expect(await s.healthz()).toEqual({ ok: true, loaded: ['flux2-klein-4b'] });
    await s.unload();
    expect(fetch.calls[1]).toMatchObject({ method: 'POST', url: 'http://imagegen:8000/unload' });
    expect(fetch.calls.every((c) => c.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });
});

describe('RecraftImageGenClient', () => {
  it('generates via b64_json, removes the background for transparent art, returns PNG', async () => {
    const webp = new Uint8Array(await sharp({ create: { width: 64, height: 64, channels: 3, background: '#f00' } }).webp().toBuffer());
    const cut = await png();
    const fetch = stubFetch((c) =>
      c.url.endsWith('/images/generations')
        ? jsonResponse({ data: [{ b64_json: Buffer.from(webp).toString('base64') }] })
        : jsonResponse({ image: { b64_json: Buffer.from(cut).toString('base64') } }),
    );
    const client = new RecraftImageGenClient({ apiKey: 'rk-test', fetch });
    const out = await client.generate({ prompt: 'frog', style: 'vector_illustration', transparentBackground: true, widthPx: 1500, heightPx: 1800 });
    expect(fetch.calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/images/generations', '/v1/images/removeBackground']);
    const gen = JSON.parse(fetch.calls[0]!.text) as Record<string, unknown>;
    expect(gen).toMatchObject({ model: 'recraftv3', style: 'digital_illustration', size: '1024x1280', response_format: 'b64_json', n: 1 });
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer rk-test');
    expect(fetch.calls[1]!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(fetch.calls[1]!.text).toContain('name="file"');
    expect(isPng(out.bytes)).toBe(true);
    expect(out.model).toBe('recraftv3');
  });

  it('picks the closest supported size', () => {
    expect(pickRecraftSize(1000, 1000)).toBe('1024x1024');
    expect(pickRecraftSize(2000, 1000)).toBe('2048x1024');
    expect(pickRecraftSize(4500, 5400)).toBe('1024x1280');
  });
});

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PRINTIFY_IMAGE_HOSTS, createAllowlistedImageFetcher } from './fetchImage.ts';
import { bytesResponse, stubFetch } from './testing.ts';

describe('createAllowlistedImageFetcher', () => {
  it('fetches Printify mockups and sniffs the MIME type from bytes', async () => {
    const jpg = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer());
    const fetch = stubFetch(() => bytesResponse(jpg, { headers: { 'content-type': 'image/png' } }));
    const fetchImage = createAllowlistedImageFetcher({ fetch });
    const out = await fetchImage('https://images-api.printify.com/mockup/abc/1/145/t.jpg?camera_label=front');
    expect(out.mimeType).toBe('image/jpeg');
    expect(out.bytes).toEqual(jpg);
    expect(PRINTIFY_IMAGE_HOSTS).toContain('images.printify.com');
  });

  it('refuses other hosts (SSRF) without fetching', async () => {
    const fetch = stubFetch(() => bytesResponse(new Uint8Array([1])));
    const fetchImage = createAllowlistedImageFetcher({ fetch });
    for (const url of ['https://example.com/a.jpg', 'http://images.printify.com/a.jpg', 'https://127.0.0.1/a.jpg', 'https://imagegen:8000/unload']) {
      await expect(fetchImage(url)).rejects.toMatchObject({ kind: 'blocked' });
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it('refuses non-images (SVG/HTML) and oversized bodies', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const f1 = stubFetch(() => bytesResponse(svg, { headers: { 'content-type': 'image/svg+xml' } }));
    await expect(createAllowlistedImageFetcher({ fetch: f1 })('https://images.printify.com/x.svg')).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    const f2 = stubFetch(() => bytesResponse(new Uint8Array(2000)));
    await expect(createAllowlistedImageFetcher({ fetch: f2, maxBytes: 1000 })('https://images.printify.com/x.jpg')).rejects.toMatchObject({
      kind: 'too_large',
    });
  });
});

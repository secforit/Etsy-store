import { describe, expect, it } from 'vitest';
import {
  LivePrintifyClient,
  PRINTIFY_USER_AGENT,
  mapExternal,
  sanitizeFileName,
  selectPrintArea,
  type ExternalWriteEvent,
} from './printify.ts';
import { fakeClock, jsonResponse, stubFetch, type RecordedCall } from './testing.ts';

const SHOP_ID = '987654';

const variantsResponse = {
  id: 12,
  title: 'Unisex Jersey Short Sleeve Tee',
  variants: [
    { id: 1, title: 'Pink / S', options: { color: 'Pink', size: 'S' }, placeholders: [{ position: 'front', width: 4500, height: 5400 }, { position: 'back', width: 4500, height: 5400 }] },
    { id: 2, title: 'Black / S', options: { color: 'Black', size: 'S' }, placeholders: [{ position: 'front', width: 4500, height: 5400 }] },
    { id: 3, title: 'Black / 5XL', options: { color: 'Black', size: '5XL' }, placeholders: [{ position: 'front', width: 3600, height: 4800 }] },
    { id: 4, title: 'White / M', options: { color: 'White', size: 'M' }, placeholders: [{ position: 'front', width: 4500, height: 5400 }] },
  ],
};

function world(route: (call: RecordedCall) => Response | null, extra: Partial<ConstructorParameters<typeof LivePrintifyClient>[0]> = {}) {
  const events: ExternalWriteEvent[] = [];
  const fetch = stubFetch((call) => route(call) ?? new Response('not found', { status: 404 }));
  const client = new LivePrintifyClient({
    token: 'pfy-token',
    shopId: SHOP_ID,
    fetch,
    clock: fakeClock(),
    catalog: () => ({ blueprintId: 12, printProviderId: 29 }),
    onExternalWrite: (e) => void events.push(e),
    ...extra,
  });
  return { fetch, client, events };
}

const path = (c: RecordedCall) => new URL(c.url).pathname;

describe('LivePrintifyClient writes', () => {
  it('uploads base64 images with a sanitised file name, auth and User-Agent', async () => {
    const { fetch, client, events } = world((c) => (path(c) === '/v1/uploads/images.json' ? jsonResponse({ id: 'img123', file_name: 'x.png' }) : null));
    const out = await client.uploadImage({ fileName: '../Design Final!!.PNG', contentsBase64: 'iVBORw0KGgo=' });
    expect(out).toEqual({ id: 'img123' });
    const call = fetch.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe('Bearer pfy-token');
    expect(call.headers['user-agent']).toBe(PRINTIFY_USER_AGENT);
    expect(JSON.parse(call.text)).toEqual({ file_name: 'design-final-.png', contents: 'iVBORw0KGgo=' });
    expect(events).toEqual([{ service: 'printify', action: 'printify.image.upload', entity: 'printify_image', entityId: 'img123', details: { fileName: 'design-final-.png' } }]);
    await expect(client.uploadImage({ fileName: 'a.png', contentsBase64: 'not base64!' })).rejects.toThrow(/base64/);
  });

  it('creates a product with the documented body shape and never retries a 5xx', async () => {
    let n = 0;
    const { fetch, client, events } = world((c) =>
      path(c) === `/v1/shops/${SHOP_ID}/products.json` ? (n++ === 0 ? jsonResponse({ id: 'prod1' }) : new Response('', { status: 500 })) : null,
    );
    const input = {
      title: 'Retro Frog Tee',
      description: 'desc',
      tags: ['frog', 'retro'],
      blueprintId: 12,
      printProviderId: 29,
      variants: [
        { id: 2, priceCents: 2799, isEnabled: true },
        { id: 4, priceCents: 2799, isEnabled: false },
      ],
      imageId: 'img123',
      printPosition: 'front',
    };
    expect(await client.createProduct(input)).toEqual({ id: 'prod1' });
    expect(JSON.parse(fetch.calls[0]!.text)).toEqual({
      title: 'Retro Frog Tee',
      description: 'desc',
      tags: ['frog', 'retro'],
      blueprint_id: 12,
      print_provider_id: 29,
      variants: [
        { id: 2, price: 2799, is_enabled: true },
        { id: 4, price: 2799, is_enabled: false },
      ],
      print_areas: [{ variant_ids: [2, 4], placeholders: [{ position: 'front', images: [{ id: 'img123', x: 0.5, y: 0.5, scale: 1, angle: 0 }] }] }],
    });
    expect(events.map((e) => e.action)).toEqual(['printify.product.create']);
    await expect(client.createProduct(input)).rejects.toMatchObject({ status: 500 });
    expect(fetch.calls).toHaveLength(2); // no retry on 5xx for creates
    await expect(client.createProduct({ ...input, variants: [{ id: 2, priceCents: 27.99, isEnabled: true }] })).rejects.toThrow(/cents/);
  });

  it('publishes with all publish flags', async () => {
    const { fetch, client, events } = world((c) => (path(c).endsWith('/publish.json') ? jsonResponse({}) : null));
    await client.publishProduct('5d39b411749d0a000f30e0f4');
    expect(path(fetch.calls[0]!)).toBe(`/v1/shops/${SHOP_ID}/products/5d39b411749d0a000f30e0f4/publish.json`);
    expect(JSON.parse(fetch.calls[0]!.text)).toEqual({
      title: true,
      description: true,
      images: true,
      variants: true,
      tags: true,
      keyFeatures: true,
      shipping_template: true,
    });
    expect(events[0]!.action).toBe('printify.product.publish');
    await expect(client.publishProduct('../../etc')).rejects.toThrow(/product id/);
  });
});

describe('LivePrintifyClient.getProduct', () => {
  it('maps mockups (default first, https only) and external given as an array', async () => {
    const { client } = world(() =>
      jsonResponse({
        id: 'p1',
        title: 'T',
        images: [
          { src: 'https://images-api.printify.com/mockup/p1/2/146/t.jpg', is_default: false },
          { src: 'http://insecure.example/x.jpg', is_default: false },
          { src: 'https://images-api.printify.com/mockup/p1/2/145/t.jpg', is_default: true },
        ],
        external: [{ id: 4_100_000_001, handle: 'https://www.etsy.com/listing/4100000001' }],
        is_locked: false,
      }),
    );
    expect(await client.getProduct('p1')).toEqual({
      id: 'p1',
      title: 'T',
      mockupUrls: ['https://images-api.printify.com/mockup/p1/2/145/t.jpg', 'https://images-api.printify.com/mockup/p1/2/146/t.jpg'],
      external: { id: '4100000001', handle: 'https://www.etsy.com/listing/4100000001' },
      isLocked: false,
    });
  });

  it('maps external given as an object, or missing', () => {
    expect(mapExternal({ id: 'abc', handle: '' })).toEqual({ id: 'abc', handle: null });
    expect(mapExternal(undefined)).toBeNull();
    expect(mapExternal([])).toBeNull();
    expect(mapExternal({ handle: 'x' })).toBeNull();
  });
});

describe('LivePrintifyClient.getCatalogEntry', () => {
  const catalogRoutes = (extra: (c: RecordedCall) => Response | null) => (c: RecordedCall) => {
    const p = path(c);
    if (p === '/v1/catalog/blueprints/12/print_providers/29/variants.json') return jsonResponse(variantsResponse);
    if (p === '/v2/catalog/blueprints/12/print_providers/29/shipping/standard.json')
      return jsonResponse({
        data: [
          { attributes: { variantId: 2, country: { code: 'US' }, shippingCost: { firstItem: { amount: 475, currency: 'USD' } } } },
          { attributes: { variantId: 4, country: { code: 'US' }, shippingCost: { firstItem: { amount: 499, currency: 'USD' } } } },
          { attributes: { variantId: 2, country: { code: 'DE' }, shippingCost: { firstItem: { amount: 999, currency: 'USD' } } } },
        ],
      });
    return extra(c);
  };

  it('builds the entry from variants, v2 US shipping and costs of an existing shop product', async () => {
    const { client, fetch, events } = world(
      catalogRoutes((c) =>
        path(c) === `/v1/shops/${SHOP_ID}/products.json` && c.method === 'GET'
          ? jsonResponse({
              current_page: 1,
              last_page: 1,
              data: [
                { id: 'other', blueprint_id: 6, print_provider_id: 29, variants: [{ id: 2, cost: 100 }] },
                { id: 'mine', blueprint_id: 12, print_provider_id: 29, variants: [{ id: 1, cost: 935 }, { id: 2, cost: 935 }, { id: 4, cost: 960 }] },
              ],
            })
          : null,
      ),
    );
    const entry = await client.getCatalogEntry('tshirt');
    expect(entry).toEqual({
      productType: 'tshirt',
      blueprintId: 12,
      printProviderId: 29,
      variants: [
        { variantId: 2, title: 'Black / S', costUsd: 9.35 },
        { variantId: 4, title: 'White / M', costUsd: 9.6 },
        { variantId: 1, title: 'Pink / S', costUsd: 9.35 },
      ],
      shippingFirstItemUsd: 4.99,
      printArea: { position: 'front', widthPx: 4500, heightPx: 5400 },
    });
    expect(events).toEqual([]); // read-only path
    const n = fetch.calls.length;
    await client.getCatalogEntry('tshirt'); // cached
    expect(fetch.calls.length).toBe(n);
  });

  it('falls back to a create+delete cost probe, reporting both writes', async () => {
    const { client, fetch, events } = world(
      catalogRoutes((c) => {
        const p = path(c);
        if (p === `/v1/shops/${SHOP_ID}/products.json` && c.method === 'GET') return jsonResponse({ current_page: 1, last_page: 1, data: [] });
        if (p === '/v1/uploads/images.json') return jsonResponse({ id: 'probeimg' });
        if (p === `/v1/shops/${SHOP_ID}/products.json` && c.method === 'POST')
          return jsonResponse({ id: 'probe1', variants: [{ id: 1, cost: 1000 }, { id: 2, cost: 1000 }, { id: 4, cost: 1100 }] });
        if (p === `/v1/shops/${SHOP_ID}/products/probe1.json` && c.method === 'DELETE') return jsonResponse({});
        return null;
      }),
    );
    const entry = await client.getCatalogEntry('tshirt');
    expect(entry.variants.map((v) => v.costUsd)).toEqual([10, 11, 10]);
    const probe = JSON.parse(fetch.calls.find((c) => c.method === 'POST' && path(c).endsWith('/products.json'))!.text);
    expect(probe.print_areas[0].placeholders[0]).toEqual({ position: 'front', images: [{ id: 'probeimg', x: 0.5, y: 0.5, scale: 1, angle: 0 }] });
    expect(probe.variants.map((v: { id: number }) => v.id)).toEqual([2, 4, 1]);
    expect(events.map((e) => e.action)).toEqual(['printify.image.upload', 'printify.cost_probe.create', 'printify.product.delete']);
  });

  it('falls back to v1 shipping profiles and refuses to probe when disabled', async () => {
    const { client } = world(
      (c) => {
        const p = path(c);
        if (p.endsWith('/variants.json')) return jsonResponse(variantsResponse);
        if (p.startsWith('/v2/')) return new Response('gone', { status: 404 });
        if (p.endsWith('/shipping.json'))
          return jsonResponse({
            profiles: [
              { variant_ids: [1, 2, 4], first_item: { cost: 450, currency: 'USD' }, additional_items: { cost: 200, currency: 'USD' }, countries: ['US'] },
              { variant_ids: [1, 2, 4], first_item: { cost: 1000, currency: 'USD' }, additional_items: { cost: 500, currency: 'USD' }, countries: ['REST_OF_THE_WORLD'] },
            ],
          });
        if (p === `/v1/shops/${SHOP_ID}/products.json`) return jsonResponse({ current_page: 1, last_page: 1, data: [] });
        return null;
      },
      { costProbe: false },
    );
    await expect(client.getCatalogEntry('tshirt')).rejects.toThrow(/no variant costs/);
    expect(await client.getShippingFirstItemUsd(12, 29, [2], 'US')).toBe(4.5);
  });

  it('auto-discovers blueprint and a US print provider when ids are not pinned', async () => {
    const { client } = world(
      (c) => {
        const p = path(c);
        if (p === '/v1/catalog/blueprints.json')
          return jsonResponse([
            { id: 6, title: 'Unisex Heavy Cotton Tee', brand: 'Gildan', model: '5000' },
            { id: 12, title: 'Unisex Jersey Short Sleeve Tee', brand: 'Bella+Canvas', model: '3001' },
            { id: 68, title: 'Ceramic Mug 11oz', brand: 'Generic', model: 'Mug' },
          ]);
        if (p === '/v1/catalog/blueprints/12/print_providers.json') return jsonResponse([{ id: 3, title: 'EU Prints' }, { id: 29, title: 'Monster Digital' }]);
        if (p === '/v1/catalog/print_providers/3.json') return jsonResponse({ id: 3, location: { country: 'DE' } });
        if (p === '/v1/catalog/print_providers/29.json') return jsonResponse({ id: 29, location: { country: 'US' } });
        return null;
      },
      { catalog: () => null },
    );
    expect(await client.discoverCatalogIds('tshirt')).toEqual({ blueprintId: 12, printProviderId: 29 });
  });
});

describe('helpers', () => {
  it('selectPrintArea prefers front, the most common size, and common colours', () => {
    const { printArea, variants } = selectPrintArea(variantsResponse.variants);
    expect(printArea).toEqual({ position: 'front', widthPx: 4500, heightPx: 5400 });
    expect(variants.map((v) => v.id)).toEqual([2, 4, 1]);
  });

  it('sanitizeFileName', () => {
    expect(sanitizeFileName('Hello World.PNG')).toBe('hello-world.png');
    expect(sanitizeFileName('...')).toBe('design.png');
  });

  it('validates construction', () => {
    expect(() => new LivePrintifyClient({ token: '', shopId: '1' })).toThrow();
    expect(() => new LivePrintifyClient({ token: 't', shopId: 'abc' })).toThrow(/numeric/);
  });
});

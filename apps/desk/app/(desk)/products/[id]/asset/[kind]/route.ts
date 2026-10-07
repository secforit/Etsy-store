/**
 * Authenticated asset download (raw art, edited file, print file). Private, never cached.
 */
import { ASSET_CSP } from '../../../../../../lib/csp.ts';
import { getDeskService } from '../../../../../../lib/service.ts';
import { getSession } from '../../../../../../lib/session.ts';
import { describeError, log } from '../../../../../../lib/log.ts';
import { isAssetKind, isUuid } from '../../../../../../lib/validate.ts';

export const dynamic = 'force-dynamic';

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store, max-age=0',
  'x-content-type-options': 'nosniff',
} as const;

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { ...PRIVATE_HEADERS, 'content-type': 'text/plain; charset=utf-8' } });
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string; kind: string }> }): Promise<Response> {
  if (!(await getSession())) return text(401, 'Unauthorized');
  const { id, kind } = await ctx.params;
  if (!isUuid(id) || !isAssetKind(kind)) return text(404, 'Not found');

  let asset: { bytes: Uint8Array; mimeType: string } | null;
  try {
    asset = await (await getDeskService()).getAsset(id, kind);
  } catch (err) {
    log.error({ route: 'asset', kind, error: describeError(err) }, 'asset read failed');
    return text(500, 'Could not read the file.');
  }
  if (!asset) return text(404, 'Not found');

  const type = ALLOWED_TYPES.has(asset.mimeType) ? asset.mimeType : 'application/octet-stream';
  const download = new URL(request.url).searchParams.get('download') === '1';
  const filename = `${kind}-${id}.${EXT[type] ?? 'bin'}`;
  const body = new Uint8Array(asset.bytes); // copy into a plain ArrayBuffer-backed view
  return new Response(body, {
    status: 200,
    headers: {
      ...PRIVATE_HEADERS,
      'content-type': type,
      'content-length': String(body.byteLength),
      'content-disposition': `${download || type === 'application/octet-stream' ? 'attachment' : 'inline'}; filename="${filename}"`,
      'content-security-policy': ASSET_CSP,
    },
  });
}

/**
 * Liveness for the Docker HEALTHCHECK. Public (no auth) and reveals nothing. The proxy answers 503
 * before this runs when the desk configuration is invalid, so a misconfigured desk reports unhealthy.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}

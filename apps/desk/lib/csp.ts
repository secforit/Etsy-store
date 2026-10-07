/**
 * Content-Security-Policy builder. Never includes 'unsafe-eval' outside `next dev`
 * (React's dev tooling needs it; production React/Next do not).
 *
 * - With a nonce (set per request by proxy.ts, which handles every page): strict nonce + 'strict-dynamic'.
 * - Without a nonce (static header in next.config): 'self' only. It covers what the proxy does not touch
 *   (build assets, robots.txt) and redirects/plain-text refusals, none of which carry inline script.
 */
export function buildCsp(nonce: string | null, opts: { isDev: boolean }): string {
  const evalSrc = opts.isDev ? " 'unsafe-eval'" : '';
  const scriptSrc = nonce ? `'self' 'nonce-${nonce}' 'strict-dynamic'${evalSrc}` : `'self'${evalSrc}`;
  const styleSrc = nonce ? `'self' 'nonce-${nonce}'` : `'self'`;
  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (!opts.isDev) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

/** Policy for authenticated image downloads: nothing may load or run, even if a file were opened as a document. */
export const ASSET_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox";

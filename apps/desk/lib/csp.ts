/**
 * Content-Security-Policy builder. Never includes 'unsafe-eval' outside `next dev`
 * (React's dev tooling needs it; production React/Next do not).
 *
 * - With a nonce (set per request by proxy.ts): strict nonce + 'strict-dynamic' policy.
 * - Without a nonce (static header in next.config for responses the proxy does not touch): 'self'
 *   only, plus 'unsafe-inline' for scripts/styles because no nonce exists there.
 */
export function buildCsp(nonce: string | null, opts: { isDev: boolean }): string {
  const evalSrc = opts.isDev ? " 'unsafe-eval'" : '';
  const scriptSrc = nonce ? `'self' 'nonce-${nonce}' 'strict-dynamic'${evalSrc}` : `'self' 'unsafe-inline'${evalSrc}`;
  const styleSrc = nonce ? `'self' 'nonce-${nonce}'` : `'self' 'unsafe-inline'`;
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

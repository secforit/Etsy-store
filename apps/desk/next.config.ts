import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { buildCsp } from './lib/csp.ts';

const appDir = path.dirname(fileURLToPath(import.meta.url));
/** Monorepo root: lets Next trace and bundle packages/core (outside this app's folder). */
const repoRoot = path.resolve(appDir, '../..');
const isDev = process.env.NODE_ENV === 'development';

/**
 * Baseline security headers on EVERY response. Page responses additionally get a per-request
 * nonce-based CSP from proxy.ts (both policies apply; the nonce one is the stricter).
 */
const securityHeaders = [
  { key: 'Content-Security-Policy', value: buildCsp(null, { isDev }) },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  // 'same-origin' (not 'no-referrer'): with no-referrer, browsers send `Origin: null` on POSTs,
  // which would break the origin check on every mutation.
  { key: 'Referrer-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }]),
];

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  // The core package's DB layer reads its SQL migrations from disk at runtime.
  outputFileTracingIncludes: {
    '/**': ['../../packages/core/src/db/migrations/*.sql'],
  },
  turbopack: { root: repoRoot },
  // @etsy-agents/core ships TypeScript sources with `.ts`-extension relative imports; Next compiles them.
  transpilePackages: ['@etsy-agents/core'],
  // Native / wasm / worker-thread dependencies of core stay as runtime requires (traced into standalone).
  serverExternalPackages: ['sharp', 'pg', '@electric-sql/pglite', 'pino', '@anthropic-ai/sdk'],
  poweredByHeader: false,
  reactStrictMode: true,
  // No image optimizer: every image is a private, authenticated asset served by a route handler.
  images: { unoptimized: true },
  experimental: {
    serverActions: {
      // Edited PNG uploads (rule 6: max 50 MB).
      bodySizeLimit: '50mb',
    },
    // The proxy buffers request bodies; it must not truncate an upload before the action sees it.
    proxyClientMaxBodySize: '50mb',
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;

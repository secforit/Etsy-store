import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

// Every page is per-request: auth cookie, CSP nonce, live data. Nothing is prerendered at build time.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { default: 'Etsy desk', template: '%s · Etsy desk' },
  description: 'Approval desk for the Etsy agent team',
  robots: { index: false, follow: false },
  referrer: 'same-origin',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f5f2' },
    { media: '(prefers-color-scheme: dark)', color: '#161514' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

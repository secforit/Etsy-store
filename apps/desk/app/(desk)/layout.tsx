import Link from 'next/link';
import type { ReactNode } from 'react';
import { logoutAction } from '../../lib/actions.ts';
import { requireSession } from '../../lib/session.ts';

export default async function DeskLayout({ children }: { children: ReactNode }) {
  // Pages, actions and the asset route each re-check the session too (layouts do not re-run on
  // every client navigation).
  await requireSession();
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/" className="brand">
            Etsy desk
          </Link>
          <nav className="nav" aria-label="Main">
            <Link href="/">Dashboard</Link>
            <Link href="/queue">Queue</Link>
            <Link href="/rollout">Rollout</Link>
            <Link href="/settings">Settings</Link>
            <form action={logoutAction} className="inline-form">
              <button type="submit">Sign out</button>
            </form>
          </nav>
        </div>
      </header>
      <main className="main">{children}</main>
    </>
  );
}

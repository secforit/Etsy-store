import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { LoginForm } from '../../components/LoginForm.tsx';
import { getSession } from '../../lib/session.ts';
import { safeNextPath } from '../../lib/validate.ts';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(Array.isArray(params.next) ? params.next[0] : params.next);
  if (await getSession()) redirect(next);
  return (
    <main className="login-wrap">
      <div className="card login-card">
        <h1>Etsy desk</h1>
        <p className="muted">Approve designs and drafts from the agent team.</p>
        <LoginForm next={next} />
      </div>
    </main>
  );
}

import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="main">
      <div className="card">
        <h1>Not found</h1>
        <p className="muted">That page or product does not exist.</p>
        <Link href="/" className="btn">
          Back to the dashboard
        </Link>
      </div>
    </main>
  );
}

'use client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="main">
      <div className="card">
        <h1>Something went wrong</h1>
        <p className="muted">
          The desk could not finish that request. If you were away for a while, your session (12 hours) may have
          expired: sign in again. Otherwise the details are in the desk logs
          {error.digest ? (
            <>
              {' '}
              (reference <code>{error.digest}</code>)
            </>
          ) : null}
          .
        </p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => reset()}>
            Try again
          </button>
          <a href="/login" className="btn">
            Sign in
          </a>
          <a href="/" className="btn">
            Dashboard
          </a>
        </div>
      </div>
    </main>
  );
}

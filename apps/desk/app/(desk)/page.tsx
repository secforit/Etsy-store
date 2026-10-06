import type { Metadata } from 'next';
import Link from 'next/link';
import { PRODUCT_STATES } from '@etsy-agents/core/domain/types.ts';
import { PauseToggle } from '../../components/PauseToggle.tsx';
import { STATE_LABELS, usd } from '../../lib/format.ts';
import { getDeskService } from '../../lib/service.ts';
import { requireSession } from '../../lib/session.ts';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  await requireSession();
  const svc = await getDeskService();
  const stats = await svc.getDashboard();
  const needsEdit = stats.countsByState.designed ?? 0;
  const needsApproval = stats.countsByState.drafted ?? 0;
  const draftMax = Math.max(stats.dailyDraftCap, 1);
  const spendMax = Math.max(stats.dailySpendCapUsd, 0.01);

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
        <span className={stats.paused ? 'badge badge-bad' : 'badge badge-ok'}>
          {stats.paused ? 'Pipeline paused' : 'Pipeline running'}
        </span>
      </div>

      {stats.paused ? (
        <div className="banner banner-warn" role="status">
          The pipeline is paused. No new jobs start until you resume it.
        </div>
      ) : null}

      <div className="grid grid-3">
        <section className="card">
          <h2>Waiting on you</h2>
          <p>
            <Link href="/queue?state=designed">
              <span className="stat">{needsEdit}</span> design{needsEdit === 1 ? '' : 's'} to edit
            </Link>
          </p>
          <p>
            <Link href="/queue?state=drafted">
              <span className="stat">{needsApproval}</span> draft{needsApproval === 1 ? '' : 's'} to approve
            </Link>
          </p>
        </section>

        <section className="card">
          <h2>Today</h2>
          <p className="small muted">Drafts created (cap)</p>
          <p>
            <span className="stat">{stats.draftsToday}</span> / {stats.dailyDraftCap}
          </p>
          <progress
            className="meter"
            max={draftMax}
            value={Math.min(stats.draftsToday, draftMax)}
            aria-label="Drafts today against the daily cap"
          />
          <p className="small muted">Cloud model spend (cap)</p>
          <p>
            <span className="stat">{usd(stats.spendTodayUsd)}</span> / {usd(stats.dailySpendCapUsd)}
          </p>
          <progress
            className="meter"
            max={spendMax}
            value={Math.min(stats.spendTodayUsd, spendMax)}
            aria-label="Cloud spend today against the daily cap"
          />
          <p className="small muted">Local models on the GPU cost $0.</p>
        </section>

        <section className="card">
          <h2>Pipeline</h2>
          <p className="small muted">
            Pausing stops new jobs from starting. Your uploads, approvals and rejections still work.
          </p>
          <PauseToggle paused={stats.paused} />
        </section>
      </div>

      <section className="card" aria-labelledby="by-state">
        <h2 id="by-state">Products by state</h2>
        <ul className="state-grid">
          {PRODUCT_STATES.map((s) => (
            <li key={s}>
              <Link
                href={`/queue?state=${s}`}
                className={(s === 'designed' || s === 'drafted') && stats.countsByState[s] > 0 ? 'attention' : undefined}
              >
                <span>{STATE_LABELS[s]}</span>
                <span>{stats.countsByState[s] ?? 0}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="report">
        <h2 id="report">Latest weekly report</h2>
        {stats.latestReportMarkdown ? (
          <pre className="report">{stats.latestReportMarkdown}</pre>
        ) : (
          <p className="muted">No report yet. The Analyst writes one each week once listings are live.</p>
        )}
      </section>
    </>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import type { GateCheckStatus, GateStatus } from '@etsy-agents/core/domain/rollout.ts';
import { eur, usd } from '../../../lib/format.ts';
import { getDeskService } from '../../../lib/service.ts';
import { requireSession } from '../../../lib/session.ts';

export const metadata: Metadata = { title: 'Rollout' };

const GATE_BADGE: Record<GateStatus, { className: string; label: string }> = {
  passed: { className: 'badge badge-ok', label: 'Passed' },
  review: { className: 'badge badge-info', label: 'Ready for review' },
  open: { className: 'badge', label: 'Not yet' },
};

const CHECK_BADGE: Record<GateCheckStatus, { className: string; label: string }> = {
  met: { className: 'badge badge-ok', label: 'Met' },
  not_met: { className: 'badge badge-bad', label: 'Not met' },
  waiting: { className: 'badge', label: 'Not enough data' },
  manual: { className: 'badge badge-info', label: 'Check by hand' },
};

const SOURCE_LABELS: Record<string, string> = {
  etsy_search: 'Etsy search',
  pinterest: 'Pinterest',
  seasonal: 'Seasonal calendar',
  unattributed: 'No source recorded',
};

function percent(share: number | null, digits = 0): string {
  return share === null ? '–' : `${(share * 100).toFixed(digits)}%`;
}

export default async function RolloutPage() {
  await requireSession();
  const { metrics: m, gates } = await (await getDeskService()).getRollout();

  return (
    <>
      <div className="page-head">
        <h1>Rollout gates</h1>
        <span className="muted small">All time, from the pipeline&apos;s own records</span>
      </div>
      <p className="muted small">
        The daily draft cap goes up only after a gate shows the shop is safe and profitable at the current one. If a
        gate fails, the phase repeats with fixes. Change the cap in <Link href="/settings">Settings</Link>.
      </p>

      <div className="grid grid-2">
        {gates.map((gate) => (
          <section className="card" key={gate.id} aria-labelledby={`${gate.id}-title`}>
            <div className="page-head">
              <h2 id={`${gate.id}-title`}>{gate.title}</h2>
              <span className={GATE_BADGE[gate.status].className}>{GATE_BADGE[gate.status].label}</span>
            </div>
            <p className="small muted">Unlocks {gate.unlocks}.</p>
            <ul className="checks">
              {gate.checks.map((c) => (
                <li key={c.id}>
                  <div className="check-head">
                    <span>{c.label}</span>
                    <span className={CHECK_BADGE[c.status].className}>{CHECK_BADGE[c.status].label}</span>
                  </div>
                  <div>
                    <strong>{c.value}</strong> <span className="muted small">target: {c.target}</span>
                  </div>
                  {c.note ? <div className="small muted">{c.note}</div> : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="grid grid-2">
        <section className="card" aria-labelledby="numbers">
          <h2 id="numbers">Numbers behind the gates</h2>
          <div className="table-wrap">
            <table>
              <tbody>
                <tr>
                  <th scope="row">Etsy drafts created</th>
                  <td>{m.draftsMade}</td>
                </tr>
                <tr>
                  <th scope="row">Approved / rejected</th>
                  <td>
                    {m.approved} / {m.rejected}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Cloud model spend</th>
                  <td>{usd(m.cloudSpendUsd)}</td>
                </tr>
                <tr>
                  <th scope="row">Etsy listing fees</th>
                  <td>{usd(m.listingFeesUsd)}</td>
                </tr>
                <tr>
                  <th scope="row">Views / favorites</th>
                  <td>
                    {m.views} / {m.favorites}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Orders / revenue</th>
                  <td>
                    {m.orders} / {eur(m.revenueEur)}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Conversion (orders ÷ views)</th>
                  <td>{percent(m.conversion, 1)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="small muted">
            Etsy does not document the time window of its view counts: compare listings with each other, not with
            other shops.
          </p>
        </section>

        <section className="card" aria-labelledby="sources">
          <h2 id="sources">Block rate by trend source</h2>
          {m.blockRateBySource.length === 0 ? (
            <p className="muted">No compliance checks yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Checked</th>
                    <th scope="col">Blocked</th>
                    <th scope="col">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {m.blockRateBySource.map((s) => (
                    <tr key={s.source}>
                      <td>{SOURCE_LABELS[s.source] ?? s.source}</td>
                      <td>{s.checked}</td>
                      <td>{s.blocked}</td>
                      <td>{percent(s.rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted">
            Products whose niche came from two sources count under both. Drop a source whose ideas are mostly blocked
            for trademarks.
          </p>
        </section>
      </div>
    </>
  );
}

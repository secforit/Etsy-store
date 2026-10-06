import type { Metadata } from 'next';
import { PauseToggle } from '../../../components/PauseToggle.tsx';
import { SettingsForm } from '../../../components/SettingsForm.tsx';
import { dateTime } from '../../../lib/format.ts';
import { getDeskService } from '../../../lib/service.ts';
import { requireSession } from '../../../lib/session.ts';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  await requireSession();
  const settings = await (await getDeskService()).getSettings();
  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <span className="muted small">Last changed {dateTime(settings.updatedAt)}</span>
      </div>
      <div className="grid grid-2">
        <SettingsForm
          dailyDraftCap={settings.dailyDraftCap}
          dailySpendCapUsd={settings.dailySpendCapUsd}
          blocklist={settings.blocklist}
        />
        <section className="card">
          <h2>Pipeline</h2>
          <p>
            Status:{' '}
            <span className={settings.paused ? 'badge badge-bad' : 'badge badge-ok'}>
              {settings.paused ? 'paused' : 'running'}
            </span>
          </p>
          <PauseToggle paused={settings.paused} />
          <p className="small muted">
            Every change here is written to the audit log. Model choices, API keys and the shop&apos;s business rules
            live in the server configuration, not on this page.
          </p>
        </section>
      </div>
    </>
  );
}

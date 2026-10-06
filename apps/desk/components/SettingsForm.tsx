'use client';

import { useActionState } from 'react';
import { updateSettingsAction } from '../lib/actions.ts';
import { IDLE } from '../lib/actionState.ts';
import { FormMessage } from './FormMessage.tsx';
import { SubmitButton } from './SubmitButton.tsx';

export function SettingsForm({
  dailyDraftCap,
  dailySpendCapUsd,
  blocklist,
}: {
  dailyDraftCap: number;
  dailySpendCapUsd: number;
  blocklist: string[];
}) {
  const [state, action] = useActionState(updateSettingsAction, IDLE);
  return (
    <form action={action} className="card">
      <div className="field">
        <label htmlFor="dailyDraftCap">
          Daily draft cap
          <span className="hint">Most Etsy drafts the pipeline may create per day (0–100).</span>
        </label>
        <input
          id="dailyDraftCap"
          name="dailyDraftCap"
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          step={1}
          required
          defaultValue={dailyDraftCap}
        />
      </div>
      <div className="field">
        <label htmlFor="dailySpendCapUsd">
          Daily cloud spend cap (USD)
          <span className="hint">Only cloud model calls count; local models on the GPU cost $0.</span>
        </label>
        <input
          id="dailySpendCapUsd"
          name="dailySpendCapUsd"
          type="number"
          inputMode="decimal"
          min={0}
          max={1000}
          step={0.01}
          required
          defaultValue={dailySpendCapUsd}
        />
      </div>
      <div className="field">
        <label htmlFor="blocklist">
          Blocklist
          <span className="hint">One term per line. Any hit blocks a product at both compliance checks.</span>
        </label>
        <textarea id="blocklist" name="blocklist" rows={10} defaultValue={blocklist.join('\n')} />
      </div>
      <div className="actions">
        <SubmitButton pendingText="Saving…">Save settings</SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

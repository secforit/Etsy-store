'use client';

import { useActionState } from 'react';
import { approveAction, rejectAction } from '../lib/actions.ts';
import { IDLE } from '../lib/actionState.ts';
import { FormMessage } from './FormMessage.tsx';
import { SubmitButton } from './SubmitButton.tsx';

export function ApproveForm({ productId, title }: { productId: string; title: string }) {
  const [state, action] = useActionState(approveAction, IDLE);
  return (
    <form action={action}>
      <input type="hidden" name="productId" value={productId} />
      <p className="small muted">Approving activates the Etsy listing (Etsy charges the listing fee).</p>
      <SubmitButton
        className="btn btn-ok"
        pendingText="Approving…"
        confirmText={`Publish "${title}" on Etsy now?`}
      >
        Approve and go live
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

export function RejectForm({ productId }: { productId: string }) {
  const [state, action] = useActionState(rejectAction, IDLE);
  return (
    <form action={action} className="stack">
      <input type="hidden" name="productId" value={productId} />
      <div className="field">
        <label htmlFor="reason">
          Reject with a reason
          <span className="hint">Up to 500 characters. It becomes an avoid-rule for future designs and listings.</span>
        </label>
        <textarea id="reason" name="reason" required maxLength={500} />
      </div>
      <div className="field">
        <label className="check">
          <input type="checkbox" name="ipMiss" />
          <span>IP problem the compliance check missed</span>
          <span className="hint">
            Tick when the design or copy uses a trademark, brand, character or celebrity that the checks let through.
            It counts against rollout Gate 2.
          </span>
        </label>
      </div>
      <SubmitButton className="btn btn-danger" pendingText="Rejecting…">
        Reject
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

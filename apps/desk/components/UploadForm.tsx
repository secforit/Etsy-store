'use client';

import { useActionState, useState } from 'react';
import type { ChangeEvent } from 'react';
import { uploadEditedAction } from '../lib/actions.ts';
import { IDLE } from '../lib/actionState.ts';
import { FormMessage } from './FormMessage.tsx';
import { SubmitButton } from './SubmitButton.tsx';

/** 50 MB, minus headroom for the multipart envelope so the request stays within the 50mb body limit. */
const MAX_BYTES = 50 * 1024 * 1024 - 64 * 1024;

export function UploadForm({ productId }: { productId: string }) {
  const [state, action] = useActionState(uploadEditedAction, IDLE);
  const [clientError, setClientError] = useState('');

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return setClientError('');
    if (file.size > MAX_BYTES) {
      setClientError('That file is larger than 50 MB.');
      e.target.value = '';
    } else if (file.type && file.type !== 'image/png') {
      setClientError('Only PNG files are accepted.');
      e.target.value = '';
    } else {
      setClientError('');
    }
  };

  return (
    <form action={action} className="stack">
      <input type="hidden" name="productId" value={productId} />
      <div className="field">
        <label htmlFor="file">
          Edited design (PNG)
          <span className="hint">PNG only, up to 50 MB and 12000×12000 px. Keep transparency for shirts and mugs.</span>
        </label>
        <input id="file" name="file" type="file" accept="image/png" required onChange={onChange} />
      </div>
      {clientError ? <p className="message message-bad">{clientError}</p> : null}
      <SubmitButton pendingText="Uploading…">Upload edited design</SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

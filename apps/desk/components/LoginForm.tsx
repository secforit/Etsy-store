'use client';

import { useActionState } from 'react';
import { loginAction } from '../lib/actions.ts';
import { IDLE } from '../lib/actionState.ts';
import { FormMessage } from './FormMessage.tsx';
import { SubmitButton } from './SubmitButton.tsx';

export function LoginForm({ next }: { next: string }) {
  const [state, action] = useActionState(loginAction, IDLE);
  return (
    <form action={action} className="stack">
      <input type="hidden" name="next" value={next} />
      {/* Single-user desk: a fixed username so password managers can file the entry; the server ignores it. */}
      <input type="text" name="username" autoComplete="username" value="razvan" readOnly hidden />
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={1024}
          autoFocus
        />
      </div>
      <SubmitButton pendingText="Checking…">Sign in</SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

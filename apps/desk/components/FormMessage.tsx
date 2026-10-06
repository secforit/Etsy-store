import type { ActionState } from '../lib/actionState.ts';

export function FormMessage({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return (
    <p className={`message ${state.ok ? 'message-ok' : 'message-bad'}`} role={state.ok ? 'status' : 'alert'}>
      {state.message}
    </p>
  );
}

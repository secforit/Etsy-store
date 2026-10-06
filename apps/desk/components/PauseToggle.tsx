import { setPausedAction } from '../lib/actions.ts';
import { SubmitButton } from './SubmitButton.tsx';

/** Server-rendered form; the action flips settings.paused (audited by the service). */
export function PauseToggle({ paused }: { paused: boolean }) {
  return (
    <form action={setPausedAction}>
      <input type="hidden" name="paused" value={paused ? 'false' : 'true'} />
      {paused ? (
        <SubmitButton className="btn btn-primary" pendingText="Resuming…">
          Resume pipeline
        </SubmitButton>
      ) : (
        <SubmitButton
          className="btn btn-danger"
          pendingText="Pausing…"
          confirmText="Pause the pipeline? Running jobs finish; no new jobs start."
        >
          Pause pipeline
        </SubmitButton>
      )}
    </form>
  );
}

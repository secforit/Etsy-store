/**
 * Product state machine. Pure functions only.
 * CONTRACT FILE: owned by the foundation.
 */
import type { JobKind, ProductState } from './types.ts';

export type ProductEvent =
  | 'concept_pass'
  | 'concept_block'
  | 'design_done'
  | 'edit_uploaded'
  | 'copy_written'
  | 'final_pass'
  | 'final_block'
  | 'qa_pass'
  | 'qa_fail' // back to `designed`: Razvan uploads a fixed file
  | 'qa_fail_final' // attempts exhausted
  | 'approve'
  | 'reject'
  | 'retire';

const TRANSITIONS: Readonly<Record<ProductState, Partial<Record<ProductEvent, ProductState>>>> = {
  proposed: { concept_pass: 'cleared', concept_block: 'blocked' },
  cleared: { design_done: 'designed' },
  designed: { edit_uploaded: 'edited' },
  edited: { copy_written: 'written' },
  written: { final_pass: 'final_cleared', final_block: 'blocked' },
  final_cleared: { qa_pass: 'drafted', qa_fail: 'designed', qa_fail_final: 'blocked' },
  drafted: { approve: 'live', reject: 'rejected' },
  live: { retire: 'retired' },
  retired: {},
  blocked: {},
  rejected: {},
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: ProductState,
    public readonly event: ProductEvent,
  ) {
    super(`Invalid transition: ${from} --${event}-->`);
    this.name = 'InvalidTransitionError';
  }
}

/** Returns the next state or throws InvalidTransitionError. */
export function transition(from: ProductState, event: ProductEvent): ProductState {
  const to = TRANSITIONS[from][event];
  if (!to) throw new InvalidTransitionError(from, event);
  return to;
}

export function canTransition(from: ProductState, event: ProductEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

/** The automated step that moves a product out of `state`, or null when waiting on a human / terminal. */
export function stepForState(state: ProductState): JobKind | null {
  switch (state) {
    case 'proposed':
      return 'concept_check';
    case 'cleared':
      return 'design';
    case 'edited':
      return 'write';
    case 'written':
      return 'final_check';
    case 'final_cleared':
      return 'qa_publish';
    default:
      return null; // designed / drafted wait on Razvan; live handled by periodic `analyze`; stop states are terminal
  }
}

export const HUMAN_WAIT_STATES: readonly ProductState[] = ['designed', 'drafted'];
export const TERMINAL_STATES: readonly ProductState[] = ['retired', 'blocked', 'rejected'];

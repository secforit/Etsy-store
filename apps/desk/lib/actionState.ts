/** Result shape returned by server actions to `useActionState` forms. */
export interface ActionState {
  ok: boolean;
  message: string;
}

export const IDLE: ActionState = { ok: true, message: '' };

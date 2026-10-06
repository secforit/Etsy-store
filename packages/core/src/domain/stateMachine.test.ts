import { describe, expect, it } from 'vitest';
import { canTransition, InvalidTransitionError, stepForState, transition } from './stateMachine.ts';
import { createPgliteDb, migrate } from '../db/db.ts';

describe('state machine', () => {
  it('walks the happy path from proposed to retired', () => {
    let s = transition('proposed', 'concept_pass');
    s = transition(s, 'design_done');
    expect(s).toBe('designed');
    expect(stepForState(s)).toBeNull(); // waits for Razvan's edit
    s = transition(s, 'edit_uploaded');
    s = transition(s, 'copy_written');
    s = transition(s, 'final_pass');
    s = transition(s, 'qa_pass');
    expect(s).toBe('drafted');
    s = transition(s, 'approve');
    expect(s).toBe('live');
    expect(transition(s, 'retire')).toBe('retired');
  });

  it('refuses to skip a gate', () => {
    expect(() => transition('proposed', 'design_done')).toThrow(InvalidTransitionError);
    expect(canTransition('written', 'qa_pass')).toBe(false);
    expect(canTransition('blocked', 'concept_pass')).toBe(false);
  });

  it('sends a QA failure back to the human edit step', () => {
    expect(transition('final_cleared', 'qa_fail')).toBe('designed');
  });
});

describe('migrations', () => {
  it('apply cleanly on PGlite and are idempotent', async () => {
    const db = await createPgliteDb();
    expect(await migrate(db)).toEqual(['001_init.sql']);
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query<{ paused: boolean }>('SELECT paused FROM settings WHERE id = 1');
    expect(rows[0]?.paused).toBe(false);
    await db.close();
  });
});

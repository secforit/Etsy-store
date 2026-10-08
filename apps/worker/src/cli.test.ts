import { Readable, Writable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '@etsy-agents/core/config/env.ts';
import type { Db } from '@etsy-agents/core/db/db.ts';
import { verifyPassword } from '@etsy-agents/core/desk/password.ts';
import { enqueue } from '@etsy-agents/core/orchestrator/queue.ts';
import { TestClock, auditActions, sharedTestDb } from '@etsy-agents/core/orchestrator/testing/fakes.ts';
import { flagInt, parseArgs } from './args.ts';
import { main } from './cli.ts';
import { readPassword } from './commands/hashPassword.ts';
import { printStatus, retryFailed } from './commands/ops.ts';
import { MemoryIo } from './io.ts';

const sink = () => new Writable({ write: (_c, _e, cb) => cb() });

describe('args', () => {
  it('parses commands, flags and booleans', () => {
    expect(parseArgs(['setup-catalog', '--type', 'mug', '--dry-run', '--blueprint=68'], ['dry-run'])).toEqual({
      command: 'setup-catalog',
      flags: { type: 'mug', 'dry-run': true, blueprint: '68' },
      positionals: [],
    });
    expect(() => flagInt({ n: 'x1' }, 'n')).toThrow(/positive integer/);
    expect(flagInt({ n: '12' }, 'n')).toBe(12);
  });
});

describe('cli main', () => {
  it('prints usage and rejects unknown commands', async () => {
    const io = new MemoryIo();
    expect(await main([], { io })).toBe(2);
    expect(io.text()).toMatch(/Usage: cli <command>/);
    const io2 = new MemoryIo();
    expect(await main(['launch-rockets'], { io: io2 })).toBe(2);
    expect(io2.errors[0]).toMatch(/Unknown command/);
  });

  it('hash-password reads stdin (never argv) and prints a verifiable scrypt hash', async () => {
    const io = new MemoryIo();
    const stdin = Readable.from(['a very long desk password\n']) as Readable & { isTTY?: boolean };
    expect(await main(['hash-password', '--cost', '16384'], { io, stdin, stdout: sink() })).toBe(0);
    const hash = io.lines[0]!;
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword('a very long desk password', hash)).toBe(true);
  });

  it('hash-password refuses short passwords', async () => {
    const stdin = Readable.from(['short\n']) as Readable & { isTTY?: boolean };
    await expect(main(['hash-password'], { io: new MemoryIo(), stdin, stdout: sink() })).rejects.toThrow(/at least 12/);
  });

  it('migrate applies migrations on an in-memory database in mock mode', async () => {
    const io = new MemoryIo();
    expect(await main(['migrate'], { io, env: loadEnv({ MODE: 'mock' }) })).toBe(0);
    expect(io.lines[0]).toMatch(/Applied 001_init\.sql, 002_orchestrator\.sql, 003_rollout\.sql \(pglite\)/);
  });

  it('readPassword strips exactly one trailing newline from piped input', async () => {
    expect(await readPassword(Readable.from(['pass word with spaces  \r\n']) as never, sink())).toBe('pass word with spaces  ');
  });
});

describe('operator commands', () => {
  let db: Db;
  const clock = new TestClock();
  beforeEach(async () => {
    db = await sharedTestDb();
  });

  it('status prints caps, counts and failed jobs', async () => {
    const { id } = await enqueue(db, { kind: 'analyze', idempotencyKey: 'a' }, clock.now());
    await db.query(`UPDATE jobs SET status = 'failed', last_error = 'boom' WHERE id = $1`, [id]);
    const io = new MemoryIo();
    await printStatus(db, clock.now(), [], io);
    expect(io.text()).toMatch(/Drafts today\s+: 0 \/ 5/);
    expect(io.text()).toMatch(/Cloud spend today : \$0\.00 \/ \$10\.00/);
    expect(io.text()).toMatch(/failed analyze .*: boom/);
    expect(io.text()).toMatch(/Gate 2: pilot quality: not yet/);
    expect(io.text()).toMatch(/\[\.\.\] Drafts reviewed: 0 of 50 \(target: 50\)/);
    expect(io.text()).toMatch(/\[\?\?\] Margin per sale: no sales yet/);
  });

  it('retry-failed requeues failed jobs and audits it', async () => {
    const a = await enqueue(db, { kind: 'analyze', idempotencyKey: 'a' }, clock.now());
    const b = await enqueue(db, { kind: 'qa_publish', idempotencyKey: 'b' }, clock.now());
    await db.query(`UPDATE jobs SET status = 'failed', attempts = 3`);
    const io = new MemoryIo();
    expect(await retryFailed(db, clock.now(), io, { kind: 'qa_publish' })).toBe(1);
    const { rows } = await db.query<{ id: string; status: string; attempts: number }>('SELECT id, status, attempts FROM jobs ORDER BY idempotency_key');
    expect(rows).toEqual([
      { id: a.id, status: 'failed', attempts: 3 },
      { id: b.id, status: 'queued', attempts: 0 },
    ]);
    expect(await auditActions(db, b.id)).toEqual(['job.requeued']);
    await expect(retryFailed(db, clock.now(), io, { kind: 'nope' })).rejects.toThrow(/unknown job kind/);
    await expect(retryFailed(db, clock.now(), io, { jobId: "1' OR 1=1" })).rejects.toThrow(/UUID/);
  });
});

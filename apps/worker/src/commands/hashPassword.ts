/**
 * `hash-password`: prints DESK_PASSWORD_HASH (scrypt$N$r$p$saltB64$hashB64) for a password read from the
 * terminal (no echo, asked twice) or from stdin. Never from argv: it would end up in shell history and `ps`.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { hashPassword } from '@etsy-agents/core/desk/password.ts';

/** Reads all of a non-TTY stream and strips ONE trailing newline. */
export async function readAllStdin(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of input) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function askHidden(question: string, input: Readable, output: Writable): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: true });
    const rlAny = rl as unknown as { _writeToOutput: (s: string) => void; output: Writable };
    let muted = false;
    rlAny._writeToOutput = (s: string) => {
      if (!muted) output.write(s);
    };
    rl.question(question, (answer) => {
      output.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

export async function readPassword(input: Readable & { isTTY?: boolean }, output: Writable): Promise<string> {
  if (!input.isTTY) return readAllStdin(input);
  const a = await askHidden('Desk password (min 12 characters): ', input, output);
  const b = await askHidden('Repeat: ', input, output);
  if (a !== b) throw new Error('the two passwords differ');
  return a;
}

export async function hashPasswordCommand(password: string, cost?: number): Promise<string> {
  return hashPassword(password, cost ? { N: cost } : {});
}

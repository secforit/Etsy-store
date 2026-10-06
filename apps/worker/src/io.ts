/** Output sink for commands (tests capture lines instead of writing to the terminal). */
export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export const consoleIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export class MemoryIo implements Io {
  readonly lines: string[] = [];
  readonly errors: string[] = [];
  out(line: string) {
    this.lines.push(line);
  }
  err(line: string) {
    this.errors.push(line);
  }
  text(): string {
    return this.lines.join('\n');
  }
}

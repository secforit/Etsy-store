/** Tiny argv parser: `cmd --flag value --bool positional`. No external dependency. */
export interface ParsedArgs {
  command: string | null;
  flags: Record<string, string | true>;
  positionals: string[];
}

export function parseArgs(argv: readonly string[], booleanFlags: readonly string[] = []): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (!booleanFlags.includes(name) && next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else if (command === null) {
      command = a;
    } else {
      positionals.push(a);
    }
  }
  return { command, flags, positionals };
}

export function flagString(flags: ParsedArgs['flags'], name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagInt(flags: ParsedArgs['flags'], name: string): number | undefined {
  const v = flagString(flags, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new Error(`--${name} must be a positive integer`);
  return Number(v);
}

/**
 * Minimal argv parser.
 *
 * Recognizes `--flag value`, `--flag=value`, and boolean `--flag`. Anything
 * not preceded by a `--name` is collected as a positional. We avoid a third-
 * party arg parser because the CLI's surface is small and we want zero
 * runtime deps beyond @maintainers/protocol.
 */

export interface ParsedArgs {
  command: string | undefined;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (i === 0 && !tok.startsWith("-")) {
      command = tok;
      continue;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq >= 0) {
        const name = tok.slice(2, eq);
        const value = tok.slice(eq + 1);
        flags[name] = value;
      } else {
        const name = tok.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positionals.push(tok);
    }
  }

  return { command, flags, positionals };
}

export function requireFlag(args: ParsedArgs, name: string): string {
  const v = args.flags[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new CliError(`missing required --${name}`);
  }
  return v;
}

export function optionalFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

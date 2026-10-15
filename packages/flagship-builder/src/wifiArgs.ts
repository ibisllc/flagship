import { readFile } from "node:fs/promises";

/** The Wi-Fi password a burn bakes in: `--wifi-password <pass>`, or the
 * contents of `--wifi-password-file <path>` (one trailing newline dropped).
 * The file form keeps the password out of the process list, which every
 * local user can read; the desktop apps use it. */
export async function resolveWifiPassword(argv: string[]): Promise<string | undefined> {
  const inline = flagValue(argv, "--wifi-password");
  if (inline !== undefined) return inline;
  const file = flagValue(argv, "--wifi-password-file");
  if (file === undefined) return undefined;
  const text = await readFile(file, "utf8");
  return text.replace(/\r?\n$/, "");
}

function flagValue(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === flag) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) return next;
    }
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

import { afterEach, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared harness for the wipe-all-users tests: a stub `npx` on PATH that
// records every `wrangler d1 execute` call (and, with WIPE_STUB_DB set, runs the
// SQL against a throwaway sqlite file), so no test ever reaches a real database.

export const SCRIPT = join(__dirname, "wipe-all-users.sh");
export const SQL = join(__dirname, "wipe-all-users-prerelease-2026-06-02.sql");

const D1_STUB = [
  'import { createRequire } from "node:module";',
  'const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");',
  "const args = process.argv.slice(2);",
  'const sql = args[args.indexOf("--command") + 1];',
  "const db = new DatabaseSync(process.env.WIPE_STUB_DB);",
  'db.exec("PRAGMA foreign_keys = ON");',
  "try {",
  "  if (/^\\s*SELECT/i.test(sql)) {",
  "    const rows = db.prepare(sql).all();",
  '    if (args.includes("--json")) console.log(JSON.stringify([{ results: rows, success: true }]));',
  "  } else db.exec(sql);",
  "} catch (e) { console.error(String(e.message)); process.exit(1); }",
].join("\n");

let binDir = "";
let callLog = "";
export const getBinDir = () => binDir;
export const getCallLog = () => callLog;

export function installStub() {
 beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "wipe-stub-bin-"));
  callLog = join(binDir, "calls.log");
  // Stub `npx`: log argv, and for a `wrangler d1 execute --command "SELECT ..."`
  // emit the shape wrangler --json produces so the preview can parse a count.
  const stub = `#!/usr/bin/env bash
echo "$*" >> "${callLog}"
if [ -n "\${WIPE_STUB_DB:-}" ]; then exec node "${join(binDir, "d1stub.mjs")}" "$@"; fi
for a in "$@"; do
  case "$a" in
    "SELECT count(*) AS n"*)
      if grep -q "DELETE FROM" "${callLog}"; then echo '[{"results":[{"n":7,"k":7}],"success":true}]'
      else echo '[{"results":[{"n":7,"k":2}],"success":true}]'; fi
      exit 0 ;;
  esac
done
exit 0
`;
  writeFileSync(join(binDir, "d1stub.mjs"), D1_STUB);
  const npxPath = join(binDir, "npx");
  writeFileSync(npxPath, stub);
  chmodSync(npxPath, 0o755);
});

afterEach(() => {
  if (binDir) rmSync(binDir, { recursive: true, force: true });
  binDir = "";
 });
}

export function run(
  args: string[],
  env?: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, ...env },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function readCalls(): string {
  try {
    return readFileSync(callLog, "utf8");
  } catch {
    return "";
  }
}

export function deleteCalls(): string[] {
  let log = "";
  try {
    log = readFileSync(callLog, "utf8");
  } catch {
    return [];
  }
  return log.split("\n").filter((l) => l.includes("DELETE FROM"));
}

export const GYM = { WIPE_ENV: "gym", WIPE_D1: "flagship-state-gym" };
export const PROD = { WIPE_ENV: "prod", WIPE_D1: "flagship-state" };

/** Run under a pseudo-terminal (stdin is a TTY) and feed `typed` to the prompt. */
export function runWithTty(
  typed: string,
  env: Record<string, string>,
): { code: number; out: string } {
  const py = [
    "import os, pty, sys, select",
    "typed = sys.argv[2].encode()",
    "pid, fd = pty.fork()",
    "if pid == 0:",
    "    os.execvp('bash', ['bash', sys.argv[1], '--yes'])",
    "out = b''",
    "sent = False",
    "while True:",
    "    r, _, _ = select.select([fd], [], [], 30)",
    "    if not r: break",
    "    try: d = os.read(fd, 4096)",
    "    except OSError: break",
    "    if not d: break",
    "    out += d",
    "    if not sent and b'to continue' in out:",
    "        os.write(fd, typed); sent = True",
    "_, st = os.waitpid(pid, 0)",
    "sys.stdout.write(out.decode(errors='replace'))",
    "sys.exit(os.waitstatus_to_exitcode(st))",
  ].join("\n");
  const r = spawnSync("python3", ["-I", "-c", py, SCRIPT, typed], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, ...env },
  });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}


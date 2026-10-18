import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Guard tests for the prod-wipe runner (AGENTS.md → "GA close-out" item 1).
// The script can delete every user/server; the guards make it require BOTH a
// --yes AND a WIPE_CONFIRM token that matches the target env, with a dry-run
// row-count preview first. These tests must NEVER touch a real DB, so a stub
// `npx` is injected on PATH: it records every `wrangler d1 execute` invocation
// and returns canned count JSON. We then assert which DELETEs did/didn't run.

const SCRIPT = join(__dirname, "wipe-all-users.sh");
const SQL = join(__dirname, "wipe-all-users-prerelease-2026-06-02.sql");
const MIGRATIONS = join(__dirname, "..", "packages", "storage", "migrations");

/** Tables main's migrations leave in place, replaying CREATE/DROP/RENAME in order. */
function liveMigrationTables(): Set<string> {
  const live = new Set<string>();
  const stmt =
    /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?(\w+)|ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+RENAME\s+TO\s+["`]?(\w+)/gi;
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    const text = readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, "");
    for (const m of text.matchAll(stmt)) {
      if (m[1]) live.add(m[1].toLowerCase());
      else if (m[2]) live.delete(m[2].toLowerCase());
      else if (m[3] && m[4]) {
        live.delete(m[3].toLowerCase());
        live.add(m[4].toLowerCase());
      }
    }
  }
  return live;
}

let binDir = "";
let callLog = "";

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "wipe-stub-bin-"));
  callLog = join(binDir, "calls.log");
  // Stub `npx`: log argv, and for a `wrangler d1 execute --command "SELECT ..."`
  // emit the shape wrangler --json produces so the preview can parse a count.
  const stub = `#!/usr/bin/env bash
echo "$*" >> "${callLog}"
for a in "$@"; do
  case "$a" in
    "SELECT count(*) AS n FROM "*) echo '[{"results":[{"n":7}],"success":true}]'; exit 0 ;;
  esac
done
exit 0
`;
  const npxPath = join(binDir, "npx");
  writeFileSync(npxPath, stub);
  chmodSync(npxPath, 0o755);
});

afterEach(() => {
  if (binDir) rmSync(binDir, { recursive: true, force: true });
  binDir = "";
});

function run(
  args: string[],
  env?: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, ...env },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readCalls(): string {
  try {
    return readFileSync(callLog, "utf8");
  } catch {
    return "";
  }
}

function deleteCalls(): string[] {
  let log = "";
  try {
    log = readFileSync(callLog, "utf8");
  } catch {
    return [];
  }
  return log.split("\n").filter((l) => l.includes("DELETE FROM"));
}

const GYM = { WIPE_ENV: "gym", WIPE_D1: "flagship-state-gym" };
const PROD = { WIPE_ENV: "prod", WIPE_D1: "flagship-state" };

/** Run under a pseudo-terminal (stdin is a TTY) and feed `typed` to the prompt. */
function runWithTty(
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

describe("wipe-all-users.sh — guards", () => {
  it("with no WIPE_ENV / WIPE_D1 it refuses: nothing defaults to prod", () => {
    const r = run([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("WIPE_ENV and WIPE_D1 are both required");
    expect(readCalls()).toBe("");
    const r2 = run(["--yes"], { WIPE_CONFIRM: "prod" });
    expect(r2.code).toBe(1);
    expect(readCalls()).toBe("");
    const r3 = run([], { WIPE_ENV: "gym" });
    expect(r3.code).toBe(1);
    const r4 = run([], { WIPE_D1: "flagship-state" });
    expect(r4.code).toBe(1);
    expect(readCalls()).toBe("");
  });

  it("--help works without a target and prints the guards", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("GUARDS");
  });

  it("default (target named, no --yes) is a dry run: previews, deletes NOTHING", () => {
    const r = run([], GYM);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("wipe preview");
    expect(r.stdout).toContain("DRY RUN");
    expect(deleteCalls()).toHaveLength(0);
  });

  it("the preview reports a row total from the counts", () => {
    const r = run([], GYM);
    expect(r.stdout).toMatch(/would delete ~\d+ row\(s\)/);
    expect(r.stdout).toContain("row(s)");
  });

  it("--yes WITHOUT WIPE_CONFIRM refuses before any delete", () => {
    const r = run(["--yes"], { ...GYM, WIPE_CONFIRM: "" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("REFUSING TO WIPE");
    expect(r.stderr).toContain("WIPE_CONFIRM must equal the target env");
    expect(deleteCalls()).toHaveLength(0);
  });

  it("--yes with a MISMATCHED WIPE_CONFIRM refuses (gym token, prod target)", () => {
    const r = run(["--yes"], { ...PROD, WIPE_CONFIRM: "gym" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("REFUSING TO WIPE");
    expect(deleteCalls()).toHaveLength(0);
  });

  it("the gym path works with its own env + token + D1 and audits", () => {
    const r = run(["--yes"], { ...GYM, WIPE_CONFIRM: "gym" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("target env : gym");
    expect(r.stdout).toContain("AUDIT");
    expect(r.stdout).toContain("WIPE START");
    expect(r.stdout).toContain("WIPE DONE");
    expect(readFileSync(callLog, "utf8")).toContain("flagship-state-gym");
    expect(deleteCalls().length).toBeGreaterThan(30);
  });

  it("PROD with --yes and WIPE_CONFIRM=prod but no terminal refuses (CI / agents / pipes)", () => {
    const r = run(["--yes"], { ...PROD, WIPE_CONFIRM: "prod" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stdin is not a terminal");
    expect(deleteCalls()).toHaveLength(0);
  });

  it("PROD at a terminal: a wrong typed name refuses, the right one proceeds", () => {
    const bad = runWithTty("flagship\n", { ...PROD, WIPE_CONFIRM: "prod" });
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("REFUSING TO WIPE PRODUCTION");
    expect(deleteCalls()).toHaveLength(0);
    const good = runWithTty("flagship-state\n", { ...PROD, WIPE_CONFIRM: "prod" });
    expect(good.out).toContain("WIPE DONE");
    expect(good.code).toBe(0);
    expect(deleteCalls().length).toBeGreaterThan(30);
  });

  it("PROD target with a non-prod D1 refuses", () => {
    const r = run(["--yes"], { WIPE_ENV: "prod", WIPE_D1: "flagship-state-gym", WIPE_CONFIRM: "prod" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("must name the prod database");
    expect(deleteCalls()).toHaveLength(0);
  });

  it("HARD-GUARD: a non-prod env pointing at the PROD D1 refuses before anything", () => {
    const r = run(["--yes"], { WIPE_ENV: "gym", WIPE_CONFIRM: "gym", WIPE_D1: "flagship-state" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("PROD database");
    expect(deleteCalls()).toHaveLength(0);
  });

  it("WIPE_WRANGLER_CONFIG threads --config into every wrangler call", () => {
    const r = run(["--yes"], { ...GYM, WIPE_CONFIRM: "gym", WIPE_WRANGLER_CONFIG: "wrangler.gym.toml" });
    expect(r.code).toBe(0);
    expect(readFileSync(callLog, "utf8")).toContain("--config wrangler.gym.toml");
  });

  it("without WIPE_WRANGLER_CONFIG no --config flag is passed", () => {
    run(["--yes"], { ...GYM, WIPE_CONFIRM: "gym", WIPE_WRANGLER_CONFIG: "" });
    expect(readFileSync(callLog, "utf8")).not.toContain("--config");
  });

  it("an unknown argument is rejected (no delete)", () => {
    const r = run(["--nuke-everything"], GYM);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown argument");
    expect(deleteCalls()).toHaveLength(0);
  });

  it("preserves marketplace_listings (never in the DELETE set)", () => {
    run(["--yes"], { ...GYM, WIPE_CONFIRM: "gym" });
    expect(readFileSync(callLog, "utf8")).not.toContain("DELETE FROM marketplace_listings");
  });
});

describe("wipe-all-users SQL table list — in sync with migrations", () => {
  it("includes the tables added since the last audit (0055-0057)", () => {
    const sql = readFileSync(SQL, "utf8");
    for (const t of ["trust_exceptions", "service_invites", "service_invite_bindings"]) {
      expect(sql).toContain(`DELETE FROM ${t};`);
    }
  });

  it("includes the metering core's counters (0069) and batch ids (0070)", () => {
    expect(readFileSync(SQL, "utf8")).toContain("DELETE FROM meter_counters;");
    expect(readFileSync(SQL, "utf8")).toContain("DELETE FROM meter_batches;");
  });

  it("includes the server-share tables (0087, 0097)", () => {
    const sql = readFileSync(SQL, "utf8");
    for (const t of ["server_shares", "server_share_unlocks", "share_inbox", "server_share_push"]) {
      expect(sql).toContain(`DELETE FROM ${t};`);
    }
  });

  it("includes the server orders (0096)", () => {
    expect(readFileSync(SQL, "utf8")).toContain("DELETE FROM server_orders;");
  });

  it("wipes or explicitly preserves every table the migrations leave live", () => {
    const sql = readFileSync(SQL, "utf8");
    const deleted = new Set([...sql.matchAll(/^DELETE FROM ([a-z_]+);/gm)].map((m) => m[1]!));
    const preservedLine = sql.match(/^-- PRESERVED-TABLES: (.+)$/m);
    expect(preservedLine).not.toBeNull();
    const preserved = new Set(preservedLine![1]!.trim().split(/\s+/));
    const live = liveMigrationTables();
    expect(live.size).toBeGreaterThan(50);
    const unaccounted = [...live].filter((t) => !deleted.has(t) && !preserved.has(t)).sort();
    expect(unaccounted, "add each to the DELETE list or the PRESERVED-TABLES line").toEqual([]);
    const gone = [...deleted, ...preserved].filter((t) => !live.has(t)).sort();
    expect(gone, "these tables no longer exist on main's migrations").toEqual([]);
    for (const t of preserved) expect(deleted.has(t), t).toBe(false);
  });

  it("wipes the per-server health reports (0084)", () => {
    expect(readFileSync(SQL, "utf8")).toContain("DELETE FROM server_health;");
  });

  it("does NOT delete build_tickets (dropped in migration 0033)", () => {
    const sql = readFileSync(SQL, "utf8");
    expect(sql).not.toMatch(/DELETE FROM build_tickets;/);
  });

  it("does NOT delete the preserved catalog table", () => {
    const sql = readFileSync(SQL, "utf8");
    expect(sql).not.toMatch(/DELETE FROM marketplace_listings;/);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Guard tests for the prod-wipe runner (CLAUDE.md → "GA close-out TODO" item 1).
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

function deleteCalls(): string[] {
  let log = "";
  try {
    log = readFileSync(callLog, "utf8");
  } catch {
    return [];
  }
  return log.split("\n").filter((l) => l.includes("DELETE FROM"));
}

describe("wipe-all-users.sh — guards", () => {
  it("default (no args) is a dry run: previews, deletes NOTHING", () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("wipe preview");
    expect(r.stdout).toContain("DRY RUN");
    expect(deleteCalls()).toHaveLength(0);
  });

  it("the preview reports a row total from the counts", () => {
    const r = run([]);
    // Each table stub returns 7; total is reported.
    expect(r.stdout).toMatch(/would delete ~\d+ row\(s\)/);
    expect(r.stdout).toContain("row(s)");
  });

  it("--yes WITHOUT WIPE_CONFIRM refuses before any delete", () => {
    const r = run(["--yes"], { WIPE_CONFIRM: "", WIPE_ENV: "prod" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("REFUSING TO WIPE");
    expect(r.stderr).toContain("WIPE_CONFIRM must equal the target env");
    expect(deleteCalls()).toHaveLength(0);
  });

  it("--yes with a MISMATCHED WIPE_CONFIRM refuses (gym token, prod target)", () => {
    const r = run(["--yes"], { WIPE_CONFIRM: "gym", WIPE_ENV: "prod" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("REFUSING TO WIPE");
    expect(deleteCalls()).toHaveLength(0);
  });

  it("--yes with a MATCHING WIPE_CONFIRM proceeds to the delete loop + audits", () => {
    const r = run(["--yes"], { WIPE_CONFIRM: "prod", WIPE_ENV: "prod" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("AUDIT");
    expect(r.stdout).toContain("WIPE START");
    expect(r.stdout).toContain("WIPE DONE");
    // It actually issued DELETEs (one per table in the canonical .sql).
    const dels = deleteCalls();
    expect(dels.length).toBeGreaterThan(30);
  });

  it("the gym/dev path still works with its own env + token + D1", () => {
    const r = run(["--yes"], {
      WIPE_ENV: "gym",
      WIPE_CONFIRM: "gym",
      WIPE_D1: "flagship-state-gym",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("target env : gym");
    // The configured D1 binding is the one wrangler is invoked against.
    const log = readFileSync(callLog, "utf8");
    expect(log).toContain("flagship-state-gym");
    expect(deleteCalls().length).toBeGreaterThan(30);
  });

  it("HARD-GUARD: a non-prod env pointing at the PROD D1 refuses before anything", () => {
    // The gym/CI path must be structurally incapable of wiping flagship-state:
    // WIPE_ENV=gym with the default (prod) WIPE_D1 exits 1 before the preview.
    const r = run(["--yes"], { WIPE_ENV: "gym", WIPE_CONFIRM: "gym" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("PROD database");
    expect(deleteCalls()).toHaveLength(0);
    // Same refusal even for an explicit WIPE_D1=flagship-state.
    const r2 = run(["--yes"], { WIPE_ENV: "gym", WIPE_CONFIRM: "gym", WIPE_D1: "flagship-state" });
    expect(r2.code).toBe(1);
    expect(deleteCalls()).toHaveLength(0);
  });

  it("WIPE_WRANGLER_CONFIG threads --config into every wrangler call", () => {
    const r = run(["--yes"], {
      WIPE_ENV: "gym",
      WIPE_CONFIRM: "gym",
      WIPE_D1: "flagship-state-gym",
      WIPE_WRANGLER_CONFIG: "wrangler.gym.toml",
    });
    expect(r.code).toBe(0);
    const log = readFileSync(callLog, "utf8");
    expect(log).toContain("--config wrangler.gym.toml");
    // And the prod path (no override) stays config-free — behavior unchanged.
  });

  it("prod default carries NO --config flag (behavior unchanged)", () => {
    run(["--yes"], { WIPE_CONFIRM: "prod", WIPE_ENV: "prod", WIPE_WRANGLER_CONFIG: "" });
    const log = readFileSync(callLog, "utf8");
    expect(log).not.toContain("--config");
  });

  it("an unknown argument is rejected (no delete)", () => {
    const r = run(["--nuke-everything"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown argument");
    expect(deleteCalls()).toHaveLength(0);
  });

  it("preserves marketplace_listings (never in the DELETE set)", () => {
    run(["--yes"], { WIPE_CONFIRM: "prod" });
    const log = readFileSync(callLog, "utf8");
    expect(log).not.toContain("DELETE FROM marketplace_listings");
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

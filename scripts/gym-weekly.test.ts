import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Self-test for the weekly CI entry (scripts/gym-weekly.sh). Two layers:
//   1. The DRY-RUN walk (GYM_WEEKLY_DRY_RUN=1) — must pass in a CI-less env,
//      print every phase, and execute NOTHING external. A booby-trapped
//      flyctl/xcrun/adb stub on PATH proves "nothing external": if the script
//      ever calls one for real, the stub logs and the test fails.
//   2. Flag/guard behavior that must not regress (prod-DB refusal, unknown arg).

const SCRIPT = join(__dirname, "gym-weekly.sh");

let binDir = "";
let trapLog = "";

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "gym-weekly-stub-"));
  trapLog = join(binDir, "trap.log");
  // Booby-trap every external binary the script could touch. Any REAL
  // invocation in dry-run mode is a bug.
  for (const bin of ["flyctl", "xcrun", "adb", "curl"]) {
    const p = join(binDir, bin);
    writeFileSync(p, `#!/usr/bin/env bash\necho "${bin} $*" >> "${trapLog}"\nexit 0\n`);
    chmodSync(p, 0o755);
  }
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
    timeout: 60_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function trapped(): string {
  try {
    return readFileSync(trapLog, "utf8");
  } catch {
    return "";
  }
}

describe("gym-weekly.sh — dry-run self-test", () => {
  it("walks every phase and exits 0 without executing any external command", () => {
    const r = run([], { GYM_WEEKLY_DRY_RUN: "1" });
    expect(r.code).toBe(0);
    for (const marker of [
      "PHASE 0 — warm up the gym data plane",
      "PHASE 0b — wipe the gym DB",
      "PHASE 0c — simulators",
      "PHASE 1 — gym:total",
      "WEEKLY REPORT",
      "PHASE 2 — cleanup",
    ]) {
      expect(r.stdout).toContain(marker);
    }
    expect(r.stdout).toContain("DRY-RUN OK");
    // Nothing external ran — the booby-trapped stubs were never invoked.
    expect(trapped()).toBe("");
  });

  it("--dry-run flag is equivalent to the env var", () => {
    const r = run(["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("DRY-RUN OK");
    expect(trapped()).toBe("");
  });

  it("dry-run states that exit 3 (cloud skipped) fails weekly mode", () => {
    const r = run([], { GYM_WEEKLY_DRY_RUN: "1" });
    expect(r.stdout).toMatch(/exit 3 .*FAILURE/);
  });

  it("the enforcement phase appears in the dry-run plan and is described as gate-blocking", () => {
    const r = run([], { GYM_WEEKLY_DRY_RUN: "1" });
    expect(r.code).toBe(0);
    // Phase 4 — the live enforcement gates — must be named in the plan.
    expect(r.stdout).toContain("live ENFORCEMENT gates");
    // Its controls are enumerated so a reviewer sees WHAT is proven on the wire.
    expect(r.stdout).toContain("restricted-mode bypass");
    expect(r.stdout).toContain("admin gate");
    expect(r.stdout).toContain("revocation-reaches-box");
    // And the standing-gate lesson is stated: a skip is never a pass, and both a
    // bypass and a skip fail the weekly run.
    expect(r.stdout).toMatch(/SKIPPED one .*FAILS the weekly run|skipped security check is not green/i);
  });

  it("the wipe phase targets the GYM db through the guarded runner (one table list)", () => {
    const r = run([], { GYM_WEEKLY_DRY_RUN: "1" });
    expect(r.stdout).toContain("WIPE_ENV=gym");
    expect(r.stdout).toContain("WIPE_D1=flagship-state-gym");
    expect(r.stdout).toContain("wipe-all-users.sh --yes");
    // It must never invoke the runner in prod posture.
    expect(r.stdout).not.toContain("WIPE_ENV=prod");
  });

  it("REFUSES to run with GYM_WIPE_D1 pointed at the prod DB", () => {
    const r = run([], { GYM_WEEKLY_DRY_RUN: "1", GYM_WIPE_D1: "flagship-state" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("must never be the prod DB");
  });

  it("--skip-sims / --skip-wipe / --no-scale-down are honored", () => {
    const r = run(["--skip-sims", "--skip-wipe", "--no-scale-down"], { GYM_WEEKLY_DRY_RUN: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--skip-ios-sim");
    expect(r.stdout).toContain("--skip-avd");
    expect(r.stdout).toContain("--skip-wipe");
    expect(r.stdout).toContain("--no-scale-down: leaving");
    expect(r.stdout).not.toContain("scaling flagship-services-gym back to 0");
  });

  it("an unknown argument is rejected", () => {
    const r = run(["--frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown argument");
  });

  it("--help prints the doc header and exits 0", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("gym:weekly");
    expect(r.stdout).toContain("Phase 0");
  });
});

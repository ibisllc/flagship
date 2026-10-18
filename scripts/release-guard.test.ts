import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Self-test for the Bucket-C release guard (CLAUDE.md → "GA close-out TODO"
// item 4). The guard FAILS a RELEASE build while the burn-time-LUKS passphrase
// or the `debug:flagship` console-user backdoor is still present in source, and
// passes the normal dev/PR build (so dev/gym stay green WITH the constants).
//
// Two halves:
//   1. Against the REAL repo (today, backdoors present): dev path exits 0 +
//      reports; RELEASE=1 exits 1 + reports — and it does NOT flag the
//      stripDebugFeatures() machinery or the strip-assertion tests.
//   2. Against a synthetic CLEAN tree via RELEASE_GUARD_ROOT (the post-GA state,
//      backdoors removed): both dev and RELEASE=1 exit 0 — proving the gate
//      goes green once the owner disarms items 2+3.

const SCRIPT = join(__dirname, "release-guard.sh");

function run(
  env?: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("release-guard.sh — against the real repo (backdoors present in dev)", () => {
  it("dev build (RELEASE unset): reports the backdoors but exits 0", () => {
    const r = run({ RELEASE: "" });
    expect(r.code).toBe(0);
    // It found the live definition...
    expect(r.stderr).toContain("burn-time LUKS passphrase");
    // ...and explained that dev is expected to carry it. The debug console
    // user is NOT a finding anymore — grant-gated debug access ships in v1
    // (owner decision 2026-07-05) from debugAccessGate.ts, which is exempt.
    expect(r.stderr).not.toContain("debug console user");
    expect(r.stderr).toMatch(/dev\/PR build/);
  });

  it("RELEASE build (RELEASE=1): fails with an actionable error", () => {
    const r = run({ RELEASE: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("BURN_PASSPHRASE");
    expect(r.stderr).toMatch(/GA close-out TODO/);
  });

  it("RELEASE=true is also enforced (boolean form)", () => {
    const r = run({ RELEASE: "true" });
    expect(r.code).toBe(1);
  });

  it("flags exactly the load-bearing definitions, not the strip machinery, tests, or the sanctioned gate", () => {
    // The output lists each finding as a file:line. Descriptive mentions of the
    // `debug:flagship` marker, the *.test.* assertions, and the SANCTIONED
    // grant-gated home (debugAccessGate.ts — a shipping v1 feature since the
    // 2026-07-05 owner decision) must NOT appear — only the real
    // BURN_PASSPHRASE assignment (in src and the generated engine copies).
    const r = run({ RELEASE: "" });
    expect(r.stderr).not.toMatch(/\.test\.ts:/);
    expect(r.stderr).not.toMatch(/preseed\.test/);
    expect(r.stderr).not.toMatch(/EngineTests\.swift/);
    expect(r.stderr).not.toMatch(/debugAccessGate\.ts/);
    expect(r.stderr).not.toMatch(/chpasswd/);
    expect(r.stderr).not.toContain("debug password");
    expect(r.stderr).toMatch(/userdata\.ts:\d+:export const BURN_PASSPHRASE/);
  });
});

describe("release-guard.sh — against a clean tree (post-GA, backdoors removed)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function makeCleanTree(): string {
    const d = mkdtempSync(join(tmpdir(), "release-guard-clean-"));
    const builderSrc = join(d, "packages", "flagship-builder", "src");
    mkdirSync(builderSrc, { recursive: true });
    // A builder source file that has done the GA disarm: NO BURN_PASSPHRASE, NO
    // debug user. It may still carry the stripDebugFeatures defense + a
    // descriptive comment mentioning the marker, which must NOT trip the gate.
    writeFileSync(
      join(builderSrc, "userdata.ts"),
      [
        "// Production builder: the debug:flagship account is stripped; this comment",
        "// references the marker but is not the backdoor.",
        "export function stripDebugFeatures(s: string): string {",
        "  return s.replace(/echo 'debug:flagship'/, '');",
        "}",
        "export function buildBootstrapScript(): string {",
        '  return "set -euo pipefail\\nuseradd -m flagship\\n";',
        "}",
        "",
      ].join("\n"),
    );
    return d;
  }

  it("dev build on a clean tree: exits 0 and reports OK", () => {
    dir = makeCleanTree();
    const r = run({ RELEASE: "", RELEASE_GUARD_ROOT: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK");
  });

  it("RELEASE build on a clean tree: exits 0 (the gate is satisfied)", () => {
    dir = makeCleanTree();
    const r = run({ RELEASE: "1", RELEASE_GUARD_ROOT: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK");
  });

  it("a clean tree with a reintroduced backdoor fails RELEASE again", () => {
    dir = makeCleanTree();
    // Simulate a careless re-add of the passphrase constant.
    writeFileSync(
      join(dir, "packages", "flagship-builder", "src", "regression.ts"),
      'export const BURN_PASSPHRASE = "flagship-build-time-luks-rekey-me-immediately";\n',
    );
    const r = run({ RELEASE: "1", RELEASE_GUARD_ROOT: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("burn-time LUKS passphrase");
  });

  it("a debug user OUTSIDE the sanctioned gate still fails RELEASE (inline-bake regression)", () => {
    dir = makeCleanTree();
    writeFileSync(
      join(dir, "packages", "flagship-builder", "src", "inline-bake.ts"),
      "export const bake = `useradd -m -s /bin/bash debug`;\n",
    );
    const r = run({ RELEASE: "1", RELEASE_GUARD_ROOT: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("debug console user");
  });

  const KEY_ONLY_GATE = [
    'import { verifyDebugAccessGrant } from "@flagship/protocol";',
    "// handles flagship/debug-access/v2",
    'const SSHD = "Match User debug\\n  AuthenticationMethods publickey\\n  PasswordAuthentication no\\n";',
    'const line = (k: string) => `expiry-time="x" ${k}`;',
    'export async function open() { await run("useradd", ["-m", "debug"]); }',
    "",
  ].join("\n");

  function writeGate(d: string, body: string): void {
    const gateDir = join(d, "packages", "server-daemon", "src");
    mkdirSync(gateDir, { recursive: true });
    writeFileSync(join(gateDir, "debugAccessGate.ts"), body);
  }

  it("a key-only, grant-verified gate passes RELEASE (its useradd is exempt)", () => {
    dir = makeCleanTree();
    writeGate(dir, KEY_ONLY_GATE);
    const r = run({ RELEASE: "1", RELEASE_GUARD_ROOT: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK");
  });

  it("a debug password anywhere fails even a dev build, the gate included", () => {
    for (const bad of [
      'const DEBUG_PASSWORD = "anything";',
      "const x = `echo debug:pw | chpasswd`;",
      'const conf = "PasswordAuthentication yes";',
    ]) {
      dir = makeCleanTree();
      writeGate(dir, `${KEY_ONLY_GATE}${bad}\n`);
      const r = run({ RELEASE: "", RELEASE_GUARD_ROOT: dir });
      expect(r.code, bad).toBe(1);
      expect(r.stderr, bad).toContain("debug password");
      rmSync(dir, { recursive: true, force: true });
    }
    dir = "";
  });

  it("a gate that stops verifying, or stops being key-only, fails", () => {
    for (const drop of ["verifyDebugAccessGrant", "AuthenticationMethods publickey", "PasswordAuthentication no", "expiry-time="]) {
      dir = makeCleanTree();
      writeGate(dir, KEY_ONLY_GATE.split(drop).join("REMOVED"));
      const r = run({ RELEASE: "", RELEASE_GUARD_ROOT: dir });
      expect(r.code, drop).toBe(1);
      expect(r.stderr, drop).toContain("no longer key-only and grant-verified");
      rmSync(dir, { recursive: true, force: true });
    }
    dir = "";
  });

  it("the real prod-wipe runner passes; a copy that lost a guard or defaults to prod fails even a dev build", () => {
    const real = readFileSync(join(__dirname, "wipe-all-users.sh"), "utf8");
    dir = makeCleanTree();
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "wipe-all-users.sh"), real);
    const ok = run({ RELEASE: "", RELEASE_GUARD_ROOT: dir });
    expect(ok.code).toBe(0);
    expect(ok.stderr).not.toContain("prod-wipe guard removed");
    for (const broken of [
      real.split("stdin is not a terminal").join("x"),
      real.split("Type the database name").join("x"),
      real.split("WIPE_ENV and WIPE_D1 are both required").join("x"),
      real + '\ntarget_env="${WIPE_ENV:-prod}"\n',
    ]) {
      writeFileSync(join(dir, "scripts", "wipe-all-users.sh"), broken);
      const r = run({ RELEASE: "", RELEASE_GUARD_ROOT: dir });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("prod-wipe guard removed");
    }
  });

  it("the real repo's wipe runner raises no finding", () => {
    expect(run({ RELEASE: "" }).stderr).not.toContain("prod-wipe guard removed");
  });
});

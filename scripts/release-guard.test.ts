import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Self-test for the release guard (AGENTS.md -> GA close-out). It FAILS a RELEASE
// build while a dev-mode bring-up backdoor is present in source, and ALWAYS (dev
// too) fails on a debug password or on any regression of the LUKS install-time
// key handling: a constant passphrase, a disabled removal, or a missing
// single-slot proof (docs/luks-burn-passphrase-removal.md).
//
// Two halves:
//   1. Against the REAL repo: both the dev and the RELEASE=1 build are clean.
//   2. Against synthetic trees via RELEASE_GUARD_ROOT: every reintroduction
//      fails.

const SCRIPT = join(__dirname, "release-guard.sh");

function run(
  env?: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("release-guard.sh — against the real repo", () => {
  it("dev build (RELEASE unset): clean, exits 0", () => {
    const r = run({ RELEASE: "" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK");
    expect(r.stderr).not.toContain("LUKS");
  });

  it("RELEASE build (RELEASE=1): green, the burn-time LUKS passphrase is gone", () => {
    const r = run({ RELEASE: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK");
  });

  it("RELEASE=true is also enforced (boolean form) and green", () => {
    expect(run({ RELEASE: "true" }).code).toBe(0);
  });

  it("does not flag the strip machinery, tests, or the sanctioned debug gate", () => {
    const r = run({ RELEASE: "" });
    expect(r.stderr).not.toMatch(/\.test\.ts:/);
    expect(r.stderr).not.toMatch(/debugAccessGate\.ts/);
    expect(r.stderr).not.toMatch(/chpasswd/);
    expect(r.stderr).not.toContain("debug password");
    expect(r.stderr).not.toContain("debug console user");
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
    // A builder source file that has done the GA disarm: no passphrase constant,
    // no debug user. It may still carry the stripDebugFeatures defense + a
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

  it("in a git checkout it reads only files git knows: ignored folders (worktrees, build output) are never walked", () => {
    dir = makeCleanTree();
    const git = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(dir, ".gitignore"), "bulk/\n");
    const bad = 'export const BURN_PASSPHRASE = "flagship-build-time-luks-rekey-me-immediately";\n';
    mkdirSync(join(dir, "bulk"), { recursive: true });
    writeFileSync(join(dir, "bulk", "stale.ts"), bad);
    expect(run({ RELEASE: "", RELEASE_GUARD_ROOT: dir }).code).toBe(0);
    // A file that is not ignored is still found, tracked or not yet added.
    writeFileSync(join(dir, "packages", "flagship-builder", "src", "burn.ts"), bad);
    const r = run({ RELEASE: "", RELEASE_GUARD_ROOT: dir });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("burn.ts");
    expect(r.stderr).not.toContain("stale.ts");
  });

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

  it("a reintroduced install-time passphrase constant fails EVERY build, dev included", () => {
    for (const bad of [
      'export const BURN_PASSPHRASE = "something-public";\n',
      'export const X = "flagship-build-time-luks-rekey-me-immediately";\n',
      'const burnPassphrase = "anything"\n',
    ]) {
      dir = makeCleanTree();
      writeFileSync(join(dir, "packages", "flagship-builder", "src", "regression.ts"), bad);
      for (const release of ["", "1"]) {
        const r = run({ RELEASE: release, RELEASE_GUARD_ROOT: dir });
        expect(r.code, `${bad} release=${release}`).toBe(1);
        expect(r.stderr).toContain("install-time LUKS passphrase constant");
      }
      rmSync(dir, { recursive: true, force: true });
    }
    dir = "";
  });

  it("the appliance's published FACTORY key is not a finding", () => {
    dir = makeCleanTree();
    writeFileSync(
      join(dir, "packages", "flagship-builder", "src", "appliance.ts"),
      'export const APPLIANCE_FACTORY_KEY = "flagship-appliance-factory-key-public-replaced-on-first-boot";\n',
    );
    expect(run({ RELEASE: "1", RELEASE_GUARD_ROOT: dir }).code).toBe(0);
  });

  function writeBootstrap(d: string, body: string): void {
    writeFileSync(join(d, "packages", "flagship-builder", "src", "userdata.ts"), body);
  }
  const GOOD_BOOTSTRAP = [
    "const luks = `",
    'cryptsetup luksAddKey "$ROOT_LUKS_PART" "$LUKS_KEY" --key-file "$LUKS_BURN_KEYFILE"',
    'cryptsetup luksRemoveKey "$ROOT_LUKS_PART" --key-file "$LUKS_BURN_KEYFILE"',
    'flagship_assert_single_luks_slot "$ROOT_LUKS_PART" "$LUKS_BURN_KEYFILE" "$LUKS_KEY"',
    "`;",
    "",
  ].join("\n");

  it("a bootstrap that removes the key and proves one slot passes", () => {
    dir = makeCleanTree();
    writeBootstrap(dir, GOOD_BOOTSTRAP);
    const r = run({ RELEASE: "1", RELEASE_GUARD_ROOT: dir });
    expect(r.code).toBe(0);
  });

  it("a disabled removal (`if false; then`) fails every build", () => {
    dir = makeCleanTree();
    writeBootstrap(dir, `${GOOD_BOOTSTRAP}// if false; then\n`);
    for (const release of ["", "1"]) {
      const r = run({ RELEASE: release, RELEASE_GUARD_ROOT: dir });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("LUKS key removal disabled");
    }
  });

  it("adding a LUKS key without ever removing the old one fails every build", () => {
    dir = makeCleanTree();
    writeBootstrap(dir, GOOD_BOOTSTRAP.split("cryptsetup luksRemoveKey").join("cryptsetup luksNothing"));
    const r = run({ RELEASE: "", RELEASE_GUARD_ROOT: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("LUKS key removal missing");
  });

  it("a removal with no single-slot proof after it fails every build", () => {
    dir = makeCleanTree();
    const noProof = GOOD_BOOTSTRAP.split("flagship_assert_single_luks_slot").join("flagship_something_else");
    writeBootstrap(dir, noProof);
    const r = run({ RELEASE: "", RELEASE_GUARD_ROOT: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("LUKS single-slot proof missing");
    // The proof placed BEFORE the removal does not count either.
    const lines = GOOD_BOOTSTRAP.split("\n");
    const swapped = [lines[0], lines[1], lines[3], lines[2], ...lines.slice(4)].join("\n");
    writeBootstrap(dir, swapped);
    expect(run({ RELEASE: "", RELEASE_GUARD_ROOT: dir }).code).toBe(1);
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

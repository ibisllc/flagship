import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(__dirname, "private-name-storage-guard.sh");
let fixtureRoot = "";

function write(relativePath: string, content: string): void {
  const path = join(fixtureRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function makeCleanTree(): void {
  fixtureRoot = mkdtempSync(join(tmpdir(), "private-name-guard-"));
  write("packages/storage/src/types.ts", [
    "export interface PushTokenRecord { deviceId: string }",
    "export interface DemoUserRecord { username: string }",
    "export interface DeviceCapabilityGrantRecord { deviceId: string }",
    "export interface DeviceIdentityRecord { deviceId: string }",
  ].join("\n"));
  write("packages/storage/migrations/0083_private_account_device_directory.sql", [
    "CREATE TABLE push_tokens (",
    "  token_id TEXT PRIMARY KEY,",
    "  device_id TEXT NOT NULL",
    ");",
  ].join("\n"));
  write("packages/protocol/src/clean.ts", "export const clean = true;\n");
  write("packages/control-plane/src/clean.ts", "export const clean = true;\n");
  write("packages/server-daemon/src/clean.ts", "export const clean = true;\n");
  write("apps/com/src/clean.ts", "export const clean = true;\n");
  write("apps/web/public/webapp/clean.js", "export const clean = true;\n");
  write("apps/web/public/webapp/lib/profiles.js", "export const KEY = 'flagship.profiles.v1';\n");
}

function run(): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, PRIVATE_NAME_GUARD_ROOT: fixtureRoot },
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
});

describe("private-name-storage-guard", () => {
  it("passes the repository's clean target schema", () => {
    fixtureRoot = join(__dirname, "..");
    const result = run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("private-name-storage-guard: OK");
    fixtureRoot = "";
  });

  it("fails a future plaintext presentation-name migration", () => {
    makeCleanTree();
    write(
      "packages/storage/migrations/0084_regression.sql",
      "ALTER TABLE device_identities ADD COLUMN device_name TEXT;\n",
    );
    const result = run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("plaintext account/device presentation field detected");
  });

  it("fails a push-token label in the storage contract", () => {
    makeCleanTree();
    write("packages/storage/src/types.ts", [
      "export interface PushTokenRecord { deviceId: string; label?: string }",
      "export interface DemoUserRecord { username: string }",
      "export interface DeviceCapabilityGrantRecord { deviceId: string }",
      "export interface DeviceIdentityRecord { deviceId: string }",
    ].join("\n"));
    expect(run().code).toBe(1);
  });

  it("fails paired-session labels and public username-only device reads", () => {
    makeCleanTree();
    write("packages/server-daemon/src/regression.ts", "export const companionLabel = 'laptop';\n");
    write("packages/control-plane/src/regression.ts", "// GET /api/users/:username/devices\n");
    expect(run().code).toBe(1);
  });

  // Raw NUL / 0x1f / 0x7f bytes, written exactly as they occur in real
  // sources (regex bounds, NUL key separators) rather than pasted inline.
  const RAW_BOUNDS = `${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}`;
  it("reports the offending line in sources that embed raw control bytes", () => {
    // Real sources carry raw control bytes (regex character-class bounds, NUL
    // composite-key separators), which makes tools classify them as binary:
    // ripgrep SKIPS them outright, and grep hides the matching line behind
    // "Binary file ... matches". Either way the operator loses the location.
    // A webapp file exactly like this hid a v1 plaintext-label pairing order.
    makeCleanTree();
    write(
      "packages/protocol/src/regression.ts",
      `const bound = /[|${RAW_BOUNDS}]/;\nexport const deviceLabel = "laptop";\nexport { bound };\n`,
    );
    const result = run();
    expect(result.code).toBe(1);
    // The actual offending line must be printed, not "Binary file ... matches".
    expect(result.stdout).toContain("deviceLabel");
    expect(result.stdout).not.toContain("Binary file");
  });

  it("fails a plaintext presentation name cached in the browser profile store", () => {
    // The names are decrypted per render. Persisting one here would put it in
    // localStorage — readable without the account key, and outliving the
    // account. This regressed once already via a jsdoc @property line, so the
    // check matches the identifier anywhere in the file.
    makeCleanTree();
    write(
      "apps/web/public/webapp/lib/profiles.js",
      "/** @property {string|null} [accountDisplayName] */\nexport const KEY = 'x';\n",
    );
    expect(run().code).toBe(1);
  });

  it("fails when a scan target resolves to no files", () => {
    // A renamed or deleted directory must break the guard loudly rather than
    // quietly reducing coverage to nothing.
    fixtureRoot = mkdtempSync(join(tmpdir(), "private-name-guard-empty-"));
    const result = run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no files to scan for");
  });

  it("allows only the explicitly neutralized historical migrations", () => {
    makeCleanTree();
    write("packages/storage/migrations/0017_push_token_label.sql", "ALTER TABLE push_tokens ADD COLUMN label TEXT;\n");
    write("packages/storage/migrations/0027_demo_users.sql", "CREATE TABLE demo_users (display TEXT);\n");
    write("packages/storage/migrations/0031_device_capability_grants.sql", "CREATE TABLE old_grants (device_label TEXT);\n");
    write("packages/storage/migrations/0044_name_claims.sql", "CREATE TABLE name_claims (label TEXT);\n");
    expect(run().code).toBe(0);
  });
});

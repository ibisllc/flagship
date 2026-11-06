/**
 * A prebuilt appliance's first boot checks the recipe's commit against the release the factory
 * installed (/var/flagship/artifact-current.json). The 2026-11-05 appliances were generalized with
 * `rm -rf /var/flagship/*`, so every 0.3 "Host on this PC" failed with "appliance release  does not
 * match": the factory now keeps the record, and the bootstrap rebuilds it from the INSTALLED.json the
 * installer left beside the release (the published images still lack it).
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAppliancePrepareScript } from "../src/appliance.js";
import { buildBootstrapScript, DEFAULT_BOOT_HOST } from "../src/userdata.js";

const COMMIT = "52c67f8848eeb878cc9f63e84786b81f6933d19c";

function preinstalledBranch(root: string): string {
  const s = buildBootstrapScript({
    ref: COMMIT,
    repoUrl: "https://github.com/ibisllc/flagship.git",
    encryptRoot: true,
    bootUnlockMode: "auto",
    bootHost: DEFAULT_BOOT_HOST,
  });
  const a = s.indexOf("    [ -L /opt/flagship ]");
  const b = s.indexOf("reusing the prebuilt release");
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  return s
    .slice(a, s.indexOf("\n", b) + 1)
    .replaceAll("/opt/flagship", `${root}/opt/flagship`)
    .replaceAll("/var/flagship", `${root}/var/flagship`);
}

function fakeAppliance(installed: object | null): string {
  const root = mkdtempSync(join(tmpdir(), "appliance-record-"));
  const rel = join(root, "opt/flagship-releases", COMMIT);
  mkdirSync(join(rel, "app/node_modules/@flagship/protocol"), { recursive: true });
  writeFileSync(join(rel, "app/node_modules/@flagship/protocol/package.json"), "{}");
  if (installed) writeFileSync(join(rel, "INSTALLED.json"), JSON.stringify(installed));
  mkdirSync(join(root, "var/flagship"), { recursive: true });
  symlinkSync(join(rel, "app"), join(root, "opt/flagship"));
  return root;
}

function run(root: string): { ok: boolean; out: string } {
  const script = `GIT_REF=${COMMIT}\n${preinstalledBranch(root)}`;
  try {
    return { ok: true, out: execFileSync("bash", ["-c", script], { encoding: "utf8" }) };
  } catch (e) {
    return { ok: false, out: String((e as { stdout?: string }).stdout ?? "") };
  }
}

describe("appliance release record", () => {
  it("rebuilds a wiped record from INSTALLED.json and passes the commit check", () => {
    const root = fakeAppliance({ commit: COMMIT, arch: "amd64", sequence: 2, artifactSha256: "ab" });
    const r = run(root);
    expect(r.out).toContain(`reusing the prebuilt release commit=${COMMIT}`);
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "var/flagship/artifact-current.json"), "utf8")).commit).toBe(COMMIT);
    expect(readFileSync(join(root, "var/flagship/artifact-sequence"), "utf8").trim()).toBe("2");
  });

  it("does not invent a record whose commit differs from the release directory", () => {
    const root = fakeAppliance({ commit: "b".repeat(40), arch: "amd64", sequence: 2 });
    const r = run(root);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("FATAL: appliance release  does not match");
  });

  it("the factory's generalize step keeps the record", () => {
    const script = buildAppliancePrepareScript({ gitRef: "main", gitCommit: COMMIT });
    expect(script).not.toContain("rm -rf /var/flagship/*");
    expect(script).toContain("! -name artifact-current.json ! -name artifact-sequence");
  });
});

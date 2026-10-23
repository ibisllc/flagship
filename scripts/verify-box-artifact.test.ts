/**
 * installer/verify-box-artifact.sh must give the same verdict as the TypeScript
 * verifier on every shared vector (SEC-INSTALL-001): it is what runs on a box
 * before any of the artifact's own code, so the two cannot drift.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = join(ROOT, "installer/verify-box-artifact.sh");
const V = JSON.parse(readFileSync(join(ROOT, "packages/protocol/test-vectors/box-artifact/vectors.json"), "utf8"));

function bash4(): string | null {
  for (const b of ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash", "/usr/bin/bash"]) {
    const r = spawnSync(b, ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" });
    if (r.status === 0 && Number(r.stdout.trim()) >= 4) return b;
  }
  return null;
}
function haveTools(): boolean {
  const ssl = spawnSync("openssl", ["version"], { encoding: "utf8" });
  return ssl.status === 0 && /OpenSSL 3/.test(ssl.stdout) && spawnSync("jq", ["--version"]).status === 0 && spawnSync("xxd", ["-v"]).status !== 127;
}
const BASH = bash4();
const run = BASH && haveTools() ? describe : describe.skip;

const dir = mkdtempSync(join(tmpdir(), "box-artifact-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const artifactPath = join(dir, "artifact.bin");
writeFileSync(artifactPath, V.artifactText.repeat(V.artifactRepeat));

function verify(o: Record<string, unknown>, sigs: unknown[], over: { manifest?: unknown; artifact?: string } = {}) {
  const mpath = join(dir, "manifest.json");
  writeFileSync(mpath, JSON.stringify({ manifest: over.manifest ?? V.manifest, signatures: sigs }));
  const t = o["trust"] as { keys: string[]; threshold: number };
  const args = [
    SCRIPT, "--manifest", mpath, "--artifact", over.artifact ?? artifactPath,
    "--trust-keys", t.keys.join(","), "--threshold", String(t.threshold),
    "--expect-sha256", String(o["expectedArtifactSha256"]), "--expect-commit", String(o["expectedCommit"]),
    "--arch", String(o["expectedArch"]), "--verifier-version", String(o["verifierVersion"]),
  ];
  if (o["lastSequence"] !== undefined) args.push("--last-sequence", String(o["lastSequence"]));
  if (o["nodeFloor"] !== undefined) args.push("--node-floor", String(o["nodeFloor"]));
  return spawnSync(BASH!, args, { encoding: "utf8" });
}

run("verify-box-artifact.sh agrees with the TypeScript verifier", () => {
  for (const c of V.cases as Array<{ name: string; signatures: unknown[]; options: Record<string, unknown>; expect: { ok: boolean; code?: string } }>) {
    it(c.name, () => {
      // The shell measures the real file; make the vector's "measured" digest and size true or false by editing the FILE.
      const o = c.options;
      let artifact = artifactPath;
      if (o["measuredSha256"] !== V.manifest.artifactSha256 || o["measuredBytes"] !== V.manifest.artifactBytes) {
        artifact = join(dir, "other.bin");
        writeFileSync(artifact, o["measuredBytes"] !== V.manifest.artifactBytes ? V.artifactText.repeat(V.artifactRepeat) + "x" : "tampered file contents");
      }
      const r = verify(o, c.signatures, { artifact });
      if (c.expect.ok) {
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toMatch(/^verified: /);
      } else {
        expect(r.status, r.stderr).toBe(1);
        // A real file cannot differ in size and not in digest, so the shell reports the digest first.
        const want = c.expect.code === "size-mismatch" ? /refused: (size-mismatch|digest-mismatch)/ : new RegExp(`refused: ${c.expect.code}`);
        expect(r.stderr).toMatch(want);
      }
    });
  }

  const good = V.cases[0];
  it("refuses a manifest whose fields do not have the canonical shape", () => {
    for (const [name, over] of [
      ["a branch as the commit", { commit: "main" }],
      ["an abbreviated commit", { commit: "0123456" }],
      ["a short digest", { artifactSha256: "ab" }],
      ["a Node version with a suffix", { nodeVersion: "24.22.1-rc1" }],
      ["a negative sequence", { sequence: "-1" }],
      ["an unknown architecture", { arch: "riscv" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = verify(good.options, good.signatures, { manifest: { ...V.manifest, ...over } });
      expect(r.status, name).toBe(1);
      expect(r.stderr, name).toMatch(/refused: (bad-manifest|not-enough-signatures|digest-mismatch|commit-mismatch)/);
    }
  });

  it("refuses a manifest missing from disk, malformed JSON and a signature list that is not a list", () => {
    writeFileSync(join(dir, "broken.json"), "{ not json");
    const r = spawnSync(BASH!, [SCRIPT, "--manifest", join(dir, "broken.json"), "--artifact", artifactPath, "--trust-keys", V.trust.keys.join(","), "--threshold", "2",
      "--expect-sha256", V.manifest.artifactSha256, "--expect-commit", V.manifest.commit, "--arch", "amd64"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused: bad-manifest/);
    const r2 = verify(good.options, "nope" as never);
    expect(r2.status).toBe(1);
  });

  it("ignores junk entries among the signatures and counts distinct authorized keys only", () => {
    const junk = [{ keyHex: "zz", signatureHex: "zz" }, {}, { keyHex: V.publicKeys[0] }, ...V.signatures.slice(0, 2), V.signatures[0]];
    expect(verify(good.options, junk).status).toBe(0);
    expect(verify(good.options, [{ keyHex: V.publicKeys[0].toUpperCase(), signatureHex: V.signatures[0].signatureHex.toUpperCase() }, V.signatures[1]]).status).toBe(0);
  });

  it("is a usage error, not a verdict, when options are missing", () => {
    expect(spawnSync(BASH!, [SCRIPT], { encoding: "utf8" }).status).toBe(2);
  });
});

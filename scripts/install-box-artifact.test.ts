/**
 * installer/install-box-artifact.sh (SEC-INSTALL-001): verifies first, unpacks
 * beside the running release, flips one symlink, and refuses everything else
 * without changing a thing.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ed } from "../packages/protocol/src/edSync.js";
import { signBoxArtifact, type BoxArtifactManifest } from "../packages/protocol/src/boxArtifact.js";
import { assembleArtifact, type BuildInfo } from "../tools/box-artifact/assemble.js";

const ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = join(ROOT, "installer/install-box-artifact.sh");

function bash4(): string | null {
  for (const b of ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash", "/usr/bin/bash"]) {
    const r = spawnSync(b, ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" });
    if (r.status === 0 && Number(r.stdout.trim()) >= 4) return b;
  }
  return null;
}
const BASH = bash4();
const ssl = spawnSync("openssl", ["version"], { encoding: "utf8" });
const ok = BASH && ssl.status === 0 && /OpenSSL 3/.test(ssl.stdout) && spawnSync("jq", ["--version"]).status === 0;
const run = ok ? describe : describe.skip;

const base = mkdtempSync(join(tmpdir(), "install-box-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const seed = new Uint8Array(32).fill(0x31);
const pub = Buffer.from(ed.getPublicKey(seed)).toString("hex");
const COMMIT = "89abcdef0123456789abcdef0123456789abcdef";

function fixtureArtifact(name: string, commit = COMMIT, extra: Record<string, string> = {}) {
  const dir = join(base, name);
  const app = join(dir, "app");
  const files: Record<string, string> = {
    "package.json": "{}", "package-lock.json": "{}", "scripts/install-helper.ts": "export {}\n",
    "node_modules/tsx/dist/cli.mjs": "// tsx\n", ...extra,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(app, rel, ".."), { recursive: true });
    writeFileSync(join(app, rel), body);
  }
  const node = join(dir, "node");
  writeFileSync(node, "#!/bin/sh\necho node\n");
  chmodSync(node, 0o755);
  const unseal = join(dir, "flagship-unseal");
  writeFileSync(unseal, "#!/bin/sh\necho unseal\n");
  chmodSync(unseal, 0o755);
  const info: BuildInfo = { schema: 1, commit, arch: "arm64", nodeVersion: "24.22.1", nodeSha256: "a".repeat(64), lockSha256: "b".repeat(64), sourceDateEpoch: 1760000000 };
  const art = assembleArtifact({ appDir: app, nodeBinary: node, unsealBinary: unseal, info });
  const artifactPath = join(dir, "a.tar.gz");
  writeFileSync(artifactPath, art.tarGz);
  const manifest: BoxArtifactManifest = {
    commit, arch: "arm64", artifactSha256: art.sha256, artifactBytes: art.bytes, nodeVersion: "24.22.1", nodeSha256: "a".repeat(64),
    lockSha256: "b".repeat(64), sbomSha256: "c".repeat(64), provenanceSha256: "d".repeat(64), minVerifier: 1, sequence: 5, issuedAt: 1760000000000,
  };
  const manifestPath = join(dir, "m.json");
  writeFileSync(manifestPath, JSON.stringify({ manifest, signatures: [signBoxArtifact(manifest, seed)] }));
  return { artifactPath, manifestPath, manifest, sha: art.sha256 };
}

function sandbox(name: string) {
  const d = join(base, name);
  const t = { releases: join(d, "releases"), current: join(d, "flagship"), state: join(d, "state"), bin: join(d, "bin") };
  mkdirSync(d, { recursive: true });
  return t;
}

function install(f: ReturnType<typeof fixtureArtifact>, t: ReturnType<typeof sandbox>, over: Partial<Record<string, string>> = {}) {
  return spawnSync(BASH!, [
    ...(over["minSequence"] ? [] : []),
    SCRIPT, "--manifest", f.manifestPath, "--artifact", f.artifactPath, "--trust-keys", over["trust"] ?? pub, "--threshold", "1",
    "--expect-sha256", over["sha"] ?? f.sha, "--expect-commit", over["commit"] ?? f.manifest.commit, "--arch", over["arch"] ?? "arm64",
    "--node-floor", over["floor"] ?? "24.22.1", "--releases", t.releases, "--current", t.current, "--state", t.state, "--bin", t.bin,
    ...(over["minSequence"] ? ["--min-sequence", over["minSequence"]] : []),
  ], { encoding: "utf8" });
}

run("install-box-artifact.sh", () => {
  it("installs a verified artifact: release dir, one atomic symlink, node and tsx wrappers, the sequence", () => {
    const f = fixtureArtifact("ok");
    const t = sandbox("ok-sbx");
    const r = install(f, t);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`installed: ${COMMIT} arm64 sequence 5`);
    expect(readlinkSync(t.current)).toBe(join(t.releases, COMMIT, "app"));
    expect(readFileSync(join(t.current, "installer/flagship-unseal"), "utf8")).toContain("#!/bin/sh");
    expect(readlinkSync(join(t.bin, "node"))).toBe(join(t.current, ".runtime/node/bin/node"));
    expect(lstatSync(join(t.bin, "flagship-tsx")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(t.bin, "flagship-tsx"), "utf8")).toContain("node_modules/tsx/dist/cli.mjs");
    expect(readFileSync(join(t.state, "artifact-sequence"), "utf8").trim()).toBe("5");
    expect(JSON.parse(readFileSync(join(t.state, "artifact-current.json"), "utf8"))).toMatchObject({ commit: COMMIT, sequence: 5 });
    // no half-unpacked directory is left behind
    expect(readdirSync(t.releases).filter((n) => n.startsWith(".incoming"))).toEqual([]);
  });

  it("a second install at the same sequence is refused as a rollback and changes nothing", () => {
    const f = fixtureArtifact("again");
    const t = sandbox("again-sbx");
    expect(install(f, t).status).toBe(0);
    // same sequence is a rollback to the verifier: the second run is refused, nothing changes
    const second = install(f, t);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("refused: rollback");
    expect(readlinkSync(t.current)).toBe(join(t.releases, COMMIT, "app"));
  });

  it("changes nothing when the artifact is tampered with, signed by the wrong key, or for another commit/arch/digest", () => {
    const f = fixtureArtifact("bad");
    for (const [name, over] of [
      ["another key", { trust: "9".repeat(64) }],
      ["another commit", { commit: "f".repeat(40) }],
      ["another arch", { arch: "amd64" }],
      ["another digest", { sha: "e".repeat(64) }],
      ["a Node floor above the artifact's", { floor: "24.99.0" }],
    ] as Array<[string, Record<string, string>]>) {
      const t = sandbox(`bad-${name.replace(/\W/g, "")}`);
      const r = install(f, t, over);
      expect(r.status, `${name}: ${r.stderr}`).toBe(1);
      expect(existsSync(t.current), name).toBe(false);
      expect(existsSync(t.releases) ? readdirSync(t.releases) : [], name).toEqual([]);
    }
    const t = sandbox("bad-tamper");
    writeFileSync(f.artifactPath, Buffer.concat([readFileSync(f.artifactPath), Buffer.from("x")]));
    expect(install(f, t).status).toBe(1);
    expect(existsSync(t.current)).toBe(false);
  });

  it("a fresh box refuses a release below the sequence its installer was built for", () => {
    const f = fixtureArtifact("minseq");
    const low = sandbox("minseq-low");
    const r = install(f, low, { minSequence: "6" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refused: rollback");
    expect(existsSync(low.current)).toBe(false);
    const ok = sandbox("minseq-ok");
    expect(install(f, ok, { minSequence: "5" }).status).toBe(0);
  });

  it("refuses to take over a real directory (a legacy git install) rather than delete it", () => {
    const f = fixtureArtifact("legacy");
    const t = sandbox("legacy-sbx");
    mkdirSync(t.current);
    writeFileSync(join(t.current, "precious"), "keep\n");
    const r = install(f, t);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("legacy install");
    expect(readFileSync(join(t.current, "precious"), "utf8")).toBe("keep\n");
  });

  it("flips from a previous release and remembers it for rollback", () => {
    const f1 = fixtureArtifact("flip1", "1".repeat(40));
    const t = sandbox("flip-sbx");
    expect(install(f1, t).status).toBe(0);
    const f2 = fixtureArtifact("flip2", "2".repeat(40));
    f2.manifest.sequence = 6;
    // re-sign the bumped manifest
    writeFileSync(f2.manifestPath, JSON.stringify({ manifest: f2.manifest, signatures: [signBoxArtifact(f2.manifest, seed)] }));
    const r = install(f2, t);
    expect(r.status, r.stderr).toBe(0);
    expect(readlinkSync(t.current)).toBe(join(t.releases, "2".repeat(40), "app"));
    expect(readFileSync(join(t.state, "artifact-previous"), "utf8").trim()).toBe(join(t.releases, "1".repeat(40), "app"));
    expect(existsSync(join(t.releases, "1".repeat(40), "app/package.json"))).toBe(true);
  });
});

void symlinkSync;

/**
 * The box artifact builder (SEC-REL-001): the same inputs give the same bytes on
 * any builder, the archive unpacks with plain tar, and it never carries a path or
 * link that points off the box.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync, chmodSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { ed } from "../../../packages/protocol/src/edSync.js";
import { assembleArtifact, skipInApp, type BuildInfo } from "../assemble.js";
import { archiveDigestFromShasums, assertNodeMeetsFloor, assertTargetBinaries, loadNodePins } from "../build.js";
import { buildSbom, componentsWithoutIntegrity } from "../sbom.js";
import { buildTar, checkArchivePath, gzipDeterministic } from "../tar.js";

const root = mkdtempSync(join(tmpdir(), "box-artifact-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const INFO: BuildInfo = {
  schema: 1, commit: "0123456789abcdef0123456789abcdef01234567", arch: "amd64", nodeVersion: "24.22.1",
  nodeSha256: "a".repeat(64), lockSha256: "b".repeat(64), sourceDateEpoch: 1760000000,
};

function workspace(name: string, opts: { reverse?: boolean; mtime?: number } = {}): { app: string; node: string } {
  const app = join(root, name, "app");
  const files: Array<[string, string, number?]> = [
    ["package.json", '{"name":"flagship"}'],
    ["package-lock.json", "{}"],
    ["installer/unseal-helper", "#!/bin/sh\n", 0o755],
    ["scripts/install-helper.ts", "export {}\n"],
    ["scripts/install-helper.test.ts", "tests stay out\n"],
    ["packages/server-daemon/package.json", "{}"],
    ["packages/server-daemon/src/index.ts", "export const x = 1\n"],
    ["packages/server-daemon/dist/index.js", "export const x = 1\n"],
    ["packages/server-daemon/dist/index.tsbuildinfo", "cache\n"],
    ["packages/server-daemon/tests/a.test.ts", "tests stay out\n"],
    ["packages/protocol/test-vectors/v.json", "{}"],
    ["node_modules/left-pad/index.js", "module.exports = 1\n"],
    ["node_modules/left-pad/test/x.js", "dependency test dirs stay\n"],
    ["docs/readme.md", "not shipped\n"],
    ["apps/mobile/x", "not shipped\n"],
    [".git/config", "never\n"],
    [".maintainers/README.md", "keys\n"],
    ["release/security-floor.json", "{}"],
    ["very/" , ""],
  ];
  const long = "node_modules/" + "deeply-nested-package-name/".repeat(5) + "lib/index.js";
  files.push([long, "long path\n"]);
  for (const [rel, body, mode] of opts.reverse ? [...files].reverse() : files) {
    if (rel.endsWith("/")) continue;
    const p = join(app, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
    if (mode) chmodSync(p, mode);
    if (opts.mtime) utimesSync(p, opts.mtime, opts.mtime);
  }
  mkdirSync(join(app, "node_modules/@flagship"), { recursive: true });
  symlinkSync("../../packages/server-daemon", join(app, "node_modules/@flagship/server-daemon"));
  const node = join(root, name, "node");
  writeFileSync(node, "#!/bin/sh\necho fake node\n");
  chmodSync(node, 0o755);
  return { app, node };
}

describe("deterministic tar", () => {
  it("the same inputs give the same digest however the files were created and stamped", () => {
    const a = workspace("a", { mtime: 1_000_000_000 });
    const b = workspace("b", { reverse: true, mtime: 1_700_000_000 });
    const x = assembleArtifact({ appDir: a.app, nodeBinary: a.node, info: INFO });
    const y = assembleArtifact({ appDir: b.app, nodeBinary: b.node, info: INFO });
    expect(x.sha256).toBe(y.sha256);
    expect(Buffer.compare(x.tarGz, y.tarGz)).toBe(0);
    const z = assembleArtifact({ appDir: a.app, nodeBinary: a.node, info: { ...INFO, commit: "f".repeat(40) } });
    expect(z.sha256).not.toBe(x.sha256);
  });

  it("gzip does not depend on the platform's zlib OS byte", () => {
    const z = gzipDeterministic(buildTar([{ kind: "file", path: "a", data: new Uint8Array([1]), executable: false }], 0));
    expect([...z.subarray(4, 10)]).toEqual([0, 0, 0, 0, 2, 3]);
  });

  it("unpacks with plain tar, keeps modes and links, and leaves out what a box never reads", () => {
    const w = workspace("unpack");
    const art = assembleArtifact({ appDir: w.app, nodeBinary: w.node, info: INFO });
    const out = join(root, "unpacked");
    mkdirSync(out);
    const tgz = join(root, "x.tar.gz");
    writeFileSync(tgz, art.tarGz);
    execFileSync("tar", ["-xzf", tgz, "-C", out, "--strip-components=1"]);
    const app = join(out, "app");
    expect(readFileSync(join(app, "packages/server-daemon/src/index.ts"), "utf8")).toBe("export const x = 1\n");
    expect(lstatSync(join(app, "installer/unseal-helper")).mode & 0o111).not.toBe(0);
    expect(lstatSync(join(app, "package.json")).mode & 0o111).toBe(0);
    expect(readlinkSync(join(app, "node_modules/@flagship/server-daemon"))).toBe("../../packages/server-daemon");
    expect(readFileSync(join(app, "node_modules", "deeply-nested-package-name/".repeat(5) + "lib/index.js"), "utf8")).toBe("long path\n");
    expect(readFileSync(join(app, ".runtime/node/bin/node"), "utf8")).toContain("fake node");
    expect(JSON.parse(readFileSync(join(out, "BUILD-INFO.json"), "utf8"))).toMatchObject({ commit: INFO.commit, nodeVersion: "24.22.1" });
    for (const gone of ["docs", "apps", ".git", "scripts/install-helper.test.ts", "packages/server-daemon/tests", "packages/protocol/test-vectors", "packages/server-daemon/dist/index.tsbuildinfo"]) {
      expect(existsSync(join(app, gone)), gone).toBe(false);
    }
    // a dependency's own test folder is kept: some packages need it at run time
    expect(existsSync(join(app, "node_modules/left-pad/test/x.js"))).toBe(true);
    // owners are root and every entry carries the commit's time
    const listing = execFileSync("tar", ["-tvzf", tgz], { encoding: "utf8" });
    expect(listing).toMatch(/root\s+root/);
    expect(listing).not.toMatch(/\b2026\b/);
    expect(gunzipSync(art.tarGz).length % 512).toBe(0);
  });

  it("refuses a symlink that points off the tree and an unsafe path", () => {
    const w = workspace("bad");
    symlinkSync("/etc/passwd", join(w.app, "node_modules/escape"));
    expect(() => assembleArtifact({ appDir: w.app, nodeBinary: w.node, info: INFO })).toThrow(/outside the tree/);
    const w2 = workspace("bad2");
    symlinkSync("../../../../outside", join(w2.app, "node_modules/climb"));
    expect(() => assembleArtifact({ appDir: w2.app, nodeBinary: w2.node, info: INFO })).toThrow(/outside the tree/);
    for (const p of ["/abs", "a/../b", "a//b", "a\\b", "", "a/./b", "a\0b"]) expect(() => checkArchivePath(p), JSON.stringify(p)).toThrow();
    expect(() => buildTar([{ kind: "dir", path: "a" }, { kind: "dir", path: "a" }], 0)).toThrow(/duplicate/);
  });

  it("skips tests and caches only where they are ours", () => {
    expect(skipInApp("packages/server-daemon/tests/x.ts")).toBe(true);
    expect(skipInApp("packages/protocol/test-vectors/x.json")).toBe(true);
    expect(skipInApp("packages/server-daemon/src/a.test.ts")).toBe(true);
    expect(skipInApp("node_modules/x/test/a.js")).toBe(false);
    expect(skipInApp("node_modules/.cache/z")).toBe(true);
    expect(skipInApp("packages/a/dist/index.js")).toBe(false);
  });
});

describe("sbom", () => {
  const lock = JSON.stringify({
    packages: {
      "": { name: "root" },
      "node_modules/b": { version: "1.0.0", integrity: "sha512-b", resolved: "https://r/b.tgz" },
      "node_modules/a": { version: "2.0.0", integrity: "sha512-a", resolved: "https://r/a.tgz" },
      "node_modules/@flagship/x": { link: true },
      "packages/x/node_modules/c": { version: "3.0.0" },
      "apps/boot": { version: "0.0.1" },
    },
  });
  it("lists every installed package in a stable order and flags a missing integrity hash", () => {
    const s = buildSbom(lock);
    expect(s.components.map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(s.lockSha256).toBe(sha(lock));
    expect(componentsWithoutIntegrity(s)).toEqual(["c@3.0.0"]);
    expect(JSON.stringify(buildSbom(lock))).toBe(JSON.stringify(s));
  });
});

describe("the pinned Node", () => {
  it("is at or above the security floor and pinned by SHA-256 for both architectures", () => {
    const pins = loadNodePins();
    expect(() => assertNodeMeetsFloor(pins.node.version)).not.toThrow();
    expect(() => assertNodeMeetsFloor("20.19.5")).toThrow(/below the security floor/);
    for (const arch of ["amd64", "arm64"] as const) {
      expect(pins.node.archives[arch].sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pins.node.archives[arch].file).toContain(`v${pins.node.version}-linux-`);
    }
    expect(pins.node.downloadBase).toMatch(/^https:\/\/nodejs\.org\/dist\/v/);
    expect(pins.node.releaseSigningKeys.fingerprints.every((f) => /^[0-9A-F]{40}$/.test(f))).toBe(true);
  });

  it("reads a file's digest from SHASUMS256.txt and refuses a missing file", () => {
    const txt = `${"a".repeat(64)}  node-v1-linux-x64.tar.xz\n${"b".repeat(64)}  node-v1-linux-arm64.tar.xz\n`;
    expect(archiveDigestFromShasums(txt, "node-v1-linux-arm64.tar.xz")).toBe("b".repeat(64));
    expect(() => archiveDigestFromShasums(txt, "node-v1-win.zip")).toThrow();
  });
});

describe("sign and verify from the command line", () => {
  it("round-trips, and refuses a manifest signed by a key that is not in the trust file", () => {
    const w = workspace("cli");
    const art = assembleArtifact({ appDir: w.app, nodeBinary: w.node, info: INFO });
    const dir = join(root, "cli-out");
    mkdirSync(dir);
    const artifactPath = join(dir, "a.tar.gz");
    writeFileSync(artifactPath, art.tarGz);
    const manifest = {
      commit: INFO.commit, arch: "amd64", artifactSha256: art.sha256, artifactBytes: art.bytes, nodeVersion: "24.22.1",
      nodeSha256: INFO.nodeSha256, lockSha256: INFO.lockSha256, sbomSha256: "c".repeat(64), provenanceSha256: "d".repeat(64),
      minVerifier: 1, sequence: 3, issuedAt: 1760000000000,
    };
    writeFileSync(join(dir, "m.json"), JSON.stringify({ manifest, signatures: [] }));
    const seed = new Uint8Array(32).fill(0x55);
    writeFileSync(join(dir, "key.hex"), Buffer.from(seed).toString("hex"));
    const pub = Buffer.from(ed.getPublicKey(seed)).toString("hex");
    writeFileSync(join(dir, "trust.json"), JSON.stringify({ keys: [pub], threshold: 1 }));
    writeFileSync(join(dir, "other-trust.json"), JSON.stringify({ keys: ["1".repeat(64)], threshold: 1 }));
    const here = new URL(".", import.meta.url).pathname;
    const tool = join(here, "../build.ts");
    const run = (...a: string[]) => spawnSync("npx", ["tsx", tool, ...a], { encoding: "utf8", cwd: join(here, "../../..") });
    const signed = run("sign", "--manifest", join(dir, "m.json"), "--out", join(dir, "signed.json"), "--key-file", join(dir, "key.hex"));
    expect(signed.status, signed.stderr).toBe(0);
    const ok = run("verify", "--manifest", join(dir, "signed.json"), "--artifact", artifactPath, "--commit", INFO.commit, "--arch", "amd64", "--trust", join(dir, "trust.json"));
    expect(ok.status, ok.stderr).toBe(0);
    const wrongTrust = run("verify", "--manifest", join(dir, "signed.json"), "--artifact", artifactPath, "--commit", INFO.commit, "--arch", "amd64", "--trust", join(dir, "other-trust.json"));
    expect(wrongTrust.status).toBe(1);
    expect(wrongTrust.stderr).toContain("not-enough-signatures");
    const rollback = run("verify", "--manifest", join(dir, "signed.json"), "--artifact", artifactPath, "--commit", INFO.commit, "--arch", "amd64", "--trust", join(dir, "trust.json"), "--last-sequence", "3");
    expect(rollback.status).toBe(1);
    expect(rollback.stderr).toContain("rollback");
    writeFileSync(artifactPath, Buffer.concat([art.tarGz, Buffer.from("x")]));
    const tampered = run("verify", "--manifest", join(dir, "signed.json"), "--artifact", artifactPath, "--commit", INFO.commit, "--arch", "amd64", "--trust", join(dir, "trust.json"));
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toMatch(/digest-mismatch|size-mismatch/);
    const branch = run("build", "--commit", "main", "--arch", "amd64", "--out", join(dir, "o"));
    expect(branch.status).toBe(1);
    expect(branch.stderr).toContain("never a branch");
  });
});

describe("the box's platform binaries", () => {
  const tree = (...dirs: string[]) => {
    const nm = mkdtempSync(join(root, "nm-"));
    for (const d of dirs) mkdirSync(join(nm, "@esbuild", d), { recursive: true });
    return nm;
  };
  it("accepts exactly the target's esbuild and refuses a build made for the builder's own platform", () => {
    expect(() => assertTargetBinaries(tree("linux-x64"), "x64")).not.toThrow();
    expect(() => assertTargetBinaries(tree("darwin-arm64"), "x64")).toThrow(/lacks @esbuild\/linux-x64/);
    expect(() => assertTargetBinaries(tree("linux-x64", "darwin-arm64"), "x64")).toThrow(/other platforms/);
    expect(() => assertTargetBinaries(tree("linux-x64"), "arm64")).toThrow(/lacks @esbuild\/linux-arm64/);
  });
});

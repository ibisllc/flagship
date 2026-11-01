/**
 * Release plan G9: the SBOM and provenance published beside every box artifact, the reproducibility
 * comparison, the endorsed-digest check for owner builds, and the pins a reproducible build depends on.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ed } from "../../../packages/protocol/src/edSync.js";
import { canonicalBoxArtifact, type BoxArtifactManifest } from "../../../packages/protocol/src/boxArtifact.js";
import { assembleArtifact, type BuildInfo } from "../assemble.js";
import { assertCompilerPinned } from "../build.js";
import { checkAgainstEndorsed, compareArtifacts, readTar, summarizeDifferences } from "../compare.js";
import { OWNER_LOCAL_BUILDER, buildProvenance, builderId } from "../provenance.js";
import { buildSbom, componentsWithoutIntegrity, integrityHashes, parseCargoLock, parseGoSum } from "../sbom.js";
import { buildTar, gzipDeterministic } from "../tar.js";

const REPO = new URL("../../../", import.meta.url).pathname;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const te = new TextEncoder();

const NPM_LOCK = JSON.stringify({
  packages: {
    "": { name: "root" },
    "node_modules/@scope/pkg": { version: "1.2.3", integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64"), resolved: "https://registry.npmjs.org/@scope/pkg/-/pkg-1.2.3.tgz" },
    "node_modules/devonly": { version: "0.1.0", integrity: "sha512-" + Buffer.alloc(64, 2).toString("base64"), dev: true, hasInstallScript: true },
    "packages/protocol": { version: "0.0.1" },
  },
});
const CARGO_LOCK = `version = 4

[[package]]
name = "flagship-keyd"
version = "0.1.0"
dependencies = [
 "ring",
]

[[package]]
name = "ring"
version = "0.17.14"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${"a".repeat(64)}"

[[package]]
name = "forked"
version = "0.2.0"
source = "git+https://github.com/example/forked?rev=abc#abc123"
`;
const GO_SUM = `golang.org/x/sys v0.47.0 h1:o7XGOvZQCADBQQ4Y7VNq2dRWQR7JmOUW8Kxx4ZsNgWs=
golang.org/x/sys v0.47.0/go.mod h1:zzz=
`;

describe("the CycloneDX SBOM", () => {
  const input = {
    npmLock: NPM_LOCK, cargoLock: CARGO_LOCK, goSums: { "installer/tls-frontend": GO_SUM, "installer/unseal-helper": GO_SUM },
    node: { version: "24.22.1", file: "node-v24.22.1-linux-x64.tar.xz", sha256: "b".repeat(64), url: "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz" },
    installed: new Set(["node_modules/@scope/pkg"]), commit: "c".repeat(40), arch: "amd64", sourceDateEpoch: 1_760_000_000,
  };

  it("names npm, Cargo, Go and the Node runtime, with hashes, scope and purls, and leaves our own code out", () => {
    const s = buildSbom(input);
    expect(s.bomFormat).toBe("CycloneDX");
    expect(s.specVersion).toBe("1.5");
    const refs = s.components.map((c) => c["bom-ref"]);
    expect(refs).toEqual([...refs].sort());
    const scoped = s.components.find((c) => c.name === "@scope/pkg")!;
    expect(scoped.purl).toBe("pkg:npm/%40scope/pkg@1.2.3");
    expect(scoped.scope).toBe("required");
    expect(scoped.hashes).toEqual([{ alg: "SHA-512", content: "01".repeat(64) }]);
    const dev = s.components.find((c) => c.name === "devonly")!;
    expect(dev.scope).toBe("excluded");
    expect(dev.properties).toContainEqual({ name: "flagship:installScript", value: "present, not run (npm ci --ignore-scripts)" });
    expect(s.components.find((c) => c.name === "ring")).toMatchObject({ purl: "pkg:cargo/ring@0.17.14", hashes: [{ alg: "SHA-256", content: "a".repeat(64) }] });
    expect(s.components.some((c) => c.name === "flagship-keyd" || c.name === "protocol")).toBe(false);
    const sys = s.components.filter((c) => c.name === "golang.org/x/sys");
    expect(sys).toHaveLength(1);
    expect(sys[0]!.properties!.filter((p) => p.name === "flagship:goModuleDir")).toHaveLength(2);
    expect(s.components.find((c) => c.name === "node")).toMatchObject({ type: "platform", hashes: [{ alg: "SHA-256", content: "b".repeat(64) }] });
    expect(s.metadata.component.version).toBe("c".repeat(40));
    expect(s.metadata.timestamp).toBe("2025-10-09T08:53:20.000Z");
  });

  it("is the same bytes for the same inputs (no clock, no random serial)", () => {
    expect(JSON.stringify(buildSbom(input))).toBe(JSON.stringify(buildSbom(input)));
    expect(buildSbom(input).serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(buildSbom({ ...input, arch: "arm64" }).serialNumber).not.toBe(buildSbom(input).serialNumber);
  });

  it("refuses an npm package or registry crate with no hash, but not a git crate pinned by commit", () => {
    const lock = JSON.stringify({ packages: { "node_modules/x": { version: "1.0.0" } } });
    const cargo = CARGO_LOCK.replace(`checksum = "${"a".repeat(64)}"\n`, "");
    expect(componentsWithoutIntegrity(buildSbom({ npmLock: lock, cargoLock: cargo }))).toEqual(["ring@0.17.14", "x@1.0.0"]);
  });

  it("parses the real locks of this repository, and every registry crate and npm package has a hash", () => {
    const cargo = parseCargoLock(readFileSync(join(REPO, "rust/Cargo.lock"), "utf8"));
    expect(cargo.length).toBeGreaterThan(100);
    expect(cargo.filter((c) => c.source?.startsWith("registry+") && !c.checksum)).toEqual([]);
    expect(parseGoSum(readFileSync(join(REPO, "installer/unseal-helper/go.sum"), "utf8")).length).toBeGreaterThan(0);
    const s = buildSbom({ npmLock: readFileSync(join(REPO, "package-lock.json"), "utf8"), cargoLock: readFileSync(join(REPO, "rust/Cargo.lock"), "utf8") });
    expect(componentsWithoutIntegrity(s)).toEqual([]);
  });

  it("turns npm integrity strings into hex digests and ignores junk", () => {
    expect(integrityHashes("sha1-AAAA sha512-" + Buffer.alloc(64, 255).toString("base64") + " md5-x")).toEqual([
      { alg: "SHA-1", content: "000000" },
      { alg: "SHA-512", content: "ff".repeat(64) },
    ]);
  });
});

describe("the provenance statement", () => {
  const base = {
    artifact: { name: "flagship-box-cccccccccccc-amd64.tar.gz", sha256: "1".repeat(64) },
    sbom: { name: "flagship-box-cccccccccccc-amd64.sbom.json", sha256: "2".repeat(64) },
    commit: "c".repeat(40), arch: "amd64", sequence: 7, sourceDateEpoch: 1_760_000_000,
    materials: [{ uri: "file:rust/Cargo.lock", sha256: "4".repeat(64) }, { uri: "file:package-lock.json", sha256: "3".repeat(64) }],
    toolchain: { typescript: "5.9.3", node: "v24.22.1", rustc: "rustc 1.99.1" },
    builder: { id: OWNER_LOCAL_BUILDER },
    steps: ["git archive", "npm ci --ignore-scripts"],
    flags: ["--skip-pgp", "--no-rust"],
  };

  it("is an in-toto v1 statement with a SLSA v1 predicate naming the artifact, the SBOM, the commit, locks and tools", () => {
    const p = buildProvenance(base);
    expect(p._type).toBe("https://in-toto.io/Statement/v1");
    expect(p.predicateType).toBe("https://slsa.dev/provenance/v1");
    expect(p.subject).toEqual([
      { name: base.artifact.name, digest: { sha256: "1".repeat(64) } },
      { name: base.sbom.name, digest: { sha256: "2".repeat(64) } },
    ]);
    const deps = p.predicate.buildDefinition.resolvedDependencies;
    expect(deps[0]).toEqual({ uri: `git+flagship@${"c".repeat(40)}`, digest: { gitCommit: "c".repeat(40) } });
    expect(deps.slice(1).map((d) => d.uri)).toEqual(["file:package-lock.json", "file:rust/Cargo.lock"]);
    expect(Object.keys(p.predicate.runDetails.builder.version)).toEqual(["node", "rustc", "typescript"]);
    expect(p.predicate.buildDefinition.internalParameters.flags).toEqual(["--no-rust", "--skip-pgp"]);
    expect(JSON.stringify(buildProvenance(base))).toBe(JSON.stringify(p));
  });

  it("refuses an abbreviated commit, a bad digest or no builder", () => {
    expect(() => buildProvenance({ ...base, commit: "cccccc" })).toThrow(/40-hex/);
    expect(() => buildProvenance({ ...base, materials: [{ uri: "x", sha256: "nope" }] })).toThrow(/SHA-256/);
    expect(() => buildProvenance({ ...base, builder: { id: "" } })).toThrow(/builder/);
  });

  it("an owner's build names itself, never the release workflow", () => {
    expect(builderId({})).toBe(OWNER_LOCAL_BUILDER);
    expect(builderId({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW_REF: "o/r/.github/workflows/box-artifact.yml@refs/heads/main" })).toBe(
      "https://github.com/o/r/.github/workflows/box-artifact.yml@refs/heads/main",
    );
    expect(builderId({ GITHUB_ACTIONS: "true" })).toBe(OWNER_LOCAL_BUILDER);
    expect(builderId({}, "https://example.org/me")).toBe("https://example.org/me");
  });
});

const INFO: BuildInfo = { schema: 1, commit: "c".repeat(40), arch: "amd64", nodeVersion: "24.22.1", nodeSha256: "e".repeat(64), lockSha256: "f".repeat(64), sourceDateEpoch: 1_760_000_000 };

function artifact(files: Record<string, string>, mtime = INFO.sourceDateEpoch): Buffer {
  const entries = [{ kind: "dir" as const, path: "flagship" }, ...Object.entries(files).map(([p, d]) => ({ kind: "file" as const, path: `flagship/${p}`, data: te.encode(d), executable: p.endsWith(".sh") }))];
  return gzipDeterministic(buildTar(entries, mtime));
}

describe("the reproducibility comparison", () => {
  it("reads back what the deterministic writer wrote, long names and modes included", () => {
    const long = "app/node_modules/" + "x".repeat(120) + "/index.js";
    const t = readTar(artifact({ [long]: "a", "app/run.sh": "#!/bin/sh\n" }));
    expect(t.get(`flagship/${long}`)).toMatchObject({ type: "file", size: 1, sha256: sha("a"), mode: 0o644 });
    expect(t.get("flagship/app/run.sh")!.mode).toBe(0o755);
    expect(t.get("flagship")!.type).toBe("dir");
  });

  it("says identical for the same build and names every differing file otherwise", () => {
    const a = artifact({ "app/a.js": "1", "app/b.js": "2", "BUILD-INFO.json": "{}" });
    expect(compareArtifacts(a, artifact({ "app/a.js": "1", "app/b.js": "2", "BUILD-INFO.json": "{}" })).identical).toBe(true);
    const r = compareArtifacts(a, artifact({ "app/a.js": "1", "app/b.js": "two", "app/c.js": "3", "BUILD-INFO.json": "{}" }));
    expect(r.identical).toBe(false);
    expect(r.differing.map((d) => [d.path, d.fields])).toEqual([["flagship/app/b.js", ["size", "sha256"]]]);
    expect(r.onlyInB).toEqual(["flagship/app/c.js"]);
    expect(summarizeDifferences(r)).toEqual({ "flagship/app/b.js": 1, "flagship/app/c.js": 1 });
    expect(compareArtifacts(a, artifact({ "app/a.js": "1", "app/b.js": "2", "BUILD-INFO.json": "{}" }, 1)).differing).toHaveLength(4);
  });

  it("reports a difference in compression alone", () => {
    const tar = buildTar([{ kind: "file", path: "flagship/x", data: te.encode("x".repeat(1000)), executable: false }], 1);
    const r = compareArtifacts(gzipDeterministic(tar), gzipSync(tar, { level: 1 }));
    expect(r.compressionOnly).toBe(true);
  });
});

describe("an owner's build against the endorsed artifact", () => {
  const seed = new Uint8Array(32).fill(9);
  const keyHex = Buffer.from(ed.getPublicKey(seed)).toString("hex");
  const art = assembleArtifact({ appDir: REPO + "release", nodeBinary: join(REPO, "release/version.json"), info: INFO });
  const manifest: BoxArtifactManifest = {
    commit: INFO.commit, arch: "amd64", artifactSha256: art.sha256, artifactBytes: art.bytes, nodeVersion: "24.22.1", nodeSha256: INFO.nodeSha256,
    lockSha256: INFO.lockSha256, sbomSha256: "1".repeat(64), provenanceSha256: "2".repeat(64), minVerifier: 1, sequence: 3, issuedAt: 1_760_000_000_000,
  };
  const doc = { manifest, signatures: [{ keyHex, signatureHex: Buffer.from(ed.sign(canonicalBoxArtifact(manifest), seed)).toString("hex") }] };
  const trust = { keys: [keyHex], threshold: 1, pq: { keyIds: [], legacyManifests: [] } } as never; // classical fixture: unpinned

  it("matches when it is the endorsed bytes and the endorsement verifies", () => {
    expect(checkAgainstEndorsed({ artifact: art.tarGz, manifestDoc: doc, commit: INFO.commit, arch: "amd64", trust })).toMatchObject({ verdict: "matches", signers: 1 });
  });

  it("differs when one byte differs, and when the endorsement is not from a pinned key", () => {
    const other = Buffer.from(art.tarGz);
    other[other.length - 1] ^= 1;
    expect(checkAgainstEndorsed({ artifact: other, manifestDoc: doc, commit: INFO.commit, arch: "amd64", trust })).toMatchObject({ verdict: "differs", reason: /not the endorsed bytes/ });
    const stranger = { keys: ["0".repeat(64)], threshold: 1, pq: { keyIds: [], legacyManifests: [] } } as never;
    expect(checkAgainstEndorsed({ artifact: art.tarGz, manifestDoc: doc, commit: INFO.commit, arch: "amd64", trust: stranger })).toMatchObject({ verdict: "differs", reason: /does not verify/ });
  });
});

describe("the pins a reproducible build depends on", () => {
  it("the TypeScript compiler is pinned to one exact version, the one in the lockfile", () => {
    const pkg = readFileSync(join(REPO, "package.json"), "utf8");
    const lock = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string; devDependencies?: Record<string, string> }> };
    expect(assertCompilerPinned(pkg, lock.packages["node_modules/typescript"]!.version!)).toBe(lock.packages[""]!.devDependencies!["typescript"]);
    expect(() => assertCompilerPinned(JSON.stringify({ devDependencies: { typescript: "^5.6.0" } }), "5.9.3")).toThrow(/exact version/);
    expect(() => assertCompilerPinned(JSON.stringify({ devDependencies: { typescript: "5.9.3" } }), "5.9.4")).toThrow(/not the pinned/);
  });

  it("the release workflow and the VM build use the same Go and Node, and the runtime lock's Node", () => {
    const wf = readFileSync(join(REPO, ".github/workflows/box-artifact.yml"), "utf8");
    const vm = readFileSync(join(REPO, "scripts/lib/upcloud-vm.sh"), "utf8");
    const vmGo = /^VM_GO=go(\S+)$/m.exec(vm)?.[1];
    expect(vmGo).toBeDefined();
    expect(/go-version: "?([0-9.]+)"?/.exec(wf)?.[1]).toBe(vmGo);
    const floor = JSON.parse(readFileSync(join(REPO, "release/security-floor.json"), "utf8")).node.minimum as string;
    expect(/node-version: ([0-9.]+)/.exec(wf)?.[1]).toBe(floor);
    const pins = JSON.parse(readFileSync(join(REPO, "tools/box-artifact/node-pins.json"), "utf8")).node.version as string;
    expect(pins).toBe(floor);
  });

  it("the release workflow publishes the SBOM and the provenance beside the artifact", () => {
    const wf = readFileSync(join(REPO, ".github/workflows/box-artifact.yml"), "utf8");
    expect(wf).toMatch(/sbom\.json/);
    expect(wf).toMatch(/provenance\.json/);
  });
});

describe("the owner-build and reproducibility scripts", () => {
  const run = (script: string, ...args: string[]) => spawnSync("bash", [join(REPO, script), ...args], { encoding: "utf8" });

  it("refuse anything but a full commit and a known architecture, before building anything", () => {
    for (const s of ["scripts/owner-build.sh", "scripts/repro-compare.sh"]) {
      expect(run(s, "--commit", "main", "--arch", "amd64", "--out", "/nonexistent").status, s).toBe(2);
      expect(run(s, "--commit", "c".repeat(40), "--arch", "x86", "--out", "/nonexistent").status, s).toBe(2);
    }
  });

  it("install only from the lock with scripts off, in a staging folder with an emptied environment, never on a server", () => {
    const lib = readFileSync(join(REPO, "scripts/lib/box-build.sh"), "utf8");
    expect(lib).toMatch(/npm ci --ignore-scripts/);
    expect(lib).not.toMatch(/npm (install|i) /);
    expect(lib).toMatch(/env -i /);
    expect(lib).toMatch(/\/etc\/flagship\/daemon\.env/);
    expect(lib).toMatch(/git -C "\$repo" archive "\$commit"/);
  });
});

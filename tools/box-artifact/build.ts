#!/usr/bin/env -S npx tsx
/**
 * Build, sign and verify the box release artifact (SEC-REL-001).
 *
 *   build  --commit <40hex> --arch amd64|arm64 --out <dir> [--repo <path>]
 *          [--node-archive <file> --node-shasums <file> --node-shasums-sig <file>]
 *          [--skip-pgp] [--sequence N]
 *   sign   --manifest <unsigned.json> --out <signed.json> (--key-file <hexseed> | --signer-cmd <cmd>)
 *   verify --manifest <signed.json> --artifact <file> --commit <40hex> --arch <arch>
 *          [--trust release/box-artifact-trust.json] [--last-sequence N]
 *
 * Run `build` only in clean CI: it installs the exact lockfile with lifecycle
 * scripts off, compiles, and writes the artifact deterministically. No step
 * resolves anything the lockfile does not name, and Node comes from the
 * official archive checked against a pinned SHA-256 and the release PGP key.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  NODE_SECURITY_FLOOR,
  canonicalBoxArtifact,
  compareSemver,
  signBoxArtifact,
  verifyBoxArtifact,
  type BoxArch,
  type BoxArtifactManifest,
  type BoxArtifactSignature,
  type ReleaseTrust,
} from "../../packages/protocol/src/boxArtifact.js";
import { assembleArtifact, type BuildInfo } from "./assemble.js";
import { buildSbom, componentsWithoutIntegrity } from "./sbom.js";

const HERE = dirname(new URL(import.meta.url).pathname);
const REPO = resolve(HERE, "../..");
export const VERIFIER_VERSION = 1;

interface NodePins {
  node: {
    version: string;
    archives: Record<BoxArch, { file: string; sha256: string }>;
    downloadBase: string;
    releaseSigningKeys: { fingerprints: string[] };
  };
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export function loadNodePins(path = join(HERE, "node-pins.json")): NodePins {
  return JSON.parse(readFileSync(path, "utf8")) as NodePins;
}

/** The Node the artifact ships must be one release/security-floor.json allows. */
export function assertNodeMeetsFloor(version: string): void {
  const floor = JSON.parse(readFileSync(join(REPO, "release/security-floor.json"), "utf8")).node.minimum as string;
  if (floor !== NODE_SECURITY_FLOOR) throw new Error("release/security-floor.json and NODE_SECURITY_FLOOR disagree");
  if (compareSemver(version, floor) < 0) throw new Error(`Node ${version} is below the security floor ${floor}`);
}

/** Check SHASUMS256.txt against its PGP signature using only the pinned fingerprints, in a throwaway keyring. */
export function verifyShasumsSignature(shasums: string, sig: string, fingerprints: readonly string[]): void {
  const home = mkdtempSync(join(tmpdir(), "box-artifact-gpg-"));
  try {
    const env = { ...process.env, GNUPGHOME: home };
    execFileSync("chmod", ["700", home]);
    let imported = 0;
    for (const fp of fingerprints) {
      const r = spawnSync("gpg", ["--batch", "--quiet", "--keyserver", "hkps://keys.openpgp.org", "--recv-keys", fp], { env, encoding: "utf8" });
      if (r.status === 0) imported++;
    }
    if (imported === 0) throw new Error("could not import any pinned Node release key");
    const v = spawnSync("gpg", ["--batch", "--status-fd", "1", "--verify", sig, shasums], { env, encoding: "utf8" });
    const good = /\[GNUPG:\] VALIDSIG ([0-9A-F]{40}) .* ([0-9A-F]{40})\s*$/m.exec(v.stdout);
    const primary = good?.[2];
    const signing = good?.[1];
    const pinned = new Set(fingerprints.map((f) => f.toUpperCase()));
    // Accept the signature when the signing key's own fingerprint or its primary key is one we pinned.
    if (v.status !== 0 || !good || !(pinned.has(signing!) || pinned.has(primary!))) {
      throw new Error("SHASUMS256.txt is not signed by a pinned Node release key");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function archiveDigestFromShasums(shasumsText: string, file: string): string {
  for (const line of shasumsText.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m && m[2] === file) return m[1]!;
  }
  throw new Error(`${file} is not in SHASUMS256.txt`);
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function need(argv: string[], name: string): string {
  const v = arg(argv, name);
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 << 20 }).trim();
}

/** The platform packages the box needs are there, and no other platform's are. */
export function assertTargetBinaries(nodeModules: string, cpu: "x64" | "arm64"): void {
  const esbuild = join(nodeModules, "@esbuild");
  if (!existsSync(join(esbuild, `linux-${cpu}`))) throw new Error(`the artifact lacks @esbuild/linux-${cpu}: npm installed for the wrong platform`);
  const wrong = readdirSync(esbuild).filter((d) => d !== `linux-${cpu}`);
  if (wrong.length > 0) throw new Error(`the artifact carries binaries for other platforms: ${wrong.map((d) => `@esbuild/${d}`).join(", ")}`);
}

async function build(argv: string[]): Promise<void> {
  const commit = need(argv, "commit");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("--commit must be a full 40-hex commit, never a branch, tag or abbreviation");
  const arch = need(argv, "arch") as BoxArch;
  if (arch !== "amd64" && arch !== "arm64") throw new Error("--arch must be amd64 or arm64");
  const out = resolve(need(argv, "out"));
  const repo = resolve(arg(argv, "repo") ?? REPO);
  if (git(repo, "rev-parse", `${commit}^{commit}`) !== commit) throw new Error("commit does not resolve to itself");
  const sequence = Number(arg(argv, "sequence") ?? "0");
  const pins = loadNodePins();
  assertNodeMeetsFloor(pins.node.version);
  const pin = pins.node.archives[arch];

  const work = mkdtempSync(join(tmpdir(), "box-artifact-build-"));
  try {
    mkdirSync(out, { recursive: true });
    const src = join(work, "src");
    mkdirSync(src);
    // A clean export of the commit: no .git, no untracked files, nothing the builder had lying around.
    execFileSync("sh", ["-c", `git -C '${repo}' archive ${commit} | tar -x -C '${src}'`]);

    // Node: the official archive, its digest pinned, and the checksums file's PGP signature checked.
    const nodeArchive = arg(argv, "node-archive") ?? join(work, pin.file);
    if (!arg(argv, "node-archive")) execFileSync("curl", ["-fsSL", "--proto", "=https", "-o", nodeArchive, pins.node.downloadBase + pin.file]);
    if (sha256(readFileSync(nodeArchive)) !== pin.sha256) throw new Error(`${pin.file} does not match the pinned SHA-256`);
    if (!argv.includes("--skip-pgp")) {
      const shasums = arg(argv, "node-shasums") ?? join(work, "SHASUMS256.txt");
      const sig = arg(argv, "node-shasums-sig") ?? join(work, "SHASUMS256.txt.sig");
      if (!arg(argv, "node-shasums")) execFileSync("curl", ["-fsSL", "--proto", "=https", "-o", shasums, pins.node.downloadBase + "SHASUMS256.txt"]);
      if (!arg(argv, "node-shasums-sig")) execFileSync("curl", ["-fsSL", "--proto", "=https", "-o", sig, pins.node.downloadBase + "SHASUMS256.txt.sig"]);
      verifyShasumsSignature(shasums, sig, pins.node.releaseSigningKeys.fingerprints);
      if (archiveDigestFromShasums(readFileSync(shasums, "utf8"), pin.file) !== pin.sha256) throw new Error("pinned SHA-256 is not the one in the signed SHASUMS256.txt");
    }
    const nodeDir = join(work, "node");
    mkdirSync(nodeDir);
    const prefix = pin.file.replace(/\.tar\.xz$/, "");
    execFileSync("tar", ["-xJf", nodeArchive, "-C", nodeDir, "--strip-components=1", `${prefix}/bin/node`, `${prefix}/LICENSE`]);

    // The exact lockfile, scripts off, then compile the daemon's workspace.
    const lockText = readFileSync(join(src, "package-lock.json"), "utf8");
    const sbom = buildSbom(lockText);
    const missing = componentsWithoutIntegrity(sbom);
    if (missing.length > 0) throw new Error(`the lockfile has packages without an integrity hash: ${missing.slice(0, 5).join(", ")}`);
    // The box is Linux whatever the builder is: npm picks platform packages (esbuild's binary, which tsx
    // runs every script with) from the HOST unless told the target, so a build on a Mac would ship darwin
    // binaries the box cannot run.
    const npmCpu = arch === "amd64" ? "x64" : "arm64";
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--include-workspace-root", "--workspace=packages/server-daemon", "--os=linux", `--cpu=${npmCpu}`], { cwd: src, stdio: "inherit" });
    assertTargetBinaries(join(src, "node_modules"), npmCpu);
    execFileSync("npx", ["tsc", "-b", "packages/server-daemon"], { cwd: src, stdio: "inherit" });

    // The early-boot unseal helper, compiled here with a pinned toolchain so no compiler is needed on the box.
    const unsealBinary = arg(argv, "unseal-binary") ?? join(work, "flagship-unseal");
    let goVersion = "prebuilt";
    if (!arg(argv, "unseal-binary")) {
      goVersion = execFileSync("go", ["version"], { encoding: "utf8" }).trim();
      execFileSync("go", ["build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-ldflags", "-s -w -buildid=", "-o", unsealBinary, "."], {
        cwd: join(src, "installer/unseal-helper"),
        stdio: "inherit",
        env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: arch === "amd64" ? "amd64" : "arm64", GOFLAGS: "-mod=readonly" },
      });
    }

    // The TLS frontend (the certificate key stays in keyd), built the same way.
    const tlsdBinary = arg(argv, "tlsd-binary") ?? join(work, "flagship-tlsd");
    if (!arg(argv, "tlsd-binary")) {
      execFileSync("go", ["build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-ldflags", "-s -w -buildid=", "-o", tlsdBinary, "."], {
        cwd: join(src, "installer/tls-frontend"),
        stdio: "inherit",
        env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: arch === "amd64" ? "amd64" : "arm64", GOFLAGS: "-mod=readonly" },
      });
    }

    const epoch = Number(git(repo, "show", "-s", "--format=%ct", commit));
    const info: BuildInfo = {
      schema: 1, commit, arch, nodeVersion: pins.node.version, nodeSha256: pin.sha256,
      lockSha256: sha256(lockText), sourceDateEpoch: epoch,
    };
    const art = assembleArtifact({ appDir: src, nodeBinary: join(nodeDir, "bin/node"), nodeLicense: join(nodeDir, "LICENSE"), unsealBinary, tlsdBinary, info });

    const sbomText = JSON.stringify(sbom, null, 2) + "\n";
    const provenance = JSON.stringify({
      schema: 1, commit, arch, sourceDateEpoch: epoch,
      builder: { ci: process.env["GITHUB_ACTIONS"] === "true", runId: process.env["GITHUB_RUN_ID"] ?? null, workflow: process.env["GITHUB_WORKFLOW_REF"] ?? null, runner: process.env["RUNNER_NAME"] ?? null },
      tools: { node: process.version, npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(), go: goVersion },
      inputs: { lockSha256: info.lockSha256, nodeSha256: pin.sha256, nodeVersion: pins.node.version },
      steps: ["git archive", "verify node archive", "npm ci --ignore-scripts", "tsc -b packages/server-daemon", "go build installer/unseal-helper", "go build installer/tls-frontend", "assemble deterministic tar.gz"],
    }, null, 2) + "\n";

    const name = `flagship-box-${commit.slice(0, 12)}-${arch}`;
    writeFileSync(join(out, `${name}.tar.gz`), art.tarGz);
    writeFileSync(join(out, `${name}.sbom.json`), sbomText);
    writeFileSync(join(out, `${name}.provenance.json`), provenance);
    const manifest: BoxArtifactManifest = {
      commit, arch, artifactSha256: art.sha256, artifactBytes: art.bytes,
      nodeVersion: pins.node.version, nodeSha256: pin.sha256, lockSha256: info.lockSha256,
      sbomSha256: sha256(sbomText), provenanceSha256: sha256(provenance),
      minVerifier: VERIFIER_VERSION, sequence, issuedAt: epoch * 1000,
    };
    canonicalBoxArtifact(manifest); // refuses a malformed manifest before anything is signed
    writeFileSync(join(out, `${name}.manifest.unsigned.json`), JSON.stringify({ manifest, signatures: [] }, null, 2) + "\n");
    console.log(`${name}.tar.gz ${art.bytes} bytes sha256 ${art.sha256}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function sign(argv: string[]): void {
  const doc = JSON.parse(readFileSync(need(argv, "manifest"), "utf8")) as { manifest: BoxArtifactManifest; signatures: BoxArtifactSignature[] };
  const keyFile = arg(argv, "key-file");
  const signerCmd = arg(argv, "signer-cmd");
  let sig: BoxArtifactSignature;
  if (keyFile) {
    sig = signBoxArtifact(doc.manifest, Uint8Array.from(Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex")));
  } else if (signerCmd) {
    // An external signer (a hardware key): it reads the canonical bytes on stdin and prints `<pubkeyhex> <signaturehex>`.
    const r = spawnSync("sh", ["-c", signerCmd], { input: Buffer.from(canonicalBoxArtifact(doc.manifest)), encoding: "utf8" });
    const m = /^([0-9a-f]{64})\s+([0-9a-f]{128})\s*$/.exec(r.stdout);
    if (r.status !== 0 || !m) throw new Error("the signer command did not print '<pubkeyhex> <signaturehex>'");
    sig = { keyHex: m[1]!, signatureHex: m[2]! };
  } else {
    throw new Error("give --key-file or --signer-cmd");
  }
  doc.signatures = [...doc.signatures.filter((s) => s.keyHex !== sig.keyHex), sig];
  writeFileSync(need(argv, "out"), JSON.stringify(doc, null, 2) + "\n");
  console.log(`signed by ${sig.keyHex}`);
}

function verify(argv: string[]): void {
  const doc = JSON.parse(readFileSync(need(argv, "manifest"), "utf8")) as { manifest: BoxArtifactManifest; signatures: BoxArtifactSignature[] };
  const trustPath = arg(argv, "trust") ?? join(REPO, "release/box-artifact-trust.json");
  const trust = JSON.parse(readFileSync(trustPath, "utf8")) as ReleaseTrust;
  const artifact = readFileSync(need(argv, "artifact"));
  const last = arg(argv, "last-sequence");
  const r = verifyBoxArtifact(doc.manifest, doc.signatures, {
    trust,
    expectedArtifactSha256: doc.manifest.artifactSha256,
    expectedCommit: need(argv, "commit"),
    expectedArch: need(argv, "arch") as BoxArch,
    measuredSha256: sha256(artifact),
    measuredBytes: artifact.length,
    verifierVersion: VERIFIER_VERSION,
    ...(last !== undefined ? { lastSequence: Number(last) } : {}),
    nodeFloor: NODE_SECURITY_FLOOR,
  });
  if (!r.ok) {
    console.error(`refused: ${r.code}${r.detail ? ` (${r.detail})` : ""}`);
    process.exit(1);
  }
  console.log(`verified: signed by ${r.signers.length} authorized key(s)`);
}

const cmd = process.argv[2];
if (process.argv[1] && basename(process.argv[1]).startsWith("build")) {
  try {
    if (cmd === "build") await build(process.argv.slice(3));
    else if (cmd === "sign") sign(process.argv.slice(3));
    else if (cmd === "verify") verify(process.argv.slice(3));
    else {
      console.error("usage: build.ts build|sign|verify ...");
      process.exit(2);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
void existsSync;

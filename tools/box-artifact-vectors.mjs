// Writes packages/protocol/test-vectors/box-artifact/vectors.json.
// Run: node --import tsx tools/box-artifact-vectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { ed } from "../packages/protocol/src/edSync.ts";
import { canonicalBoxArtifact, signBoxArtifact, verifyBoxArtifact } from "../packages/protocol/src/boxArtifact.ts";

const hex = (b) => Buffer.from(b).toString("hex");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const seed = (n) => new Uint8Array(32).fill(n);
const keys = [0x21, 0x22, 0x23, 0x24].map((n) => ({ seed: seed(n), pub: hex(ed.getPublicKey(seed(n))) }));
const artifact = Buffer.from("flagship box artifact fixture\n".repeat(40));

const manifest = {
  commit: "0123456789abcdef0123456789abcdef01234567",
  arch: "amd64",
  artifactSha256: sha(artifact),
  artifactBytes: artifact.length,
  nodeVersion: "24.22.1",
  nodeSha256: sha("node-v24.22.1-linux-x64.tar.xz fixture"),
  lockSha256: sha("package-lock.json fixture"),
  sbomSha256: sha("sbom fixture"),
  provenanceSha256: sha("provenance fixture"),
  minVerifier: 1,
  sequence: 7,
  issuedAt: 1760000000000,
};
const canonical = new TextDecoder().decode(canonicalBoxArtifact(manifest));
const sigs = keys.map((k) => signBoxArtifact(manifest, k.seed));
const trust = { keys: keys.slice(0, 3).map((k) => k.pub), threshold: 2 };
const base = { trust, verifierVersion: 1, lastSequence: 6, nodeFloor: "24.22.1", expectedArtifactSha256: manifest.artifactSha256, expectedCommit: manifest.commit, expectedArch: "amd64", measuredSha256: manifest.artifactSha256, measuredBytes: manifest.artifactBytes };

const cases = [
  ["two of three authorized signers", { sigs: [sigs[0], sigs[2]], opts: base, expect: { ok: true } }],
  ["one signer is below the threshold", { sigs: [sigs[0]], opts: base, expect: { ok: false, code: "not-enough-signatures" } }],
  ["the same signer twice counts once", { sigs: [sigs[0], sigs[0]], opts: base, expect: { ok: false, code: "not-enough-signatures" } }],
  ["an unauthorized key does not count", { sigs: [sigs[0], sigs[3]], opts: base, expect: { ok: false, code: "not-enough-signatures" } }],
  ["a signature over another manifest does not count", { sigs: [sigs[0], { keyHex: sigs[1].keyHex, signatureHex: signBoxArtifact({ ...manifest, sequence: 8 }, keys[1].seed).signatureHex }], opts: base, expect: { ok: false, code: "not-enough-signatures" } }],
  ["the downloaded file has another digest", { sigs: [sigs[0], sigs[1]], opts: { ...base, measuredSha256: sha("tampered") }, expect: { ok: false, code: "digest-mismatch" } }],
  ["the recipe named another digest", { sigs: [sigs[0], sigs[1]], opts: { ...base, expectedArtifactSha256: sha("other") }, expect: { ok: false, code: "digest-mismatch" } }],
  ["the file is a different size", { sigs: [sigs[0], sigs[1]], opts: { ...base, measuredBytes: manifest.artifactBytes + 1 }, expect: { ok: false, code: "size-mismatch" } }],
  ["the recipe named another commit", { sigs: [sigs[0], sigs[1]], opts: { ...base, expectedCommit: "f".repeat(40) }, expect: { ok: false, code: "commit-mismatch" } }],
  ["wrong architecture", { sigs: [sigs[0], sigs[1]], opts: { ...base, expectedArch: "arm64" }, expect: { ok: false, code: "arch-mismatch" } }],
  ["a rolled-back sequence", { sigs: [sigs[0], sigs[1]], opts: { ...base, lastSequence: 7 }, expect: { ok: false, code: "rollback" } }],
  ["the verifier is too old", { sigs: [sigs[0], sigs[1]], opts: { ...base, verifierVersion: 0 }, expect: { ok: false, code: "verifier-too-old" } }],
  ["Node below the floor", { sigs: [sigs[0], sigs[1]], opts: { ...base, nodeFloor: "24.99.0" }, expect: { ok: false, code: "node-below-floor" } }],
].map(([name, c]) => {
  const got = verifyBoxArtifact(manifest, c.sigs, c.opts);
  const shape = got.ok ? { ok: true } : { ok: false, code: got.code };
  if (JSON.stringify(shape) !== JSON.stringify(c.expect)) throw new Error(`${name}: expected ${JSON.stringify(c.expect)} got ${JSON.stringify(shape)}`);
  return { name, signatures: c.sigs, options: c.opts, expect: c.expect };
});

mkdirSync("packages/protocol/test-vectors/box-artifact", { recursive: true });
writeFileSync("packages/protocol/test-vectors/box-artifact/vectors.json", JSON.stringify({
  about: "A box release artifact manifest. Authorities sign the canonical bytes with Ed25519 (seeds are 32 repeated bytes 0x21..0x24; the first three are authorized, threshold 2). The artifact fixture is the 'artifactText' repeated; its SHA-256 and size are in the manifest.",
  artifactText: "flagship box artifact fixture\n",
  artifactRepeat: 40,
  seeds: keys.map((k) => hex(k.seed)),
  publicKeys: keys.map((k) => k.pub),
  manifest, canonical, signatures: sigs, trust, cases,
}, null, 2) + "\n");
console.log("wrote", cases.length, "cases");

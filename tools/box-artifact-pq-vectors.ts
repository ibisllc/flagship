#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for the box artifact's PQ companion (packages/protocol/src/boxArtifactPq.ts).
 * The TypeScript port GENERATES them; packages/protocol/tests/boxArtifactPq.test.ts and the
 * installer's shell verifier (scripts/verify-box-artifact.test.ts) check them.
 *
 * Run:          npx tsx tools/box-artifact-pq-vectors.ts
 * CI freshness: npx tsx tools/box-artifact-pq-vectors.ts --check
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { canonicalBoxArtifact, signBoxArtifact, verifyBoxArtifact, type BoxArtifactManifest, type BoxArtifactSignature } from "../packages/protocol/src/boxArtifact.js";
import { BOX_ARTIFACT_PQ_BINDING_SUBJECT, boxArtifactV1Digest, signBoxArtifactPq, type BoxArtifactPqPin } from "../packages/protocol/src/boxArtifactPq.js";
import { hybridSign, hybridSigKeygen, pqKeyId, SUITE_HYBRID_SIG_ED25519_MLDSA65_V1 } from "../packages/protocol/src/pqHybrid.js";
import { signPqKeyBinding, TAG_PQ_KEY_BINDING } from "../packages/protocol/src/pqTrust.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/box-artifact/pq-vectors.json");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const fill = (v: number): Uint8Array => new Uint8Array(32).fill(v);
const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const NOW = 1_760_000_000_000;

const artifact = Buffer.from("flagship box artifact fixture\n".repeat(40));
const manifest: BoxArtifactManifest = {
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
  sequence: 9,
  issuedAt: NOW,
};
const v1 = canonicalBoxArtifact(manifest);

const signers = [[0x31, 0x41], [0x32, 0x42], [0x33, 0x43]].map(([a, b]) => {
  const { publicKey, secretKey } = hybridSigKeygen(fill(a!), fill(b!));
  const ed25519PubHex = hex(publicKey.subarray(0, 32));
  const binding = signPqKeyBinding(
    { role: "release-key", subjectId: BOX_ARTIFACT_PQ_BINDING_SUBJECT, ed25519PubHex, mldsaPubHex: hex(publicKey.subarray(32)), issuedAt: NOW },
    (m) => hybridSign(secretKey, TAG_PQ_KEY_BINDING, m, { deterministic: true }),
  );
  const classical = signBoxArtifact(manifest, fill(a!));
  return { edSeed: hex(fill(a!)), mldsaSeed: hex(fill(b!)), ed25519PubHex, keyId: hex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, publicKey)), binding, classical, pq: signBoxArtifactPq(v1, secretKey, publicKey) };
});
const trust = { keys: signers.map((s) => s.ed25519PubHex), threshold: 2 };
const pin: BoxArtifactPqPin = { version: 1, keyIds: signers.slice(0, 2).map((s) => s.keyId).concat(signers[2]!.keyId), legacyManifests: [] };
const full = (i: number): BoxArtifactSignature => ({ ...signers[i]!.classical, pq: signers[i]!.pq });
const bare = (i: number): BoxArtifactSignature => signers[i]!.classical;
const bindings = signers.map((s) => s.binding);
const flip = (h: string): string => (h.slice(0, -2) + (h.slice(-2) === "00" ? "01" : "00"));

type Case = { name: string; signatures: BoxArtifactSignature[]; pin: BoxArtifactPqPin; bindings: unknown[]; expect: { ok: boolean; code?: string } };
const cases: Case[] = [
  { name: "no pin: classical two of three", signatures: [bare(0), bare(1)], pin: { version: 1, keyIds: [], legacyManifests: [] }, bindings: [], expect: { ok: true } },
  { name: "pinned: two signers with their PQ companions", signatures: [full(0), full(1)], pin, bindings, expect: { ok: true } },
  { name: "pinned: the PQ halves stripped", signatures: [bare(0), bare(1)], pin, bindings, expect: { ok: false, code: "pq-signature-required" } },
  { name: "pinned: one companion stripped leaves one of two", signatures: [full(0), bare(1)], pin, bindings, expect: { ok: false, code: "pq-signature-required" } },
  { name: "pinned: a companion over another manifest", signatures: [full(0), { ...bare(1), pq: { keyId: signers[1]!.keyId, signatureHex: flip(signers[1]!.pq.signatureHex) } }], pin, bindings, expect: { ok: false, code: "pq-signature-required" } },
  { name: "pinned: a signer's companion under another signer's key", signatures: [full(0), { ...bare(1), pq: signers[0]!.pq }], pin, bindings, expect: { ok: false, code: "pq-signature-required" } },
  { name: "pinned: a binding missing", signatures: [full(0), full(1)], pin, bindings: [bindings[0]], expect: { ok: false, code: "pq-signature-required" } },
  { name: "pinned: a key that is not in the pin", signatures: [full(0), full(1)], pin: { ...pin, keyIds: [signers[0]!.keyId] }, bindings, expect: { ok: false, code: "pq-signature-required" } },
  { name: "pinned: a binding with a forged signature", signatures: [full(0), full(1)], pin, bindings: [bindings[0], { ...bindings[1], signature: flip(bindings[1]!.signature) }], expect: { ok: false, code: "pq-signature-required" } },
  { name: "pinned: a binding for another purpose", signatures: [full(0), full(1)], pin, bindings: [bindings[0], { ...bindings[1], subjectId: "flagship-release" }], expect: { ok: false, code: "pq-signature-required" } },
  { name: "pinned: a manifest signed before the cut-over", signatures: [bare(0), bare(1)], pin: { ...pin, legacyManifests: [boxArtifactV1Digest(v1)] }, bindings: [], expect: { ok: true } },
  { name: "pinned: still too few signers", signatures: [full(0)], pin, bindings, expect: { ok: false, code: "not-enough-signatures" } },
];
for (const c of cases) {
  const r = verifyBoxArtifact(manifest, c.signatures, { trust, verifierVersion: 1, pqPin: c.pin, pqBindings: c.bindings, now: NOW });
  const got = r.ok ? { ok: true } : { ok: false, code: r.code };
  if (JSON.stringify(got) !== JSON.stringify(c.expect)) throw new Error(`${c.name}: ${JSON.stringify(got)}`);
}

const doc = {
  about:
    "The PQ companion of a box artifact's signatures (packages/protocol/src/boxArtifactPq.ts). Each signer has a `release-key` binding (subject flagship-box-artifact); with a non-empty pin a signer counts only with its hybrid companion over flagship/box-artifact/v2|<sha256(v1)>|<signer>|<keyId>, except for a manifest whose v1 digest the pin lists. Every port (TS, installer/verify-box-artifact.sh) must give each case's `expect`. `now` is the verifier clock for the bindings.",
  now: NOW,
  artifactText: "flagship box artifact fixture\n",
  artifactRepeat: 40,
  manifest,
  canonicalV1: new TextDecoder().decode(v1),
  v1Digest: boxArtifactV1Digest(v1),
  trust,
  signers: signers.map(({ classical: _c, ...s }) => s),
  cases,
};
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(`${OUT} is stale: run npx tsx tools/box-artifact-pq-vectors.ts`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote ${cases.length} cases to ${OUT}`);
}

#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for the signed runtime manifest (packages/protocol/src/runtimeManifest.ts). The TypeScript port
 * GENERATES them; packages/protocol/tests/runtimeManifest.test.ts and the Rust updater
 * (rust/crates/flagship-updater/tests/runtime_manifest.rs) check them.
 *
 * Run:          npx tsx tools/runtime-manifest-vectors.ts
 * CI freshness: npx tsx tools/runtime-manifest-vectors.ts --check
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { BOX_ARTIFACT_PQ_BINDING_SUBJECT, type BoxArtifactPqPin } from "../packages/protocol/src/boxArtifactPq.js";
import { canonicalRuntimeManifest, signRuntimeManifest, signRuntimeManifestPq, verifyRuntimeManifest, type RuntimeManifest, type RuntimeManifestSignature } from "../packages/protocol/src/runtimeManifest.js";
import { hybridSign, hybridSigKeygen, pqKeyId, SUITE_HYBRID_SIG_ED25519_MLDSA65_V1 } from "../packages/protocol/src/pqHybrid.js";
import { signPqKeyBinding, TAG_PQ_KEY_BINDING } from "../packages/protocol/src/pqTrust.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/runtime-manifest/vectors.json");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const fill = (v: number): Uint8Array => new Uint8Array(32).fill(v);
const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const NOW = 1_760_000_000_000;

const lockText = '{"schema":1,"runtime":"node","version":"24.22.1","fixture":true}\n';
const SIGNER_FP = "5be8a3f6c8a5c01d106c0ad820b1a390b168d356";
const OTHER_FP = "4ed778f539e3634c779c87c6d7062848a1ab005c";
const manifest: RuntimeManifest = {
  runtime: "node",
  version: "24.22.1",
  lockSha256: sha(lockText),
  securityFloor: "24.22.1",
  sequence: 12,
  issuedAt: NOW - 86_400_000,
  validUntil: NOW + 30 * 86_400_000,
  revokedSigners: [],
};
const v1 = canonicalRuntimeManifest(manifest);

const signers = [[0x51, 0x61], [0x52, 0x62]].map(([a, b]) => {
  const { publicKey, secretKey } = hybridSigKeygen(fill(a!), fill(b!));
  const ed25519PubHex = hex(publicKey.subarray(0, 32));
  const binding = signPqKeyBinding(
    { role: "release-key", subjectId: BOX_ARTIFACT_PQ_BINDING_SUBJECT, ed25519PubHex, mldsaPubHex: hex(publicKey.subarray(32)), issuedAt: NOW },
    (m) => hybridSign(secretKey, TAG_PQ_KEY_BINDING, m, { deterministic: true }),
  );
  return {
    ed25519PubHex,
    keyId: hex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, publicKey)),
    binding,
    classical: signRuntimeManifest(manifest, fill(a!)),
    pq: signRuntimeManifestPq(v1, secretKey, publicKey),
  };
});
const trust = { keys: signers.map((s) => s.ed25519PubHex), threshold: 1 };
const pin: BoxArtifactPqPin = { version: 1, keyIds: signers.map((s) => s.keyId), legacyManifests: [] };
const noPin: BoxArtifactPqPin = { version: 1, keyIds: [], legacyManifests: [] };
const full = (i: number): RuntimeManifestSignature => ({ ...signers[i]!.classical, pq: signers[i]!.pq });
const bare = (i: number): RuntimeManifestSignature => signers[i]!.classical;
const bindings = signers.map((s) => s.binding);
const flip = (h: string): string => h.slice(0, -2) + (h.slice(-2) === "00" ? "01" : "00");

interface Case {
  name: string;
  manifest: RuntimeManifest;
  signatures: RuntimeManifestSignature[];
  lockText: string;
  lockSigners: string[];
  trust: { keys: string[]; threshold: number };
  pin: BoxArtifactPqPin;
  bindings: unknown[];
  now: number;
  lastSequence?: number;
  expect: { ok: boolean; code?: string };
}
const base = { manifest, lockText, lockSigners: [SIGNER_FP], trust, pin: noPin, bindings: [] as unknown[], now: NOW };
const resign = (m: RuntimeManifest): RuntimeManifestSignature[] => [signRuntimeManifest(m, fill(0x51))];
const cases: Case[] = [
  { ...base, name: "classical: one of one signs", signatures: [bare(0)], expect: { ok: true } },
  { ...base, name: "classical: a signature by a key nobody authorised", signatures: [signRuntimeManifest(manifest, fill(0x77))], expect: { ok: false, code: "not-enough-signatures" } },
  { ...base, name: "classical: a tampered field", manifest: { ...manifest, sequence: 13 }, signatures: [bare(0)], expect: { ok: false, code: "not-enough-signatures" } },
  { ...base, name: "classical: a threshold of two with one signer", trust: { ...trust, threshold: 2 }, signatures: [bare(0)], expect: { ok: false, code: "not-enough-signatures" } },
  { ...base, name: "classical: two signers meet a threshold of two", trust: { ...trust, threshold: 2 }, signatures: [bare(0), bare(1)], expect: { ok: true } },
  { ...base, name: "a manifest past its validity (freeze)", now: manifest.validUntil + 1, signatures: [bare(0)], expect: { ok: false, code: "expired" } },
  { ...base, name: "valid on its last millisecond", now: manifest.validUntil, signatures: [bare(0)], expect: { ok: true } },
  { ...base, name: "a replayed older sequence", lastSequence: 12, signatures: [bare(0)], expect: { ok: false, code: "rollback" } },
  { ...base, name: "a newer sequence than the last accepted", lastSequence: 11, signatures: [bare(0)], expect: { ok: true } },
  { ...base, name: "a lock that is not the one the manifest signs", lockText: lockText + " ", signatures: [bare(0)], expect: { ok: false, code: "lock-mismatch" } },
  (() => {
    const m = { ...manifest, revokedSigners: [SIGNER_FP] };
    return { ...base, name: "the lock still names a signer the manifest revokes", manifest: m, signatures: resign(m), expect: { ok: false, code: "signer-revoked" } } as Case;
  })(),
  (() => {
    const m = { ...manifest, revokedSigners: [OTHER_FP] };
    return { ...base, name: "a revoked signer the lock does not name does not matter", manifest: m, signatures: resign(m), expect: { ok: true } } as Case;
  })(),
  (() => {
    const m = { ...manifest, securityFloor: "99.0.0" };
    return { ...base, name: "a version below the manifest's own floor", manifest: m, signatures: resign(m), expect: { ok: false, code: "bad-manifest" } } as Case;
  })(),
  { ...base, name: "pinned: the signer with its PQ companion", pin, bindings, signatures: [full(0)], expect: { ok: true } },
  { ...base, name: "pinned: the PQ half stripped", pin, bindings, signatures: [bare(0)], expect: { ok: false, code: "pq-signature-required" } },
  { ...base, name: "pinned: a forged companion", pin, bindings, signatures: [{ ...bare(0), pq: { keyId: signers[0]!.keyId, signatureHex: flip(signers[0]!.pq.signatureHex) } }], expect: { ok: false, code: "pq-signature-required" } },
  { ...base, name: "pinned: another signer's companion", pin, bindings, signatures: [{ ...bare(0), pq: signers[1]!.pq }], expect: { ok: false, code: "pq-signature-required" } },
  { ...base, name: "pinned: the binding is missing", pin, bindings: [], signatures: [full(0)], expect: { ok: false, code: "pq-signature-required" } },
  { ...base, name: "pinned: a key the pin does not name", pin: { ...pin, keyIds: [signers[1]!.keyId] }, bindings, signatures: [full(0)], expect: { ok: false, code: "pq-signature-required" } },
];

const out = {
  schema: 1,
  about: "Generated by tools/runtime-manifest-vectors.ts. Each case: the manifest, signatures, the lock text it carries, the lock's signer fingerprints, trust, PQ pin and bindings, the verifier's clock and last sequence, and the expected verdict.",
  now: NOW,
  canonicalV1: Buffer.from(v1).toString(),
  cases: cases.map((c) => {
    // The generator checks its own expectations with the TypeScript verifier, so a vector can never be wrong.
    const r = verifyRuntimeManifest(c.manifest, c.signatures, { trust: c.trust, pqPin: c.pin, pqBindings: c.bindings, lockText: c.lockText, lockSigners: c.lockSigners, now: c.now, ...(c.lastSequence !== undefined ? { lastSequence: c.lastSequence } : {}) });
    if (r.ok !== c.expect.ok || (!r.ok && r.code !== c.expect.code)) throw new Error(`vector "${c.name}": expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(r)}`);
    return c;
  }),
};
const text = JSON.stringify(out, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error("runtime-manifest vectors are stale: run npx tsx tools/runtime-manifest-vectors.ts");
    process.exit(1);
  }
  console.log("runtime-manifest vectors are fresh");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT} (${cases.length} cases)`);
}

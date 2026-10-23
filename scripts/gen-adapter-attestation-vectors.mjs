#!/usr/bin/env node
// Writes packages/protocol/test-vectors/adapter-attestation/vectors.json from the TS reference
// (packages/protocol/src/adapterAttestation.ts, SEC-ADAPTER-002). Build the protocol package first:
//   npx tsc -b packages/protocol && node scripts/gen-adapter-attestation-vectors.mjs
// `--check` exits 1 when the file on disk differs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../packages/protocol/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/protocol/test-vectors/adapter-attestation/vectors.json");
const hex = (b) => Buffer.from(b).toString("hex");
const text = (b) => new TextDecoder().decode(b);
const keypair = (byte) => {
  const privateKey = new Uint8Array(32).fill(byte);
  return { privateKey, publicKey: P.ed.getPublicKey(privateKey) };
};
const flip = (sigHex) => (sigHex[0] === "0" ? "1" : "0") + sigHex.slice(1);

const vet = keypair(0x61);
const other = keypair(0x62);
const T0 = 1_761_264_000_000;
const DAY = 86_400_000;
const pinned = [{ pubHex: hex(vet.publicKey), notBefore: T0 - DAY, notAfter: T0 + 365 * DAY }];

const REPO = "https://github.com/me/notes";
const BASE = "a".repeat(40);
const manifest = JSON.stringify({
  schema_version: 1,
  name: "notes",
  version: "0.1.0",
  description: "Notes",
  runtime: { image: "x", port: 8080 },
  network: { egress: ["api.example.org"] },
});
const adapter = P.deriveRepoAdapter(
  { "index.js": "const port = 3000;\n" },
  { "index.js": "const port = process.env.PORT;\n" },
  { repo: REPO, base: BASE },
);
const file = P.buildAdapterFile(manifest, adapter);
const fileSha = createHash("sha256").update(file).digest("hex");
const capabilityDigestHex = P.adapterFileCapabilityDigest(file);

const pass = {
  adapterDigestHex: fileSha,
  repo: REPO,
  baseRevision: BASE,
  capabilityDigestHex,
  validatorVersion: "adapter-rules/1",
  policyVersion: "adapter-review/1",
  reviewerModel: "claude-haiku-5-5",
  modelVersion: "claude-haiku-5-5-20261001",
  evidenceSha256Hex: "e".repeat(64),
  outcome: "pass",
  issuedAt: T0,
  expiresAt: T0 + 90 * DAY,
};
const revoked = { ...pass, evidenceSha256Hex: "f".repeat(64), outcome: "revoked", issuedAt: T0 + DAY, expiresAt: T0 + 93 * DAY };
const signedPass = P.signAdapterAttestation(pass, vet);
const signedRevoked = P.signAdapterAttestation(revoked, vet);

const index1 = {
  sequence: 1,
  prevDigestHex: "genesis",
  issuedAt: T0,
  expiresAt: T0 + 3 * DAY,
  attestationDigests: [P.attestationDigest(pass)],
  withdrawn: [],
};
const index2 = {
  sequence: 2,
  prevDigestHex: P.adapterIndexDigest(index1),
  issuedAt: T0 + DAY,
  expiresAt: T0 + 4 * DAY,
  attestationDigests: [P.attestationDigest(revoked)],
  withdrawn: [fileSha],
};
const signedIndex1 = P.signAdapterIndex(index1, vet);
const signedIndex2 = P.signAdapterIndex(index2, vet);

const vectors = {
  about:
    "Adapter attestations and the adapter index (SEC-ADAPTER-002). Rebuild `canonical` byte for byte from `fields` (`|` joined, tag first; the index sorts and de-duplicates both digest lists, joined with `,`); the pinned signatures verify under `keys.vetPubHex` inside its window. `file.capabilityDigestHex` is capabilityDigest(capabilitiesOf(manifest)) of the adapter file. Each `indexChecks` entry runs verifyAdapterIndex with the given high-water mark and time and must give `expect`. Each `standing` entry runs adapterStanding over the listed attestations at `now`. A revocation is final.",
  keys: { vetSeedHex: hex(vet.privateKey), vetPubHex: hex(vet.publicKey), otherSeedHex: hex(other.privateKey), pinned },
  file: { text: file, sha256Hex: fileSha, capabilityDigestHex },
  attestations: {
    pass: { fields: pass, canonical: text(P.canonicalAdapterAttestation(pass)), digestHex: P.attestationDigest(pass), signatureHex: signedPass.signatureHex },
    revoked: { fields: revoked, canonical: text(P.canonicalAdapterAttestation(revoked)), digestHex: P.attestationDigest(revoked), signatureHex: signedRevoked.signatureHex },
  },
  attestationRejects: [
    { why: "signature flipped", signed: { ...signedPass, signatureHex: flip(signedPass.signatureHex) } },
    { why: "outcome changed after signing", signed: { ...signedPass, attestation: { ...pass, outcome: "fail" } } },
    { why: "expiry extended after signing", signed: { ...signedPass, attestation: { ...pass, expiresAt: pass.expiresAt + DAY } } },
    { why: "unpinned key", signed: P.signAdapterAttestation(pass, other) },
    { why: "issued before the key's window", signed: P.signAdapterAttestation({ ...pass, issuedAt: T0 - 2 * DAY, expiresAt: T0 }, vet) },
  ],
  indexes: {
    one: { fields: index1, canonical: text(P.canonicalAdapterIndex(index1)), digestHex: P.adapterIndexDigest(index1), signatureHex: signedIndex1.signatureHex },
    two: { fields: index2, canonical: text(P.canonicalAdapterIndex(index2)), digestHex: P.adapterIndexDigest(index2), signatureHex: signedIndex2.signatureHex },
  },
  indexChecks: [
    { why: "first index from scratch", index: "one", highWater: null, now: T0 + 1000, expect: { ok: true, digestHex: P.adapterIndexDigest(index1) } },
    { why: "the next index extends it", index: "two", highWater: { sequence: 1, digestHex: P.adapterIndexDigest(index1) }, now: T0 + DAY + 1000, expect: { ok: true, digestHex: P.adapterIndexDigest(index2) } },
    { why: "rollback", index: "one", highWater: { sequence: 2, digestHex: P.adapterIndexDigest(index2) }, now: T0 + DAY + 1000, expect: { ok: false, reason: "rollback" } },
    { why: "fork at the same sequence", index: "one", highWater: { sequence: 1, digestHex: "9".repeat(64) }, now: T0 + 1000, expect: { ok: false, reason: "fork" } },
    { why: "next sequence not extending", index: "two", highWater: { sequence: 1, digestHex: "9".repeat(64) }, now: T0 + DAY + 1000, expect: { ok: false, reason: "fork" } },
    { why: "expired", index: "one", highWater: null, now: T0 + 3 * DAY, expect: { ok: false, reason: "expired" } },
    { why: "issued in the future", index: "two", highWater: null, now: T0, expect: { ok: false, reason: "not-yet-valid" } },
  ],
  standing: [
    { why: "a current pass", attestations: ["pass"], now: T0 + 1000, expect: "vetted" },
    { why: "a pass past its expiry", attestations: ["pass"], now: T0 + 90 * DAY, expect: "expired" },
    { why: "a revocation beats the pass", attestations: ["pass", "revoked"], now: T0 + 2 * DAY, expect: "revoked" },
    { why: "a revocation beats a later pass", attestations: ["revoked", "laterPass"], now: T0 + 3 * DAY, expect: "revoked" },
    { why: "nothing about this digest", attestations: [], now: T0, expect: "none" },
  ],
  laterPass: { ...pass, issuedAt: T0 + 2 * DAY, expiresAt: T0 + 92 * DAY },
};

const json = JSON.stringify(vectors, null, 2) + "\n";
if (process.argv.includes("--check")) {
  let have = "";
  try {
    have = readFileSync(out, "utf8");
  } catch {}
  if (have !== json) {
    console.error(`✗ ${out} is stale (run: node scripts/gen-adapter-attestation-vectors.mjs)`);
    process.exit(1);
  }
  console.log("adapter attestation vectors are current");
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(`wrote ${out}`);
}

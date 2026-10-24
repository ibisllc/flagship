#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for the CA lease's PQ companion (packages/protocol/src/caLeasePq.ts). The
 * TypeScript port GENERATES them; packages/protocol/tests/caLeasePq.test.ts checks them. The
 * phones and the webapp do not verify the PQ half yet (parity allowlist).
 *
 * Run:          npx tsx tools/ca-lease-pq-vectors.ts
 * CI freshness: npx tsx tools/ca-lease-pq-vectors.ts --check
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalCaEndorsement, type CaEndorsement } from "@ibisllc/maintainers";
import { ed25519 } from "@noble/curves/ed25519.js";
import { CA_LEASE_PQ_BINDING_SUBJECT, caLeaseV1Digest, gateCaLeasesPq, signCaLeasePq, type CaLeasePqPin } from "../packages/protocol/src/caLeasePq.js";
import { hybridSign, hybridSigKeygen, pqKeyId, SUITE_HYBRID_SIG_ED25519_MLDSA65_V1 } from "../packages/protocol/src/pqHybrid.js";
import { signPqKeyBinding, TAG_PQ_KEY_BINDING } from "../packages/protocol/src/pqTrust.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/ca-lease-pq/vectors.json");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const fill = (v: number): Uint8Array => new Uint8Array(32).fill(v);
const NOW = 1_790_000_000_000;

const holder = hybridSigKeygen(fill(0x51), fill(0x61));
const holderEd = hex(holder.publicKey.subarray(0, 32));
const keyId = hex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, holder.publicKey));
const binding = signPqKeyBinding(
  { role: "release-key", subjectId: CA_LEASE_PQ_BINDING_SUBJECT, ed25519PubHex: holderEd, mldsaPubHex: hex(holder.publicKey.subarray(32)), issuedAt: NOW },
  (m) => hybridSign(holder.secretKey, TAG_PQ_KEY_BINDING, m, { deterministic: true }),
);

function lease(id: string, caPubkey: string): CaEndorsement {
  const e = {
    kind: "CaEndorsement" as const,
    version: 1 as const,
    endorsementId: id,
    track: "ca",
    caPubkey,
    scope: "flagship/directory-attestation",
    notBefore: "2026-10-19T01:36:06.489Z",
    notAfter: "2027-01-17T01:36:06.489Z",
    issuedAt: "2026-10-19T01:36:06.489Z",
    signedBy: holderEd,
  };
  return { ...e, signatures: [{ pubkey: holderEd, sig: hex(ed25519.sign(canonicalCaEndorsement(e), fill(0x51))) }] } as CaEndorsement;
}

const a = lease("6f1c2d3e-0000-4000-8000-00000000000a", "a".repeat(64));
const b = lease("6f1c2d3e-0000-4000-8000-00000000000b", "b".repeat(64));
const ed = async (m: Uint8Array) => ed25519.sign(m, fill(0x51));
const key = { ed25519PubHex: holderEd, mldsaPubHex: hex(holder.publicKey.subarray(32)) };
const pqA = await signCaLeasePq(a, key, ed, fill(0x61), { deterministic: true });
const pqB = await signCaLeasePq(b, key, ed, fill(0x61), { deterministic: true });
const pin: CaLeasePqPin = { version: 1, keyIds: [keyId], legacyLeases: [] };
const flip = (h: string): string => h.slice(0, -2) + (h.slice(-2) === "00" ? "01" : "00");

type Case = { name: string; pin: CaLeasePqPin; bindings: unknown[]; endorsements: unknown[]; accepted: string[] };
const cases: Case[] = [
  { name: "no pin: every lease counts", pin: { version: 1, keyIds: [], legacyLeases: [] }, bindings: [], endorsements: [], accepted: [a.endorsementId, b.endorsementId] },
  { name: "pinned: both leases with their companions", pin, bindings: [binding], endorsements: [pqA, pqB], accepted: [a.endorsementId, b.endorsementId] },
  { name: "pinned: a lease whose companion was stripped", pin, bindings: [binding], endorsements: [pqA], accepted: [a.endorsementId] },
  { name: "pinned: the companions without the binding", pin, bindings: [], endorsements: [pqA, pqB], accepted: [] },
  { name: "pinned: a companion moved to another lease", pin, bindings: [binding], endorsements: [{ ...pqA, endorsementId: b.endorsementId }], accepted: [] },
  { name: "pinned: a forged companion signature", pin, bindings: [binding], endorsements: [{ ...pqA, signature: flip(pqA.signature) }, pqB], accepted: [b.endorsementId] },
  { name: "pinned: a binding for another purpose", pin, bindings: [{ ...binding, subjectId: "flagship-release" }], endorsements: [pqA, pqB], accepted: [] },
  { name: "pinned: another key in the pin", pin: { ...pin, keyIds: ["c".repeat(64)] }, bindings: [binding], endorsements: [pqA, pqB], accepted: [] },
  { name: "pinned: a lease signed before the cut-over", pin: { ...pin, legacyLeases: [caLeaseV1Digest(a)!] }, bindings: [binding], endorsements: [pqB], accepted: [a.endorsementId, b.endorsementId] },
];
for (const c of cases) {
  const got = gateCaLeasesPq([a, b], { bindings: c.bindings, endorsements: c.endorsements }, { pin: c.pin, now: NOW }).accepted.map((e) => e.endorsementId);
  if (JSON.stringify(got) !== JSON.stringify(c.accepted)) throw new Error(`${c.name}: ${JSON.stringify(got)}`);
}
const doc = {
  about:
    "The PQ companion of a CaEndorsement lease (packages/protocol/src/caLeasePq.ts): flagship/ca-lease/v2|<endorsementId>|<sha256(v1)>|<signedBy>|<keyId>, hybrid-signed under the ca-track holder's release-key binding (subject flagship-ca-track). With a non-empty pin a lease counts only with a verified companion unless its v1 digest is in legacyLeases. Each case lists the endorsementIds that must be accepted, in order.",
  now: NOW,
  leases: [a, b],
  v1Digests: [caLeaseV1Digest(a), caLeaseV1Digest(b)],
  keyId,
  cases,
};
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(`${OUT} is stale: run npx tsx tools/ca-lease-pq-vectors.ts`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote ${cases.length} cases to ${OUT}`);
}

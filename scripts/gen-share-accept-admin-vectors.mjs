#!/usr/bin/env node
// Writes packages/protocol/test-vectors/server-share-accept-admin/vectors.json
// from the TS reference: envelope #12 of docs/share-a-server.md (only an admin
// device of the joining account accepts a share). Build the protocol package
// first:
//   npx tsc -b packages/protocol && node scripts/gen-share-accept-admin-vectors.mjs
// `--check` exits 1 when the file on disk differs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../packages/protocol/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/protocol/test-vectors/server-share-accept-admin/vectors.json");
const hex = (b) => Buffer.from(b).toString("hex");
const fill = (n, v) => new Uint8Array(n).fill(v);
const keypair = (seed) => ({ privateKey: seed, publicKey: P.ed.getPublicKey(seed) });

const umkB = { seed: fill(32, 0x5b) };
const adminRoot = keypair(fill(32, 0x3c));
const otherAdmin = keypair(fill(32, 0x4d));
const irk = P.deriveIRK(umkB);
const ca = keypair(fill(32, 0xca));
const shareId = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const member = P.deriveShareMemberKey(umkB, shareId);
const memberPubHex = hex(member.publicKey);
const serverDomain = "home.harry.flagship.services";
const t0 = 1_760_000_000_000;

const keys = {
  memberUmkSeedHex: hex(umkB.seed),
  shareId,
  memberPubHex,
  adminRootSeedHex: hex(adminRoot.privateKey),
  adminRootPubHex: hex(adminRoot.publicKey),
  otherAdminSeedHex: hex(otherAdmin.privateKey),
  otherAdminPubHex: hex(otherAdmin.publicKey),
  irkPubHex: hex(irk.publicKey),
  caSeedHex: hex(ca.privateKey),
  caPubHex: hex(ca.publicKey),
};
const signers = { adminRoot, otherAdmin, irk, member };

const accept = { serverDomain, shareId, memberPubHex, acceptedAt: t0 + 3 };
const admit = { ...accept, keyKind: "admin-root", keyPubHex: keys.adminRootPubHex };
const admitIrk = { ...accept, keyKind: "irk", keyPubHex: keys.irkPubHex };
const canon = P.serverShareAcceptAdminCanonicalBytes;

const envelopes = [
  ["adminRoot", admit],
  ["irk", admitIrk],
].map(([signer, fields]) => {
  const bytes = canon(fields);
  return {
    kind: "accept-admin",
    signer,
    fields,
    canonical: new TextDecoder().decode(bytes),
    signature: hex(P.ed.sign(bytes, signers[signer].privateKey)),
  };
});

const refuse = [
  ["keyKind is unknown", { ...admit, keyKind: "device" }],
  ["keyPubHex is not 64 hex", { ...admit, keyPubHex: keys.adminRootPubHex.slice(2) }],
  ["keyPubHex is uppercase", { ...admit, keyPubHex: keys.adminRootPubHex.toUpperCase() }],
  ["shareId is uppercase", { ...admit, shareId: shareId.toUpperCase() }],
  ["memberPubHex is not 64 hex", { ...admit, memberPubHex: "ab" }],
  ["serverDomain carries the separator", { ...admit, serverDomain: "a|b" }],
  ["serverDomain is empty", { ...admit, serverDomain: "" }],
  ["acceptedAt is negative", { ...admit, acceptedAt: -1 }],
].map(([why, fields]) => {
  let threw = false;
  try {
    canon(fields);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`refuse case did not throw: ${why}`);
  return { kind: "accept-admin", why, fields };
});

const sigOf = (fields, key) => hex(P.ed.sign(canon(fields), key.privateKey));
const a0 = envelopes[0].signature;
const reject = [
  { why: "signed by another account's admin root", fields: admit, signature: sigOf(admit, otherAdmin), pub: "adminRoot" },
  { why: "a non-admin device signed with the member key", fields: admit, signature: sigOf(admit, member), pub: "adminRoot" },
  { why: "moved to another share after signing", fields: { ...admit, shareId: "00112233445566778899aabbccddeeff" }, signature: a0, pub: "adminRoot" },
  { why: "moved to another server after signing", fields: { ...admit, serverDomain: "media.harry.flagship.services" }, signature: a0, pub: "adminRoot" },
  { why: "member key swapped after signing", fields: { ...admit, memberPubHex: "ee".repeat(32) }, signature: a0, pub: "adminRoot" },
  { why: "acceptedAt moved after signing", fields: { ...admit, acceptedAt: t0 + 4 }, signature: a0, pub: "adminRoot" },
  { why: "keyKind relabelled after signing", fields: { ...admit, keyKind: "irk" }, signature: a0, pub: "adminRoot" },
  {
    why: "a #3 member-key accept signature replayed as #12",
    fields: admit,
    signature: hex(P.ed.sign(P.serverShareAcceptCanonicalBytes(accept), member.privateKey)),
    pub: "member",
  },
];
const pubOf = { adminRoot: adminRoot.publicKey, member: member.publicKey };
for (const r of reject) {
  if (P.ed.verify(Buffer.from(r.signature, "hex"), canon(r.fields), pubOf[r.pub])) {
    throw new Error(`reject case verifies: ${r.why}`);
  }
}

// The attestation the box checks (TS and the box only: the apps carry it as is).
const attestation = P.signAccountKeyAttestation(
  { keyKind: "admin-root", keyPubHex: keys.adminRootPubHex, issuedAt: t0, expiresAt: t0 + P.ACCOUNT_KEY_ATTESTATION_TTL_MS },
  ca,
);
const attestationCase = {
  attestation,
  canonical: new TextDecoder().decode(P.canonicalAccountKeyAttestation(attestation)),
};

// The sealed acceptance's plaintext with the admin proof, as every app writes it.
const payload = {
  v: 1,
  accept,
  signature: hex(P.ed.sign(P.serverShareAcceptCanonicalBytes(accept), member.privateKey)),
  admin: { admit, signature: a0, attestation },
};
if (!P.parseShareAcceptancePayload(payload)?.admin) throw new Error("payload does not parse");

const doc = {
  about:
    "Envelope #12 of docs/share-a-server.md: only an admin device of the joining account accepts a share. Every platform must build each envelope's canonical string from `fields` and reproduce the Ed25519 signature with the named signer (adminRoot = Ed25519 seed adminRootSeedHex, irk = the protocol IRK of memberUmkSeedHex, member = deriveShareMemberKey(memberUmk, shareId)); refuse every `refuse` case; fail to verify every `reject` case against the named public key; and parse `payload` (the sealed acceptance's plaintext) keeping its `admin` proof. `attestation` is `.com`'s CA-signed AccountKeyAttestation (CA = Ed25519 seed caSeedHex); only TS and the box check it, the apps carry it unchanged.",
  keys,
  envelopes,
  refuse,
  reject,
  attestation: attestationCase,
  payload,
};
const text = `${JSON.stringify(doc, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let cur = "";
  try {
    cur = readFileSync(out, "utf8");
  } catch {}
  if (cur !== text) {
    console.error(`${out} is stale: run node scripts/gen-share-accept-admin-vectors.mjs`);
    process.exit(1);
  }
  console.log("share accept-admin vectors up to date");
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ${out}`);
}

#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for the hybrid companions of admin-root rotations and device capability grants
 * (packages/protocol/src/pqAuthorityRecords.ts, docs/architecture-v2/pq-suites.md §20). TypeScript
 * generates them; packages/protocol/tests/pqAuthorityRecords.test.ts, the Swift
 * PqAuthorityVectorTests and the Kotlin PqAuthorityVectorsTest check them.
 *
 * Run:          npx tsx tools/pq-authority-vectors.ts
 * CI freshness: npx tsx tools/pq-authority-vectors.ts --check
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hybridSigKeygen, hybridSign } from "../packages/protocol/src/pqHybrid.js";
import { canonicalPqKeyBinding, type PqKeyBindingStatement, type PqKeyBindingWire } from "../packages/protocol/src/pqTrust.js";
import { canonicalDeviceCapabilityGrant, type DeviceCapabilityGrant } from "../packages/protocol/src/deviceCapability.js";
import {
  TAG_ADMIN_ROOT_ROTATION_V2,
  canonicalAdminRootRotationV2,
  pqBindingKeyIdHex,
  signAdminRootRotationPq,
  signDeviceGrantPq,
} from "../packages/protocol/src/pqAuthorityRecords.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/pq-authority/vectors.json");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);

interface Signer {
  name: string;
  edSeedHex: string;
  mldsaSeedHex: string;
  ed25519PubHex: string;
  mldsaPubHex: string;
  secret: Uint8Array;
}

function signer(name: string, a: number, b: number): Signer {
  const { publicKey, secretKey } = hybridSigKeygen(fill(32, a), fill(32, b));
  return {
    name,
    edSeedHex: hex(fill(32, a)),
    mldsaSeedHex: hex(fill(32, b)),
    ed25519PubHex: hex(publicKey.subarray(0, 32)),
    mldsaPubHex: hex(publicKey.subarray(32)),
    secret: secretKey,
  };
}

const OLD = signer("oldRoot", 0x71, 0x72);
const NEW = signer("newRoot", 0x73, 0x74);
const IRK = signer("irk", 0x75, 0x76);
const OTHER = signer("other", 0x77, 0x78);
const USER = "alice";
const NOW = 1_795_000_000_000;
const ISSUED = NOW - 60_000;

/** A binding of `ed`'s Ed25519 key to `ml`'s ML-DSA key, signed by both (the secret is ed seed || ml seed). */
function bind(ed: Signer, ml: Signer, role: PqKeyBindingStatement["role"], subjectId = USER): PqKeyBindingWire {
  const st: PqKeyBindingStatement = { role, subjectId, ed25519PubHex: ed.ed25519PubHex, mldsaPubHex: ml.mldsaPubHex, issuedAt: ISSUED };
  const secret = new Uint8Array([...unhex(ed.edSeedHex), ...unhex(ml.mldsaSeedHex)]);
  return { v: 1, ...st, signature: hex(hybridSign(secret, "flagship/pq-key-binding/v1", canonicalPqKeyBinding(st), { deterministic: true })) };
}

const bindings = {
  oldRoot: bind(OLD, OLD, "admin-root"),
  newRoot: bind(NEW, NEW, "admin-root"),
  irk: bind(IRK, IRK, "account-irk"),
  other: bind(OTHER, OTHER, "admin-root"),
  newRootOtherMldsa: bind(NEW, OTHER, "admin-root"),
  newRootWrongSubject: bind(NEW, NEW, "admin-root", "bob"),
};

const strict = { profile: "strict", rollout: "enforced" };
const compat = { profile: "compatibility", rollout: "legacy" };

// ── rotation ────────────────────────────────────────────────────────────
const rotationFields = { username: USER, oldAdminRootPubHex: OLD.ed25519PubHex, newAdminRootPubHex: NEW.ed25519PubHex, issuedAt: NOW - 1000 };
const rotation = {
  username: USER,
  oldAdminRootPub: unhex(OLD.ed25519PubHex),
  newAdminRootPub: unhex(NEW.ed25519PubHex),
  issuedAt: rotationFields.issuedAt,
};
const newKeyId = pqBindingKeyIdHex(bindings.newRoot);
const pq = signAdminRootRotationPq(rotation, OLD.secret, bindings.newRoot, { deterministic: true });
const byNew = signAdminRootRotationPq(rotation, NEW.secret, bindings.newRoot, { deterministic: true });
const otherMl = { ...pq, newRootBinding: bindings.newRootOtherMldsa };
const classical = { ...pq, signature: { suite: "ed25519/v1", signature: "00".repeat(64) } };
const flipped = { ...pq, signature: { ...pq.signature, signature: pq.signature.signature.slice(0, -2) + (pq.signature.signature.endsWith("00") ? "01" : "00") } };

type Expect = { ok: true } | { ok: false; code: string };
const ok: Expect = { ok: true };
const no = (code: string): Expect => ({ ok: false, code });

const rotationCases = [
  { name: "strict: old root's hybrid signature naming the new root's binding", pq, oldRootBinding: "oldRoot", policy: strict, expect: ok },
  { name: "compatibility: a companion that is sent still verifies", pq, oldRootBinding: "oldRoot", policy: compat, expect: ok },
  { name: "classical suite in the companion", pq: classical, oldRootBinding: "oldRoot", policy: strict, expect: no("strict-requires-hybrid") },
  { name: "new root's binding swapped for one naming another ML-DSA key", pq: otherMl, oldRootBinding: "oldRoot", policy: strict, expect: no("bad-signature") },
  { name: "signed by the new root instead of the old", pq: byNew, oldRootBinding: "oldRoot", policy: strict, expect: no("bad-signature") },
  { name: "one bit of the signature flipped", pq: flipped, oldRootBinding: "oldRoot", policy: strict, expect: no("bad-signature") },
  { name: "strict: the verifier holds no binding for the old root", pq, oldRootBinding: null, policy: strict, expect: no("strict-requires-binding") },
  { name: "compatibility: no binding for the old root", pq, oldRootBinding: null, policy: compat, expect: no("no-binding") },
  { name: "old-root binding of another key", pq, oldRootBinding: "other", policy: strict, expect: no("binding-key-mismatch") },
  { name: "new root's binding names another account", pq: { ...pq, newRootBinding: bindings.newRootWrongSubject }, oldRootBinding: "oldRoot", policy: strict, expect: no("binding-subject") },
  { name: "no companion at all", pq: null, oldRootBinding: "oldRoot", policy: strict, expect: no("strict-requires-hybrid") },
];

// ── device grants ───────────────────────────────────────────────────────
const devicePub = "ab".repeat(32);
const grantFields = (scopes: string[], grantId: string) => ({
  grantId,
  username: USER,
  deviceId: "0123456789abcdef0123456789abcdef",
  devicePubKeyHex: devicePub,
  scopes,
  issuedAt: NOW - 5000,
  expiresAt: NOW - 5000 + 90 * 24 * 3_600_000,
});
const toGrant = (f: ReturnType<typeof grantFields>): DeviceCapabilityGrant => ({
  grantId: f.grantId,
  username: f.username,
  deviceId: f.deviceId,
  devicePubKey: unhex(f.devicePubKeyHex),
  scopes: f.scopes as DeviceCapabilityGrant["scopes"],
  issuedAt: f.issuedAt,
  expiresAt: f.expiresAt,
});
const adminGrant = grantFields(["admin", "browse", "add-device"], "6b0f8a52-3c1d-4e2b-9a7f-0d1e2f3a4b5c");
const memberGrant = grantFields(["browse"], "7c1f9b63-4d2e-4f3c-8b80-1e2f3a4b5c6d");
const adminPq = signDeviceGrantPq(toGrant(adminGrant), OLD.secret, { deterministic: true });
const memberPq = signDeviceGrantPq(toGrant(memberGrant), IRK.secret, { deterministic: true });

const grantCases = [
  { name: "admin grant, admin root's companion, strict", grant: adminGrant, pq: adminPq, signer: "oldRoot", signerBinding: "oldRoot", policy: strict, expect: ok },
  { name: "member grant, IRK's companion, compatibility", grant: memberGrant, pq: memberPq, signer: "irk", signerBinding: "irk", policy: compat, expect: ok },
  { name: "scopes widened after signing", grant: { ...memberGrant, scopes: ["browse", "admin"] }, pq: memberPq, signer: "irk", signerBinding: "irk", policy: strict, expect: no("bad-signature") },
  { name: "companion presented for another root", grant: adminGrant, pq: adminPq, signer: "irk", signerBinding: "irk", policy: strict, expect: no("bad-signature") },
  { name: "binding of another key than the signer", grant: adminGrant, pq: adminPq, signer: "oldRoot", signerBinding: "irk", policy: strict, expect: no("binding-key-mismatch") },
  { name: "classical suite in the companion", grant: adminGrant, pq: { suite: "ed25519/v1", signature: "00".repeat(64) }, signer: "oldRoot", signerBinding: "oldRoot", policy: strict, expect: no("strict-requires-hybrid") },
  { name: "strict: no binding for the signer", grant: adminGrant, pq: adminPq, signer: "oldRoot", signerBinding: null, policy: strict, expect: no("strict-requires-binding") },
];

const doc = {
  about:
    "Hybrid companions for admin-root rotations (flagship/admin-root-rotation/v2) and device capability grants (flagship/device-capability-grant/v2). Every port must build `rotation.canonical` from `rotation.fields` and `rotation.newRootKeyId`, and each grant's `canonical` from its fields, byte for byte; verify every case with its gate (bindings from `bindings`, verified with role and subject as named, `now` = `now`) and get `expect`. The ML-DSA halves are deterministic (rnd = 0^32), so a port that re-signs with the signer seeds reproduces everything after the first 128 hex characters of each signature.",
  tag: TAG_ADMIN_ROOT_ROTATION_V2,
  now: NOW,
  signers: [OLD, NEW, IRK, OTHER].map(({ secret: _s, ...s }) => s),
  bindings,
  rotation: {
    fields: rotationFields,
    newRootKeyId: newKeyId,
    canonical: new TextDecoder().decode(canonicalAdminRootRotationV2(rotation, newKeyId)),
    pq,
  },
  rotationCases,
  grants: {
    admin: { fields: adminGrant, canonical: new TextDecoder().decode(canonicalDeviceCapabilityGrant(toGrant(adminGrant))), pq: adminPq },
    member: { fields: memberGrant, canonical: new TextDecoder().decode(canonicalDeviceCapabilityGrant(toGrant(memberGrant))), pq: memberPq },
  },
  grantCases,
};

const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  let cur = "";
  try {
    cur = readFileSync(OUT, "utf8");
  } catch {
    /* missing */
  }
  if (cur !== text) {
    console.error(`${OUT} is stale: run npx tsx tools/pq-authority-vectors.ts`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
}

#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for the account master-key rotation (packages/protocol/src/accountKeyRotation.ts).
 * TypeScript generates them with fixed seeds and fixed seal randomness; packages/protocol/tests/
 * accountKeyRotation.test.ts, the Swift AccountKeyRotationVectorTests, the Kotlin
 * AccountKeyRotationVectorsTest and apps/web/tests/webappAccountKeyRotationVectors.test.ts check
 * them. Ed25519 and the X-Wing seal (fixed randomness) reproduce byte for byte in every port; the
 * Ed25519-recipient seal is checked in the open direction; `chainCases` are the box's (TS only).
 *
 * Run:          npx tsx tools/account-key-rotation-vectors.ts
 * CI freshness: npx tsx tools/account-key-rotation-vectors.ts --check
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "../packages/protocol/src/edSync.js";
import { hybridSealKeygen, hybridSigKeygen, hybridSign } from "../packages/protocol/src/pqHybrid.js";
import { canonicalPqKeyBinding, type PqKeyBindingStatement, type PqKeyBindingWire } from "../packages/protocol/src/pqTrust.js";
import { deriveAccountDeviceKeySeed } from "../packages/protocol/src/accountMetadata.js";
import { signAdminRootRotation } from "../packages/protocol/src/adminRootRotation.js";
import { signAdminRootRotationPq } from "../packages/protocol/src/pqAuthorityRecords.js";
import {
  TAG_ACCOUNT_KEY_ROTATION,
  TAG_ACCOUNT_KEY_ROTATION_V2,
  TAG_CGK_REKEY,
  TAG_DEVICE_KEY_ROTATE,
  TAG_DEVICE_RECEIVE_KEY,
  TAG_LUKS_REKEY_CONFIRM,
  TAG_SWK_REKEY,
  TAG_UMK_ROTATION_DELIVERY,
  accountKeyRotationDigestHex,
  buildUmkRotationDelivery,
  canonicalAccountKeyRotation,
  canonicalAccountKeyRotationV2,
  canonicalCgkRekey,
  canonicalDeviceKeyRotate,
  canonicalDeviceReceiveKey,
  canonicalLuksRekeyConfirm,
  canonicalSwkRekey,
  canonicalUmkRotationDelivery,
  deriveAidSeed,
  deriveIrkSeedInScheme,
  encodeUmkRotationPlaintext,
  keptDevicesDigestHex,
  keptDevicesLines,
  sealUmkRotation,
  signAccountKeyRotation,
  signAccountKeyRotationPq,
  signDeviceKeyRotate,
  signDeviceReceiveKey,
  signRekey,
  umkDeliverySenderKeyId,
  type AccountKeyRotation,
  type AccountKeyRotationSignatures,
  type AccountKeyState,
  type IrkScheme,
} from "../packages/protocol/src/accountKeyRotation.js";
import { pqBindingKeyIdHex } from "../packages/protocol/src/pqAuthorityRecords.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/account-key-rotation/vectors.json");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);
const seq = (f: (i: number) => number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => f(i) & 0xff);
const utf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

const USER = "alice";
const NOW = 1_795_000_000_000;
const ISSUED = NOW - 60_000;

interface Key { seedHex: string; pubHex: string; seed: Uint8Array }
const key = (seed: Uint8Array): Key => ({ seed, seedHex: hex(seed), pubHex: hex(ed.getPublicKey(seed)) });
const pub = (k: Key) => k.pubHex;

/** A hybrid signer: Ed25519 seed `a`, ML-DSA seed `b`. */
function hybrid(a: number, b: number) {
  const { publicKey, secretKey } = hybridSigKeygen(fill(32, a), fill(32, b));
  return { ...key(fill(32, a)), mldsaSeedHex: hex(fill(32, b)), mldsaPubHex: hex(publicKey.subarray(32)), secret: secretKey };
}

const ADMIN = hybrid(0x81, 0x82);
const OTHER = hybrid(0x83, 0x84);
const ADMIN2 = hybrid(0x85, 0x86);

const OLD_UMK = seq((i) => i * 3 + 1);
const NEW_UMK = seq((i) => 0xa0 + i);
const NEW_UMK2 = seq((i) => 0x40 + i * 5);
const irk = (umk: Uint8Array, scheme: IrkScheme, v: number) => key(deriveIrkSeedInScheme(umk, scheme, v));
const OLD_IRK = irk(OLD_UMK, "web", 2);
const NEW_IRK = irk(NEW_UMK, "ios", 1);
const NEW_IRK2 = irk(NEW_UMK2, "android", 1);
const OLD_AID = key(deriveAidSeed(OLD_UMK));
const NEW_AID = key(deriveAidSeed(NEW_UMK));
const NEW_AID2 = key(deriveAidSeed(NEW_UMK2));
const NEW_IRK_MLDSA = fill(32, 0x91);
const NEW_IRK2_MLDSA = fill(32, 0x92);

const ID = { a: "a".repeat(32), b: "b".repeat(32), c: "c".repeat(32), d: "d".repeat(32), e: "e".repeat(32) };
const DEV = {
  a: key(fill(32, 0x11)),
  b: key(fill(32, 0x12)),
  c: key(fill(32, 0x14)),
  e: key(deriveAccountDeviceKeySeed(OLD_UMK, USER, ID.e)),
  eNew: key(fill(32, 0x15)),
};
const B_RECEIVE_SEED = fill(32, 0x13);
const B_RECEIVE_PUB = hybridSealKeygen(B_RECEIVE_SEED).publicKey;

const kept = [
  { deviceId: ID.c, devicePubHex: pub(DEV.c) },
  { deviceId: ID.a, devicePubHex: pub(DEV.a) },
  { deviceId: ID.b, devicePubHex: pub(DEV.b) },
];
const keptDigest = keptDevicesDigestHex(kept);

const rotation: AccountKeyRotation = {
  username: USER,
  fromEpoch: 0,
  toEpoch: 1,
  oldIrkPubHex: pub(OLD_IRK),
  newIrkPubHex: pub(NEW_IRK),
  newIrkScheme: "ios",
  oldAidPubHex: pub(OLD_AID),
  newAidPubHex: pub(NEW_AID),
  adminRootPubHex: pub(ADMIN),
  removedDeviceIds: [ID.e, ID.d],
  keptDevicesDigestHex: keptDigest,
  recoveryRecordDigestHex: hex(sha256(new TextEncoder().encode("recovery record v2, generation 2"))),
  nonceHex: "0f".repeat(16),
  issuedAt: NOW - 1000,
};
type Signer = { seed: Uint8Array };
const kp = (k: Signer) => ({ privateKey: k.seed, publicKey: ed.getPublicKey(k.seed) });
const sign = (r: AccountKeyRotation, adminRoot: Signer = ADMIN, newIrk: Signer = NEW_IRK, newAid: Signer = NEW_AID): AccountKeyRotationSignatures =>
  signAccountKeyRotation(r, { adminRoot: kp(adminRoot), newIrk: kp(newIrk), newAid: kp(newAid) });
const signatures = sign(rotation);

const state: AccountKeyState = { username: USER, epoch: 0, irkPubHex: pub(OLD_IRK), aidPubHex: pub(OLD_AID), adminRootPubHex: pub(ADMIN) };

type Expect = { ok: true } | { ok: false; code: string };
const ok: Expect = { ok: true };
const no = (code: string): Expect => ({ ok: false, code });
const flipLast = (h: string): string => h.slice(0, -2) + (h.endsWith("00") ? "01" : "00");

const SMALL_ORDER = "01" + "00".repeat(31);
const at = (over: Partial<AccountKeyRotation>): AccountKeyRotation => ({ ...rotation, ...over });
const epochGap = at({ fromEpoch: 1, toEpoch: 2 });
const badStep = at({ toEpoch: 2 });
const byIrk = at({ adminRootPubHex: pub(OLD_IRK) });
const byOther = at({ adminRootPubHex: pub(OTHER) });
const sameAid = at({ newAidPubHex: pub(OLD_AID) });
const weakIrk = at({ newIrkPubHex: SMALL_ORDER });
const otherAccount = at({ username: "bob" });

const hopCases = [
  { name: "admin root signs, new IRK and AID prove possession", rotation, signatures, state, expect: ok },
  { name: "signed by the old IRK, claiming it as the admin root", rotation: byIrk, signatures: sign(byIrk, OLD_IRK), state, expect: no("signed-by-irk") },
  { name: "names another admin root than the pinned one", rotation: byOther, signatures: sign(byOther, OTHER), state, expect: no("wrong-admin-root") },
  { name: "names the pinned admin root but another key signed", rotation, signatures: sign(rotation, OTHER), state, expect: no("bad-admin-signature") },
  { name: "a field changed after signing", rotation: at({ keptDevicesDigestHex: "00".repeat(32) }), signatures, state, expect: no("bad-admin-signature") },
  { name: "skips an epoch", rotation: epochGap, signatures: sign(epochGap), state, expect: no("epoch-gap") },
  { name: "replays a hop the verifier already applied", rotation, signatures, state: { ...state, epoch: 1 }, expect: no("stale-epoch") },
  { name: "moves two epochs at once", rotation: badStep, signatures: sign(badStep), state, expect: no("bad-epoch-step") },
  { name: "old IRK is not the one the verifier holds", rotation, signatures, state: { ...state, irkPubHex: pub(NEW_IRK2) }, expect: no("wrong-old-irk") },
  { name: "old AID is not the one the verifier pinned", rotation, signatures, state: { ...state, aidPubHex: pub(NEW_AID2) }, expect: no("wrong-old-aid") },
  { name: "the verifier never pinned an AID", rotation, signatures, state: { ...state, aidPubHex: null }, expect: ok },
  { name: "another account", rotation: otherAccount, signatures: sign(otherAccount), state, expect: no("wrong-account") },
  { name: "new IRK is a small-order key", rotation: weakIrk, signatures: sign(weakIrk), state, expect: no("weak-key") },
  { name: "new AID equals the old AID", rotation: sameAid, signatures: sign(sameAid, ADMIN, NEW_IRK, OLD_AID), state, expect: no("key-not-new") },
  { name: "new IRK signature flipped", rotation, signatures: { ...signatures, newIrkSignatureHex: flipLast(signatures.newIrkSignatureHex) }, state, expect: no("bad-new-irk-signature") },
  { name: "new AID signature made by the new IRK", rotation, signatures: { ...signatures, newAidSignatureHex: signatures.newIrkSignatureHex }, state, expect: no("bad-new-aid-signature") },
  { name: "uppercase hex in the nonce", rotation: at({ nonceHex: "0F".repeat(16) }), signatures, state, expect: no("malformed") },
];

// ── PQ companion ────────────────────────────────────────────────────────
function bind(edSeed: Uint8Array, mlSeed: Uint8Array, role: PqKeyBindingStatement["role"], subjectId = USER): PqKeyBindingWire {
  const { publicKey } = hybridSigKeygen(edSeed, mlSeed);
  const st: PqKeyBindingStatement = { role, subjectId, ed25519PubHex: hex(publicKey.subarray(0, 32)), mldsaPubHex: hex(publicKey.subarray(32)), issuedAt: ISSUED };
  const secret = new Uint8Array([...edSeed, ...mlSeed]);
  return { v: 1, ...st, signature: hex(hybridSign(secret, "flagship/pq-key-binding/v1", canonicalPqKeyBinding(st), { deterministic: true })) };
}
const bindings = {
  adminRoot: bind(ADMIN.seed, unhex(ADMIN.mldsaSeedHex), "admin-root"),
  other: bind(OTHER.seed, unhex(OTHER.mldsaSeedHex), "admin-root"),
  admin2: bind(ADMIN2.seed, unhex(ADMIN2.mldsaSeedHex), "admin-root"),
  newIrk: bind(NEW_IRK.seed, NEW_IRK_MLDSA, "account-irk"),
  newIrk2: bind(NEW_IRK2.seed, NEW_IRK2_MLDSA, "account-irk"),
  newIrkWrongSubject: bind(NEW_IRK.seed, NEW_IRK_MLDSA, "account-irk", "bob"),
  newIrkWrongRole: bind(NEW_IRK.seed, NEW_IRK_MLDSA, "device"),
};
const strict = { profile: "strict", rollout: "enforced" };
const compat = { profile: "compatibility", rollout: "legacy" };
const newIrkKeyId = pqBindingKeyIdHex(bindings.newIrk);
const pq = signAccountKeyRotationPq(rotation, ADMIN.secret, bindings.newIrk, { deterministic: true });
const pqByOther = signAccountKeyRotationPq(rotation, OTHER.secret, bindings.newIrk, { deterministic: true });
/** Signatures by name; each case assembles `{ signature: pqSignatures[signature], newIrkBinding: bindings[binding] }`, or no companion. */
const pqSignatures = {
  adminRoot: pq.signature,
  other: pqByOther.signature,
  classical: { suite: "ed25519/v1", signature: "00".repeat(64) },
};
const pqCases = [
  { name: "strict: admin root's hybrid signature naming the new IRK's binding", signature: "adminRoot", binding: "newIrk", adminRootBinding: "adminRoot", policy: strict, expect: ok },
  { name: "compatibility: a companion that is sent still verifies", signature: "adminRoot", binding: "newIrk", adminRootBinding: "adminRoot", policy: compat, expect: ok },
  { name: "signed by another root's hybrid key", signature: "other", binding: "newIrk", adminRootBinding: "adminRoot", policy: strict, expect: no("bad-signature") },
  { name: "classical suite in the companion", signature: "classical", binding: "newIrk", adminRootBinding: "adminRoot", policy: strict, expect: no("strict-requires-hybrid") },
  { name: "new IRK's binding names another account", signature: "adminRoot", binding: "newIrkWrongSubject", adminRootBinding: "adminRoot", policy: strict, expect: no("binding-subject") },
  { name: "new IRK's binding has another role", signature: "adminRoot", binding: "newIrkWrongRole", adminRootBinding: "adminRoot", policy: strict, expect: no("binding-role") },
  { name: "strict: the verifier holds no binding for the admin root", signature: "adminRoot", binding: "newIrk", adminRootBinding: null, policy: strict, expect: no("strict-requires-binding") },
  { name: "admin-root binding of another key", signature: "adminRoot", binding: "newIrk", adminRootBinding: "other", policy: strict, expect: no("binding-key-mismatch") },
  { name: "no companion at all", signature: null, binding: null, adminRootBinding: "adminRoot", policy: strict, expect: no("strict-requires-hybrid") },
];

// ── The box's chain (TS) ────────────────────────────────────────────────
const hop2: AccountKeyRotation = {
  ...rotation,
  fromEpoch: 1,
  toEpoch: 2,
  oldIrkPubHex: pub(NEW_IRK),
  newIrkPubHex: pub(NEW_IRK2),
  newIrkScheme: "android",
  oldAidPubHex: pub(NEW_AID),
  newAidPubHex: pub(NEW_AID2),
  adminRootPubHex: pub(ADMIN2),
  removedDeviceIds: [ID.c],
  keptDevicesDigestHex: keptDevicesDigestHex(kept.filter((k) => k.deviceId !== ID.c)),
  recoveryRecordDigestHex: null,
  nonceHex: "1e".repeat(16),
  issuedAt: NOW - 500,
};
const hop2ByOldRoot = { ...hop2, adminRootPubHex: pub(ADMIN) };
const rootRotation = { username: USER, oldAdminRootPubHex: pub(ADMIN), newAdminRootPubHex: pub(ADMIN2), issuedAt: NOW - 800 };
const rootRot = { username: USER, oldAdminRootPub: unhex(pub(ADMIN)), newAdminRootPub: unhex(pub(ADMIN2)), issuedAt: rootRotation.issuedAt };
const rootEvent = {
  kind: "admin-root-rotation",
  rotation: rootRotation,
  signatureHex: hex(signAdminRootRotation(rootRot, kp(ADMIN))),
  pq: signAdminRootRotationPq(rootRot, ADMIN.secret, bindings.admin2, { deterministic: true }),
};
const hop1Event = { kind: "account-key-rotation", rotation, signatures, pq };
const hop2Event = {
  kind: "account-key-rotation",
  rotation: hop2,
  signatures: sign(hop2, ADMIN2, NEW_IRK2, NEW_AID2),
  pq: signAccountKeyRotationPq(hop2, ADMIN2.secret, bindings.newIrk2, { deterministic: true }),
};
const byIrkEvent = { kind: "account-key-rotation", rotation: byIrk, signatures: sign(byIrk, OLD_IRK) };
const strip = <T extends { pq?: unknown }>(e: T) => {
  const { pq: _p, ...rest } = e;
  return rest;
};
const after = (epoch: number, irkPubHex: string, aidPubHex: string, adminRootPubHex: string) => ({ username: USER, epoch, irkPubHex, aidPubHex, adminRootPubHex });
/** Events by name; each case lists the names in order. */
const chainEvents = {
  hop1: hop1Event,
  root: rootEvent,
  hop2: hop2Event,
  hop2ByOldRoot: { ...strip(hop2Event), rotation: hop2ByOldRoot, signatures: sign(hop2ByOldRoot, ADMIN, NEW_IRK2, NEW_AID2) },
  hop1ByIrk: byIrkEvent,
  rootFromOther: { ...strip(rootEvent), rotation: { ...rootRotation, oldAdminRootPubHex: pub(OTHER) } },
  rootBadSignature: { ...strip(rootEvent), signatureHex: flipLast(rootEvent.signatureHex) },
  hop1NoPq: strip(hop1Event),
  rootNoPq: strip(rootEvent),
};
const end2 = after(2, pub(NEW_IRK2), pub(NEW_AID2), pub(ADMIN2));
const end1 = after(1, pub(NEW_IRK), pub(NEW_AID), pub(ADMIN));
const chainCases = [
  { name: "one hop", events: ["hop1"], expect: { ok: true, applied: 1, state: end1 } },
  { name: "hop, admin-root rotation, hop signed by the new root", events: ["hop1", "root", "hop2"], expect: { ok: true, applied: 2, state: end2 } },
  { name: "strict: every event carries its companion", events: ["hop1", "root", "hop2"], strict: true, expect: { ok: true, applied: 2, state: end2 } },
  { name: "after the root rotated, a hop signed by the old root", events: ["hop1", "root", "hop2ByOldRoot"], expect: no("wrong-admin-root") },
  { name: "a missing hop (epoch 1 to 2 from epoch 0)", events: ["root", "hop2"], expect: no("epoch-gap") },
  { name: "the same hop twice", events: ["hop1", "hop1"], expect: no("stale-epoch") },
  { name: "a hop signed by the old IRK", events: ["hop1ByIrk"], expect: no("signed-by-irk") },
  { name: "admin-root rotation from a root the box does not pin", events: ["hop1", "rootFromOther"], expect: no("wrong-admin-root") },
  { name: "admin-root rotation with a bad signature", events: ["rootBadSignature"], expect: no("bad-admin-root-rotation") },
  { name: "strict: a hop without its companion", events: ["hop1NoPq"], strict: true, expect: no("strict-requires-hybrid") },
  { name: "strict: an admin-root rotation without its companion", events: ["hop1", "rootNoPq", "hop2"], strict: true, expect: no("strict-requires-hybrid") },
  { name: "compatibility: companions are not required", events: ["hop1NoPq"], expect: { ok: true, applied: 1, state: end1 } },
];

// ── Deliveries ──────────────────────────────────────────────────────────
const DELIVERY_ISSUED = NOW - 900;
const plainB = encodeUmkRotationPlaintext({ umk: NEW_UMK, irkScheme: "ios" });
const plainC = encodeUmkRotationPlaintext({ umk: NEW_UMK, irkScheme: "ios", adminRootSeed: ADMIN.seed });
const XWING_RANDOMNESS = fill(64, 0x55);
const EPH = fill(32, 0x66);
const NONCE = fill(12, 0x77);
const sealB = sealUmkRotation({ rotation, deviceId: ID.b, plaintext: plainB, recipient: { kind: "xwing", publicKey: B_RECEIVE_PUB }, issuedAt: DELIVERY_ISSUED, randomness: { xwing: XWING_RANDOMNESS } });
const sealC = sealUmkRotation({ rotation, deviceId: ID.c, plaintext: plainC, recipient: { kind: "ed25519", devicePub: unhex(pub(DEV.c)) }, issuedAt: DELIVERY_ISSUED, randomness: { ephPriv: EPH, nonce: NONCE } });
const delB = buildUmkRotationDelivery({ rotation, deviceId: ID.b, devicePubHex: pub(DEV.b), sealed: sealB.sealed, issuedAt: DELIVERY_ISSUED, adminRoot: kp(ADMIN) });
const delC = buildUmkRotationDelivery({ rotation, deviceId: ID.c, devicePubHex: pub(DEV.c), sealed: sealC.sealed, issuedAt: DELIVERY_ISSUED, adminRoot: kp(ADMIN) });
const wrongUmkPlain = encodeUmkRotationPlaintext({ umk: NEW_UMK2, irkScheme: "ios" });
const sealWrong = sealUmkRotation({ rotation, deviceId: ID.b, plaintext: wrongUmkPlain, recipient: { kind: "xwing", publicKey: B_RECEIVE_PUB }, issuedAt: DELIVERY_ISSUED, randomness: { xwing: XWING_RANDOMNESS } });
const delWrong = buildUmkRotationDelivery({ rotation, deviceId: ID.b, devicePubHex: pub(DEV.b), sealed: sealWrong.sealed, issuedAt: DELIVERY_ISSUED, adminRoot: kp(ADMIN) });
const otherSchemePlain = encodeUmkRotationPlaintext({ umk: NEW_UMK, irkScheme: "web" });
const sealScheme = sealUmkRotation({ rotation, deviceId: ID.b, plaintext: otherSchemePlain, recipient: { kind: "xwing", publicKey: B_RECEIVE_PUB }, issuedAt: DELIVERY_ISSUED, randomness: { xwing: XWING_RANDOMNESS } });
const delScheme = buildUmkRotationDelivery({ rotation, deviceId: ID.b, devicePubHex: pub(DEV.b), sealed: sealScheme.sealed, issuedAt: DELIVERY_ISSUED, adminRoot: kp(ADMIN) });
const delByOther = buildUmkRotationDelivery({ rotation, deviceId: ID.b, devicePubHex: pub(DEV.b), sealed: sealB.sealed, issuedAt: DELIVERY_ISSUED, adminRoot: kp(OTHER) });
const otherHop = at({ nonceHex: "2d".repeat(16) });

const self = { b: { deviceId: ID.b, devicePubHex: pub(DEV.b) }, c: { deviceId: ID.c, devicePubHex: pub(DEV.c) } };
const dcase = (name: string, o: { delivery: typeof delB; sealedHex: string; kind: string; self: typeof self.b; secretHex: string; rotation?: AccountKeyRotation; expect: Expect }) => ({
  name,
  rotation: o.rotation ?? rotation,
  delivery: o.delivery.delivery,
  signatureHex: o.delivery.signatureHex,
  sealedHex: o.sealedHex,
  kind: o.kind,
  self: o.self,
  secretHex: o.secretHex,
  expect: o.expect,
});
const bSec = hex(B_RECEIVE_SEED);
const cSec = DEV.c.seedHex;
const deliveryCases = [
  dcase("X-Wing to the receive key", { delivery: delB, sealedHex: hex(sealB.sealed), kind: "xwing", self: self.b, secretHex: bSec, expect: ok }),
  dcase("Ed25519 fallback, keeping the admin root", { delivery: delC, sealedHex: hex(sealC.sealed), kind: "ed25519", self: self.c, secretHex: cSec, expect: ok }),
  dcase("signed by another key than the hop's admin root", { delivery: delByOther, sealedHex: hex(sealB.sealed), kind: "xwing", self: self.b, secretHex: bSec, expect: no("bad-signature") }),
  dcase("names another hop", { delivery: delB, sealedHex: hex(sealB.sealed), kind: "xwing", self: self.b, secretHex: bSec, rotation: otherHop, expect: no("rotation-mismatch") }),
  dcase("opened by another device", { delivery: delB, sealedHex: hex(sealB.sealed), kind: "xwing", self: self.c, secretHex: cSec, expect: no("wrong-recipient") }),
  dcase("sealed bytes swapped", { delivery: delB, sealedHex: hex(sealWrong.sealed), kind: "xwing", self: self.b, secretHex: bSec, expect: no("sealed-mismatch") }),
  dcase("wrong receive-key secret", { delivery: delB, sealedHex: hex(sealB.sealed), kind: "xwing", self: self.b, secretHex: hex(fill(32, 0x99)), expect: no("open-failed") }),
  dcase("X-Wing blob opened as an Ed25519 seal", { delivery: delB, sealedHex: hex(sealB.sealed), kind: "ed25519", self: self.b, secretHex: DEV.b.seedHex, expect: no("open-failed") }),
  dcase("a UMK that does not yield the hop's keys", { delivery: delWrong, sealedHex: hex(sealWrong.sealed), kind: "xwing", self: self.b, secretHex: bSec, expect: no("umk-mismatch") }),
  dcase("a scheme other than the hop's", { delivery: delScheme, sealedHex: hex(sealScheme.sealed), kind: "xwing", self: self.b, secretHex: bSec, expect: no("umk-mismatch") }),
];

const plaintextCases = [
  { name: "UMK and scheme", hex: hex(plainB), expect: { ok: true, umkHex: hex(NEW_UMK), irkScheme: "ios", adminRootSeedHex: null } },
  { name: "UMK, scheme and admin root", hex: hex(plainC), expect: { ok: true, umkHex: hex(NEW_UMK), irkScheme: "ios", adminRootSeedHex: ADMIN.seedHex } },
  { name: "android scheme byte", hex: hex(NEW_UMK) + "0300", expect: { ok: true, umkHex: hex(NEW_UMK), irkScheme: "android", adminRootSeedHex: null } },
  { name: "unknown scheme byte", hex: hex(NEW_UMK) + "0400", expect: no("bad-plaintext") },
  { name: "scheme byte 0", hex: hex(NEW_UMK) + "0000", expect: no("bad-plaintext") },
  { name: "unknown flag", hex: hex(NEW_UMK) + "0202", expect: no("bad-plaintext") },
  { name: "admin-root flag without the seed", hex: hex(NEW_UMK) + "0201", expect: no("bad-plaintext") },
  { name: "seed without the flag", hex: hex(NEW_UMK) + "0200" + ADMIN.seedHex, expect: no("bad-plaintext") },
  { name: "truncated", hex: hex(NEW_UMK).slice(2) + "0200", expect: no("bad-plaintext") },
];

// ── Kept devices, derived keys ──────────────────────────────────────────
const keptCases = [
  { name: "a kept device", kept, self: self.b, expect: ok },
  { name: "the removed derived-key device", kept, self: { deviceId: ID.e, devicePubHex: pub(DEV.e) }, expect: no("not-kept") },
  { name: "a kept id with another key", kept, self: { deviceId: ID.b, devicePubHex: pub(DEV.c) }, expect: no("not-kept") },
  { name: "list with one device left out", kept: kept.slice(1), self: self.b, expect: no("kept-digest-mismatch") },
];
const derivedCases = [
  { name: "creator's key derived from the old UMK", umkHex: hex(OLD_UMK), username: USER, deviceId: ID.e, devicePubHex: pub(DEV.e), derived: true },
  { name: "a joined device's random key", umkHex: hex(OLD_UMK), username: USER, deviceId: ID.b, devicePubHex: pub(DEV.b), derived: false },
  { name: "the derived key checked against the new UMK", umkHex: hex(NEW_UMK), username: USER, deviceId: ID.e, devicePubHex: pub(DEV.e), derived: false },
  { name: "the derived key checked under another device id", umkHex: hex(OLD_UMK), username: USER, deviceId: ID.d, devicePubHex: pub(DEV.e), derived: false },
];

// ── Small envelopes ─────────────────────────────────────────────────────
const dkr = { username: USER, deviceId: ID.e, oldDevicePubHex: pub(DEV.e), newDevicePubHex: pub(DEV.eNew), issuedAt: NOW - 2000 };
const dkrSigs = signDeviceKeyRotate(dkr, { newKey: kp(DEV.eNew), adminRoot: kp(ADMIN) });
const drk = { username: USER, deviceId: ID.b, devicePubHex: pub(DEV.b), xwingPubHex: hex(B_RECEIVE_PUB), issuedAt: NOW - 3000 };
const drkSig = signDeviceReceiveKey(drk, kp(DEV.b));
const DOMAIN = "home.alice.flagship.services";
const cgk = { serverDomain: DOMAIN, toEpoch: 1, sealedHex: "ab".repeat(92), issuedAt: NOW - 400 };
const swk = { serverDomain: DOMAIN, toEpoch: 1, oldSwkCommitHex: hex(sha256(new TextEncoder().encode("old swk"))), sealedHex: "cd".repeat(92), issuedAt: NOW - 300 };
const luks = { serverDomain: DOMAIN, toEpoch: 1, sealedKeyDigestHex: hex(sha256(new TextEncoder().encode("sealed luks key"))), issuedAt: NOW - 200 };

const doc = {
  about:
    "Account master-key rotation (packages/protocol/src/accountKeyRotation.ts). Every port builds each envelope's `canonical` from its `fields`, reproduces every Ed25519 signature (deterministic) and the X-Wing seal (`delivery.xwing`, fixed randomness) byte for byte, and gives each case its `expect`: `hopCases` through the one-hop verify, `pqCases` through the companion verify (bindings from `bindings`, `now` = `now`), `deliveryCases` through the delivery open, `plaintextCases`, `keptCases`, `derivedCases`. `chainCases` start from `chainStart` and are the box's (TypeScript only). Hex is lowercase; a new IRK is version 1 of `newIrkScheme`.",
  tags: {
    rotation: TAG_ACCOUNT_KEY_ROTATION,
    rotationV2: TAG_ACCOUNT_KEY_ROTATION_V2,
    delivery: TAG_UMK_ROTATION_DELIVERY,
    deviceKeyRotate: TAG_DEVICE_KEY_ROTATE,
    deviceReceiveKey: TAG_DEVICE_RECEIVE_KEY,
    cgkRekey: TAG_CGK_REKEY,
    swkRekey: TAG_SWK_REKEY,
    luksRekeyConfirm: TAG_LUKS_REKEY_CONFIRM,
  },
  now: NOW,
  keys: {
    adminRoot: { seedHex: ADMIN.seedHex, pubHex: ADMIN.pubHex, mldsaSeedHex: ADMIN.mldsaSeedHex },
    other: { seedHex: OTHER.seedHex, pubHex: OTHER.pubHex, mldsaSeedHex: OTHER.mldsaSeedHex },
    adminRoot2: { seedHex: ADMIN2.seedHex, pubHex: ADMIN2.pubHex, mldsaSeedHex: ADMIN2.mldsaSeedHex },
    oldUmkHex: hex(OLD_UMK),
    newUmkHex: hex(NEW_UMK),
    oldIrk: { scheme: "web", version: 2, seedHex: OLD_IRK.seedHex, pubHex: OLD_IRK.pubHex },
    newIrk: { scheme: "ios", version: 1, seedHex: NEW_IRK.seedHex, pubHex: NEW_IRK.pubHex, mldsaSeedHex: hex(NEW_IRK_MLDSA) },
    oldAid: { seedHex: OLD_AID.seedHex, pubHex: OLD_AID.pubHex },
    newAid: { seedHex: NEW_AID.seedHex, pubHex: NEW_AID.pubHex },
    devices: Object.fromEntries(Object.entries(DEV).map(([k, v]) => [k, { seedHex: v.seedHex, pubHex: v.pubHex }])),
    deviceIds: ID,
    bReceive: { seedHex: hex(B_RECEIVE_SEED), pubHex: hex(B_RECEIVE_PUB) },
  },
  keptDevices: { list: kept, lines: keptDevicesLines(kept), digestHex: keptDigest },
  rotation: {
    fields: rotation,
    canonical: utf8(canonicalAccountKeyRotation(rotation)),
    digestHex: accountKeyRotationDigestHex(rotation),
    signatures,
  },
  hopCases,
  bindings,
  pq: {
    newIrkKeyIdHex: newIrkKeyId,
    canonicalV2: utf8(canonicalAccountKeyRotationV2(rotation, newIrkKeyId)),
  },
  pqSignatures,
  pqCases,
  chainStart: state,
  chainEvents,
  chainCases,
  delivery: {
    xwing: {
      plaintextHex: hex(plainB),
      senderKeyIdHex: hex(umkDeliverySenderKeyId(rotation.adminRootPubHex)),
      context: [USER, "1", ID.b],
      randomnessHex: hex(XWING_RANDOMNESS),
      issuedAt: DELIVERY_ISSUED,
      sealedHex: hex(sealB.sealed),
      delivery: delB.delivery,
      canonical: utf8(canonicalUmkRotationDelivery(delB.delivery)),
      signatureHex: delB.signatureHex,
    },
    ed25519: {
      plaintextHex: hex(plainC),
      ephPrivHex: hex(EPH),
      nonceHex: hex(NONCE),
      sealedHex: hex(sealC.sealed),
      delivery: delC.delivery,
      canonical: utf8(canonicalUmkRotationDelivery(delC.delivery)),
      signatureHex: delC.signatureHex,
    },
  },
  deliveryCases,
  plaintextCases,
  keptCases,
  derivedCases,
  deviceKeyRotate: { fields: dkr, canonical: utf8(canonicalDeviceKeyRotate(dkr)), ...dkrSigs },
  deviceReceiveKey: { fields: drk, canonical: utf8(canonicalDeviceReceiveKey(drk)), signatureHex: drkSig },
  cgkRekey: { fields: cgk, canonical: utf8(canonicalCgkRekey(cgk)), signatureHex: signRekey(canonicalCgkRekey(cgk), kp(ADMIN)), signer: "adminRoot" },
  swkRekey: { fields: swk, canonical: utf8(canonicalSwkRekey(swk)), signatureHex: signRekey(canonicalSwkRekey(swk), kp(ADMIN)), signer: "adminRoot" },
  luksRekeyConfirm: { fields: luks, canonical: utf8(canonicalLuksRekeyConfirm(luks)), signatureHex: signRekey(canonicalLuksRekeyConfirm(luks), kp(NEW_IRK)), signer: "newIrk" },
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
    console.error(`${OUT} is stale: run npx tsx tools/account-key-rotation-vectors.ts`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
}

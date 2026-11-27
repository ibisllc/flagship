// Account master-key rotation: browser twin of packages/protocol/src/accountKeyRotation.ts, byte
// for byte (vectors in packages/protocol/test-vectors/account-key-rotation/, replayed by
// apps/web/tests/webappAccountKeyRotationVectors.test.ts).
//
// The hop flagship/account-key-rotation/v1 moves the account from key epoch N to N+1. Only the
// pinned admin root authorises it (never an IRK); the new IRK and new AID sign the same bytes.
// Kept devices get the new UMK in flagship/umk-rotation-delivery/v1, sealed with X-Wing to their
// receive key (flagship/device-receive-key/v1) or to their Ed25519 identity key. The browser can
// sign the classical hop (a web admin holds the admin root) and verifies the hybrid companion
// flagship/account-key-rotation/v2; it never signs one (keyless-web rule: no ML-DSA admin half).
// The follow-ups flagship/device-key-rotate/v1, flagship/cgk-rekey/v1, flagship/swk-rekey/v1 and
// flagship/luks-rekey-confirm/v1 are here for their canonical bytes and signatures.
//
// Pure and synchronous; Uint8Array in and out, hex lowercase. Errors are AccountKeyRotationError
// with the protocol's codes (PqBindingError codes pass through from the companion check).

import { ed25519, hkdf, sha256, x25519, gcm } from "../vendor/noble-post-quantum/pq-seal.js";
import { hybridOpen, hybridSeal, hybridSealWithRandomness, parseHybridSealPublicKey, pqKeyId } from "./voiciCore.js";
import { PqBindingError, verifyCriticalSignature, verifyPqKeyBinding } from "./pqBinding.js";

export const TAG_ACCOUNT_KEY_ROTATION = "flagship/account-key-rotation/v1";
export const TAG_ACCOUNT_KEY_ROTATION_V2 = "flagship/account-key-rotation/v2";
export const TAG_UMK_ROTATION_DELIVERY = "flagship/umk-rotation-delivery/v1";
export const TAG_DEVICE_KEY_ROTATE = "flagship/device-key-rotate/v1";
export const TAG_DEVICE_RECEIVE_KEY = "flagship/device-receive-key/v1";
export const TAG_CGK_REKEY = "flagship/cgk-rekey/v1";
export const TAG_SWK_REKEY = "flagship/swk-rekey/v1";
export const TAG_LUKS_REKEY_CONFIRM = "flagship/luks-rekey-confirm/v1";
export const IRK_SCHEMES = ["web", "ios", "android"];

const SCHEME_BYTE = { web: 1, ios: 2, android: 3 };
const FLAG_ADMIN_ROOT = 0x01;
const HYBRID = "hybrid-ed25519-mldsa65/v1";
const SUITE_HYBRID_SIG = 0x0002;
const SEAL_TAG = "flagship.seal.v1";
const HEX32 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{32}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const DOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const te = new TextEncoder();

export class AccountKeyRotationError extends Error {
  constructor(code) {
    super(code);
    this.name = "AccountKeyRotationError";
    this.code = code;
  }
}
const fail = (code) => {
  throw new AccountKeyRotationError(code);
};

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function bytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const sha256Hex = (b) => hex(sha256(b));
function need(ok, what) {
  if (!ok) throw new Error(`account-key-rotation: invalid ${what}`);
}
const isUint = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
function username(u) {
  need(typeof u === "string" && u.length > 0 && u.length <= 64 && u === u.toLowerCase(), "username");
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i);
    need(c !== 0x7c && c > 0x1f && c !== 0x7f, "username");
  }
  return u;
}
const hex32 = (v, what) => (need(typeof v === "string" && HEX32.test(v), what), v);
const uint = (v, what) => (need(isUint(v), what), v);
const domain = (v) => (need(typeof v === "string" && DOMAIN.test(v), "serverDomain"), v);
const deviceId = (v) => (need(typeof v === "string" && HEX16.test(v), "deviceId"), v);
const sealedHex = (v) => (need(typeof v === "string" && HEX.test(v), "sealedHex"), v);

/** 32 bytes, canonically encoded, not of small order (edSync.isAcceptableEd25519PublicKey). */
export function isAcceptableEd25519Key(pubHex) {
  if (typeof pubHex !== "string" || !HEX32.test(pubHex)) return false;
  try {
    const b = bytes(pubHex);
    const p = ed25519.Point.fromBytes(b, false);
    return hex(p.toBytes()) === pubHex && !p.isSmallOrder();
  } catch {
    return false;
  }
}

function verifyEd(sigHex, msg, pubHex) {
  if (typeof sigHex !== "string" || !/^[0-9a-f]{128}$/.test(sigHex) || !isAcceptableEd25519Key(pubHex)) return false;
  try {
    return ed25519.verify(bytes(sigHex), msg, bytes(pubHex), { zip215: false });
  } catch {
    return false;
  }
}
const signEd = (seed, msg) => hex(ed25519.sign(msg, seed));
const pubOf = (seed) => hex(ed25519.getPublicKey(seed));

// ── The hop ───────────────────────────────────────────────────────────────

function rotationFields(r) {
  need(IRK_SCHEMES.includes(r.newIrkScheme), "newIrkScheme");
  need(Array.isArray(r.removedDeviceIds), "removedDeviceIds");
  const removed = r.removedDeviceIds.map(deviceId).sort();
  for (let i = 1; i < removed.length; i++) need(removed[i] !== removed[i - 1], "removedDeviceIds (duplicate)");
  need(r.recoveryRecordDigestHex === null || HEX32.test(r.recoveryRecordDigestHex), "recoveryRecordDigestHex");
  need(typeof r.nonceHex === "string" && HEX16.test(r.nonceHex), "nonceHex");
  return [
    username(r.username),
    String(uint(r.fromEpoch, "fromEpoch")),
    String(uint(r.toEpoch, "toEpoch")),
    hex32(r.oldIrkPubHex, "oldIrkPubHex"),
    hex32(r.newIrkPubHex, "newIrkPubHex"),
    r.newIrkScheme,
    hex32(r.oldAidPubHex, "oldAidPubHex"),
    hex32(r.newAidPubHex, "newAidPubHex"),
    hex32(r.adminRootPubHex, "adminRootPubHex"),
    removed.length ? removed.join(",") : "none",
    hex32(r.keptDevicesDigestHex, "keptDevicesDigestHex"),
    r.recoveryRecordDigestHex ?? "none",
    r.nonceHex,
    String(uint(r.issuedAt, "issuedAt")),
  ];
}

export function canonicalAccountKeyRotation(r) {
  return te.encode([TAG_ACCOUNT_KEY_ROTATION, ...rotationFields(r)].join("|"));
}

export function accountKeyRotationDigestHex(r) {
  return sha256Hex(canonicalAccountKeyRotation(r));
}

/** Seeds are 32-byte Ed25519 seeds: the admin root, the new IRK and the new AID. */
export function signAccountKeyRotation(r, { adminRootSeed, newIrkSeed, newAidSeed }) {
  const msg = canonicalAccountKeyRotation(r);
  return { adminRootSignatureHex: signEd(adminRootSeed, msg), newIrkSignatureHex: signEd(newIrkSeed, msg), newAidSignatureHex: signEd(newAidSeed, msg) };
}

/** One hop against the verifier's own state ({username, epoch, irkPubHex, aidPubHex?, adminRootPubHex}). */
export function verifyAccountKeyRotation({ rotation: r, signatures: s, state: st }) {
  const state = {
    username: st.username.toLowerCase(),
    epoch: st.epoch,
    irkPubHex: st.irkPubHex.toLowerCase(),
    aidPubHex: st.aidPubHex ? st.aidPubHex.toLowerCase() : null,
    adminRootPubHex: st.adminRootPubHex.toLowerCase(),
  };
  let msg;
  try {
    msg = canonicalAccountKeyRotation(r);
  } catch {
    fail("malformed");
  }
  if (!s || typeof s !== "object") fail("malformed");
  if (r.username !== state.username) fail("wrong-account");
  if (r.adminRootPubHex === state.irkPubHex || r.adminRootPubHex === r.oldIrkPubHex || r.adminRootPubHex === r.oldAidPubHex) fail("signed-by-irk");
  if (r.adminRootPubHex !== state.adminRootPubHex) fail("wrong-admin-root");
  if (r.fromEpoch < state.epoch) fail("stale-epoch");
  if (r.fromEpoch > state.epoch) fail("epoch-gap");
  if (r.toEpoch !== r.fromEpoch + 1) fail("bad-epoch-step");
  if (r.oldIrkPubHex !== state.irkPubHex) fail("wrong-old-irk");
  if (state.aidPubHex && r.oldAidPubHex !== state.aidPubHex) fail("wrong-old-aid");
  if (!isAcceptableEd25519Key(r.newIrkPubHex) || !isAcceptableEd25519Key(r.newAidPubHex)) fail("weak-key");
  const keys = [r.oldIrkPubHex, r.newIrkPubHex, r.oldAidPubHex, r.newAidPubHex, r.adminRootPubHex];
  if (new Set(keys).size !== keys.length) fail("key-not-new");
  if (!verifyEd(s.adminRootSignatureHex, msg, r.adminRootPubHex)) fail("bad-admin-signature");
  if (!verifyEd(s.newIrkSignatureHex, msg, r.newIrkPubHex)) fail("bad-new-irk-signature");
  if (!verifyEd(s.newAidSignatureHex, msg, r.newAidPubHex)) fail("bad-new-aid-signature");
}

// ── Hybrid companion (verify only) ────────────────────────────────────────

export function canonicalAccountKeyRotationV2(r, newIrkKeyIdHex) {
  need(typeof newIrkKeyIdHex === "string" && HEX32.test(newIrkKeyIdHex), "newIrkKeyIdHex");
  return te.encode([TAG_ACCOUNT_KEY_ROTATION_V2, ...rotationFields(r), newIrkKeyIdHex].join("|"));
}

/** The hybrid key id of a binding's two keys. */
export function bindingKeyIdHex(w) {
  return hex(pqKeyId(SUITE_HYBRID_SIG, bytes(w.ed25519PubHex + w.mldsaPubHex)));
}

/**
 * The admin root's hybrid signature over the v2 bytes, under the verifier's own verified binding
 * for the admin root (lib/pqBinding.js). Returns the new IRK's verified binding; throws
 * PqBindingError.
 */
export function verifyAccountKeyRotationPq({ rotation, pq, adminRootBinding, policy, now }) {
  const o = pq && typeof pq === "object" ? pq : null;
  if (!o) throw pqError("strict-requires-hybrid");
  const e = o.signature && typeof o.signature === "object" ? o.signature : null;
  if (!e || typeof e.suite !== "string" || typeof e.signature !== "string") throw pqError("bad-signature");
  if (e.suite !== HYBRID) throw pqError(e.suite === "ed25519/v1" ? "strict-requires-hybrid" : "unknown-suite");
  const binding = verifyPqKeyBinding(o.newIrkBinding, { role: "account-irk", subjectId: rotation.username, ed25519PubHex: rotation.newIrkPubHex, now });
  let message;
  try {
    message = canonicalAccountKeyRotationV2(rotation, bindingKeyIdHex(binding));
  } catch {
    throw pqError("bad-signature");
  }
  verifyCriticalSignature({ message, expectedPurpose: TAG_ACCOUNT_KEY_ROTATION_V2, envelope: { suite: HYBRID, signature: e.signature }, signerEd25519PubHex: rotation.adminRootPubHex, binding: adminRootBinding, policy });
  return binding;
}

const pqError = (code) => new PqBindingError(code);

// ── Kept devices, derived keys ────────────────────────────────────────────

export function keptDevicesLines(devices) {
  need(Array.isArray(devices) && devices.length > 0, "kept devices");
  const sorted = devices.map((d) => ({ id: deviceId(d.deviceId), pub: hex32(d.devicePubHex, "devicePubHex") })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) need(sorted[i].id !== sorted[i - 1].id, "kept devices (duplicate id)");
  return sorted.map((d) => `${d.id}:${d.pub}\n`).join("");
}

export function keptDevicesDigestHex(devices) {
  return sha256Hex(te.encode(keptDevicesLines(devices)));
}

export function verifyKeptDevice({ rotation, kept, self }) {
  let digest;
  try {
    digest = keptDevicesDigestHex(kept);
  } catch {
    fail("malformed");
  }
  if (digest !== rotation.keptDevicesDigestHex) fail("kept-digest-mismatch");
  if (!kept.some((d) => d.deviceId === self.deviceId && d.devicePubHex === self.devicePubHex)) fail("not-kept");
}

/** True when the device key is HKDF(umk, flagship/account-device-key/v1|acct|id). */
export function deviceKeyIsUmkDerived(umk, accountName, id, devicePubHex) {
  if (!HEX16.test(id) || !HEX32.test(devicePubHex)) return false;
  const seed = hkdf(sha256, umk, new Uint8Array(0), te.encode(`flagship/account-device-key/v1|${accountName.toLowerCase()}|${id}`), 32);
  return pubOf(seed) === devicePubHex;
}

export function deriveIrkSeedInScheme(umk, scheme, version = 1) {
  need(umk.length === 32 && IRK_SCHEMES.includes(scheme) && Number.isSafeInteger(version) && version >= 1, "irk derivation");
  const [salt, info] = scheme === "web" ? ["", `flagship.irk.v${version}`] : scheme === "ios" ? ["", `flagship/irk/v${version}`] : [`flagship/irk/v${version}`, "ed25519-seed"];
  return hkdf(sha256, umk, te.encode(salt), te.encode(info), 32);
}

export function deriveAidSeed(umk) {
  need(umk.length === 32, "umk");
  return hkdf(sha256, umk, new Uint8Array(0), te.encode("flagship/account-id/v1"), 32);
}

export function checkRotatedUmk(r, p) {
  if (p.irkScheme !== r.newIrkScheme) fail("umk-mismatch");
  if (pubOf(deriveIrkSeedInScheme(p.umk, p.irkScheme, 1)) !== r.newIrkPubHex) fail("umk-mismatch");
  if (pubOf(deriveAidSeed(p.umk)) !== r.newAidPubHex) fail("umk-mismatch");
}

// ── The delivery ──────────────────────────────────────────────────────────

export function encodeUmkRotationPlaintext({ umk, irkScheme, adminRootSeed = null }) {
  need(umk instanceof Uint8Array && umk.length === 32, "umk");
  need(IRK_SCHEMES.includes(irkScheme), "irkScheme");
  need(adminRootSeed === null || (adminRootSeed instanceof Uint8Array && adminRootSeed.length === 32), "adminRootSeed");
  const out = new Uint8Array(adminRootSeed ? 66 : 34);
  out.set(umk, 0);
  out[32] = SCHEME_BYTE[irkScheme];
  out[33] = adminRootSeed ? FLAG_ADMIN_ROOT : 0;
  if (adminRootSeed) out.set(adminRootSeed, 34);
  return out;
}

export function decodeUmkRotationPlaintext(b) {
  if (!(b instanceof Uint8Array) || (b.length !== 34 && b.length !== 66)) fail("bad-plaintext");
  const scheme = IRK_SCHEMES.find((s) => SCHEME_BYTE[s] === b[32]);
  if (!scheme) fail("bad-plaintext");
  const flags = b[33];
  if ((flags & ~FLAG_ADMIN_ROOT) !== 0) fail("bad-plaintext");
  const hasRoot = (flags & FLAG_ADMIN_ROOT) !== 0;
  if (hasRoot !== (b.length === 66)) fail("bad-plaintext");
  return { umk: b.slice(0, 32), irkScheme: scheme, adminRootSeed: hasRoot ? b.slice(34, 66) : null };
}

export function canonicalUmkRotationDelivery(d) {
  return te.encode([
    TAG_UMK_ROTATION_DELIVERY,
    username(d.username),
    String(uint(d.toEpoch, "toEpoch")),
    deviceId(d.deviceId),
    hex32(d.devicePubHex, "devicePubHex"),
    hex32(d.rotationDigestHex, "rotationDigestHex"),
    hex32(d.sealedDigestHex, "sealedDigestHex"),
    String(uint(d.issuedAt, "issuedAt")),
  ].join("|"));
}

export function umkDeliveryContext(accountName, toEpoch, id) {
  return [te.encode(username(accountName)), te.encode(String(uint(toEpoch, "toEpoch"))), te.encode(deviceId(id))];
}

export function umkDeliverySenderKeyId(adminRootPubHex) {
  return sha256(bytes(hex32(adminRootPubHex, "adminRootPubHex")));
}

/** The Ed25519-recipient seal (encryption.ts sealForRecipient) with optional fixed randomness. */
function sealToEd25519(plaintext, devicePub, ephPriv, nonce) {
  const eph = ephPriv ?? x25519.utils.randomSecretKey();
  const n = nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const ephPub = x25519.getPublicKey(eph);
  const shared = x25519.getSharedSecret(eph, ed25519.utils.toMontgomery(devicePub));
  const key = hkdf(sha256, shared, ephPub, te.encode(SEAL_TAG), 32);
  const ct = gcm(key, n).encrypt(plaintext);
  const out = new Uint8Array(44 + ct.length);
  out.set(ephPub, 0);
  out.set(n, 32);
  out.set(ct, 44);
  return out;
}

function openFromEd25519(blob, edSeed) {
  if (blob.length < 44) throw new Error("short");
  const ephPub = blob.subarray(0, 32);
  const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(edSeed), ephPub);
  const key = hkdf(sha256, shared, ephPub, te.encode(SEAL_TAG), 32);
  return gcm(key, blob.subarray(32, 44)).decrypt(blob.subarray(44));
}

/** recipient: {kind: "xwing", publicKey} | {kind: "ed25519", devicePub}; randomness for vectors only. */
export function sealUmkRotation({ rotation: r, deviceId: id, plaintext, recipient, issuedAt, randomness = {} }) {
  if (recipient.kind === "xwing") {
    parseHybridSealPublicKey(recipient.publicKey);
    const opts = { purpose: TAG_UMK_ROTATION_DELIVERY, senderKeyId: umkDeliverySenderKeyId(r.adminRootPubHex), issuedAt: uint(issuedAt, "issuedAt") };
    const ctx = umkDeliveryContext(r.username, r.toEpoch, id);
    const sealed = randomness.xwing
      ? hybridSealWithRandomness(recipient.publicKey, opts, ctx, plaintext, randomness.xwing)
      : hybridSeal(recipient.publicKey, opts, ctx, plaintext);
    return { kind: "xwing", sealed };
  }
  need(recipient.devicePub?.length === 32, "devicePub");
  return { kind: "ed25519", sealed: sealToEd25519(plaintext, recipient.devicePub, randomness.ephPriv, randomness.nonce) };
}

export function buildUmkRotationDelivery({ rotation, deviceId: id, devicePubHex, sealed, issuedAt, adminRootSeed }) {
  const delivery = {
    username: rotation.username,
    toEpoch: rotation.toEpoch,
    deviceId: id,
    devicePubHex,
    rotationDigestHex: accountKeyRotationDigestHex(rotation),
    sealedDigestHex: sha256Hex(sealed),
    issuedAt,
  };
  return { delivery, signatureHex: signEd(adminRootSeed, canonicalUmkRotationDelivery(delivery)) };
}

/** A kept device opens its delivery (the caller verified the hop under its own pin). */
export function openUmkRotationDelivery({ rotation: r, delivery: d, signatureHex, sealed, kind, self, secret }) {
  let msg;
  try {
    msg = canonicalUmkRotationDelivery(d);
  } catch {
    fail("malformed");
  }
  if (!verifyEd(signatureHex, msg, r.adminRootPubHex)) fail("bad-signature");
  if (d.username !== r.username || d.toEpoch !== r.toEpoch) fail("rotation-mismatch");
  if (d.rotationDigestHex !== accountKeyRotationDigestHex(r)) fail("rotation-mismatch");
  if (d.deviceId !== self.deviceId || d.devicePubHex !== self.devicePubHex) fail("wrong-recipient");
  if (d.sealedDigestHex !== sha256Hex(sealed)) fail("sealed-mismatch");
  let plain;
  try {
    if (kind === "xwing") {
      const opened = hybridOpen(secret, TAG_UMK_ROTATION_DELIVERY, umkDeliveryContext(r.username, r.toEpoch, d.deviceId), sealed);
      if (opened.header.issuedAt !== d.issuedAt) throw new Error("issuedAt");
      if (hex(opened.header.senderKeyId) !== hex(umkDeliverySenderKeyId(r.adminRootPubHex))) throw new Error("sender");
      plain = opened.plaintext;
    } else if (kind === "ed25519") {
      if (pubOf(secret) !== d.devicePubHex) throw new Error("seed");
      plain = openFromEd25519(sealed, secret);
    } else {
      throw new Error("kind");
    }
  } catch {
    fail("open-failed");
  }
  const p = decodeUmkRotationPlaintext(plain);
  checkRotatedUmk(r, p);
  return p;
}

// ── Device key rotate / receive key ───────────────────────────────────────

export function canonicalDeviceKeyRotate(r) {
  return te.encode([TAG_DEVICE_KEY_ROTATE, username(r.username), deviceId(r.deviceId), hex32(r.oldDevicePubHex, "oldDevicePubHex"), hex32(r.newDevicePubHex, "newDevicePubHex"), String(uint(r.issuedAt, "issuedAt"))].join("|"));
}

export function signDeviceKeyRotate(r, { newKeySeed, adminRootSeed }) {
  const msg = canonicalDeviceKeyRotate(r);
  return { newKeySignatureHex: signEd(newKeySeed, msg), adminRootSignatureHex: signEd(adminRootSeed, msg) };
}

export function verifyDeviceKeyRotate(r, s, adminRootPubHex) {
  let msg;
  try {
    msg = canonicalDeviceKeyRotate(r);
  } catch {
    return false;
  }
  if (r.newDevicePubHex === r.oldDevicePubHex || r.newDevicePubHex === adminRootPubHex) return false;
  return verifyEd(s.newKeySignatureHex, msg, r.newDevicePubHex) && verifyEd(s.adminRootSignatureHex, msg, adminRootPubHex);
}

export function canonicalDeviceReceiveKey(k) {
  need(typeof k.xwingPubHex === "string" && HEX.test(k.xwingPubHex), "xwingPubHex");
  parseHybridSealPublicKey(bytes(k.xwingPubHex));
  return te.encode([TAG_DEVICE_RECEIVE_KEY, username(k.username), deviceId(k.deviceId), hex32(k.devicePubHex, "devicePubHex"), k.xwingPubHex, String(uint(k.issuedAt, "issuedAt"))].join("|"));
}

export function signDeviceReceiveKey(k, deviceSeed) {
  return signEd(deviceSeed, canonicalDeviceReceiveKey(k));
}

export function verifyDeviceReceiveKey(k, signatureHex) {
  let msg;
  try {
    msg = canonicalDeviceReceiveKey(k);
  } catch {
    return false;
  }
  return verifyEd(signatureHex, msg, k.devicePubHex);
}

// ── Per-server follow-ups ─────────────────────────────────────────────────

export function canonicalCgkRekey(c) {
  return te.encode([TAG_CGK_REKEY, domain(c.serverDomain), String(uint(c.toEpoch, "toEpoch")), sealedHex(c.sealedHex), String(uint(c.issuedAt, "issuedAt"))].join("|"));
}

export function canonicalSwkRekey(c) {
  return te.encode([TAG_SWK_REKEY, domain(c.serverDomain), String(uint(c.toEpoch, "toEpoch")), hex32(c.oldSwkCommitHex, "oldSwkCommitHex"), sealedHex(c.sealedHex), String(uint(c.issuedAt, "issuedAt"))].join("|"));
}

export function canonicalLuksRekeyConfirm(c) {
  return te.encode([TAG_LUKS_REKEY_CONFIRM, domain(c.serverDomain), String(uint(c.toEpoch, "toEpoch")), hex32(c.sealedKeyDigestHex, "sealedKeyDigestHex"), String(uint(c.issuedAt, "issuedAt"))].join("|"));
}

export function signRekey(canonical, seed) {
  return signEd(seed, canonical);
}

export function verifyRekey(build, signatureHex, signerPubHex) {
  let msg;
  try {
    msg = build();
  } catch {
    return false;
  }
  return verifyEd(signatureHex, msg, signerPubHex);
}

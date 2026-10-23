// Hybrid key bindings, verify-only (packages/protocol/src/pqTrust.ts; vectors in
// packages/protocol/test-vectors/pq-binding/; spec docs/architecture-v2/pq-suites.md §9-§10).
//
// A box's STK binds its ML-DSA-65 key: both keys sign
//   flagship/pq-key-binding/v1|box-stk|<serverDomain>|<stkHex>|<mldsaHex>|<issuedAt>
// with the hybrid suite flagship/hybrid-sig/ed25519-mldsa65/v1. This browser checks it under
// the STK it PINNED (boxKeyPins.js) and then pins the ML-DSA key too. It never signs: the
// keyless-web rule keeps private keys out of website JavaScript.

import { ed25519, ml_dsa65 } from "../vendor/noble-post-quantum/pq-verify.js";

export const TAG_PQ_KEY_BINDING = "flagship/pq-key-binding/v1";
export const TAG_BOOT_KEY_BINDING_V2 = "flagship/boot-key-binding/v2";
const SUITE_TAG = "flagship/hybrid-sig/ed25519-mldsa65/v1";
const SUITE_ID = 0x0002;
const ROLES = ["account-irk", "admin-root", "device", "box-stk", "boot-key"];
const SUBJECT = /^[a-z0-9][a-z0-9._:@-]{0,252}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const HEX_MLDSA = /^[0-9a-f]{3904}$/;
const HEX = /^(?:[0-9a-f]{2})*$/;
const MAX_SKEW_MS = 5 * 60 * 1000;
const WIRE_KEYS = "ed25519PubHex,issuedAt,mldsaPubHex,role,signature,subjectId,v";
const enc = (s) => new TextEncoder().encode(s);

export class PqBindingError extends Error {
  constructor(code) {
    super(code);
    this.name = "PqBindingError";
    this.code = code;
  }
}
const fail = (code) => {
  throw new PqBindingError(code);
};

function bytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function strictPoint(b) {
  try {
    const p = ed25519.Point.fromBytes(b, false);
    const again = p.toBytes();
    return again.every((x, i) => x === b[i]) && !p.isSmallOrder() && p.isTorsionFree();
  } catch {
    return false;
  }
}

/** M' of the hybrid suite (pq-suites.md §5.2). */
function hybridMessage(pk, purpose, payload) {
  const tag = enc(SUITE_TAG);
  const p = enc(purpose);
  const n = payload.length;
  return concat(Uint8Array.of(tag.length), tag, Uint8Array.of(SUITE_ID >> 8, SUITE_ID & 0xff), pk, Uint8Array.of(p.length), p,
    Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff), payload);
}

/** True only when BOTH components verify over M' (strict Ed25519 profile, ML-DSA-65 with the suite context). */
export function hybridVerify(pk, purpose, payload, sig) {
  if (pk.length !== 1984 || sig.length !== 3373 || !strictPoint(pk.subarray(0, 32))) return false;
  const m = hybridMessage(pk, purpose, payload);
  let edOk = false;
  let mlOk = false;
  try {
    edOk = strictPoint(sig.subarray(0, 32)) && ed25519.verify(sig.subarray(0, 64), m, pk.subarray(0, 32), { zip215: false });
  } catch {
    edOk = false;
  }
  try {
    mlOk = ml_dsa65.verify(sig.subarray(64), m, pk.subarray(32), { context: enc(SUITE_TAG) });
  } catch {
    mlOk = false;
  }
  return edOk && mlOk;
}

export function canonicalPqKeyBinding(w) {
  return enc([TAG_PQ_KEY_BINDING, w.role, w.subjectId, w.ed25519PubHex, w.mldsaPubHex, String(w.issuedAt)].join("|"));
}

/**
 * The same checks, in the same order and with the same codes, as the protocol package's
 * verifyPqKeyBinding. Returns { mldsaPubHex, issuedAt, hybridPublicKey } or throws PqBindingError.
 */
export function verifyPqKeyBinding(w, expect) {
  if (typeof w !== "object" || w === null || Array.isArray(w)) fail("binding-malformed");
  if (Object.keys(w).sort().join(",") !== WIRE_KEYS || w.v !== 1) fail("binding-malformed");
  if (typeof w.signature !== "string" || w.signature.length > 2 * 65536 || !HEX.test(w.signature)) fail("binding-malformed");
  if (typeof w.ed25519PubHex !== "string" || !HEX32.test(w.ed25519PubHex)) fail("binding-malformed");
  if (typeof w.mldsaPubHex !== "string" || !HEX_MLDSA.test(w.mldsaPubHex)) fail("binding-malformed");
  if (!Number.isSafeInteger(w.issuedAt) || w.issuedAt < 0) fail("binding-malformed");
  if (!ROLES.includes(w.role)) fail("binding-role");
  if (typeof w.subjectId !== "string" || !SUBJECT.test(w.subjectId)) fail("binding-subject");
  if (w.role !== expect.role) fail("binding-role");
  if (w.subjectId !== expect.subjectId) fail("binding-subject");
  if (w.ed25519PubHex !== String(expect.ed25519PubHex).toLowerCase()) fail("binding-key-mismatch");
  if (expect.mldsaPubHex && w.mldsaPubHex !== String(expect.mldsaPubHex).toLowerCase()) fail("binding-pq-key-changed");
  if (w.issuedAt > expect.now + MAX_SKEW_MS) fail("binding-future");
  if (expect.minIssuedAt !== undefined && w.issuedAt < expect.minIssuedAt) fail("binding-stale");
  const pk = bytes(w.ed25519PubHex + w.mldsaPubHex);
  if (!strictPoint(pk.subarray(0, 32))) fail("bad-public-key");
  if (!hybridVerify(pk, TAG_PQ_KEY_BINDING, canonicalPqKeyBinding(w), bytes(w.signature))) fail("bad-signature");
  return { mldsaPubHex: w.mldsaPubHex, issuedAt: w.issuedAt, hybridPublicKey: pk };
}

/** The STK's v2 hybrid signature over a boot-key binding, under the pinned STK + ML-DSA keys. */
export function verifyBootKeyBindingV2(binding, hybridSignatureHex, stkHex, mldsaPubHex) {
  try {
    const sig = String(hybridSignatureHex ?? "").toLowerCase();
    if (!/^[0-9a-f]{6746}$/.test(sig) || !HEX32.test(stkHex) || !HEX_MLDSA.test(mldsaPubHex)) return false;
    const msg = enc([TAG_BOOT_KEY_BINDING_V2, String(binding.serverDomain).toLowerCase(), binding.bootPubHex, String(binding.issuedAt)].join("|"));
    return hybridVerify(bytes(stkHex + mldsaPubHex), TAG_BOOT_KEY_BINDING_V2, msg, bytes(sig));
  } catch {
    return false;
  }
}

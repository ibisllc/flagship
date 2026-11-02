// The byte-level primitives under voi.ci and Messages (docs/voici-and-messages.md §7.1; the architecture-v2 hybrid
// seal, docs/architecture-v2/pq-suites.md §2-§4). Browser twin of packages/protocol/src/webEnvelope.ts (helpers and
// the envelope) and the hybrid-seal half of packages/protocol/src/pqHybrid.ts, byte for byte (shared vectors in
// packages/protocol/test-vectors/messages/, replayed by apps/web/tests/voiciProtocol.test.ts). Import it through
// lib/voiciProtocol.js.
//
// Exported API:
//   hex, hexToBytes, isLowerHex, sha256Hex, b64Encode, b64Decode, canonicalJson, canonicalJsonBytes,
//   ed25519PublicKey, ed25519SignHex, ed25519VerifyHex, p256VerifyP1363,
//   TAG_WEB_ENVELOPE, WEB_ENVELOPE_MAX_BYTES, WEB_ENVELOPE_MAX_BODY_BYTES, canonicalWebEnvelope, parseWebEnvelope,
//   signWebEnvelopeEd25519, signWebEnvelopeP256, verifyWebEnvelopeSignature,
//   PqHybridError, SUITE_HYBRID_SEAL_V1, TAG_HYBRID_SEAL_V1, TAG_ENVELOPE_V2, HYBRID_SEAL_* sizes,
//   validatePurposeTag, encodeEnvelopeHeader, decodeEnvelopeHeader, decodeEnvelope, pqKeyId,
//   parseHybridSealPublicKey, hybridSealKeygen, hybridSealKdfInfo, hybridSealWithRandomness, hybridSeal, hybridOpen.
//
// Pure and synchronous; Uint8Array in and out, hex lowercase. Signing functions take the key the caller holds (the
// webapp is a full account device for Messages, spec §9.5); nothing here fetches or stores a key.

import { ed25519, gcm, hkdf, ml_kem768_x25519, p256, sha256, sha512, x25519 } from "../vendor/noble-post-quantum/pq-seal.js";

const te = new TextEncoder();
const utf8 = (s) => te.encode(s);

// ── small encoders ────────────────────────────────────────────────────────

export function hex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function isLowerHex(s, bytes) {
  if (typeof s !== "string" || s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) return false;
  return bytes === undefined || s.length === bytes * 2;
}

export function hexToBytes(h) {
  if (!isLowerHex(h)) throw new Error("not lowercase hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function sha256Hex(b) {
  return hex(sha256(typeof b === "string" ? utf8(b) : b));
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding. */
export function b64Encode(b) {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    s += i + 1 < b.length ? B64[(n >> 6) & 63] : "=";
    s += i + 2 < b.length ? B64[n & 63] : "=";
  }
  return s;
}

/** Strict standard base64: padded, canonical (re-encodes to the same string), else null. */
export function b64Decode(s) {
  if (typeof s !== "string" || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => (s[i + k] === "=" ? 0 : B64.indexOf(s[i + k])));
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return b64Encode(out) === s ? out : null;
}

// ── canonical JSON (RFC 8785 subset: sorted keys, safe integers only) ─────

function jsonString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw new Error("canonical JSON: lone surrogate");
      out += s[i] + s[i + 1];
      i++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) throw new Error("canonical JSON: lone surrogate");
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += s[i];
  }
  return out + '"';
}

export function canonicalJson(v) {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw new Error("canonical JSON: only safe integers");
    return String(v);
  }
  if (typeof v === "string") return jsonString(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return "{" + keys.map((k) => jsonString(k) + ":" + canonicalJson(v[k])).join(",") + "}";
  }
  throw new Error("canonical JSON: unsupported value");
}

export function canonicalJsonBytes(v) {
  return utf8(canonicalJson(v));
}

// ── signatures ────────────────────────────────────────────────────────────

// The libsodium small-order / non-canonical blocklist the protocol package's `ed` refuses (edSync.ts).
const LOW_ORDER_PUBKEYS = new Set([
  "0100000000000000000000000000000000000000000000000000000000000000",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
]);

export function ed25519PublicKey(seed) {
  return ed25519.getPublicKey(seed);
}

/** Ed25519 (RFC 8032, deterministic) over `msg` with a 32-byte seed, hex. */
export function ed25519SignHex(msg, seed) {
  return hex(ed25519.sign(msg, seed));
}

export function ed25519VerifyHex(sigHex, msg, pubHex) {
  if (!isLowerHex(sigHex, 64) || !isLowerHex(pubHex, 32) || LOW_ORDER_PUBKEYS.has(pubHex)) return false;
  try {
    return ed25519.verify(hexToBytes(sigHex), msg, hexToBytes(pubHex));
  } catch {
    return false;
  }
}

/** ECDSA P-256 / SHA-256, IEEE P1363 signature (hex 128), uncompressed SEC1 key (hex 130). High-S accepted. */
export function p256VerifyP1363(sigHex, msg, pubHex) {
  if (!isLowerHex(sigHex, 64) || !isLowerHex(pubHex, 65) || !pubHex.startsWith("04")) return false;
  try {
    return p256.verify(hexToBytes(sigHex), msg, hexToBytes(pubHex), { lowS: false });
  } catch {
    return false;
  }
}

/** Deterministic (RFC 6979, low-S) P-256 signature, hex: tests only; the browser signs with WebCrypto. */
export function p256SignHex(msg, privateKey) {
  return hex(p256.sign(msg, privateKey, { lowS: true }));
}

// ── the web envelope ──────────────────────────────────────────────────────

export const TAG_WEB_ENVELOPE = "flagship/web-envelope/v1";
export const WEB_ENVELOPE_MAX_BYTES = 64 * 1024;
export const WEB_ENVELOPE_MAX_BODY_BYTES = 24 * 1024;

const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const ENVELOPE_KEYS = ["audience", "bodyB64", "conv", "cred", "from", "kind", "msgId", "sentAt", "seq", "sig", "sigAlg", "v"];
const isTime = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function noSepCtrl(name, value) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x7c) throw new Error(`canonical-bytes field "${name}" contains separator '|' at index ${i}`);
    if (c <= 0x1f || c === 0x7f) throw new Error(`canonical-bytes field "${name}" contains control char 0x${c.toString(16)} at index ${i}`);
  }
}

/** The signed bytes. Throws on a field that cannot be joined. */
export function canonicalWebEnvelope(e) {
  if (!KIND.test(e.kind)) throw new Error(`${TAG_WEB_ENVELOPE}: bad kind`);
  for (const [k, v] of [["audience", e.audience], ["conv", e.conv], ["from", e.from], ["msgId", e.msgId]]) {
    if (typeof v !== "string") throw new Error(`${TAG_WEB_ENVELOPE}: ${k} must be a string`);
    noSepCtrl(k, v);
  }
  if (!isTime(e.seq) || e.seq < 1) throw new Error(`${TAG_WEB_ENVELOPE}: bad seq`);
  if (!isTime(e.sentAt)) throw new Error(`${TAG_WEB_ENVELOPE}: bad sentAt`);
  const body = b64Decode(e.bodyB64);
  if (!body) throw new Error(`${TAG_WEB_ENVELOPE}: bodyB64 is not canonical base64`);
  return utf8(
    [TAG_WEB_ENVELOPE, e.kind, e.audience, e.conv, e.from, e.msgId, String(e.seq), String(e.sentAt), sha256Hex(body), sha256Hex(canonicalJsonBytes(e.cred))].join("|"),
  );
}

/** Strict outer shape of an untrusted envelope (JSON text or a parsed value); null when malformed. */
export function parseWebEnvelope(input, maxBodyBytes = WEB_ENVELOPE_MAX_BODY_BYTES) {
  let r = input;
  if (typeof input === "string") {
    try {
      r = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const keys = Object.keys(r).sort();
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((k, i) => k !== ENVELOPE_KEYS[i])) return null;
  if (r.v !== 1 || typeof r.kind !== "string" || !KIND.test(r.kind)) return null;
  for (const k of ["audience", "conv", "from"]) {
    if (typeof r[k] !== "string" || r[k].length > 256 || !/^[a-z0-9-]*$/.test(r[k])) return null;
  }
  if (!isLowerHex(r.msgId, 16)) return null;
  if (!isTime(r.seq) || r.seq < 1 || !isTime(r.sentAt)) return null;
  const body = b64Decode(r.bodyB64);
  if (!body || body.length > maxBodyBytes) return null;
  if (!r.cred || typeof r.cred !== "object" || Array.isArray(r.cred)) return null;
  try {
    canonicalJson(r.cred);
  } catch {
    return null;
  }
  if (r.sigAlg !== "ed25519" && r.sigAlg !== "p256") return null;
  if (!isLowerHex(r.sig, 64)) return null;
  return { v: 1, kind: r.kind, audience: r.audience, conv: r.conv, from: r.from, msgId: r.msgId, seq: r.seq, sentAt: r.sentAt, bodyB64: r.bodyB64, cred: r.cred, sigAlg: r.sigAlg, sig: r.sig };
}

export function signWebEnvelopeEd25519(e, seed) {
  const unsigned = { ...e, sigAlg: "ed25519" };
  delete unsigned.sig;
  return { ...unsigned, sig: ed25519SignHex(canonicalWebEnvelope(unsigned), seed) };
}

/** Deterministic P-256: vectors and tests; browsers sign with WebCrypto over canonicalWebEnvelope. */
export function signWebEnvelopeP256(e, privateKey) {
  const unsigned = { ...e, sigAlg: "p256" };
  delete unsigned.sig;
  return { ...unsigned, sig: p256SignHex(canonicalWebEnvelope(unsigned), privateKey) };
}

export function verifyWebEnvelopeSignature(e, signerPub) {
  let bytes;
  try {
    bytes = canonicalWebEnvelope(e);
  } catch {
    return false;
  }
  return e.sigAlg === "p256" ? p256VerifyP1363(e.sig, bytes, signerPub) : ed25519VerifyHex(e.sig, bytes, signerPub);
}

// ── the hybrid seal (pqHybrid.ts §2-§4) ───────────────────────────────────

export const SUITE_HYBRID_SEAL_V1 = 0x0001;
const SUITE_HYBRID_SIG = 0x0002;
export const TAG_HYBRID_SEAL_V1 = "flagship/hybrid-seal/v1";
export const TAG_ENVELOPE_V2 = "flagship/envelope/v2";
const TAG_KEY_ID = "flagship/pq-key-id/v1";

export const ENVELOPE_MAX_HEADER_LEN = 1024;
export const ENVELOPE_MAX_BODY_LEN = 1_048_576 + 4096;
export const HYBRID_SEAL_PUBLIC_KEY_LEN = 1216;
export const HYBRID_SEAL_SECRET_KEY_LEN = 32;
export const HYBRID_SEAL_ENC_LEN = 1120;
export const HYBRID_SEAL_TAG_LEN = 16;
export const HYBRID_SEAL_RANDOMNESS_LEN = 64;
export const HYBRID_SEAL_MAX_PLAINTEXT_LEN = 1_048_576;
export const HYBRID_SEAL_MAX_CONTEXT_FIELDS = 16;
export const HYBRID_SEAL_MAX_CONTEXT_FIELD_LEN = 1024;

const KEY_ID_LEN = 32;
const ML_KEM_PK_LEN = 1184;
const OKM_LEN = 44;
const SUITES = new Set([SUITE_HYBRID_SEAL_V1, SUITE_HYBRID_SIG]);

/** A refusal; `code` matches the TypeScript, the Rust crates and the vectors. */
export class PqHybridError extends Error {
  constructor(code) {
    super(code);
    this.name = "PqHybridError";
    this.code = code;
  }
}
const fail = (code) => {
  throw new PqHybridError(code);
};

function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

const u8 = (n) => Uint8Array.of(n & 0xff);
const u16be = (n) => Uint8Array.of((n >>> 8) & 0xff, n & 0xff);
const u32be = (n) => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
function u64be(n) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}
const lp8 = (b) => concat(u8(b.length), b);

/** Purpose-tag grammar (§2.2); `allowLegacyPb` admits the v1 `pb/...` tags. */
export function validatePurposeTag(tag, allowLegacyPb = false) {
  if (typeof tag !== "string" || tag.length === 0 || tag.length > 128) return false;
  const parts = tag.split("/");
  const ns = parts[0];
  if (!(ns === "flagship" || (allowLegacyPb && ns === "pb"))) return false;
  const segments = parts.length - 2;
  if (segments < 1 || segments > 6) return false;
  for (const seg of parts.slice(1, -1)) {
    if (seg.length === 0 || seg.length > 48 || !/^[a-z0-9][a-z0-9-]*$/.test(seg)) return false;
  }
  return /^v[1-9][0-9]{0,3}$/.test(parts[parts.length - 1]);
}

const T = { purpose: 0x01, suite: 0x02, sender: 0x03, recipient: 0x04, installation: 0x05, generation: 0x06, session: 0x07, policy: 0x08, issued: 0x09, expires: 0x0a, bodyLen: 0x0b };
const FIXED_LEN = { [T.suite]: 2, [T.sender]: 32, [T.recipient]: 32, [T.installation]: 16, [T.generation]: 8, [T.session]: 32, [T.policy]: 64, [T.issued]: 8, [T.expires]: 8, [T.bodyLen]: 4 };

function validateHeader(h) {
  const p = utf8(h.purpose);
  if (p.length === 0 || p.length > 128) fail("header-field-length");
  if (!validatePurposeTag(h.purpose)) fail("header-bad-value");
  const fixed = [[h.senderKeyId, 32], [h.recipientKeyId, 32], [h.installationId, 16], [h.sessionNonce, 32], [h.policyDigest, 64]];
  for (const [v, n] of fixed) if (v !== undefined && v.length !== n) fail("header-field-length");
  if (!SUITES.has(h.suite)) fail("header-bad-value");
  for (const v of [h.issuedAt, h.expiresAt, h.authorityGeneration]) if (v !== undefined && !isTime(v)) fail("header-bad-value");
  if (h.expiresAt !== undefined && h.expiresAt <= h.issuedAt) fail("header-bad-value");
  if (!isTime(h.bodyLen) || h.bodyLen > ENVELOPE_MAX_BODY_LEN) fail("header-bad-value");
  if (h.suite === SUITE_HYBRID_SEAL_V1 && h.recipientKeyId === undefined) fail("header-missing-field");
}

/** The v2 envelope header (§3): lp8(magic) || u16 TLV length || TLVs in type order. */
export function encodeEnvelopeHeader(h) {
  validateHeader(h);
  const tlv = [];
  const put = (ty, v) => tlv.push(u8(ty), u16be(v.length), v);
  put(T.purpose, utf8(h.purpose));
  put(T.suite, u16be(h.suite));
  put(T.sender, h.senderKeyId);
  if (h.recipientKeyId) put(T.recipient, h.recipientKeyId);
  if (h.installationId) put(T.installation, h.installationId);
  if (h.authorityGeneration !== undefined) put(T.generation, u64be(h.authorityGeneration));
  if (h.sessionNonce) put(T.session, h.sessionNonce);
  if (h.policyDigest) put(T.policy, h.policyDigest);
  put(T.issued, u64be(h.issuedAt));
  if (h.expiresAt !== undefined) put(T.expires, u64be(h.expiresAt));
  put(T.bodyLen, u32be(h.bodyLen));
  const body = concat(...tlv);
  const out = concat(lp8(utf8(TAG_ENVELOPE_V2)), u16be(body.length), body);
  if (out.length > ENVELOPE_MAX_HEADER_LEN) fail("header-too-large");
  return out;
}

function readU64(v) {
  const n = new DataView(v.buffer, v.byteOffset, 8).getBigUint64(0);
  return n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.NaN : Number(n);
}

/** Decodes a header at the start of `bytes`; check order as in §3.3. */
export function decodeEnvelopeHeader(bytes) {
  const magic = lp8(utf8(TAG_ENVELOPE_V2));
  if (bytes.length < magic.length) fail("header-truncated");
  if (!equalBytes(bytes.subarray(0, magic.length), magic)) fail("header-bad-magic");
  if (bytes.length < magic.length + 2) fail("header-truncated");
  const tlvLen = (bytes[magic.length] << 8) | bytes[magic.length + 1];
  const total = magic.length + 2 + tlvLen;
  if (total > ENVELOPE_MAX_HEADER_LEN) fail("header-too-large");
  if (bytes.length < total) fail("header-truncated");
  const tlv = bytes.subarray(magic.length + 2, total);
  const f = {};
  let purpose;
  let prev = 0;
  let o = 0;
  while (o < tlv.length) {
    if (o + 3 > tlv.length) fail("header-truncated");
    const ty = tlv[o];
    const len = (tlv[o + 1] << 8) | tlv[o + 2];
    o += 3;
    if (o + len > tlv.length) fail("header-truncated");
    const value = tlv.subarray(o, o + len);
    o += len;
    if (ty < T.purpose || ty > T.bodyLen) fail("header-unknown-field");
    if (ty === prev) fail("header-duplicate-field");
    if (ty < prev) fail("header-field-order");
    prev = ty;
    if (ty === T.purpose) {
      if (len === 0 || len > 128) fail("header-field-length");
      try {
        purpose = new TextDecoder("utf-8", { fatal: true }).decode(value);
      } catch {
        fail("header-bad-value");
      }
    } else if (len !== FIXED_LEN[ty]) {
      fail("header-field-length");
    }
    if (ty === T.suite && !SUITES.has((value[0] << 8) | value[1])) fail("header-bad-value");
    f[ty] = value;
  }
  const req = (ty) => f[ty] ?? fail("header-missing-field");
  if (purpose === undefined) fail("header-missing-field");
  const suiteB = req(T.suite);
  const sender = req(T.sender);
  const issued = req(T.issued);
  const bodyLenB = req(T.bodyLen);
  const opt = (ty) => (f[ty] ? Uint8Array.from(f[ty]) : undefined);
  const header = {
    purpose,
    suite: (suiteB[0] << 8) | suiteB[1],
    senderKeyId: Uint8Array.from(sender),
    issuedAt: readU64(issued),
    bodyLen: new DataView(bodyLenB.buffer, bodyLenB.byteOffset, 4).getUint32(0),
  };
  const recipient = opt(T.recipient);
  if (recipient) header.recipientKeyId = recipient;
  const installation = opt(T.installation);
  if (installation) header.installationId = installation;
  if (f[T.generation]) header.authorityGeneration = readU64(f[T.generation]);
  const session = opt(T.session);
  if (session) header.sessionNonce = session;
  const policy = opt(T.policy);
  if (policy) header.policyDigest = policy;
  if (f[T.expires]) header.expiresAt = readU64(f[T.expires]);
  validateHeader(header);
  if (!equalBytes(encodeEnvelopeHeader(header), bytes.subarray(0, total))) fail("header-bad-value");
  return { header, length: total };
}

/** Decodes `header || body`; the body must be exactly `bodyLen` bytes. */
export function decodeEnvelope(bytes) {
  const { header, length } = decodeEnvelopeHeader(bytes);
  const body = bytes.subarray(length);
  if (body.length !== header.bodyLen) fail("body-length");
  return { header, headerBytes: bytes.subarray(0, length), body };
}

/** Key id (§2.3): the first 32 bytes of SHA-512(lp8(tag) || u16 suite || u16 len || key). */
export function pqKeyId(suite, publicKey) {
  return sha512(concat(lp8(utf8(TAG_KEY_ID)), u16be(suite), u16be(publicKey.length), publicKey)).slice(0, KEY_ID_LEN);
}

const X25519_PROBE = new Uint8Array(32).fill(0x5a);

function mlKemModulusOk(ek) {
  for (let i = 0; i < 1152; i += 3) {
    const b0 = ek[i];
    const b1 = ek[i + 1];
    const b2 = ek[i + 2];
    if ((b0 | ((b1 & 0x0f) << 8)) >= 3329) return false;
    if (((b1 >> 4) | (b2 << 4)) >= 3329) return false;
  }
  return true;
}

/** Validates an X-Wing encapsulation key (length, ML-KEM modulus, X25519 not small order). */
export function parseHybridSealPublicKey(pk) {
  if (!(pk instanceof Uint8Array) || pk.length !== HYBRID_SEAL_PUBLIC_KEY_LEN) fail("bad-public-key");
  if (!mlKemModulusOk(pk.subarray(0, ML_KEM_PK_LEN))) fail("bad-public-key");
  try {
    x25519.getSharedSecret(X25519_PROBE, pk.subarray(ML_KEM_PK_LEN));
  } catch {
    fail("bad-public-key");
  }
  return pk;
}

export function hybridSealKeygen(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== HYBRID_SEAL_SECRET_KEY_LEN) fail("bad-secret-key");
  const { publicKey } = ml_kem768_x25519.keygen(seed);
  return { publicKey: parseHybridSealPublicKey(publicKey), secretKey: Uint8Array.from(seed) };
}

function checkSealInputs(purpose, context) {
  if (!validatePurposeTag(purpose)) fail("bad-purpose");
  if (context.length > HYBRID_SEAL_MAX_CONTEXT_FIELDS || context.some((c) => c.length > HYBRID_SEAL_MAX_CONTEXT_FIELD_LEN)) fail("context-too-large");
}

/** The HKDF `info` (§4.3). */
export function hybridSealKdfInfo(headerBytes, header, context, enc) {
  const ctx = [u8(context.length)];
  for (const c of context) ctx.push(u16be(c.length), c);
  return concat(
    lp8(utf8(TAG_HYBRID_SEAL_V1)),
    u16be(SUITE_HYBRID_SEAL_V1),
    lp8(utf8(header.purpose)),
    header.senderKeyId,
    header.recipientKeyId ?? new Uint8Array(KEY_ID_LEN),
    u32be(headerBytes.length),
    headerBytes,
    ...ctx,
    enc,
  );
}

function deriveSealKeys(ss, info) {
  const okm = hkdf(sha512, ss, utf8(TAG_HYBRID_SEAL_V1), info, OKM_LEN);
  return { key: okm.slice(0, 32), nonce: okm.slice(32, OKM_LEN) };
}

/**
 * Seal with caller-supplied encapsulation randomness (64 bytes: ML-KEM coins, then the X25519 ephemeral secret).
 * Reusing `eseed` reuses the AES key and nonce: vectors only; everything else calls hybridSeal.
 * opts: {purpose, senderKeyId, issuedAt, expiresAt?, installationId?, authorityGeneration?, sessionNonce?, policyDigest?}
 */
export function hybridSealWithRandomness(recipientPublicKey, opts, context, plaintext, eseed) {
  const pk = parseHybridSealPublicKey(recipientPublicKey);
  checkSealInputs(opts.purpose, context);
  if (plaintext.length > HYBRID_SEAL_MAX_PLAINTEXT_LEN) fail("plaintext-too-large");
  if (eseed.length !== HYBRID_SEAL_RANDOMNESS_LEN) fail("randomness");
  const header = {
    purpose: opts.purpose,
    suite: SUITE_HYBRID_SEAL_V1,
    senderKeyId: opts.senderKeyId,
    recipientKeyId: pqKeyId(SUITE_HYBRID_SEAL_V1, pk),
    issuedAt: opts.issuedAt,
    bodyLen: HYBRID_SEAL_ENC_LEN + plaintext.length + HYBRID_SEAL_TAG_LEN,
  };
  if (opts.expiresAt !== undefined) header.expiresAt = opts.expiresAt;
  if (opts.installationId) header.installationId = opts.installationId;
  if (opts.authorityGeneration !== undefined) header.authorityGeneration = opts.authorityGeneration;
  if (opts.sessionNonce) header.sessionNonce = opts.sessionNonce;
  if (opts.policyDigest) header.policyDigest = opts.policyDigest;
  const headerBytes = encodeEnvelopeHeader(header);
  const { cipherText: enc, sharedSecret } = ml_kem768_x25519.encapsulate(pk, eseed);
  const { key, nonce } = deriveSealKeys(sharedSecret, hybridSealKdfInfo(headerBytes, header, context, enc));
  sharedSecret.fill(0);
  const sealed = gcm(key, nonce, concat(headerBytes, enc)).encrypt(plaintext);
  key.fill(0);
  return concat(headerBytes, enc, sealed);
}

export function hybridSeal(recipientPublicKey, opts, context, plaintext) {
  const eseed = crypto.getRandomValues(new Uint8Array(HYBRID_SEAL_RANDOMNESS_LEN));
  try {
    return hybridSealWithRandomness(recipientPublicKey, opts, context, plaintext, eseed);
  } finally {
    eseed.fill(0);
  }
}

/** Opens a seal; every failure past the header checks is `decrypt-failed`. Returns {header, plaintext}. */
export function hybridOpen(recipientSecretKey, expectedPurpose, context, sealed) {
  checkSealInputs(expectedPurpose, context);
  const { publicKey } = hybridSealKeygen(recipientSecretKey);
  const { header, headerBytes, body } = decodeEnvelope(sealed);
  if (header.suite !== SUITE_HYBRID_SEAL_V1) fail("suite-mismatch");
  if (header.purpose !== expectedPurpose) fail("purpose-mismatch");
  const myId = pqKeyId(SUITE_HYBRID_SEAL_V1, publicKey);
  if (!header.recipientKeyId || !equalBytes(header.recipientKeyId, myId)) fail("recipient-mismatch");
  if (body.length < HYBRID_SEAL_ENC_LEN + HYBRID_SEAL_TAG_LEN) fail("body-length");
  if (body.length - HYBRID_SEAL_ENC_LEN - HYBRID_SEAL_TAG_LEN > HYBRID_SEAL_MAX_PLAINTEXT_LEN) fail("plaintext-too-large");
  const enc = body.subarray(0, HYBRID_SEAL_ENC_LEN);
  let ss;
  try {
    ss = ml_kem768_x25519.decapsulate(enc, recipientSecretKey);
  } catch {
    fail("decrypt-failed");
  }
  const { key, nonce } = deriveSealKeys(ss, hybridSealKdfInfo(headerBytes, header, context, enc));
  ss.fill(0);
  try {
    const plaintext = gcm(key, nonce, concat(headerBytes, enc)).decrypt(body.subarray(HYBRID_SEAL_ENC_LEN));
    return { header, plaintext };
  } catch {
    return fail("decrypt-failed");
  } finally {
    key.fill(0);
  }
}

// AES-256-GCM and the KDFs the voici modules share.
export const aesGcm = (key, nonce, aad) => gcm(key, nonce, aad);
export const hkdfSha256 = (ikm, info, len = 32) => hkdf(sha256, ikm, new Uint8Array(0), utf8(info), len);
export { sha256 };

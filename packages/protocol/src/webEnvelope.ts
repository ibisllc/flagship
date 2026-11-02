/**
 * `flagship/web-envelope/v1`: the signed envelope a website (voi.ci) or an app sends to a Flagship API, and the
 * canonical-JSON and base64 rules every voi.ci / Messages record uses (docs/voici-and-messages.md §7.1). Generic: the
 * voi.ci kinds live in voiciMessages.ts; `packages/flagship-web` and the apps reproduce these bytes from the shared
 * vectors (packages/protocol/test-vectors/messages/).
 *
 * Wire form (JSON):
 *   {v:1, kind, audience, conv, from, msgId, seq, sentAt, bodyB64, cred, sigAlg, sig}
 * Signed bytes:
 *   flagship/web-envelope/v1|<kind>|<audience>|<conv>|<from>|<msgId>|<seq>|<sentAt>|<H(bodyBytes)>|<H(credBytes)>
 * where bodyBytes = base64-decoded `bodyB64`, credBytes = canonicalJson(cred), H = SHA-256 lowercase hex.
 * `sigAlg` "ed25519" (64-byte signature, hex) or "p256" (ECDSA P-256 over SHA-256, IEEE P1363 r||s, hex; high-S is
 * accepted because WebCrypto does not normalize).
 *
 * Canonical JSON (`canonicalJson`): the RFC 8785 subset for our data: object keys sorted by UTF-16 code units, no
 * whitespace, strings escaped exactly as JSON.stringify does for well-formed strings (`\"`, `\\`, `\b\f\n\r\t`,
 * other C0 as `\u00xx`, everything else literal UTF-8), safe integers only (no floats, no -0), `null`, booleans,
 * arrays. Lone surrogates, floats and non-plain values throw.
 *
 * Exported API: TAG_WEB_ENVELOPE, WEB_ENVELOPE_MAX_BYTES, WEB_ENVELOPE_MAX_BODY_BYTES, WebEnvelope, WebEnvelopeSigAlg,
 * canonicalJson, canonicalJsonBytes, b64Encode, b64Decode, sha256Hex, hexToBytes, isLowerHex, canonicalWebEnvelope,
 * parseWebEnvelope, signWebEnvelopeEd25519, signWebEnvelopeP256, verifyWebEnvelopeSignature, p256VerifyP1363,
 * ed25519VerifyHex.
 */
import { sha256 } from "@noble/hashes/sha256";
import { p256 } from "@noble/curves/nist.js";
import { hex, validateNoSepCtrl } from "./canonicalBase.js";
import { ed } from "./edSync.js";
import type { Bytes } from "./types.js";

export const TAG_WEB_ENVELOPE = "flagship/web-envelope/v1";
/** Whole envelope JSON, UTF-8 (voici-message and voici-reply). */
export const WEB_ENVELOPE_MAX_BYTES = 64 * 1024;
/** Decoded body (voici-message and voici-reply). */
export const WEB_ENVELOPE_MAX_BODY_BYTES = 24 * 1024;

export type WebEnvelopeSigAlg = "ed25519" | "p256";

export interface WebEnvelope {
  v: 1;
  kind: string;
  audience: string;
  conv: string;
  from: string;
  msgId: string;
  seq: number;
  sentAt: number;
  bodyB64: string;
  cred: Record<string, unknown>;
  sigAlg: WebEnvelopeSigAlg;
  sig: string;
}

// ── small encoders ─────────────────────────────────────────────────────────

const enc = new TextEncoder();

export function sha256Hex(b: Bytes | string): string {
  return hex(sha256(typeof b === "string" ? enc.encode(b) : b));
}

export function isLowerHex(s: unknown, bytes?: number): s is string {
  if (typeof s !== "string" || s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) return false;
  return bytes === undefined || s.length === bytes * 2;
}

export function hexToBytes(h: string): Bytes {
  if (!isLowerHex(h)) throw new Error("not lowercase hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_CODES = Uint8Array.from(B64, (c) => c.charCodeAt(0));
const ASCII = new TextDecoder();
/** Char code → 6-bit value; "=" (and anything the regex below refuses) reads as 0. */
const B64_INDEX = (() => {
  const t = new Uint8Array(128);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Standard base64 with padding. */
export function b64Encode(b: Bytes): string {
  const out = new Uint8Array(Math.ceil(b.length / 3) * 4);
  let o = 0;
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out[o++] = B64_CODES[(n >> 18) & 63]!;
    out[o++] = B64_CODES[(n >> 12) & 63]!;
    out[o++] = i + 1 < b.length ? B64_CODES[(n >> 6) & 63]! : 61;
    out[o++] = i + 2 < b.length ? B64_CODES[n & 63]! : 61;
  }
  return ASCII.decode(out);
}

/** Strict standard base64: padded, canonical (re-encodes to the same string), else null. */
export function b64Decode(s: unknown): Bytes | null {
  if (typeof s !== "string" || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n =
      (B64_INDEX[s.charCodeAt(i)]! << 18) | (B64_INDEX[s.charCodeAt(i + 1)]! << 12) | (B64_INDEX[s.charCodeAt(i + 2)]! << 6) | B64_INDEX[s.charCodeAt(i + 3)]!;
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return b64Encode(out) === s ? out : null;
}

// ── canonical JSON ─────────────────────────────────────────────────────────

const PLAIN = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;

function jsonString(s: string): string {
  if (PLAIN.test(s)) return `"${s}"`;
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw new Error("canonical JSON: lone surrogate");
      out += s[i]! + s[i + 1]!;
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

/** Canonical JSON text of a JSON value (see the module header). */
export function canonicalJson(v: unknown): string {
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
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return "{" + keys.map((k) => jsonString(k) + ":" + canonicalJson(o[k])).join(",") + "}";
  }
  throw new Error("canonical JSON: unsupported value");
}

export function canonicalJsonBytes(v: unknown): Bytes {
  return enc.encode(canonicalJson(v));
}

// ── the envelope ───────────────────────────────────────────────────────────

const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const ENVELOPE_KEYS = ["audience", "bodyB64", "conv", "cred", "from", "kind", "msgId", "sentAt", "seq", "sig", "sigAlg", "v"];

function isTime(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/** The signed bytes. Throws on a field that cannot be joined. */
export function canonicalWebEnvelope(e: Omit<WebEnvelope, "sig" | "sigAlg"> & { sigAlg?: WebEnvelopeSigAlg }): Bytes {
  if (!KIND.test(e.kind)) throw new Error(`${TAG_WEB_ENVELOPE}: bad kind`);
  for (const [k, v] of [["audience", e.audience], ["conv", e.conv], ["from", e.from], ["msgId", e.msgId]] as const) {
    if (typeof v !== "string") throw new Error(`${TAG_WEB_ENVELOPE}: ${k} must be a string`);
    validateNoSepCtrl(k, v);
  }
  if (!isTime(e.seq) || e.seq < 1) throw new Error(`${TAG_WEB_ENVELOPE}: bad seq`);
  if (!isTime(e.sentAt)) throw new Error(`${TAG_WEB_ENVELOPE}: bad sentAt`);
  const body = b64Decode(e.bodyB64);
  if (!body) throw new Error(`${TAG_WEB_ENVELOPE}: bodyB64 is not canonical base64`);
  return enc.encode(
    [TAG_WEB_ENVELOPE, e.kind, e.audience, e.conv, e.from, e.msgId, String(e.seq), String(e.sentAt), sha256Hex(body), sha256Hex(canonicalJsonBytes(e.cred))].join("|"),
  );
}

/**
 * Strict outer shape of an untrusted envelope (JSON text or an already parsed value): exactly the keys above, types,
 * hex lengths for msgId (16 bytes) and the signature, canonical base64. Kind-specific rules (audience, conv, from,
 * caps of the cred) are the caller's. `maxBodyBytes` defaults to WEB_ENVELOPE_MAX_BODY_BYTES. Null when malformed.
 */
export function parseWebEnvelope(input: unknown, maxBodyBytes = WEB_ENVELOPE_MAX_BODY_BYTES): WebEnvelope | null {
  let v: unknown = input;
  if (typeof input === "string") {
    try {
      v = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r).sort();
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((k, i) => k !== ENVELOPE_KEYS[i])) return null;
  if (r.v !== 1 || typeof r.kind !== "string" || !KIND.test(r.kind)) return null;
  for (const k of ["audience", "conv", "from"] as const) {
    if (typeof r[k] !== "string" || (r[k] as string).length > 256 || !/^[a-z0-9-]*$/.test(r[k] as string)) return null;
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
  return {
    v: 1,
    kind: r.kind,
    audience: r.audience as string,
    conv: r.conv as string,
    from: r.from as string,
    msgId: r.msgId,
    seq: r.seq,
    sentAt: r.sentAt,
    bodyB64: r.bodyB64 as string,
    cred: r.cred as Record<string, unknown>,
    sigAlg: r.sigAlg,
    sig: r.sig,
  };
}

export function signWebEnvelopeEd25519(e: Omit<WebEnvelope, "sig" | "sigAlg">, seed: Bytes): WebEnvelope {
  const unsigned = { ...e, sigAlg: "ed25519" as const };
  return { ...unsigned, sig: hex(ed.sign(canonicalWebEnvelope(unsigned), seed)) };
}

/** Deterministic (RFC 6979, low-S) P-256 signature: for vectors and tests; browsers sign with WebCrypto. */
export function signWebEnvelopeP256(e: Omit<WebEnvelope, "sig" | "sigAlg">, privateKey: Bytes): WebEnvelope {
  const unsigned = { ...e, sigAlg: "p256" as const };
  return { ...unsigned, sig: hex(p256.sign(canonicalWebEnvelope(unsigned), privateKey, { lowS: true })) };
}

/** ECDSA P-256 / SHA-256, IEEE P1363 signature (hex 128), uncompressed SEC1 key (hex 130). High-S accepted. */
export function p256VerifyP1363(sigHex: string, msg: Bytes, pubHex: string): boolean {
  if (!isLowerHex(sigHex, 64) || !isLowerHex(pubHex, 65) || !pubHex.startsWith("04")) return false;
  try {
    return p256.verify(hexToBytes(sigHex), msg, hexToBytes(pubHex), { lowS: false });
  } catch {
    return false;
  }
}

export function ed25519VerifyHex(sigHex: string, msg: Bytes, pubHex: string): boolean {
  if (!isLowerHex(sigHex, 64) || !isLowerHex(pubHex, 32)) return false;
  try {
    return ed.verify(hexToBytes(sigHex), msg, hexToBytes(pubHex));
  } catch {
    return false;
  }
}

/** Checks `sig` over the canonical bytes with `signerPub` (Ed25519 hex 64, or P-256 SEC1 uncompressed hex 130). */
export function verifyWebEnvelopeSignature(e: WebEnvelope, signerPub: string): boolean {
  let bytes: Bytes;
  try {
    bytes = canonicalWebEnvelope(e);
  } catch {
    return false;
  }
  return e.sigAlg === "p256" ? p256VerifyP1363(e.sig, bytes, signerPub) : ed25519VerifyHex(e.sig, bytes, signerPub);
}

// Ed25519 public keys from outside are checked here before any signature is verified under them
// (test-vectors/ed25519-low-order; the same rule as packages/protocol edSync.isAcceptableEd25519PublicKey).
// WebCrypto and noble's default (ZIP-215) verify accept small-order keys, under which R = identity, S = 0
// verifies for every message, so the verifier alone is no guard. Every Ed25519 verify in the webapp goes
// through verifyEd25519 / verifyEd25519Sync.
import { ed25519, sha512 } from "../vendor/noble-post-quantum/pq-seal.js";

const VERDICT = new Map();
const VERDICT_MAX = 512;

function bytesOf(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string" && /^(?:[0-9a-fA-F]{2})*$/.test(v)) {
    const out = new Uint8Array(v.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(v.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** True when `pub` (bytes or hex) is 32 bytes, canonically encoded and not of small order. */
export function isAcceptableEd25519PublicKey(pub) {
  const b = bytesOf(pub);
  if (!b || b.length !== 32) return false;
  const id = toHex(b);
  const known = VERDICT.get(id);
  if (known !== undefined) return known;
  let ok;
  try {
    const p = ed25519.Point.fromBytes(b, false);
    ok = toHex(p.toBytes()) === id && !p.isSmallOrder();
  } catch {
    ok = false;
  }
  if (VERDICT.size >= VERDICT_MAX) VERDICT.delete(VERDICT.keys().next().value);
  VERDICT.set(id, ok);
  return ok;
}

/** WebCrypto Ed25519 verify behind the key check. Bytes or hex; never throws. */
export async function verifyEd25519(pub, signature, message) {
  try {
    const p = bytesOf(pub);
    const s = bytesOf(signature);
    if (!p || !s || s.length !== 64 || !isAcceptableEd25519PublicKey(p)) return false;
    const key = await crypto.subtle.importKey("raw", p, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, s, message);
  } catch {
    return false;
  }
}

// noble's default verify follows ZIP-215 (non-canonical R, cofactored check), so a signature with a
// mixed-order R verifies there and nowhere else. The sync path uses the same strict rule as `.com`'s edSync
// and WebCrypto (test-vectors/ed25519-strict): S < L, R and A canonical, A not of small order, and the
// cofactorless equation [S]B = R + [k]A.
const L = ed25519.Point.Fn.ORDER;

function leNumber(b) {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}

function canonicalPoint(b) {
  const p = ed25519.Point.fromBytes(b, false);
  return toHex(p.toBytes()) === toHex(b) ? p : null;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

function strictVerify(sig, msg, pub) {
  const A = canonicalPoint(pub);
  if (!A || A.isSmallOrder()) return false;
  const rBytes = sig.subarray(0, 32);
  const R = canonicalPoint(rBytes);
  if (!R) return false;
  const S = leNumber(sig.subarray(32));
  if (S >= L) return false;
  const k = leNumber(sha512(concat(rBytes, pub, msg))) % L;
  const sB = S === 0n ? ed25519.Point.ZERO : ed25519.Point.BASE.multiply(S);
  return sB.equals(R.add(A.multiplyUnsafe(k)));
}

/** Strict Ed25519 verify behind the key check. Bytes or hex; never throws. */
export function verifyEd25519Sync(pub, signature, message) {
  try {
    const p = bytesOf(pub);
    const s = bytesOf(signature);
    const m = bytesOf(message);
    if (!p || !s || !m || s.length !== 64 || !isAcceptableEd25519PublicKey(p)) return false;
    return strictVerify(s, m, p);
  } catch {
    return false;
  }
}

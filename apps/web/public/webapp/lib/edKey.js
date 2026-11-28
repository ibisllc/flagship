// Ed25519 public keys from outside are checked here before any signature is verified under them
// (test-vectors/ed25519-low-order; the same rule as packages/protocol edSync.isAcceptableEd25519PublicKey).
// WebCrypto and noble's default (ZIP-215) verify accept small-order keys, under which R = identity, S = 0
// verifies for every message, so the verifier alone is no guard. Every Ed25519 verify in the webapp goes
// through verifyEd25519 / verifyEd25519Sync.
import { ed25519 } from "../vendor/noble-post-quantum/pq-seal.js";

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

/** noble Ed25519 verify behind the key check (`opts` as noble's, e.g. { zip215: false }). Never throws. */
export function verifyEd25519Sync(pub, signature, message, opts) {
  try {
    const p = bytesOf(pub);
    const s = bytesOf(signature);
    if (!p || !s || s.length !== 64 || !isAcceptableEd25519PublicKey(p)) return false;
    return opts === undefined ? ed25519.verify(s, message, p) : ed25519.verify(s, message, p, opts);
  } catch {
    return false;
  }
}

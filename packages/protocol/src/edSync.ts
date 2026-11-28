import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { opaqueOps } from "./opaqueKey.js";

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// ── Low-order / non-canonical public-key refusal ───────────────────────
// Plain Ed25519 verification ACCEPTS low-order public keys: with the identity
// key (0x01 00…00) the signature R = identity, S = 0 verifies against ANY
// message, under noble's ZIP-215 rules and under WebCrypto's cofactorless
// check alike. Any envelope whose verifier key comes from untrusted input (a
// username claim's IRK, a redeem AID, …) could then be "signed" by anyone. So
// before any verify, the key must decode under RFC 8032's canonical rules
// (y < p, no x = 0 with the sign bit) and must not be of small order. A hand-
// typed blocklist missed three such encodings; this is the structural rule.
// Honest keys are a·B: always canonical and of prime order, so nothing
// legitimate is refused. The verdict is remembered per key (bounded), so a
// key's point decode is paid once per isolate, not once per request.
const KEY_VERDICT = new Map<string, boolean>();
const KEY_VERDICT_MAX = 512;

/** True when `pub` is 32 bytes, canonically encoded and not of small order. */
export function isAcceptableEd25519PublicKey(pub: Uint8Array | string): boolean {
  let bytes: Uint8Array;
  try {
    bytes = typeof pub === "string" ? ed.etc.hexToBytes(pub) : pub;
  } catch {
    return false;
  }
  if (bytes.length !== 32) return false;
  const id = ed.etc.bytesToHex(bytes);
  const known = KEY_VERDICT.get(id);
  if (known !== undefined) return known;
  let ok: boolean;
  try {
    ok = !ed.Point.fromBytes(bytes, false).isSmallOrder();
  } catch {
    ok = false;
  }
  if (KEY_VERDICT.size >= KEY_VERDICT_MAX) {
    const oldest = KEY_VERDICT.keys().next().value;
    if (oldest !== undefined) KEY_VERDICT.delete(oldest);
  }
  KEY_VERDICT.set(id, ok);
  return ok;
}

function pubBytesOf(pub: Uint8Array | string): Uint8Array {
  return typeof pub === "string" ? ed.etc.hexToBytes(pub) : pub;
}

const asBytes = (v: Uint8Array | string): Uint8Array => (typeof v === "string" ? ed.etc.hexToBytes(v) : v);

// ── Verified-triple memo ───────────────────────────────────────────────
// Ed25519 verification is a pure function of (signature, message, public key),
// so a triple that verified once verifies the same forever: remembering it
// weakens nothing. It is what makes a stored artifact (a device grant, a
// server order) cost one verification per isolate instead of one per request.
// Only successes are kept, so a flood of bad signatures cannot push good
// entries out. Bounded; the oldest goes first. State that CAN change (a
// grant's revocation, expiry, a rotated root) is judged by the callers on
// every call and is never part of this key.
const VERIFIED = new Map<string, true>();
const VERIFIED_MAX = 2048;
// Failures are remembered too (a stored grant signed by another root fails the
// same way on every request), in a SEPARATE small map: a flood of bad
// signatures can only push other bad ones out, never a good entry.
const REJECTED = new Map<string, true>();
const REJECTED_MAX = 256;

function tripleKey(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): string {
  // Length-prefixed latin1 concatenation: exact, no hash to collide.
  let out = `${sig.length}.${pub.length}.`;
  const chunk = 4096;
  for (const b of [sig, pub, msg]) {
    for (let i = 0; i < b.length; i += chunk) {
      out += String.fromCharCode.apply(null, b.subarray(i, i + chunk) as unknown as number[]);
    }
  }
  return out;
}

function remember(key: string): void {
  if (VERIFIED.size >= VERIFIED_MAX) {
    const oldest = VERIFIED.keys().next().value;
    if (oldest !== undefined) VERIFIED.delete(oldest);
  }
  VERIFIED.set(key, true);
}

function rememberRejected(key: string): void {
  if (REJECTED.size >= REJECTED_MAX) {
    const oldest = REJECTED.keys().next().value;
    if (oldest !== undefined) REJECTED.delete(oldest);
  }
  REJECTED.set(key, true);
}

// ── Strict verification ────────────────────────────────────────────────
// noble's default verify follows ZIP-215: R may be a non-canonical encoding
// (y >= p, or x = 0 with the sign bit) and the check is cofactored
// ([8][S]B = [8]R + [8][k]A), so one signature has several byte forms and a
// small-order component in R is ignored. Every signer we accept produces
// RFC 8032 signatures, which also pass the strict rule used here and by
// WebCrypto: S < L, R canonically encoded, A canonical and not of small order,
// and the cofactorless equation [S]B = R + [k]A. So a signature verifies in
// exactly one byte form and the same way as on the platform verifiers.
const L = ed.CURVE.n;

function leNumber(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
}

function strictVerify(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean {
  if (sig.length !== 64 || pub.length !== 32) return false;
  try {
    const A = ed.Point.fromHex(pub, false);
    if (A.isSmallOrder()) return false;
    const rBytes = sig.subarray(0, 32);
    const R = ed.Point.fromHex(rBytes, false);
    const S = leNumber(sig.subarray(32));
    if (S >= L) return false;
    const k = ed.etc.mod(leNumber(sha512(ed.etc.concatBytes(rBytes, pub, msg))), L);
    const sB = S === 0n ? ed.Point.ZERO : ed.Point.BASE.multiply(S);
    return sB.equals(R.add(A.multiply(k, false)));
  } catch {
    return false;
  }
}

// Hardened verify: reject low-order / malformed pubkeys, verify strictly, and
// NEVER throw on bad input (a boolean verifier must return false, not crash
// the handler — an unguarded throw surfaced as a Worker 500).
function safeVerify(
  sig: Uint8Array | string,
  msg: Uint8Array | string,
  pub: Uint8Array | string,
): boolean {
  try {
    const pubBytes = pubBytesOf(pub);
    if (!isAcceptableEd25519PublicKey(pubBytes)) return false;
    const sigBytes = asBytes(sig);
    const msgBytes = asBytes(msg);
    const key = tripleKey(sigBytes, msgBytes, pubBytes);
    if (VERIFIED.has(key)) return true;
    if (REJECTED.has(key)) return false;
    const ok = strictVerify(sigBytes, msgBytes, pubBytes);
    if (ok) remember(key);
    else rememberRejected(key);
    return ok;
  } catch {
    return false;
  }
}

// ── Native verification where the runtime has it ───────────────────────
// @noble/ed25519 verifies in pure JavaScript, about 1.2 ms of CPU a signature
// (the Workers Free plan allows 10 ms a request). Runtimes with WebCrypto
// Ed25519 (workerd, Node 22+, browsers) check one in about 0.05 ms. The native
// check only ever ACCEPTS: it applies the same strict rule (cofactorless, canonical
// R and S) to a key we already found canonical and of prime order, so whatever it
// accepts the strict check accepts too. Anything it does not accept is handed to
// the strict check, which decides alone where the runtime lacks Ed25519.
type NativeKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const nativeKeys = new Map<string, Promise<NativeKey>>();
let nativeBroken = false;

function nativeKeyFor(pub: Uint8Array): Promise<NativeKey> {
  const id = ed.etc.bytesToHex(pub);
  let k = nativeKeys.get(id);
  if (!k) {
    if (nativeKeys.size >= 256) nativeKeys.delete(nativeKeys.keys().next().value!);
    k = crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
    nativeKeys.set(id, k);
    k.catch(() => nativeKeys.delete(id));
  }
  return k;
}

/** Same verdict as the synchronous `ed.verify`, usually much cheaper. */
async function verifyFast(
  sig: Uint8Array | string,
  msg: Uint8Array | string,
  pub: Uint8Array | string,
): Promise<boolean> {
  try {
    const pubBytes = pubBytesOf(pub);
    const sigBytes = asBytes(sig);
    const msgBytes = asBytes(msg);
    if (!isAcceptableEd25519PublicKey(pubBytes)) return false;
    if (sigBytes.length !== 64) return safeVerify(sig, msg, pub);
    const key = tripleKey(sigBytes, msgBytes, pubBytes);
    if (VERIFIED.has(key)) return true;
    if (!nativeBroken && typeof crypto !== "undefined" && crypto.subtle) {
      try {
        const k = await nativeKeyFor(pubBytes);
        if (await crypto.subtle.verify("Ed25519", k, sigBytes, msgBytes)) {
          remember(key);
          return true;
        }
      } catch (e) {
        // A key the platform cannot decode is just a bad key; only a runtime
        // that lacks Ed25519 altogether turns the native path off.
        const name = (e as { name?: string } | null)?.name;
        if (name === "NotSupportedError" || e instanceof TypeError) nativeBroken = true;
      }
    }
    return safeVerify(sig, msg, pub);
  } catch {
    return false;
  }
}

// Re-export the noble namespace with verify swapped for the hardened one.
// A Proxy delegates every other member (sign/getPublicKey/etc/Point/utils)
// unchanged — the ESM namespace binding itself is read-only, so we can't
// reassign `ed.verify` in place.
function opaqueSign(msg: Uint8Array | string, priv: Uint8Array | string): Uint8Array {
  const ops = opaqueOps(priv);
  if (!ops) return ed.sign(msg, priv);
  return ops.sign(asBytes(msg));
}

const edHardened = new Proxy(ed, {
  get(target, prop, receiver) {
    if (prop === "verify") return safeVerify;
    if (prop === "verifyAsync") {
      return async (sig: Uint8Array | string, msg: Uint8Array | string, pub: Uint8Array | string) =>
        safeVerify(sig, msg, pub);
    }
    if (prop === "sign") return opaqueSign;
    if (prop === "signAsync") return async (msg: Uint8Array | string, priv: Uint8Array | string) => opaqueSign(msg, priv);
    if (prop === "getPublicKey") {
      return (priv: Uint8Array | string) => {
        const ops = opaqueOps(priv);
        return ops ? ops.publicKey : ed.getPublicKey(priv);
      };
    }
    return Reflect.get(target, prop, receiver);
  },
});

export { edHardened as ed, verifyFast as edVerifyFast };

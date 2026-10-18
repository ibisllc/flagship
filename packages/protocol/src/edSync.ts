import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// ── Low-order / non-canonical public-key blocklist ─────────────────────
// Plain Ed25519 verification ACCEPTS low-order public keys — most
// dangerously the all-zero key (0x00…00), for which a zero signature
// verifies against ANY message. Left unguarded this is a forgery vector:
// any envelope whose verifier pubkey comes from untrusted input (a
// username claim's IRK, a redeem AID, …) could be satisfied with the zero
// key, letting an attacker forge a "valid" signature for a key nobody
// controls (e.g. squat any username). We reject the canonical small-order
// + non-canonical encodings (the libsodium blocklist) at the single `ed`
// chokepoint so every verify() in the protocol is covered at once. These
// keys are never legitimate signing keys, so rejecting them is always safe.
// Hex, lowercase, little-endian point encodings.
const LOW_ORDER_PUBKEYS: ReadonlySet<string> = new Set([
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

// Hardened verify: reject low-order / malformed pubkeys and NEVER throw on
// bad input (a boolean verifier must return false, not crash the handler —
// an unguarded throw surfaced as a Worker 500 / "service unavailable").
function safeVerify(
  sig: Uint8Array | string,
  msg: Uint8Array | string,
  pub: Uint8Array | string,
  opts?: Parameters<typeof ed.verify>[3],
): boolean {
  try {
    const pubBytes = pubBytesOf(pub);
    if (pubBytes.length !== 32) return false;
    if (LOW_ORDER_PUBKEYS.has(ed.etc.bytesToHex(pubBytes))) return false;
    if (opts !== undefined) return ed.verify(sig, msg, pub, opts);
    const key = tripleKey(asBytes(sig), asBytes(msg), pubBytes);
    if (VERIFIED.has(key)) return true;
    if (REJECTED.has(key)) return false;
    const ok = ed.verify(sig, msg, pub);
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
// check only ever ACCEPTS: it is stricter than noble's ZIP-215 rules (it takes
// the cofactorless equation and a canonical encoding of R and S), so whatever
// it accepts noble accepts too. Anything it does not accept is handed to the
// exact old check, which keeps the old verdict for every odd encoding.
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
    if (pubBytes.length !== 32 || sigBytes.length !== 64) return safeVerify(sig, msg, pub);
    if (LOW_ORDER_PUBKEYS.has(ed.etc.bytesToHex(pubBytes))) return false;
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
const edHardened = new Proxy(ed, {
  get(target, prop, receiver) {
    if (prop === "verify") return safeVerify;
    return Reflect.get(target, prop, receiver);
  },
});

export { edHardened as ed, verifyFast as edVerifyFast };

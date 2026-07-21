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
    return opts === undefined
      ? ed.verify(sig, msg, pub)
      : ed.verify(sig, msg, pub, opts);
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

export { edHardened as ed };

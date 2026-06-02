// Ed25519 public key → X25519 (Curve25519) Montgomery-u conversion.
//
// The webapp needs to SEAL the LUKS key FOR a box's STK Ed25519 pubkey
// (the boot-approval reply). Sealing requires the recipient's X25519
// public key, derived from its Ed25519 pubkey via the standard
// birational map. WebCrypto exposes no such conversion, and the webapp
// can't bundle @noble/curves, so we implement the (small, pure) map
// here with BigInt field arithmetic.
//
// This is the PUBLIC-key counterpart to keystore.js's private-key
// conversion (SHA-512 clamp). It must match @noble/curves'
// `ed25519.utils.toMontgomery` byte-for-byte (the iOS/box side uses the
// same map):
//
//   y = LE(pubkey) with the top (sign) bit cleared      // Point.fromBytes
//   u = (1 + y) / (1 - y)  mod p,   p = 2^255 - 19       // edwards.js:671
//   return Fp.toBytes(u)  // 32-byte little-endian
//
// (See node_modules/@noble/curves/abstract/edwards.js toMontgomery.)

const P = (1n << 255n) - 19n;

/** Modular reduction into [0, P). */
function mod(a) {
  const r = a % P;
  return r >= 0n ? r : r + P;
}

/** Modular inverse via Fermat's little theorem: a^(p-2) mod p. */
function invert(a) {
  return modPow(mod(a), P - 2n, P);
}

function modPow(base, exp, m) {
  let result = 1n;
  let b = base % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    e >>= 1n;
    b = (b * b) % m;
  }
  return result;
}

/** Decode 32 little-endian bytes into a BigInt. */
function leToBig(bytes) {
  let x = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    x = (x << 8n) | BigInt(bytes[i]);
  }
  return x;
}

/** Encode a field element as 32 little-endian bytes. */
function bigToLe32(x) {
  const out = new Uint8Array(32);
  let v = mod(x);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Convert a 32-byte Ed25519 public key to its 32-byte X25519
 * (Montgomery-u) public key. Pure; throws on a non-32-byte input.
 * @param {Uint8Array} edPub  32-byte Ed25519 public key
 * @returns {Uint8Array}      32-byte X25519 public key (little-endian u)
 */
export function ed25519PubToX25519(edPub) {
  if (!(edPub instanceof Uint8Array) || edPub.length !== 32) {
    throw new Error("ed25519PubToX25519: expected a 32-byte public key");
  }
  // Point.fromBytes reads the affine y from the low 255 bits; the top
  // bit is the x-coordinate sign, which the u-map doesn't use. Clear it.
  const raw = edPub.slice();
  raw[31] &= 0x7f;
  const y = mod(leToBig(raw));
  // u = (1 + y) / (1 - y) mod p
  const u = mod((1n + y) * invert(mod(1n - y)));
  return bigToLe32(u);
}

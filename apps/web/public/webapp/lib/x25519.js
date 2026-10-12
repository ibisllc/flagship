// X25519 private keys for WebCrypto. The spec only allows a raw import for
// an X25519 PUBLIC key; a private one has to arrive as PKCS#8, and current
// browsers enforce that (Chrome 147: "Cannot create a key using the specified
// key usages"). Every place that unseals with this device's key goes through
// here, so a box's unlock request can actually be opened.

// DER prefix of a PKCS#8 PrivateKeyInfo wrapping a 32-byte X25519 scalar.
const X25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
  0x04, 0x22, 0x04, 0x20,
]);

/** Import a 32-byte X25519 scalar for ECDH (`deriveBits`). */
export async function importX25519Private(scalar) {
  const pkcs8 = new Uint8Array(X25519_PKCS8_PREFIX.length + 32);
  pkcs8.set(X25519_PKCS8_PREFIX, 0);
  pkcs8.set(scalar, X25519_PKCS8_PREFIX.length);
  try {
    return await crypto.subtle.importKey("pkcs8", pkcs8, "X25519", false, ["deriveBits"]);
  } catch (e) {
    // An engine that predates PKCS#8 X25519 but takes raw private keys.
    try {
      return await crypto.subtle.importKey("raw", scalar, "X25519", false, ["deriveBits"]);
    } catch {
      throw e;
    }
  }
}

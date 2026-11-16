// The few primitives the sign-in pipe needs, from the same vendored noble bundle the protocol port uses
// (X25519, HKDF-SHA256, AES-256-GCM), plus the protocol checks signIn.js calls. Synchronous and dependency-free, so
// the pipe works in any browser that runs ES modules, with or without WebCrypto X25519.

import { gcm, hkdf, sha256, x25519 } from "./proto/vendor/noble-post-quantum/pq-seal.js";

export { checkVoiciSignInAnswer, checkWebDelegation, hexToBytes, isLowerHex } from "./proto/lib/voiciProtocol.js";

export const x25519PublicKey = (sk) => x25519.getPublicKey(sk);
export const x25519Shared = (sk, peer) => x25519.getSharedSecret(sk, peer);
export const hkdfSha256 = (ikm, salt, info, len) => hkdf(sha256, ikm, salt, info, len);
export const gcmOpen = (key, nonce, ct) => gcm(key, nonce).decrypt(ct);
export const gcmSeal = (key, nonce, pt) => gcm(key, nonce).encrypt(pt);

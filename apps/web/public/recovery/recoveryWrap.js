// Flagship recovery-escrow wrap layer — the SINGLE cross-platform crypto
// contract for wrapping a secret (UMK seed / ACME account key / admin master
// root) under a WebAuthn-PRF-derived key.
//
// This is byte-for-byte identical to the mobile escrow crypto:
//   - iOS   apps/mobile/ios/Sources/Flagship/Recovery.swift,
//           AcmeAccountKey.swift, AdminRootEscrow.swift
//   - Kotlin apps/mobile/android/.../keystore/Recovery.kt,
//           .../core/AdminRootEscrow.kt
//
// The construction, for every blob:
//   key  = HKDF-SHA256(ikm = prfSecret, salt = <domain-sep tag>, info = "",
//                      L = 32)                         ← AES-256 key
//   blob = base64( nonce(12) ‖ AES-256-GCM(key, nonce, plaintext) ‖ tag(16) )
//
// The nonce lives INSIDE the blob (there is NO separate nonce field on the
// wire) — `.com` treats the whole base64 string as one opaque ciphertext and
// only ever SHA-256s it. Each secret rides the SAME PRF-derived input keying
// material but a DISTINCT HKDF salt, so they derive independent AES keys.
//
// Extracted out of recovery.js so the exact shipped wrap is unit-testable in
// Node (global WebCrypto) without the DOM / WebAuthn / Argon2 surface — see
// apps/web/tests/recoveryWrapKat.test.ts, which pins a cross-platform KAT the
// iOS + Android suites decrypt byte-for-byte.

const _enc = new TextEncoder();

// Domain-separation HKDF salts — MUST match the mobile constants verbatim.
//   UMK   : Recovery.swift `flagship/recovery-wrap/v1`         / Recovery.kt WRAP_SALT
//   ACME  : AcmeAccountKey.swift `flagship/recovery-acme-wrap/v1`
//   admin : AdminRootEscrow.swift `flagship/recovery-admin-root-wrap/v1`
export const HKDF_UMK_SALT = _enc.encode("flagship/recovery-wrap/v1");
export const HKDF_ACME_SALT = _enc.encode("flagship/recovery-acme-wrap/v1");
export const HKDF_ADMIN_ROOT_SALT = _enc.encode("flagship/recovery-admin-root-wrap/v1");

/**
 * Derive the AES-256-GCM wrap key from the PRF secret under a domain salt.
 * HKDF-SHA256, empty `info`, 32-byte output — identical to CryptoKit's
 * `HKDF<SHA256>.deriveKey(inputKeyMaterial:salt:info:outputByteCount:)` with an
 * empty info, and to the Android `hkdfSha256(ikm, salt, info=empty, 32)`.
 */
async function deriveWrapKey(prfBytes, saltBytes, usages) {
  const ikm = await crypto.subtle.importKey("raw", prfBytes, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: saltBytes, info: new Uint8Array() },
    ikm,
    256,
  );
  return crypto.subtle.importKey("raw", new Uint8Array(bits), { name: "AES-GCM" }, false, usages);
}

/**
 * Wrap `plaintext` under HKDF(prfBytes, saltBytes) with the given 12-byte
 * nonce. Split out so the KAT can pin a deterministic ciphertext; production
 * callers use {@link wrapWithPrf}, which supplies a fresh random nonce.
 */
export async function wrapWithPrfNonce(plaintext, prfBytes, saltBytes, nonce) {
  const key = await deriveWrapKey(prfBytes, saltBytes, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext),
  );
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return bytesToB64(out);
}

/** Wrap `plaintext` (a raw seed/scalar) → self-contained base64 blob. */
export async function wrapWithPrf(plaintext, prfBytes, saltBytes) {
  const nonce = randBytes(12);
  return wrapWithPrfNonce(plaintext, prfBytes, saltBytes, nonce);
}

/**
 * Reverse of {@link wrapWithPrf}: take the base64 blob (nonce‖ct‖tag) and the
 * PRF secret + domain salt, return the recovered plaintext bytes. Throws on a
 * wrong key (GCM tag mismatch).
 */
export async function unwrapWithPrf(wrappedB64, prfBytes, saltBytes) {
  const wrapped = base64ToBytes(wrappedB64);
  if (wrapped.length < 12 + 16) throw new Error("wrapped blob too short");
  const nonce = wrapped.slice(0, 12);
  const ct = wrapped.slice(12);
  const key = await deriveWrapKey(prfBytes, saltBytes, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct);
  return new Uint8Array(pt);
}

function randBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function bytesToB64(b) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function base64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

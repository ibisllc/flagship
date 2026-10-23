//! The v1 seal format and the `SealedSecretResponse` wrapper, byte for byte
//! with `packages/protocol/src/encryption.ts` and `phoneEndpoint.ts` (and the
//! Go helper in `installer/unseal-helper/internal/unseal`).
//!
//! ```text
//! blob     = eph_x25519_pub(32) || nonce(12) || AES-256-GCM(ct || tag16), no AAD
//! scalar   = clamp(SHA-512(ed25519_seed)[0..32])
//! shared   = X25519(scalar, eph_pub)        (all-zero output refused)
//! key      = HKDF-SHA256(ikm = shared, salt = eph_pub, info = "flagship.seal.v1", 32)
//! response = seal( be32(len(ctx)) || ctx || secret )
//! ctx      = "flagship/secret-response/v1|" || hex(nonce) || "|" || purpose
//! ```

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use core::fmt;
use hkdf::Hkdf;
use sha2::{Digest, Sha256, Sha512};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

/// HKDF `info` (`FLAGSHIP_SEAL_TAG` in encryption.ts).
pub const SEAL_TAG: &str = "flagship.seal.v1";
/// Context tag bound inside a `SealedSecretResponse` (`TAG_SECRET_RESPONSE_CTX`).
pub const TAG_SECRET_RESPONSE_CTX: &str = "flagship/secret-response/v1";

const EPH_PUB_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const HEADER_LEN: usize = EPH_PUB_LEN + NONCE_LEN;

/// Why a blob did not open. The `Display` text is the Go helper's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SealError {
    /// The Ed25519 seed was not 32 bytes.
    SeedLength(usize),
    /// Fewer than 44 bytes: no room for the ephemeral key and nonce.
    BlobTooShort,
    /// The ephemeral key is a low-order point (all-zero shared secret).
    LowOrderPoint,
    /// AES-GCM authentication failed: wrong key or tampered bytes.
    Authentication,
    /// The opened response has no 4-byte length prefix.
    ResponseTooShort,
    /// The length prefix points past the end of the payload.
    ResponseTruncated,
    /// The bound `(nonce, purpose)` is not the request the box sent.
    ContextMismatch,
}

impl fmt::Display for SealError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SeedLength(n) => {
                write!(f, "identity Ed25519 priv (seed) must be 32 bytes, got {n}")
            }
            Self::BlobTooShort => {
                f.write_str("sealed blob too short (need at least eph_pub + nonce)")
            }
            Self::LowOrderPoint => {
                f.write_str("x25519: crypto/ecdh: bad X25519 remote ECDH input: low order point")
            }
            Self::Authentication => f.write_str(
                "gcm open (tag mismatch / wrong key): cipher: message authentication failed",
            ),
            Self::ResponseTooShort => f.write_str("sealed secret response payload too short"),
            Self::ResponseTruncated => f.write_str("sealed secret response payload truncated"),
            Self::ContextMismatch => {
                f.write_str("sealed secret response bound to a different (nonce, purpose)")
            }
        }
    }
}

impl std::error::Error for SealError {}

/// libsodium's `crypto_sign_ed25519_sk_to_curve25519` (noble `toMontgomerySecret`).
pub fn x25519_scalar_from_ed25519_seed(seed: &[u8]) -> Result<Zeroizing<[u8; 32]>, SealError> {
    if seed.len() != 32 {
        return Err(SealError::SeedLength(seed.len()));
    }
    let digest: Zeroizing<[u8; 64]> = Zeroizing::new(Sha512::digest(seed).into());
    let mut scalar = Zeroizing::new([0u8; 32]);
    if let Some(head) = digest.get(..32) {
        scalar.copy_from_slice(head);
    }
    if let Some(b) = scalar.first_mut() {
        *b &= 248;
    }
    if let Some(b) = scalar.last_mut() {
        *b &= 127;
        *b |= 64;
    }
    Ok(scalar)
}

/// The X25519 public key a sealer must target for this Ed25519 seed.
pub fn x25519_public_from_ed25519_seed(seed: &[u8]) -> Result<[u8; 32], SealError> {
    let scalar = x25519_scalar_from_ed25519_seed(seed)?;
    let secret = StaticSecret::from(*scalar);
    Ok(PublicKey::from(&secret).to_bytes())
}

fn seal_key(shared: &[u8], eph_pub: &[u8]) -> Zeroizing<[u8; 32]> {
    let hk = Hkdf::<Sha256>::new(Some(eph_pub), shared);
    let mut key = Zeroizing::new([0u8; 32]);
    // 32 bytes is far below HKDF-SHA256's 8160-byte limit, so expand cannot fail.
    if hk.expand(SEAL_TAG.as_bytes(), key.as_mut_slice()).is_err() {
        key.fill(0);
    }
    key
}

/// `openSealed`: open with a raw 32-byte X25519 private scalar.
pub fn open_sealed(
    blob: &[u8],
    recipient_scalar: &[u8; 32],
) -> Result<Zeroizing<Vec<u8>>, SealError> {
    let (header, ct) = blob
        .split_at_checked(HEADER_LEN)
        .ok_or(SealError::BlobTooShort)?;
    let (eph_pub, nonce) = header.split_at(EPH_PUB_LEN);
    let mut eph = [0u8; 32];
    eph.copy_from_slice(eph_pub);

    let secret = StaticSecret::from(*recipient_scalar);
    let shared = secret.diffie_hellman(&PublicKey::from(eph));
    if !shared.was_contributory() {
        return Err(SealError::LowOrderPoint);
    }
    let key = seal_key(shared.as_bytes(), eph_pub);
    let cipher = Aes256Gcm::new(&(*key).into());
    let nonce = Nonce::try_from(nonce).map_err(|_| SealError::BlobTooShort)?;
    cipher
        .decrypt(&nonce, ct)
        .map(Zeroizing::new)
        .map_err(|_| SealError::Authentication)
}

/// `openSealedFromEd25519Recipient`: open with the box's 32-byte STK seed.
pub fn open_sealed_from_ed25519_seed(
    blob: &[u8],
    seed: &[u8],
) -> Result<Zeroizing<Vec<u8>>, SealError> {
    let scalar = x25519_scalar_from_ed25519_seed(seed)?;
    open_sealed(blob, &scalar)
}

/// `secretResponseContext(nonce, purpose)`, taking the nonce as the hex the box
/// put in its request (the Go helper's form).
pub fn secret_response_context(nonce_hex: &str, purpose: &str) -> Vec<u8> {
    format!("{TAG_SECRET_RESPONSE_CTX}|{nonce_hex}|{purpose}").into_bytes()
}

/// `openSealedSecretResponse`: open, then require the bound context to be
/// exactly the `(nonce, purpose)` of the request the box sent.
pub fn open_sealed_secret_response(
    sealed: &[u8],
    seed: &[u8],
    expect_nonce_hex: &str,
    expect_purpose: &str,
) -> Result<Zeroizing<Vec<u8>>, SealError> {
    open_sealed_secret_response_bytes(
        sealed,
        seed,
        expect_nonce_hex.as_bytes(),
        expect_purpose.as_bytes(),
    )
}

/// Byte form of [`open_sealed_secret_response`]: the CLI receives argv bytes,
/// which need not be UTF-8, and Go compares them as bytes.
pub fn open_sealed_secret_response_bytes(
    sealed: &[u8],
    seed: &[u8],
    expect_nonce_hex: &[u8],
    expect_purpose: &[u8],
) -> Result<Zeroizing<Vec<u8>>, SealError> {
    let payload = open_sealed_from_ed25519_seed(sealed, seed)?;
    let (len_bytes, rest) = payload
        .split_first_chunk::<4>()
        .ok_or(SealError::ResponseTooShort)?;
    let ctx_len = usize::try_from(u32::from_be_bytes(*len_bytes))
        .map_err(|_| SealError::ResponseTruncated)?;
    let (ctx, secret) = rest
        .split_at_checked(ctx_len)
        .ok_or(SealError::ResponseTruncated)?;
    let mut expected = Vec::with_capacity(ctx.len());
    expected.extend_from_slice(TAG_SECRET_RESPONSE_CTX.as_bytes());
    expected.push(b'|');
    expected.extend_from_slice(expect_nonce_hex);
    expected.push(b'|');
    expected.extend_from_slice(expect_purpose);
    if ctx != expected.as_slice() {
        return Err(SealError::ContextMismatch);
    }
    Ok(Zeroizing::new(secret.to_vec()))
}

/// `sealForRecipient` with caller-chosen randomness. Boxes never seal; this
/// exists so tests and vector generators produce deterministic blobs.
pub fn seal_for_recipient_with(
    plaintext: &[u8],
    recipient_x25519_pub: &[u8; 32],
    eph_secret: [u8; 32],
    nonce: [u8; 12],
) -> Vec<u8> {
    let eph = StaticSecret::from(eph_secret);
    let eph_pub = PublicKey::from(&eph).to_bytes();
    let shared = eph.diffie_hellman(&PublicKey::from(*recipient_x25519_pub));
    let key = seal_key(shared.as_bytes(), &eph_pub);
    let cipher = Aes256Gcm::new(&(*key).into());
    let n = Nonce::from(nonce);
    let ct = cipher.encrypt(&n, plaintext).unwrap_or_default();
    let mut out = Vec::with_capacity(HEADER_LEN.saturating_add(ct.len()));
    out.extend_from_slice(&eph_pub);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out
}

/// `buildSealedSecretResponse`'s payload framing, sealed with caller randomness.
pub fn build_sealed_secret_response_with(
    secret: &[u8],
    recipient_x25519_pub: &[u8; 32],
    nonce_hex: &str,
    purpose: &str,
    eph_secret: [u8; 32],
    nonce: [u8; 12],
) -> Vec<u8> {
    let ctx = secret_response_context(nonce_hex, purpose);
    let len = u32::try_from(ctx.len()).unwrap_or(u32::MAX);
    let mut payload = Zeroizing::new(Vec::with_capacity(
        4usize
            .saturating_add(ctx.len())
            .saturating_add(secret.len()),
    ));
    payload.extend_from_slice(&len.to_be_bytes());
    payload.extend_from_slice(&ctx);
    payload.extend_from_slice(secret);
    seal_for_recipient_with(&payload, recipient_x25519_pub, eph_secret, nonce)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use crate::gohex::{decode, encode};

    const SEED: &str = "9d61b19deff31a5f7c4f7e4c8a2b1d4e5d6c7b8a9f0e1d2c3b4a596877869506";

    #[test]
    fn opens_the_pinned_go_vector() {
        let seed = decode(SEED.as_bytes()).unwrap();
        let raw = decode(b"8dc0e0bd9fceb5ecab0632c331aee422268719476d312a04aef93cacdc9abe2070043b6bc257e7498c3b89560d2b744dd9b532ab4b8e111200d30027b45ddc45245cd9af3eea784fb9aee483cc173ed5c63c57e048ddfd855f553af2").unwrap();
        let got = open_sealed_from_ed25519_seed(&raw, &seed).unwrap();
        assert_eq!(
            encode(&got),
            "030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc"
        );
    }

    #[test]
    fn round_trips_and_refuses_tampering() {
        let seed = [7u8; 32];
        let pub_x = x25519_public_from_ed25519_seed(&seed).unwrap();
        let nonce_hex = "ab".repeat(32);
        let mut blob = build_sealed_secret_response_with(
            b"disk key",
            &pub_x,
            &nonce_hex,
            "unlock-key",
            [1; 32],
            [2; 12],
        );
        assert_eq!(
            &*open_sealed_secret_response(&blob, &seed, &nonce_hex, "unlock-key").unwrap(),
            b"disk key"
        );
        assert_eq!(
            open_sealed_secret_response(&blob, &seed, &"cd".repeat(32), "unlock-key"),
            Err(SealError::ContextMismatch)
        );
        assert_eq!(
            open_sealed_secret_response(&blob, &seed, &nonce_hex, "entitlement"),
            Err(SealError::ContextMismatch)
        );
        assert_eq!(
            open_sealed_from_ed25519_seed(&blob, &[8u8; 32]),
            Err(SealError::Authentication)
        );
        blob[50] ^= 1;
        assert_eq!(
            open_sealed_from_ed25519_seed(&blob, &seed),
            Err(SealError::Authentication)
        );
        assert_eq!(
            open_sealed_from_ed25519_seed(&blob[..43], &seed),
            Err(SealError::BlobTooShort)
        );
        assert_eq!(
            open_sealed_from_ed25519_seed(&blob, &[1, 2]),
            Err(SealError::SeedLength(2))
        );
    }

    #[test]
    fn refuses_a_low_order_ephemeral_key() {
        let blob = [0u8; 60];
        assert_eq!(
            open_sealed_from_ed25519_seed(&blob, &[7u8; 32]),
            Err(SealError::LowOrderPoint)
        );
    }
}

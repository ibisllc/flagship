//! The primitives `@flagship/protocol` uses for the box's keys, byte-compatible with the TS
//! implementations (`encryption.ts`, `cloudGossip.ts`, `swkDerive.ts`).

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub const SEAL_TAG: &[u8] = b"flagship.seal.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CryptoError;

pub type Key32 = Zeroizing<[u8; 32]>;

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// HKDF-SHA256 to 32 bytes. An empty salt is the RFC 5869 default (HashLen zeros), as in noble.
pub fn hkdf32(ikm: &[u8], salt: &[u8], info: &[u8]) -> Key32 {
    let mut out = Zeroizing::new([0u8; 32]);
    // A 32-byte output is always within HKDF-SHA256's 8160-byte limit.
    let _ = Hkdf::<Sha256>::new(Some(salt), ikm).expand(info, out.as_mut());
    out
}

pub fn random<const N: usize>() -> Result<[u8; N], CryptoError> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|_| CryptoError)?;
    Ok(b)
}

fn cipher(key: &[u8; 32]) -> Result<Aes256Gcm, CryptoError> {
    Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError)
}

/// AES-256-GCM with a fresh 12-byte nonce; returns (nonce, ciphertext || tag).
pub fn gcm_seal(key: &[u8; 32], plaintext: &[u8]) -> Result<([u8; 12], Vec<u8>), CryptoError> {
    let nonce = random::<12>()?;
    let ct = cipher(key)?
        .encrypt(&Nonce::from(nonce), plaintext)
        .map_err(|_| CryptoError)?;
    Ok((nonce, ct))
}

pub fn gcm_open(
    key: &[u8; 32],
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let nonce: [u8; 12] = nonce.try_into().map_err(|_| CryptoError)?;
    if ciphertext.len() < 16 {
        return Err(CryptoError);
    }
    cipher(key)?
        .decrypt(&Nonce::from(nonce), ciphertext)
        .map(Zeroizing::new)
        .map_err(|_| CryptoError)
}

/// `openSealedFromEd25519Recipient`: `[eph X25519 pub 32][nonce 12][ct+tag]`, opened with the
/// X25519 scalar of the Ed25519 seed (the birational map libsodium and noble use).
pub fn open_sealed(
    blob: &[u8],
    ed_signing: &ed25519_dalek::SigningKey,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let (eph, rest) = blob.split_at_checked(32).ok_or(CryptoError)?;
    let (nonce, ct) = rest.split_at_checked(12).ok_or(CryptoError)?;
    let eph: [u8; 32] = eph.try_into().map_err(|_| CryptoError)?;
    let secret = x25519_dalek::StaticSecret::from(*Zeroizing::new(ed_signing.to_scalar_bytes()));
    let shared = secret.diffie_hellman(&x25519_dalek::PublicKey::from(eph));
    // noble refuses an all-zero shared secret (a low-order ephemeral key).
    if !shared.was_contributory() {
        return Err(CryptoError);
    }
    let key = hkdf32(shared.as_bytes(), &eph, SEAL_TAG);
    gcm_open(&key, nonce, ct)
}

/// `sealForEd25519Recipient`, for tests and fixtures.
pub fn seal_to_ed25519(
    plaintext: &[u8],
    recipient: &ed25519_dalek::VerifyingKey,
) -> Result<Vec<u8>, CryptoError> {
    let eph_secret = x25519_dalek::StaticSecret::from(random::<32>()?);
    let eph_pub = x25519_dalek::PublicKey::from(&eph_secret);
    let their = x25519_dalek::PublicKey::from(recipient.to_montgomery().to_bytes());
    let shared = eph_secret.diffie_hellman(&their);
    let key = hkdf32(shared.as_bytes(), eph_pub.as_bytes(), SEAL_TAG);
    let (nonce, ct) = gcm_seal(&key, plaintext)?;
    let mut out = Vec::with_capacity(ct.len().saturating_add(44));
    out.extend_from_slice(eph_pub.as_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// `base64url` without padding (Node's `Buffer.toString("base64url")`).
pub fn b64u(data: &[u8]) -> String {
    use base64ct::Encoding;
    base64ct::Base64UrlUnpadded::encode_string(data)
}

/// Standard base64 with padding, whitespace already removed.
pub fn b64_decode(text: &str) -> Option<Vec<u8>> {
    use base64ct::Encoding;
    base64ct::Base64::decode_vec(text).ok()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;

    #[test]
    fn sealed_box_round_trip_and_wrong_key() {
        let k = ed25519_dalek::SigningKey::from_bytes(&[0x42; 32]);
        let blob = seal_to_ed25519(b"hello", &k.verifying_key()).unwrap();
        assert_eq!(blob.len(), 44 + 5 + 16);
        assert_eq!(open_sealed(&blob, &k).unwrap().as_slice(), b"hello");
        let other = ed25519_dalek::SigningKey::from_bytes(&[9; 32]);
        assert!(open_sealed(&blob, &other).is_err());
        assert!(open_sealed(&blob[..43], &k).is_err());
        let mut low_order = blob.clone();
        low_order[..32].fill(0);
        assert!(open_sealed(&low_order, &k).is_err());
    }

    #[test]
    fn hkdf_empty_salt_is_the_zero_salt() {
        assert_eq!(*hkdf32(b"k", b"", b"i"), *hkdf32(b"k", &[0u8; 32], b"i"));
    }
}

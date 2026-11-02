//! The relay feed's encryption (docs/architecture-v2/relay-mesh.md §4.5.1, owner decision 2026-11-01): the Rust twin
//! of `packages/control-plane/src/relayFeedSeal.ts` and of the repo's `flagship.seal.v1`
//! (`packages/protocol/src/encryption.ts` `sealForEd25519Recipient` / `openSealedFromEd25519Recipient`). Shared vectors:
//! `packages/control-plane/tests/vectors/relay-feed-seal.json` (`scripts/relay-feed-seal-vectors.ts`).
//!
//! ```text
//! feed file   AES-256-GCM(key = the epoch's mesh key, 12-byte nonce, AAD below) → ciphertext ‖ 16-byte tag
//! AAD         flagship/relay-feed-sealed/v1|<servicesApex>|<object>|<page, or empty for the head>|<epoch>
//! key line    flagship/relay-mesh-key/v1|<servicesApex>|<relayId>|<epoch>|<mesh key, 64 lowercase hex>
//! sealed      ephemeral X25519 pub ‖ 12-byte nonce ‖ AES-256-GCM(key = HKDF-SHA256(shared, salt = eph pub,
//!             info "flagship.seal.v1")), to the X25519 form of an Ed25519 key; no AAD
//! ```
//!
//! Byte-level helpers only: the JSON envelopes (`RelayFeedSealed`, `RelayMeshKeys`) are read by the relay.

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{AeadInOut, KeyInit, Nonce, Tag};
use ed25519_dalek::{SigningKey, VerifyingKey};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::error::CryptoError;

pub const TAG_RELAY_FEED_SEALED: &str = "flagship/relay-feed-sealed/v1";
pub const TAG_RELAY_MESH_KEY: &str = "flagship/relay-mesh-key/v1";
/// `FLAGSHIP_SEAL_TAG`.
pub const FLAGSHIP_SEAL_TAG: &str = "flagship.seal.v1";

const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const EPH_LEN: usize = 32;

/// `relayFeedAad`.
#[must_use]
pub fn relay_feed_aad(services_apex: &str, object: &str, page: Option<u64>, epoch: u64) -> String {
    let page = page.map(|p| p.to_string()).unwrap_or_default();
    format!("{TAG_RELAY_FEED_SEALED}|{services_apex}|{object}|{page}|{epoch}")
}

fn gcm_open(
    key: &[u8; 32],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    sealed: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let ct_len = sealed
        .len()
        .checked_sub(TAG_LEN)
        .ok_or(CryptoError::DecryptFailed)?;
    let (ct, tag) = sealed
        .split_at_checked(ct_len)
        .ok_or(CryptoError::DecryptFailed)?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::DecryptFailed)?;
    let tag = Tag::<Aes256Gcm>::try_from(tag).map_err(|_| CryptoError::DecryptFailed)?;
    let mut buf = ct.to_vec();
    cipher
        .decrypt_inout_detached(
            &Nonce::<Aes256Gcm>::from(*nonce),
            aad,
            buf.as_mut_slice().into(),
            &tag,
        )
        .map_err(|_| CryptoError::DecryptFailed)?;
    Ok(buf)
}

fn gcm_seal(
    key: &[u8; 32],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::DecryptFailed)?;
    let mut buf = plaintext.to_vec();
    let tag = cipher
        .encrypt_inout_detached(
            &Nonce::<Aes256Gcm>::from(*nonce),
            aad,
            buf.as_mut_slice().into(),
        )
        .map_err(|_| CryptoError::PlaintextTooLarge)?;
    buf.extend_from_slice(tag.as_slice());
    Ok(buf)
}

/// Decrypt a feed file's ciphertext (ciphertext ‖ tag) under the epoch's mesh key and its AAD.
///
/// # Errors
/// [`CryptoError::DecryptFailed`] for any tampering, the wrong key, epoch, object or page.
pub fn open_relay_feed(
    key: &[u8; 32],
    nonce: &[u8; NONCE_LEN],
    aad: &str,
    sealed: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    gcm_open(key, nonce, aad.as_bytes(), sealed)
}

/// Encrypt a feed file (`.com`'s side; harnesses and tests).
///
/// # Errors
/// [`CryptoError::PlaintextTooLarge`].
pub fn seal_relay_feed(
    key: &[u8; 32],
    nonce: &[u8; NONCE_LEN],
    aad: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    gcm_seal(key, nonce, aad.as_bytes(), plaintext)
}

fn seal_key(shared: &[u8; 32], eph_pub: &[u8]) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let mut okm = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(eph_pub), shared)
        .expand(FLAGSHIP_SEAL_TAG.as_bytes(), okm.as_mut_slice())
        .map_err(|_| CryptoError::DecryptFailed)?;
    Ok(okm)
}

/// `openSealedFromEd25519Recipient`: open a `flagship.seal.v1` blob addressed to an Ed25519 key, with its seed.
///
/// # Errors
/// [`CryptoError::DecryptFailed`] for a short, tampered or misaddressed blob.
pub fn open_sealed_from_ed25519_seed(blob: &[u8], seed: &[u8; 32]) -> Result<Vec<u8>, CryptoError> {
    let (eph, rest) = blob
        .split_at_checked(EPH_LEN)
        .ok_or(CryptoError::DecryptFailed)?;
    let (nonce, ct) = rest
        .split_at_checked(NONCE_LEN)
        .ok_or(CryptoError::DecryptFailed)?;
    let eph: [u8; EPH_LEN] = eph.try_into().map_err(|_| CryptoError::DecryptFailed)?;
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| CryptoError::DecryptFailed)?;
    let secret = StaticSecret::from(SigningKey::from_bytes(seed).to_scalar_bytes());
    let shared = Zeroizing::new(secret.diffie_hellman(&PublicKey::from(eph)).to_bytes());
    let key = seal_key(&shared, &eph)?;
    gcm_open(&key, &nonce, &[], ct)
}

/// `sealForEd25519Recipient` (`.com`'s side; harnesses and tests).
///
/// # Errors
/// [`CryptoError::BadPublicKey`] for a key that is not an Ed25519 point, [`CryptoError::Randomness`].
pub fn seal_for_ed25519_recipient(
    plaintext: &[u8],
    recipient: &[u8; 32],
) -> Result<Vec<u8>, CryptoError> {
    let x = VerifyingKey::from_bytes(recipient)
        .map_err(|_| CryptoError::BadPublicKey)?
        .to_montgomery()
        .to_bytes();
    let mut eph_seed = Zeroizing::new([0u8; 32]);
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(eph_seed.as_mut_slice()).map_err(|_| CryptoError::Randomness)?;
    getrandom::fill(&mut nonce).map_err(|_| CryptoError::Randomness)?;
    let eph = StaticSecret::from(*eph_seed);
    let eph_pub = PublicKey::from(&eph).to_bytes();
    let shared = Zeroizing::new(eph.diffie_hellman(&PublicKey::from(x)).to_bytes());
    let key = seal_key(&shared, &eph_pub)?;
    let ct = gcm_seal(&key, &nonce, &[], plaintext)?;
    let mut out = Vec::with_capacity(EPH_LEN.saturating_add(NONCE_LEN).saturating_add(ct.len()));
    out.extend_from_slice(&eph_pub);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// The line a sealed mesh key holds.
#[must_use]
pub fn relay_mesh_key_line(
    services_apex: &str,
    relay_id: &str,
    epoch: u64,
    key: &[u8; 32],
) -> String {
    let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
    format!("{TAG_RELAY_MESH_KEY}|{services_apex}|{relay_id}|{epoch}|{hex}")
}

/// The key in an opened line, when it names this apex, this relay and the epoch it is filed under.
#[must_use]
pub fn mesh_key_from_line(
    line: &str,
    services_apex: &str,
    relay_id: &str,
    epoch: u64,
) -> Option<[u8; 32]> {
    let prefix = format!("{TAG_RELAY_MESH_KEY}|{services_apex}|{relay_id}|{epoch}|");
    let hex = line.strip_prefix(&prefix)?;
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        let at = i.checked_mul(2)?;
        *o = u8::from_str_radix(hex.get(at..at.checked_add(2)?)?, 16).ok()?;
    }
    Some(out)
}

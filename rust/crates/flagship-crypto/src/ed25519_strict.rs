//! The strict Ed25519 profile both ports enforce, so a malicious signer cannot
//! produce a signature that one port accepts and the other refuses:
//! canonical, torsion-free, non-identity public key; canonical R and S < L;
//! cofactorless check (`verify_strict`). With A and R torsion-free the
//! cofactored check used by other libraries gives the same answer.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

pub(crate) fn parse_public(bytes: &[u8; 32]) -> Option<VerifyingKey> {
    let vk = VerifyingKey::from_bytes(bytes).ok()?;
    let point = vk.to_edwards();
    if vk.is_weak() || !point.is_torsion_free() || point.compress().to_bytes() != *bytes {
        return None;
    }
    Some(vk)
}

pub(crate) fn verify(vk: &VerifyingKey, msg: &[u8], sig: &[u8; 64]) -> bool {
    let sig = Signature::from_bytes(sig);
    vk.verify_strict(msg, &sig).is_ok()
}

pub(crate) fn sign(sk: &SigningKey, msg: &[u8]) -> [u8; 64] {
    sk.sign(msg).to_bytes()
}

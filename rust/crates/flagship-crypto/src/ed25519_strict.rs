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

#[cfg(test)]
mod low_order_vectors {
    use super::*;

    const VECTORS: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/test-vectors/ed25519-low-order/vectors.json"
    ));

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    fn arr<const N: usize>(s: &str) -> [u8; N] {
        unhex(s).try_into().unwrap()
    }

    #[test]
    fn refuses_every_low_order_key_and_keeps_the_honest_one() {
        let v: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        let forged: [u8; 64] = arr(v["forgedSignatureHex"].as_str().unwrap());
        for k in v["rejectPublicKeysHex"].as_array().unwrap() {
            let k = k.as_str().unwrap();
            if let Some(vk) = parse_public(&arr(k)) {
                panic!("accepted low-order key {k}: {vk:?}");
            }
            // Even without the parse step, verify_strict must refuse the forgery.
            if let Ok(vk) = VerifyingKey::from_bytes(&arr(k)) {
                for m in v["messagesHex"].as_array().unwrap() {
                    assert!(!verify(&vk, &unhex(m.as_str().unwrap()), &forged), "forged under {k}");
                }
            }
        }
        let h = &v["honest"];
        let vk = parse_public(&arr(h["publicKeyHex"].as_str().unwrap())).expect("honest key");
        for s in h["signatures"].as_array().unwrap() {
            let msg = unhex(s["messageHex"].as_str().unwrap());
            assert!(verify(&vk, &msg, &arr(s["signatureHex"].as_str().unwrap())));
        }
    }
}

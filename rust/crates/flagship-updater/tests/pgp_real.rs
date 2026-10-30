#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]
use pgp::composed::{Deserializable, DetachedSignature, SignedPublicKey};
use pgp::types::KeyDetails;

#[test]
fn node_24_22_1_shasums_verify_with_the_rust_openpgp_library() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/node-24.22.1/");
    let key_text = std::fs::read_to_string(format!("{dir}signer.asc")).unwrap();
    let sums = std::fs::read(format!("{dir}SHASUMS256.txt")).unwrap();
    let sig = std::fs::read(format!("{dir}SHASUMS256.txt.sig")).unwrap();
    let (key, _) = SignedPublicKey::from_string(&key_text).unwrap();
    eprintln!("fingerprint {}", key.fingerprint());
    let s = DetachedSignature::from_bytes(&sig[..]).unwrap();
    s.verify(&key, &sums).unwrap();
    let mut tampered = sums.clone();
    tampered[0] ^= 1;
    assert!(s.verify(&key, &tampered).is_err());
}

//! The owner moves the box to another name in its account (`policy.rename`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

use ed25519_dalek::{Signer, SigningKey};
use flagship_keyd::files::names_for;
use flagship_keyd::service::KeydService;
use flagship_keyd::tls::{TlsKeys, system_clock};
use flagship_keyd::wire::{Args, to_hex};
use serde_json::{Value, json};

fn args(v: Value) -> Args {
    v.as_object().unwrap().clone().into_iter().collect()
}

#[test]
fn the_name_comes_only_from_the_owners_signed_entitlement_for_this_key_inside_the_account() {
    let dir = std::env::temp_dir().join(format!("kr-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let identity = [0x42u8; 32];
    let stk = to_hex(SigningKey::from_bytes(&identity).verifying_key().as_bytes());
    let root = SigningKey::from_bytes(&[9u8; 32]);
    let irk = SigningKey::from_bytes(&[8u8; 32]);
    let old = "home2.alice.gym.flagship.services";
    let fresh = "home.alice.gym.flagship.services";
    let tls = TlsKeys::new(names_for(old), None, system_clock());
    let mut svc = KeydService::new(&identity, None, None, None, Some(tls), None)
        .with_owner(&to_hex(irk.verifying_key().as_bytes()), old)
        .with_admin_root(Some(&to_hex(root.verifying_key().as_bytes())))
        .with_state_dir(dir.clone());
    let sign = |user: &str, canon: &str, at: u64, key: &SigningKey| {
        let statement = format!("flagship/root-entitlement/v1|{user}|{stk}|{canon}|{at}");
        to_hex(&key.sign(statement.as_bytes()).to_bytes())
    };
    let mut call = |canon: &str, sig: String| {
        svc.handle(
            "policy.rename",
            &args(json!({"username": "alice", "podCanonical": canon, "issuedAt": 5, "signatureHex": sig})),
        )
    };
    let other = SigningKey::from_bytes(&[7u8; 32]);
    assert!(call(fresh, sign("alice", fresh, 5, &other)).is_err(), "someone else's signature");
    assert!(
        call("home.bob.gym.flagship.services", sign("alice", "home.bob.gym.flagship.services", 5, &root)).is_err(),
        "another account"
    );
    assert!(call(fresh, sign("alice", "other.alice.gym.flagship.services", 5, &root)).is_err(), "a different name than signed");
    let ok = call(fresh, sign("alice", fresh, 5, &root)).unwrap();
    assert_eq!(ok.result.get("serverFqdn").and_then(Value::as_str), Some(fresh));
    let kept = std::fs::read_to_string(dir.join("policy.json")).unwrap();
    assert_eq!(kept, format!("{{\"serverFqdn\":\"{fresh}\"}}"));
    let _ = std::fs::remove_dir_all(&dir);
}

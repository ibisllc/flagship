#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use flagship_crypto::service_invite::{
    AcceptServiceInvite, CreateServiceInvite, RedeemServiceInvite, RevokeServiceInvite, accept_canonical, create_canonical, redeem_canonical,
    revoke_canonical, secret_hash, verify_accept, verify_create, verify_redeem, verify_revoke,
};
use serde_json::Value;

const VECTORS: &str = include_str!("../../../../packages/protocol/test-vectors/service-invite/vectors.json");

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap().to_owned()
}
fn hex(v: &Value, k: &str) -> Vec<u8> {
    (0..s(v, k).len() / 2).map(|i| u8::from_str_radix(&s(v, k)[i * 2..i * 2 + 2], 16).unwrap()).collect()
}

fn create_of(c: &Value) -> CreateServiceInvite {
    CreateServiceInvite {
        invite_id: s(c, "inviteId"),
        author_aid: hex(c, "authorAID"),
        service_ref: s(c, "serviceRef"),
        secret_hash: s(c, "secretHash"),
        encrypted_bundle: s(c, "encryptedBundle"),
        issued_at: c["issuedAt"].as_u64().unwrap(),
        max_redemptions: c.get("maxRedemptions").and_then(Value::as_u64),
        expires_at: c.get("expiresAt").and_then(Value::as_u64),
    }
}

#[test]
fn create_vectors() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let irk = s(&v["keys"]["irk"], "pub");
    for c in v["create"].as_array().unwrap() {
        let o = create_of(c);
        assert_eq!(create_canonical(&o).unwrap(), s(c, "canonical"), "{}", s(c, "name"));
        assert!(verify_create(&o, &s(c, "signature"), &irk), "{}", s(c, "name"));
        // the caps are part of the signed bytes: dropping one breaks the signature
        if o.max_redemptions.is_some() || o.expires_at.is_some() {
            let stripped = CreateServiceInvite { max_redemptions: None, expires_at: None, ..o.clone() };
            assert!(!verify_create(&stripped, &s(c, "signature"), &irk), "{}", s(c, "name"));
        }
        let moved = CreateServiceInvite { service_ref: "other--app".into(), ..o };
        assert!(!verify_create(&moved, &s(c, "signature"), &irk));
    }
}

#[test]
fn redeem_accept_revoke_vectors() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    for c in v["redeem"].as_array().unwrap() {
        let o = RedeemServiceInvite { secret_hash: s(c, "secretHash"), visitor_aid: hex(c, "visitorAID"), redeemed_at: c["redeemedAt"].as_u64().unwrap() };
        assert_eq!(redeem_canonical(&o).unwrap(), s(c, "canonical"));
        assert!(verify_redeem(&o, &s(c, "signature"), &s(&v["keys"]["friend"], "pub")));
        assert!(!verify_redeem(&o, &s(c, "signature"), &s(&v["keys"]["contact"], "pub")), "another key's signature is not the friend's");
    }
    for c in v["accept"].as_array().unwrap() {
        let o = AcceptServiceInvite { invite_id: s(c, "inviteId"), service_ref: s(c, "serviceRef"), contact_aid: hex(c, "contactAID"), accepted_at: c["acceptedAt"].as_u64().unwrap() };
        assert_eq!(accept_canonical(&o).unwrap(), s(c, "canonical"));
        assert!(verify_accept(&o, &s(c, "signature"), &s(&v["keys"]["contact"], "pub")));
    }
    for c in v["revoke"].as_array().unwrap() {
        let o = RevokeServiceInvite { invite_id: s(c, "inviteId"), issued_at: c["issuedAt"].as_u64().unwrap() };
        assert_eq!(revoke_canonical(&o).unwrap(), s(c, "canonical"));
        assert!(verify_revoke(&o, &s(c, "signature"), &s(&v["keys"]["irk"], "pub")));
        assert!(!verify_revoke(&RevokeServiceInvite { issued_at: o.issued_at + 1, ..o }, &s(c, "signature"), &s(&v["keys"]["irk"], "pub")));
    }
}

#[test]
fn secret_hash_vectors_and_refusals() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    for c in v["secretHash"].as_array().unwrap() {
        assert_eq!(secret_hash(&hex(c, "secretHex")), s(c, "expect"));
    }
    for c in v["invalid"].as_array().unwrap() {
        match s(c, "op").as_str() {
            "create" => {
                let mut o = create_of(&v["create"][0]);
                o.invite_id = c.get("inviteId").and_then(Value::as_str).map_or(o.invite_id, str::to_owned);
                // a negative cap or a fractional expiry has no u64: the type already refuses it
                if let Some(n) = c.get("maxRedemptions").and_then(Value::as_u64) {
                    o.max_redemptions = Some(n);
                }
                if let Some(n) = c.get("expiresAt").and_then(Value::as_u64) {
                    o.expires_at = Some(n);
                }
                let bad_id = c.get("inviteId").and_then(Value::as_str).is_some_and(|i| i.contains('|'));
                assert_eq!(create_canonical(&o).is_err(), bad_id, "{}", s(c, "name"));
            }
            "redeem-secret" => {
                let o = RedeemServiceInvite { secret_hash: s(c, "secretHash"), visitor_aid: hex(c, "visitorAID"), redeemed_at: 1 };
                assert!(redeem_canonical(&o).is_err(), "{}", s(c, "name"));
            }
            other => panic!("unknown invalid op {other}"),
        }
    }
    assert!(create_canonical(&CreateServiceInvite { issued_at: 9_007_199_254_740_992, ..create_of(&v["create"][0]) }).is_err());
    assert!(create_canonical(&CreateServiceInvite { max_redemptions: Some(9_007_199_254_740_992), ..create_of(&v["create"][0]) }).is_err());
}

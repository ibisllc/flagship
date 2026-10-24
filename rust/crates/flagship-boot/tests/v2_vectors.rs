//! Boot unlock v2 against the shared vectors (`test-vectors/boot-unlock-v2/vectors.json`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use flagship_boot::v2::{self, LeaseV3Fields, UnlockPolicy};
use serde_json::Value;

fn vectors() -> Value {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/test-vectors/boot-unlock-v2/vectors.json"
    );
    serde_json::from_str(&std::fs::read_to_string(p).expect("vectors")).expect("json")
}

fn s<'a>(v: &'a Value, path: &[&str]) -> &'a str {
    let mut cur = v;
    for k in path {
        cur = &cur[*k];
    }
    cur.as_str().unwrap_or_else(|| panic!("{path:?}"))
}

fn h(x: &str) -> Vec<u8> {
    flagship_boot::gohex::decode(x.as_bytes()).expect("hex")
}

fn seed(x: &str) -> [u8; 32] {
    h(x).try_into().expect("32 bytes")
}

fn policy(p: &str) -> UnlockPolicy {
    if p == "strict" {
        UnlockPolicy::Strict
    } else {
        UnlockPolicy::Compat
    }
}

#[test]
fn request_signature_matches_byte_for_byte() {
    let v = vectors();
    let body = v2::sign_request_v2(
        &seed(s(&v, &["keys", "boot", "edSeed"])),
        &seed(s(&v, &["keys", "boot", "mldsaSeed"])),
        s(&v, &["serverDomain"]),
        s(&v, &["request", "fields", "nonceHex"]),
        v["request"]["fields"]["issuedAt"].as_i64().unwrap(),
        &seed(s(&v, &["keys", "replyKem", "seed"])),
        true,
    )
    .unwrap();
    let got: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(got["pq"]["signature"], v["request"]["pq"]["signature"]);
    assert_eq!(
        got["pq"]["replyKemPubHex"],
        v["request"]["pq"]["replyKemPubHex"]
    );
    assert_eq!(
        got["request"]["stkPub"].as_str(),
        Some(s(&v, &["keys", "boot", "pubHex"]))
    );
}

#[test]
fn reply_cases() {
    let v = vectors();
    let owner = h(s(&v, &["keys", "owner", "publicKey"]));
    let reply = seed(s(&v, &["keys", "replyKem", "seed"]));
    for c in v["reply"]["cases"].as_array().unwrap() {
        let sealed = h(c["sealed"].as_str().unwrap());
        let got = match v2::box_accepts(policy(c["policy"].as_str().unwrap()), &sealed) {
            Err(e) => e.code().to_owned(),
            Ok(()) if !v2::is_v2_sealed(&sealed) => "accept-v1".to_owned(),
            Ok(()) => match v2::open_boot_reply_v2(
                &sealed,
                s(&v, &["serverDomain"]),
                s(&v, &["keys", "boot", "pubHex"]),
                c["nonceHex"].as_str().unwrap(),
                &reply,
                &owner,
            ) {
                Ok(k) => {
                    assert_eq!(flagship_boot::gohex::encode(&k), s(&v, &["diskKey"]));
                    "ok".to_owned()
                }
                Err(e) => e.code().to_owned(),
            },
        };
        assert_eq!(got, c["expect"].as_str().unwrap(), "{}", c["name"]);
    }
}

#[test]
fn lease_cases() {
    let v = vectors();
    let owner = h(s(&v, &["keys", "owner", "publicKey"]));
    let lease_seed = seed(s(&v, &["keys", "leaseKem", "seed"]));
    for c in v["lease"]["cases"].as_array().unwrap() {
        let sealed = h(c["sealed"].as_str().unwrap());
        let l = &c["lease"];
        let f = LeaseV3Fields {
            server_domain: l["serverDomain"].as_str().unwrap().to_owned(),
            boot_pub_hex: l["bootPubHex"].as_str().unwrap().to_owned(),
            lease_id: l["leaseId"].as_str().unwrap().to_owned(),
            issued_at: l["issuedAt"].as_i64().unwrap(),
            expires_at: l["expiresAt"].as_i64().unwrap(),
            max_uses: l["maxUses"].as_i64().unwrap_or(-1),
        };
        let got = match v2::box_accepts(policy(c["policy"].as_str().unwrap()), &sealed) {
            Err(e) => e.code().to_owned(),
            Ok(()) if !v2::is_v2_sealed(&sealed) => "accept-v1".to_owned(),
            Ok(()) => match v2::open_lease_v3_sealed(
                &f,
                &sealed,
                &lease_seed,
                &owner,
                c["nowMs"].as_i64().unwrap(),
            ) {
                Ok(k) => {
                    assert_eq!(flagship_boot::gohex::encode(&k), s(&v, &["diskKey"]));
                    "ok".to_owned()
                }
                Err(e) => e.code().to_owned(),
            },
        };
        assert_eq!(got, c["expect"].as_str().unwrap(), "{}", c["name"]);
    }
}

#[test]
fn lease_through_json_and_policy_file() {
    let v = vectors();
    let c = &v["lease"]["cases"][0];
    let l = &c["lease"];
    let body = serde_json::json!({
        "serverDomain": l["serverDomain"], "leaseId": l["leaseId"], "stkPub": s(&v, &["keys", "boot", "pubHex"]),
        "sealedKey": c["sealed"], "issuedAt": l["issuedAt"], "expiresAt": l["expiresAt"], "maxUses": null, "signature": "00",
    })
    .to_string();
    let key = v2::open_auto_unlock_lease_any(
        body.as_bytes(),
        &seed(s(&v, &["keys", "boot", "edSeed"])),
        s(&v, &["serverDomain"]).as_bytes(),
        &[0; 32],
        Some(&h(s(&v, &["keys", "owner", "publicKey"]))),
        Some(&seed(s(&v, &["keys", "leaseKem", "seed"]))),
        UnlockPolicy::Strict,
        c["nowMs"].as_i64().unwrap(),
    )
    .unwrap();
    assert_eq!(flagship_boot::gohex::encode(&key), s(&v, &["diskKey"]));
    for p in v["policy"].as_array().unwrap() {
        let text = p["text"].as_str().map(str::as_bytes);
        let got = v2::parse_unlock_policy(text, p["hasV2Material"].as_bool().unwrap());
        let want = if p["expect"] == "strict" {
            UnlockPolicy::Strict
        } else {
            UnlockPolicy::Compat
        };
        assert_eq!(got, want, "{p}");
    }
}

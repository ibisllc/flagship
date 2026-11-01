//! Admin authority over app-rank orders against the shared verdicts
//! (packages/protocol/test-vectors/access-enforcement/rank-orders.json, written by the TypeScript applier's test).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use flagship_access::rank::{AdminTrust, GrantView, verify_rank_entry};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/test-vectors/access-enforcement/rank-orders.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn trust(t: &Value) -> AdminTrust {
    AdminTrust {
        owner_irk_hex: t["ownerIrk"].as_str().unwrap().to_owned(),
        admin_root_hex: t["adminRoot"].as_str().map(str::to_owned),
        username: t["username"].as_str().unwrap().to_owned(),
        now_ms: t["now"].as_u64().unwrap(),
        grants: t["grants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| GrantView {
                grant_id: g["grantId"].as_str().unwrap().to_owned(),
                username: g["username"].as_str().unwrap().to_owned(),
                device_id: g["deviceId"].as_str().unwrap().to_owned(),
                device_pub_hex: g["devicePubHex"].as_str().unwrap().to_owned(),
                scopes: g["scopes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_str().unwrap().to_owned())
                    .collect(),
                issued_at: g["issuedAt"].as_u64().unwrap(),
                expires_at: g["expiresAt"].as_u64().unwrap(),
                signature_hex: g["signatureHex"].as_str().unwrap().to_owned(),
                signer_root: g["signerRoot"].as_str().unwrap().to_owned(),
                revoked: g["revoked"].as_bool().unwrap(),
            })
            .collect(),
    }
}

#[test]
fn every_order_gets_the_typescript_verdict() {
    let v = vectors();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 20);
    let mut failures = Vec::new();
    for c in cases {
        let t = trust(&v["trusts"][c["trust"].as_str().unwrap()]);
        let ok = verify_rank_entry(
            &c["order"],
            c["signature"].as_str().unwrap(),
            c["serviceRef"].as_str().unwrap(),
            c["installed"].as_bool().unwrap(),
            &t,
        );
        let want = c["expect"].as_str().unwrap() == "ok";
        if ok != want {
            failures.push(c["name"].as_str().unwrap().to_owned());
        }
    }
    assert!(failures.is_empty(), "disagree: {failures:?}");
}

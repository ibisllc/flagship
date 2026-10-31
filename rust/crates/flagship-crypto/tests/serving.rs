#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use flagship_crypto::serving::{
    CertificateOrder, Grace, OnLapse, RenewalKeyDelegation, RevocationApply, RevocationEntry,
    RevocationKind, RevocationState, RouteClaim, ServingDecision, ServingInput, ServingLease,
    ServingPolicy, SignedLease, apply_revocation_entries, canonical_name_list,
    certificate_order_canonical, delegation_canonical, lease_canonical, name_list_sha256,
    policy_canonical, revocation_canonical, route_claim_canonical, route_collisions,
    serving_decision, verify_canonical,
};
use serde_json::Value;

const VECTORS: &str =
    include_str!("../../../../packages/protocol/test-vectors/serving-authority/vectors.json");

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap().to_owned()
}
fn n(v: &Value, k: &str) -> u64 {
    v[k].as_u64().unwrap()
}

fn policy(v: &Value) -> ServingPolicy {
    ServingPolicy {
        account: s(v, "account"),
        box_pub: s(v, "box"),
        reg_gen: n(v, "regGen"),
        policy_gen: n(v, "policyGen"),
        grace: Grace::parse(&s(v, "grace")).unwrap(),
        on_lapse: OnLapse::parse(&s(v, "onLapse")).unwrap(),
        scope_sha256: s(v, "scopeSha256"),
        issued_at: n(v, "issuedAt"),
    }
}
fn delegation(v: &Value) -> RenewalKeyDelegation {
    RenewalKeyDelegation {
        account: s(v, "account"),
        renewal_pub: s(v, "renewalPub"),
        device_id: s(v, "deviceId"),
        issued_at: n(v, "issuedAt"),
    }
}
fn lease(v: &Value) -> ServingLease {
    ServingLease {
        account: s(v, "account"),
        box_pub: s(v, "box"),
        reg_gen: n(v, "regGen"),
        policy_gen: n(v, "policyGen"),
        lease_id: s(v, "leaseId"),
        issued_at: n(v, "issuedAt"),
        not_after: n(v, "notAfter"),
    }
}
fn revocation(v: &Value) -> RevocationEntry {
    RevocationEntry {
        sequence: n(v, "sequence"),
        kind: RevocationKind::parse(&s(v, "kind")).unwrap(),
        account: s(v, "account"),
        subject: s(v, "subject"),
        generation: n(v, "generation"),
        revoked_at: n(v, "revokedAt"),
    }
}

#[test]
fn every_record_has_the_same_canonical_bytes_and_signature() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let records = v["records"].as_array().unwrap();
    assert!(records.len() >= 8);
    for r in records {
        let rec = &r["record"];
        let canonical = match r["kind"].as_str().unwrap() {
            "serving-policy" => policy_canonical(&policy(rec)),
            "renewal-key-delegation" => delegation_canonical(&delegation(rec)),
            "serving-lease" => lease_canonical(&lease(rec)),
            "revocation-entry" => revocation_canonical(&revocation(rec)),
            "certificate-order" => certificate_order_canonical(&CertificateOrder {
                class: s(rec, "class"),
                device: s(rec, "device"),
                reg_gen: n(rec, "regGen"),
                csr_sha256: s(rec, "csrSha256"),
                request_id: s(rec, "requestId"),
                issued_at: n(rec, "issuedAt"),
            }),
            "route-claim" => route_claim_canonical(&RouteClaim {
                account: s(rec, "account"),
                phone_route_pub: s(rec, "phoneRoutePub"),
                hostname: s(rec, "hostname"),
                generation: n(rec, "generation"),
                session_nonce: s(rec, "sessionNonce"),
                issued_at: n(rec, "issuedAt"),
            }),
            other => panic!("unknown kind {other}"),
        };
        assert_eq!(
            canonical.as_deref().unwrap(),
            s(r, "canonical"),
            "{}",
            r["kind"]
        );
        assert!(verify_canonical(
            &canonical,
            &s(r, "signature"),
            &s(r, "signerPub")
        ));
        let mut flipped = s(r, "signature");
        flipped.replace_range(
            0..2,
            if flipped.starts_with("00") {
                "01"
            } else {
                "00"
            },
        );
        assert!(!verify_canonical(&canonical, &flipped, &s(r, "signerPub")));
    }
}

#[test]
fn name_lists_agree() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    for l in v["nameLists"].as_array().unwrap() {
        let owned: Vec<(String, String)> = l["names"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| (s(x, "class"), s(x, "name")))
            .collect();
        let names: Vec<(&str, &str)> = owned
            .iter()
            .map(|(c, n)| (c.as_str(), n.as_str()))
            .collect();
        assert_eq!(canonical_name_list(&names).unwrap(), s(l, "canonical"));
        assert_eq!(name_list_sha256(&names).unwrap(), s(l, "sha256"));
    }
    assert!(canonical_name_list(&[("control", "*.alice.flagship.services")]).is_err());
    assert!(canonical_name_list(&[("apps", "Home.alice.flagship.services")]).is_err());
    assert!(
        canonical_name_list(&[
            ("control", "home.alice.flagship.services"),
            ("apps", "home.alice.flagship.services")
        ])
        .is_err()
    );
    assert_eq!(
        route_collisions(
            &["home.alice.flagship.services"],
            "alice.flagship.services",
            &[
                "notes.alice.flagship.services",
                "Home.alice.flagship.services"
            ]
        ),
        vec!["Home.alice.flagship.services"]
    );
}

#[test]
fn relay_decisions_agree_with_typescript() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let revocation_key = s(&v, "revocationKeyPub");
    let decisions = v["decisions"].as_array().unwrap();
    assert_eq!(decisions.len(), 14);
    for d in decisions {
        let i = &d["input"];
        let entries: Vec<(RevocationEntry, String)> = i["revocationEntries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (revocation(&e["entry"]), s(e, "signature")))
            .collect();
        let state = match apply_revocation_entries(
            &RevocationState::default(),
            &entries,
            &revocation_key,
        ) {
            RevocationApply::Applied { state, .. } => state,
            other => panic!("{}: {other:?}", d["name"]),
        };
        let pol = policy(&i["policy"]["record"]);
        let pol_sig = s(&i["policy"], "signature");
        let leases: Vec<SignedLease> = i["leases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| SignedLease {
                lease: lease(&l["record"]),
                signature: s(l, "signature"),
                delegation: l
                    .get("delegation")
                    .map(|dv| (delegation(&dv["record"]), s(dv, "signature"))),
            })
            .collect();
        let account = s(i, "account");
        let box_pub = s(i, "box");
        let from_com = s(i, "adminKeyFromCom");
        let from_box = s(i, "adminKeyFromBox");
        let got = serving_decision(&ServingInput {
            account: &account,
            box_pub: &box_pub,
            reg_gen: n(i, "regGen"),
            admin_key_from_com: &from_com,
            admin_key_from_box: &from_box,
            policy: Some((&pol, &pol_sig)),
            leases: &leases,
            revocations: &state,
            now: n(i, "now"),
        });
        let e = &d["expected"];
        let want = if e["apps"].as_bool().unwrap() {
            ServingDecision::Serve {
                until: e["until"].as_u64(),
                policy_gen: n(e, "policyGen"),
                on_lapse: OnLapse::parse(&s(e, "onLapse")).unwrap(),
            }
        } else {
            let reason: &'static str = Box::leak(s(e, "reason").into_boxed_str());
            ServingDecision::Refuse {
                control: e["control"].as_bool().unwrap(),
                reason,
                lock: e["lock"].as_bool().unwrap(),
            }
        };
        assert_eq!(got, want, "{}", d["name"]);
    }
}

#[test]
fn revocation_log_stops_at_a_gap_and_skips_duplicates() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let key = s(&v, "revocationKeyPub");
    let rec = v["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["kind"] == "revocation-entry")
        .unwrap();
    let one = (revocation(&rec["record"]), s(rec, "signature"));
    let RevocationApply::Applied { state, applied } = apply_revocation_entries(
        &RevocationState::default(),
        std::slice::from_ref(&one),
        &key,
    ) else {
        panic!("first entry did not apply");
    };
    assert_eq!((state.sequence, applied), (1, 1));
    assert!(matches!(
        apply_revocation_entries(&state, std::slice::from_ref(&one), &key),
        RevocationApply::Applied { applied: 0, .. }
    ));
    let mut third = one.clone();
    third.0.sequence = 3;
    assert_eq!(
        apply_revocation_entries(&state, &[third], &key),
        RevocationApply::Gap { at: 2 }
    );
    let mut forged = one;
    forged.0.sequence = 2;
    assert_eq!(
        apply_revocation_entries(&state, &[forged], &key),
        RevocationApply::BadSignature { at: 2 }
    );
}

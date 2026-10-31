#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use flagship_crypto::server_share::{
    ServerShareAccept, ServerShareAcceptAdmin, ServerShareGrant, ServerShareLeave,
    ServerShareRevoke, accept_admin_canonical, accept_canonical, grant_canonical, label_ok,
    leave_canonical, revoke_canonical, verify_accept, verify_accept_admin, verify_grant,
    verify_leave, verify_revoke,
};
use serde_json::Value;

const SHARE: &str =
    include_str!("../../../../packages/protocol/test-vectors/server-share/vectors.json");
const ADMIN: &str = include_str!(
    "../../../../packages/protocol/test-vectors/server-share-accept-admin/vectors.json"
);

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap().to_owned()
}
fn n(v: &Value, k: &str) -> u64 {
    v[k].as_u64().unwrap_or(u64::MAX)
}

fn grant_of(f: &Value) -> ServerShareGrant {
    ServerShareGrant {
        server_domain: s(f, "serverDomain"),
        share_id: s(f, "shareId"),
        member_pub_hex: s(f, "memberPubHex"),
        level: s(f, "level"),
        unlock_at_boot: f["unlockAtBoot"].as_bool().unwrap(),
        see_app_data: f["seeAppData"].as_bool().unwrap(),
        label: s(f, "label"),
        issued_at: n(f, "issuedAt"),
    }
}

fn accept_of(f: &Value) -> ServerShareAccept {
    ServerShareAccept {
        server_domain: s(f, "serverDomain"),
        share_id: s(f, "shareId"),
        member_pub_hex: s(f, "memberPubHex"),
        accepted_at: n(f, "acceptedAt"),
    }
}

fn leave_of(f: &Value) -> ServerShareLeave {
    ServerShareLeave {
        server_domain: s(f, "serverDomain"),
        share_id: s(f, "shareId"),
        member_pub_hex: s(f, "memberPubHex"),
        issued_at: n(f, "issuedAt"),
    }
}

fn admin_of(f: &Value) -> ServerShareAcceptAdmin {
    ServerShareAcceptAdmin {
        server_domain: s(f, "serverDomain"),
        share_id: s(f, "shareId"),
        member_pub_hex: s(f, "memberPubHex"),
        accepted_at: n(f, "acceptedAt"),
        key_kind: s(f, "keyKind"),
        key_pub_hex: s(f, "keyPubHex"),
    }
}

#[test]
fn envelopes_have_the_typescript_bytes_and_signatures() {
    let v: Value = serde_json::from_str(SHARE).unwrap();
    let owner = s(&v["keys"], "ownerSignerPub");
    let member = s(&v["keys"], "memberPubHex");
    let mut seen = 0;
    for e in v["envelopes"].as_array().unwrap() {
        let signer = if e["signer"] == "owner" {
            &owner
        } else {
            &member
        };
        let (canonical, ok) = match e["kind"].as_str().unwrap() {
            "grant" => {
                let g = grant_of(&e["fields"]);
                (
                    grant_canonical(&g).unwrap(),
                    verify_grant(&g, &s(e, "signature"), signer),
                )
            }
            "revoke" => {
                let f = &e["fields"];
                let r = ServerShareRevoke {
                    server_domain: s(f, "serverDomain"),
                    share_id: s(f, "shareId"),
                    issued_at: n(f, "issuedAt"),
                };
                (
                    revoke_canonical(&r).unwrap(),
                    verify_revoke(&r, &s(e, "signature"), signer),
                )
            }
            "accept" => {
                let a = accept_of(&e["fields"]);
                (
                    accept_canonical(&a).unwrap(),
                    verify_accept(&a, &s(e, "signature"), signer),
                )
            }
            "leave" => {
                let l = leave_of(&e["fields"]);
                (
                    leave_canonical(&l).unwrap(),
                    verify_leave(&l, &s(e, "signature"), signer),
                )
            }
            _ => continue, // session, offer, list, unlock, inbox, push, update: not ported yet
        };
        assert_eq!(canonical, s(e, "canonical"));
        assert!(ok, "{}", s(e, "canonical"));
        seen += 1;
    }
    assert_eq!(seen, 5, "two grants, a revoke, an accept and a leave");
}

#[test]
fn refusals_and_rejections() {
    let v: Value = serde_json::from_str(SHARE).unwrap();
    for r in v["refuse"].as_array().unwrap() {
        if r["kind"] == "grant" {
            assert!(
                grant_canonical(&grant_of(&r["fields"])).is_err(),
                "{}",
                s(r, "why")
            );
        }
    }
    let owner = s(&v["keys"], "ownerSignerPub");
    let member = s(&v["keys"], "memberPubHex");
    for r in v["reject"].as_array().unwrap() {
        match r["kind"].as_str().unwrap() {
            "grant" => assert!(
                !verify_grant(&grant_of(&r["fields"]), &s(r, "signature"), &owner),
                "{}",
                s(r, "why")
            ),
            "leave" => assert!(
                !verify_leave(&leave_of(&r["fields"]), &s(r, "signature"), &member),
                "{}",
                s(r, "why")
            ),
            _ => {} // update, push: not ported yet
        }
    }
}

#[test]
fn accept_admin_vectors() {
    let v: Value = serde_json::from_str(ADMIN).unwrap();
    let share_admin = s(&v["keys"], "shareAdminPubHex");
    for e in v["envelopes"].as_array().unwrap() {
        let a = admin_of(&e["fields"]);
        assert_eq!(accept_admin_canonical(&a).unwrap(), s(e, "canonical"));
        assert!(verify_accept_admin(&a, &s(e, "signature"), &share_admin));
    }
    for r in v["refuse"].as_array().unwrap() {
        if r["kind"] == "accept-admin" {
            assert!(
                accept_admin_canonical(&admin_of(&r["fields"])).is_err(),
                "{}",
                s(r, "why")
            );
        }
    }
    for r in v["reject"].as_array().unwrap() {
        if r.get("signature").is_some() && r["fields"].get("keyKind").is_some() {
            assert!(
                !verify_accept_admin(&admin_of(&r["fields"]), &s(r, "signature"), &share_admin),
                "{}",
                s(r, "why")
            );
        }
    }
}

#[test]
fn labels() {
    assert!(label_ok("Sam"));
    assert!(label_ok(&"é".repeat(64)));
    assert!(!label_ok(&"é".repeat(65)));
    assert!(!label_ok(""));
    assert!(!label_ok(" Sam"));
    assert!(!label_ok("Sam\u{feff}"));
    assert!(!label_ok("Sam\u{85}"));
    assert!(!label_ok("a|b"));
    assert!(!label_ok("a\nb"));
    assert!(!label_ok("a\u{7f}"));
}

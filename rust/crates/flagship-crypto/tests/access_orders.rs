#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use flagship_crypto::access_orders::{
    AppRankOrder, RestoredAccessApproval, ServiceAccessModeOrder, ServiceAllowRemoveOrder,
    app_rank_canonical, parse_app_rank_target, restored_access_approve_canonical,
    service_access_mode_canonical, service_allow_remove_canonical, verify_app_rank,
    verify_restored_access_approve, verify_service_access_mode, verify_service_allow_remove,
};
use serde_json::Value;

const VECTORS: &str =
    include_str!("../../../../packages/protocol/test-vectors/app-access-orders/vectors.json");

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap().to_owned()
}

#[test]
fn rank_vectors() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let pubkey = s(&v, "signerPub");
    for c in v["rank"]["cases"].as_array().unwrap() {
        let o = AppRankOrder {
            service_ref: s(c, "serviceRef"),
            target: s(c, "target"),
            rank: s(c, "rank"),
            issued_at: c["issuedAt"].as_u64().unwrap(),
        };
        assert_eq!(app_rank_canonical(&o).unwrap(), s(c, "canonical"));
        assert!(
            verify_app_rank(&o, &s(c, "signature"), &pubkey),
            "{}",
            s(c, "canonical")
        );
        let later = AppRankOrder {
            issued_at: o.issued_at + 1,
            ..o.clone()
        };
        assert!(
            !verify_app_rank(&later, &s(c, "signature"), &pubkey),
            "a different time is a different message"
        );
        let other = AppRankOrder {
            rank: if o.rank == "member" {
                "manager".into()
            } else {
                "member".into()
            },
            ..o
        };
        assert!(!verify_app_rank(&other, &s(c, "signature"), &pubkey));
    }
    for c in v["rank"]["invalid"].as_array().unwrap() {
        let Some(issued_at) = c["issuedAt"].as_u64() else {
            continue;
        }; // negative: no u64 to hold it
        let o = AppRankOrder {
            service_ref: s(c, "serviceRef"),
            target: s(c, "target"),
            rank: s(c, "rank"),
            issued_at,
        };
        assert!(app_rank_canonical(&o).is_err(), "{}", s(c, "why"));
        assert!(!verify_app_rank(&o, &"00".repeat(64), &pubkey));
    }
}

#[test]
fn mode_vectors() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let pubkey = s(&v, "signerPub");
    for c in v["mode"]["cases"].as_array().unwrap() {
        let o = ServiceAccessModeOrder {
            service_ref: s(c, "serviceRef"),
            mode: s(c, "mode"),
            issued_at: c["issuedAt"].as_u64().unwrap(),
        };
        assert_eq!(
            service_access_mode_canonical(&o).unwrap(),
            s(c, "canonical")
        );
        assert!(verify_service_access_mode(&o, &s(c, "signature"), &pubkey));
    }
    for c in v["mode"]["invalid"].as_array().unwrap() {
        let Some(issued_at) = c["issuedAt"].as_u64() else {
            continue;
        };
        let o = ServiceAccessModeOrder {
            service_ref: s(c, "serviceRef"),
            mode: s(c, "mode"),
            issued_at,
        };
        assert!(
            service_access_mode_canonical(&o).is_err(),
            "{}",
            s(c, "why")
        );
    }
}

#[test]
fn remove_vectors() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let pubkey = s(&v, "signerPub");
    for c in v["remove"]["cases"].as_array().unwrap() {
        let o = ServiceAllowRemoveOrder {
            service_ref: s(c, "serviceRef"),
            aid: s(c, "aid"),
            issued_at: c["issuedAt"].as_u64().unwrap(),
        };
        assert_eq!(
            service_allow_remove_canonical(&o).unwrap(),
            s(c, "canonical")
        );
        assert!(verify_service_allow_remove(&o, &s(c, "signature"), &pubkey));
    }
    for c in v["remove"]["invalid"].as_array().unwrap() {
        let Some(issued_at) = c["issuedAt"].as_u64() else {
            continue;
        };
        let o = ServiceAllowRemoveOrder {
            service_ref: s(c, "serviceRef"),
            aid: s(c, "aid"),
            issued_at,
        };
        assert!(
            service_allow_remove_canonical(&o).is_err(),
            "{}",
            s(c, "why")
        );
    }
}

#[test]
fn rank_targets_and_refusals() {
    let hex64 = "ab".repeat(32);
    assert!(parse_app_rank_target(&format!("device:{hex64}")).is_some());
    assert!(parse_app_rank_target(&format!("device:{}", hex64.to_uppercase())).is_none());
    assert!(parse_app_rank_target(&format!("share:{}", "ab".repeat(16))).is_some());
    assert!(parse_app_rank_target(&format!("share:{hex64}")).is_none());
    assert!(parse_app_rank_target("invite:inv-1.x_y").is_some());
    assert!(parse_app_rank_target("invite:").is_none());
    assert!(parse_app_rank_target(&format!("grant:inv-1/{hex64}")).is_some());
    assert!(parse_app_rank_target("grant:inv-1/short").is_none());
    assert!(parse_app_rank_target("owner:x").is_none());
    let refuse = |target: String| AppRankOrder {
        service_ref: "svc".into(),
        target,
        rank: "refused".into(),
        issued_at: 1,
    };
    assert!(app_rank_canonical(&refuse(format!("device:{hex64}"))).is_ok());
    assert!(
        app_rank_canonical(&refuse(format!("aid:{hex64}"))).is_err(),
        "only a device or a co-manager can be refused"
    );
    assert!(
        app_rank_canonical(&AppRankOrder {
            issued_at: 9_007_199_254_740_992,
            ..refuse(format!("device:{hex64}"))
        })
        .is_err()
    );
    assert!(
        app_rank_canonical(&AppRankOrder {
            service_ref: "-svc".into(),
            ..refuse(format!("device:{hex64}"))
        })
        .is_err()
    );
    assert!(
        app_rank_canonical(&AppRankOrder {
            service_ref: "a".repeat(129),
            ..refuse(format!("device:{hex64}"))
        })
        .is_err()
    );
}

#[test]
fn restored_access_approval_binds_the_exact_draft() {
    let o = RestoredAccessApproval {
        service_ref: "harry--chess-club".into(),
        draft_sha256: "0f".repeat(32),
        issued_at: 1_760_000_000_000,
    };
    assert_eq!(
        restored_access_approve_canonical(&o).unwrap(),
        format!(
            "flagship/restored-access-approve/v1|harry--chess-club|{}|1760000000000",
            "0f".repeat(32)
        )
    );
    assert!(
        restored_access_approve_canonical(&RestoredAccessApproval {
            draft_sha256: "xyz".into(),
            ..o.clone()
        })
        .is_err()
    );
    assert!(!verify_restored_access_approve(
        &o,
        &"00".repeat(64),
        &"00".repeat(32)
    ));
}

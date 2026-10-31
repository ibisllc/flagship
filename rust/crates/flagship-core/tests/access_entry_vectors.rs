//! Entry verification against the verdicts of the TypeScript applier
//! (packages/server-daemon/test-vectors/access-entries.json).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use flagship_core::access_entry::{EntryTrust, InviteTier, Verdict, Verified, verify_entry};
use flagship_core::access_journal::parse_entry;
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/server-daemon/test-vectors/access-entries.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn trust(v: &Value) -> EntryTrust {
    let t = &v["trust"];
    let strings = |x: &Value| {
        x.as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };
    EntryTrust {
        admin_signers: strings(&t["adminSigners"]),
        installed: strings(&t["installed"]),
        create_signers: t["createSigners"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                (
                    c["pub"].as_str().unwrap().to_string(),
                    InviteTier::parse(c["tier"].as_str().unwrap()).unwrap(),
                )
            })
            .collect(),
    }
}

#[test]
fn every_case_gets_the_typescript_verdict() {
    let v = vectors();
    let t = trust(&v);
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 25);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let entry = parse_entry(&c["entry"]);
        let verdict = entry.as_ref().map_or(Verdict::Refused, |e| {
            verify_entry(e, c["serviceRef"].as_str().unwrap(), &t)
        });
        let want = c["expect"].as_str().unwrap();
        assert_eq!(
            matches!(verdict, Verdict::Refused),
            want == "refused",
            "{name}: {verdict:?}"
        );
    }
}

#[test]
fn a_verified_entry_says_what_was_verified() {
    let v = vectors();
    let t = trust(&v);
    let find = |needle: &str| {
        v["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"].as_str().unwrap().starts_with(needle))
            .unwrap()
            .clone()
    };
    let verdict = |c: &Value| {
        verify_entry(
            &parse_entry(&c["entry"]).unwrap(),
            c["serviceRef"].as_str().unwrap(),
            &t,
        )
    };

    assert!(
        matches!(verdict(&find("a mode order signed by the admin root")), Verdict::Verified(Verified::Mode { ref mode, .. }) if mode == "restricted")
    );
    assert!(matches!(verdict(&find("a rank entry")), Verdict::Skipped));
    match verdict(&find("a join through an admin-signed create")) {
        Verdict::Verified(Verified::Join {
            create,
            redeemed_at,
            ..
        }) => {
            assert_eq!(create.tier, InviteTier::Admin);
            assert_eq!(create.service_ref, "alice--club");
            assert!(redeemed_at > 0);
        }
        other => panic!("{other:?}"),
    }
    match verdict(&find("a join through a create signed by a member device")) {
        Verdict::Verified(Verified::Join { create, .. }) => assert_eq!(
            create.tier,
            InviteTier::Member,
            "the invite is only as strong as its maker"
        ),
        other => panic!("{other:?}"),
    }
    match verdict(&find("a withdraw signed by the admin root")) {
        Verdict::Verified(Verified::Withdraw { admin_signed, .. }) => assert!(admin_signed),
        other => panic!("{other:?}"),
    }
    match verdict(&find("a share grant ended by the member's own leave")) {
        Verdict::Verified(Verified::Share { ended, level, .. }) => {
            assert!(ended && level == "manage")
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_withdraw_not_signed_by_an_admin_is_kept_but_says_so() {
    let v = vectors();
    let t = trust(&v);
    let mut c = v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"].as_str().unwrap().starts_with("a withdraw"))
        .unwrap()
        .clone();
    c["entry"]["signature"] = Value::String("b".repeat(128));
    match verify_entry(&parse_entry(&c["entry"]).unwrap(), "alice--club", &t) {
        Verdict::Verified(Verified::Withdraw { admin_signed, .. }) => assert!(
            !admin_signed,
            "a creator-signed withdraw is judged by the store, which knows the creator"
        ),
        other => panic!("{other:?}"),
    }
}

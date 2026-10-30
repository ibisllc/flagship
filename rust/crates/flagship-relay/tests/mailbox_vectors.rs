#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use flagship_relay::mailbox::{
    canonical_announce, mailbox_epoch, mailbox_id, verify_announcements,
};
use flagship_relay::payload::MailboxAnnouncement;
use serde_json::Value;

const VECTORS: &str =
    include_str!("../../../../packages/tunnel-protocol/test-vectors/mailbox.json");

#[test]
fn ids_canonical_bytes_and_epoch_follow_the_typescript() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    assert_eq!(
        mailbox_epoch(v["now"].as_u64().unwrap()),
        v["epoch"].as_u64().unwrap()
    );
    for i in v["ids"].as_array().unwrap() {
        let (pik, epoch) = (i["pik"].as_str().unwrap(), i["epoch"].as_u64().unwrap());
        assert_eq!(mailbox_id(pik, epoch), i["id"].as_str().unwrap());
        assert_eq!(
            canonical_announce(pik, epoch),
            i["canonical"].as_str().unwrap()
        );
    }
}

#[test]
fn every_announcement_list_gets_the_typescript_verdict() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let now = v["now"].as_u64().unwrap();
    for l in v["lists"].as_array().unwrap() {
        let list: Vec<MailboxAnnouncement> = l["list"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| MailboxAnnouncement {
                pik_pub_hex: a["pikPubHex"].as_str().unwrap().to_owned(),
                epoch: a["epoch"].as_f64().unwrap(),
                sig_hex: a["sigHex"].as_str().unwrap().to_owned(),
            })
            .collect();
        let want: Option<Vec<String>> = l["ids"]
            .as_array()
            .map(|a| a.iter().map(|x| x.as_str().unwrap().to_owned()).collect());
        assert_eq!(verify_announcements(&list, now), want, "{}", l["name"]);
    }
}

#[test]
fn a_non_integral_or_negative_epoch_never_verifies() {
    for epoch in [f64::NAN, -1.0, 1.5, f64::INFINITY] {
        let a = MailboxAnnouncement {
            pik_pub_hex: "00".repeat(32),
            epoch,
            sig_hex: "00".repeat(64),
        };
        assert_eq!(verify_announcements(&[a], 1_760_000_000_000), None);
    }
}

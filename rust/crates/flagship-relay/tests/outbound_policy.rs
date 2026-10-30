#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use flagship_relay::outbound::policy::{is_public_unicast, vet_outbound_host};
use serde_json::Value;

const VECTORS: &str =
    include_str!("../../../../packages/tunnel-protocol/test-vectors/outbound-policy.json");

#[test]
fn every_host_gets_the_typescript_verdict() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let hosts = v["hosts"].as_array().unwrap();
    assert!(hosts.len() >= 50);
    for h in hosts {
        let raw = h["host"].as_str().unwrap();
        assert_eq!(
            vet_outbound_host(raw),
            h["vetted"].as_str().map(str::to_owned),
            "{raw:?}"
        );
    }
}

#[test]
fn every_address_gets_the_typescript_verdict_except_that_a_zone_identifier_is_refused() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    for a in v["addresses"].as_array().unwrap() {
        let addr = a["address"].as_str().unwrap();
        let want = a["publicUnicast"].as_bool().unwrap();
        // The one deliberate difference: Node strips a `%zone` and judges the rest, which a resolver never produces.
        let expect = if addr.contains('%') { false } else { want };
        assert_eq!(is_public_unicast(addr), expect, "{addr:?}");
    }
}

#[test]
fn private_and_special_ranges_are_never_reachable() {
    for a in [
        "10.1.2.3",
        "127.0.0.1",
        "169.254.169.254",
        "192.168.0.1",
        "172.20.0.1",
        "100.64.1.1",
        "::1",
        "fdaa::1",
        "fe80::1",
        "::ffff:10.0.0.1",
        "64:ff9b::a00:1",
    ] {
        assert!(!is_public_unicast(a), "{a}");
    }
    for h in [
        "localhost",
        "x.internal",
        "169.254.169.254",
        "metadata.google.internal",
        "2130706433",
        "127.1",
    ] {
        assert_eq!(vet_outbound_host(h), None, "{h}");
    }
}

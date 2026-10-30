#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]
mod common;

use common::{Spec, build};
use flagship_updater::manifest;
use flagship_updater::verify::{Expect, Trust, verify};

fn expect(b: &common::Built) -> Expect {
    Expect {
        sha256: b.sha.clone(),
        commit: b.commit.clone(),
        arch: "amd64".into(),
        last_sequence: None,
        node_floor: Some("22.0.0".into()),
        now_ms: 1_700_000_100_000,
    }
}

fn run(
    b: &common::Built,
    trust: &Trust,
    e: &Expect,
) -> Result<flagship_updater::verify::Verified, String> {
    let file = manifest::parse(&std::fs::read_to_string(&b.manifest).unwrap())
        .map_err(|r| r.to_string())?;
    verify(&file, &b.artifact, trust, e).map_err(|r| r.code.to_owned())
}

#[test]
fn a_correctly_signed_release_verifies() {
    let b = build(&Spec::new('a', 5));
    let v = run(&b, &b.trust, &expect(&b)).unwrap();
    assert_eq!((v.sequence, v.signers), (5, 1));
}

#[test]
fn the_canonical_bytes_are_the_documented_form() {
    let b = build(&Spec::new('b', 7));
    let c = b.manifest_struct.canonical();
    assert!(c.starts_with(&format!(
        "flagship/box-artifact/v1|{}|amd64|{}|",
        b.commit, b.sha
    )));
    assert!(c.ends_with("|1|7|1700000000000"));
}

#[test]
fn a_tampered_manifest_fails_its_signature() {
    let mut s = Spec::new('a', 5);
    s.tamper = true;
    let b = build(&s);
    assert_eq!(
        run(&b, &b.trust, &expect(&b)).unwrap_err(),
        "not-enough-signatures"
    );
}

#[test]
fn a_threshold_of_two_needs_two_distinct_authorised_signers() {
    let mut s = Spec::new('a', 5);
    s.signers = vec![1, 2];
    s.threshold = 2;
    let b = build(&s);
    assert_eq!(run(&b, &b.trust, &expect(&b)).unwrap().signers, 2);
    let mut one = b.trust.clone();
    one.keys.truncate(1);
    one.threshold = 1;
    assert_eq!(run(&b, &one, &expect(&b)).unwrap().signers, 1);
    let mut stranger = b.trust.clone();
    stranger.keys = vec![
        common::Signer::new(9).ed_hex(),
        common::Signer::new(8).ed_hex(),
    ];
    assert_eq!(
        run(&b, &stranger, &expect(&b)).unwrap_err(),
        "not-enough-signatures"
    );
}

#[test]
fn a_repeated_signature_counts_once() {
    let mut s = Spec::new('a', 5);
    s.signers = vec![1, 1];
    s.threshold = 2;
    let b = build(&s);
    let mut t = b.trust.clone();
    t.keys = vec![
        common::Signer::new(1).ed_hex(),
        common::Signer::new(2).ed_hex(),
    ];
    assert_eq!(
        run(&b, &t, &expect(&b)).unwrap_err(),
        "not-enough-signatures"
    );
}

#[test]
fn the_recipe_and_the_file_must_agree_with_the_manifest() {
    let b = build(&Spec::new('a', 5));
    let mut e = expect(&b);
    e.sha256 = "0".repeat(64);
    assert_eq!(run(&b, &b.trust, &e).unwrap_err(), "digest-mismatch");
    let mut e = expect(&b);
    e.commit = "b".repeat(40);
    assert_eq!(run(&b, &b.trust, &e).unwrap_err(), "commit-mismatch");
    let mut e = expect(&b);
    e.arch = "arm64".into();
    assert_eq!(run(&b, &b.trust, &e).unwrap_err(), "arch-mismatch");
    // the artifact bytes changed after signing
    std::fs::write(&b.artifact, b"not the artifact").unwrap();
    assert_eq!(
        run(&b, &b.trust, &expect(&b)).unwrap_err(),
        "digest-mismatch"
    );
}

#[test]
fn an_older_or_equal_sequence_is_a_rollback() {
    let b = build(&Spec::new('a', 5));
    let mut e = expect(&b);
    e.last_sequence = Some(5);
    assert_eq!(run(&b, &b.trust, &e).unwrap_err(), "rollback");
    e.last_sequence = Some(9);
    assert_eq!(run(&b, &b.trust, &e).unwrap_err(), "rollback");
    e.last_sequence = Some(4);
    assert!(run(&b, &b.trust, &e).is_ok());
}

#[test]
fn node_below_the_floor_is_refused() {
    let mut s = Spec::new('a', 5);
    s.node_version = "22.5.0";
    let b = build(&s);
    let mut e = expect(&b);
    e.node_floor = Some("22.5.0".into());
    assert!(run(&b, &b.trust, &e).is_ok());
    e.node_floor = Some("22.5.1".into());
    assert_eq!(run(&b, &b.trust, &e).unwrap_err(), "node-below-floor");
    e.node_floor = Some("22.10.0".into());
    assert_eq!(run(&b, &b.trust, &e).unwrap_err(), "node-below-floor");
}

#[test]
fn bad_trust_is_refused_before_any_signature_counts() {
    let b = build(&Spec::new('a', 5));
    let mut t = b.trust.clone();
    t.threshold = 0;
    assert_eq!(run(&b, &t, &expect(&b)).unwrap_err(), "bad-trust");
    let mut t = b.trust.clone();
    t.keys = vec!["xyz".into()];
    assert_eq!(run(&b, &t, &expect(&b)).unwrap_err(), "bad-trust");
    let mut t = b.trust.clone();
    t.threshold = 2;
    assert_eq!(run(&b, &t, &expect(&b)).unwrap_err(), "bad-trust");
}

#[test]
fn a_malformed_manifest_is_refused() {
    for bad in [
        "",
        "[]",
        "{}",
        "{\"manifest\":{}}",
        "{\"manifest\":{\"commit\":\"x\"},\"signatures\":[]}",
    ] {
        assert_eq!(
            manifest::parse(bad).unwrap_err().code,
            "bad-manifest",
            "{bad}"
        );
    }
}

#[test]
fn with_the_pq_pin_every_signer_needs_the_hybrid_companion() {
    let mut s = Spec::new('a', 5);
    s.pq = true;
    let b = build(&s);
    assert_eq!(run(&b, &b.trust, &expect(&b)).unwrap().signers, 1);
    // the same classical-only manifest is refused once the pin names the key
    let classic = build(&Spec::new('a', 5));
    let mut t = classic.trust.clone();
    t.pq_key_ids = vec![common::Signer::new(1).pq_id()];
    assert_eq!(
        run(&classic, &t, &expect(&classic)).unwrap_err(),
        "pq-signature-required"
    );
    // unless its v1 digest is a pre-cut-over (legacy) manifest
    t.legacy_manifests = vec![common::sha256_hex(
        classic.manifest_struct.canonical().as_bytes(),
    )];
    assert!(run(&classic, &t, &expect(&classic)).is_ok());
}

#[test]
fn a_pq_key_the_pin_does_not_name_does_not_count() {
    let mut s = Spec::new('a', 5);
    s.pq = true;
    let b = build(&s);
    let mut t = b.trust.clone();
    t.pq_key_ids = vec!["0".repeat(64)];
    assert_eq!(
        run(&b, &t, &expect(&b)).unwrap_err(),
        "pq-signature-required"
    );
}

#[test]
fn a_binding_from_the_future_does_not_count() {
    let mut s = Spec::new('a', 5);
    s.pq = true;
    let b = build(&s);
    let mut e = expect(&b);
    e.now_ms = 1_600_000_000_000;
    assert_eq!(run(&b, &b.trust, &e).unwrap_err(), "pq-signature-required");
}

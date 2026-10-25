//! G01: who signs the catalog and how the box checks it (the release-key
//! trust model of `release/box-artifact-trust.json`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::path::Path;

use flagship_gpu::catalog::{CatalogEnvelope, VerifiedCatalog};
use flagship_gpu::catalog_trust::{CatalogTrust, ReleaseKeyVerifier};
use flagship_gpu::sim::SimDrivers;
use flagship_gpu::testkit::{TestSigner, envelope, sim_payload, trust_json};

const NOW: u64 = 1_800_000_000_000;

fn open(e: &CatalogEnvelope, t: &CatalogTrust) -> Result<VerifiedCatalog, String> {
    VerifiedCatalog::open(e, &ReleaseKeyVerifier::new(t.clone(), NOW), 0).map_err(|e| e.to_string())
}

#[test]
fn the_repo_trust_file_parses() {
    let t = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../release/box-artifact-trust.json"),
    )
    .unwrap();
    let t = CatalogTrust::from_trust_json(&t).unwrap();
    assert!(t.threshold >= 1 && !t.keys.is_empty());
}

#[test]
fn trust_file_shapes_are_checked() {
    assert!(CatalogTrust::from_trust_json(r#"{"schema":1,"threshold":0,"keys":[]}"#).is_err());
    assert!(CatalogTrust::from_trust_json(r#"{"schema":1,"threshold":2,"keys":["00"]}"#).is_err());
    assert!(CatalogTrust::from_trust_json(r#"{"schema":2,"threshold":1,"keys":[]}"#).is_err());
}

#[test]
fn threshold_signers_and_pq_companions() {
    let a = TestSigner::new(11).unwrap();
    let b = TestSigner::new(12).unwrap();
    let c = TestSigner::new(13).unwrap();
    let p = sim_payload(4, &SimDrivers::default(), &[]);
    let two_of_three = CatalogTrust::from_trust_json(&trust_json(&[&a, &b, &c], 2, false)).unwrap();
    assert!(open(&envelope(&p, &[&a, &c], false, NOW).unwrap(), &two_of_three).is_ok());
    assert!(open(&envelope(&p, &[&b], false, NOW).unwrap(), &two_of_three).is_err());
    let mut dup = envelope(&p, &[&a], false, NOW).unwrap();
    dup.signatures.push(dup.signatures[0].clone());
    assert!(
        open(&dup, &two_of_three).is_err(),
        "the same signer twice counts once"
    );

    let pinned = CatalogTrust::from_trust_json(&trust_json(&[&a, &b], 2, true)).unwrap();
    let ok = envelope(&p, &[&a, &b], true, NOW).unwrap();
    assert!(open(&ok, &pinned).is_ok());
    let mut wrong_subject = ok.clone();
    for w in &mut wrong_subject.pq_bindings {
        w.subject_id = "flagship-box-artifact".into();
    }
    assert!(
        open(&wrong_subject, &pinned).is_err(),
        "a binding for another subject"
    );
    let mut swapped = ok.clone();
    let (pq0, pq1) = (
        swapped.signatures[0].pq.clone(),
        swapped.signatures[1].pq.clone(),
    );
    swapped.signatures[0].pq = pq1;
    swapped.signatures[1].pq = pq0;
    assert!(
        open(&swapped, &pinned).is_err(),
        "a companion belongs to its signer"
    );
    let only_a = CatalogTrust {
        pq_key_ids: vec![a.pq_key_id_hex()],
        ..pinned.clone()
    };
    assert!(
        open(&ok, &only_a).is_err(),
        "a release key the pin doesn't name"
    );
    let future = envelope(&p, &[&a, &b], true, NOW + 3_600_000).unwrap();
    assert!(
        open(&future, &pinned).is_err(),
        "a binding dated in the future"
    );
}

/// A catalog signed by `scripts/gpu-catalog.mjs` (fake YubiKeys, the
/// release key ceremony's test mode) verifies in Rust.
#[test]
fn the_signing_tool_output_verifies() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let env: CatalogEnvelope = serde_json::from_str(
        &std::fs::read_to_string(dir.join("gpu-catalog.signed.json")).unwrap(),
    )
    .unwrap();
    let trust = CatalogTrust::from_trust_json(
        &std::fs::read_to_string(dir.join("gpu-catalog.trust.json")).unwrap(),
    )
    .unwrap();
    let c = VerifiedCatalog::open(&env, &ReleaseKeyVerifier::new(trust.clone(), NOW), 0).unwrap();
    assert!(!c.entries().is_empty());
    assert!(trust.pq_pinned(), "the fixture carries a PQ companion");
    let mut t = env;
    t.payload = t.payload.replacen("receipts", "receipts ", 1);
    assert!(VerifiedCatalog::open(&t, &ReleaseKeyVerifier::new(trust, NOW), 0).is_err());
}

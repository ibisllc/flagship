//! The signed compatibility catalog.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod common;

use std::collections::BTreeSet;

use common::{TestVerifier, entry, host, sign};
use flagship_gpu::catalog::{CATALOG_SCHEMA, CatalogError, CatalogPayload, VerifiedCatalog};
use flagship_gpu::device::{Backend, Capability};
use flagship_gpu::provider::IsolationProfile;

fn payload(serial: u64) -> CatalogPayload {
    CatalogPayload {
        schema: CATALOG_SCHEMA.into(),
        serial,
        issued_at: "2026-10-01T00:00:00Z".into(),
        entries: vec![
            entry("h100", Backend::NvidiaCuda, &["0x2330"], "13.0"),
            entry("mi210", Backend::AmdRocm, &["0x740f"], "6.4.3"),
        ],
    }
}

#[test]
fn verifies_before_parsing_and_refuses_tampering() {
    let env = sign(&payload(5));
    assert!(VerifiedCatalog::open(&env, &TestVerifier, 0).is_ok());
    let mut tampered = env.clone();
    tampered.payload = tampered.payload.replace("13.0", "12.0");
    assert!(matches!(
        VerifiedCatalog::open(&tampered, &TestVerifier, 0),
        Err(CatalogError::BadSignature(_))
    ));
    let mut other_key = env.clone();
    other_key.key_id = "attacker".into();
    assert!(matches!(
        VerifiedCatalog::open(&other_key, &TestVerifier, 0),
        Err(CatalogError::BadSignature(_))
    ));
    let mut serial = env;
    serial.serial = 6;
    assert!(VerifiedCatalog::open(&serial, &TestVerifier, 0).is_err());
}

#[test]
fn refuses_rollback() {
    let env = sign(&payload(5));
    assert_eq!(
        VerifiedCatalog::open(&env, &TestVerifier, 6),
        Err(CatalogError::Rollback { got: 5, min: 6 })
    );
}

#[test]
fn refuses_mutable_image_tags() {
    for r in [
        "nvcr.io/nvidia/cuda:latest".to_owned(),
        "nvcr.io/nvidia/cuda:12.9.1-runtime-ubuntu24.04".to_owned(),
        format!("nvcr.io/nvidia/cuda:latest@sha256:{}", common::DIGEST),
    ] {
        let mut p = payload(5);
        p.entries[0].images[0].reference = r.clone();
        assert!(
            matches!(
                VerifiedCatalog::open(&sign(&p), &TestVerifier, 0),
                Err(CatalogError::Entry { .. })
            ),
            "{r}"
        );
    }
}

#[test]
fn refuses_entries_the_code_could_not_honour() {
    let mut p = payload(5);
    p.entries[1].isolation.push(IsolationProfile::GvisorNvproxy);
    assert!(
        VerifiedCatalog::open(&sign(&p), &TestVerifier, 0).is_err(),
        "gVisor for ROCm"
    );
    let mut p = payload(5);
    p.entries[1].partitioning = true;
    assert!(
        VerifiedCatalog::open(&sign(&p), &TestVerifier, 0).is_err(),
        "MIG on AMD"
    );
    let mut p = payload(5);
    p.entries[0].runsc.clear();
    assert!(
        VerifiedCatalog::open(&sign(&p), &TestVerifier, 0).is_err(),
        "nvproxy without runsc"
    );
    let mut p = payload(5);
    p.entries[0].images.clear();
    assert!(VerifiedCatalog::open(&sign(&p), &TestVerifier, 0).is_err());
}

#[test]
fn qualification_is_exact() {
    let cat = VerifiedCatalog::open(&sign(&payload(5)), &TestVerifier, 0).unwrap();
    let compute = BTreeSet::from([Capability::Compute]);
    let d = common::h100(0);
    let gv = IsolationProfile::GvisorNvproxy;
    assert_eq!(cat.qualify(&d, &host(), gv, &compute).unwrap().id, "h100");

    let mut h = host();
    h.kernel = "6.12.49+deb13-amd64".into();
    assert!(cat.qualify(&d, &h, gv, &compute).is_err());
    let mut h = host();
    h.module_signing_enforced = false;
    assert!(cat.qualify(&d, &h, gv, &compute).is_err());
    let mut h = host();
    h.runsc = Some("20250101.0".into());
    assert!(cat.qualify(&d, &h, gv, &compute).is_err());
    assert!(
        cat.qualify(&d, &h, IsolationProfile::VmPassthrough, &compute)
            .is_ok(),
        "runsc only gates gVisor"
    );

    let mut other_driver = d.clone();
    other_driver.driver_version = "575.0.0".into();
    assert!(cat.qualify(&other_driver, &host(), gv, &compute).is_err());
    let mut other_model = d.clone();
    other_model.pci_device_id = Some(0x2331);
    assert!(
        cat.qualify(&other_model, &host(), gv, &compute).is_err(),
        "no carry-over across models"
    );
    let graphics = BTreeSet::from([Capability::Compute, Capability::Graphics]);
    assert!(
        cat.qualify(&d, &host(), gv, &graphics).is_err(),
        "graphics is qualified separately"
    );
}

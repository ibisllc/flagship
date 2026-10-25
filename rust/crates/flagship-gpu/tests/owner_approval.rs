//! The owner's signed GPU approval, checked by gpud itself: the shared vectors
//! (`packages/protocol/test-vectors/gpu-approval/vectors.json`, written by the TS port), keyd's
//! pins as the anchor, and claims that arrive unsigned, forged or widened.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use flagship_gpu::catalog::VerifiedCatalog;
use flagship_gpu::catalog_trust::{CatalogTrust, ReleaseKeyVerifier};
use flagship_gpu::device::{Backend, Capability};
use flagship_gpu::owner_approval::{
    ApprovalProof, OwnerAnchor, OwnerAnchorSource, box_local, canonical, verify,
};
use flagship_gpu::provider::IsolationProfile;
use flagship_gpu::request::GpuApproval;
use flagship_gpu::service::{CatalogSource, GpuService, ServiceConfig, ServiceParts};
use flagship_gpu::sim::{SimGpu, SimHost};
use flagship_gpu::testkit::{
    TEST_SERVER, TestOwner, TestSigner, app, approval, envelope, sim_host_facts, sim_payload,
    trust_json,
};
use serde_json::{Value, json};

const VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/protocol/test-vectors/gpu-approval/vectors.json"
));
const NOW: u64 = 1_800_000_000_000;

#[test]
fn the_shared_vectors_give_the_ts_verdicts() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let anchor = OwnerAnchor {
        server: v["anchor"]["server"].as_str().unwrap().into(),
        signer_hex: v["anchor"]["signerHex"].as_str().unwrap().into(),
    };
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 15);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let a: GpuApproval = serde_json::from_value(c["approval"].clone()).unwrap();
        let p: ApprovalProof = serde_json::from_value(c["proof"].clone()).unwrap();
        if let Some(text) = c["canonical"].as_str() {
            assert_eq!(
                canonical(&anchor.server, &a, p.issued_at).unwrap(),
                text,
                "{name}"
            );
        }
        assert_eq!(
            verify(&anchor, &a, &p).is_ok(),
            c["expect"].as_bool().unwrap(),
            "{name}: {:?}",
            verify(&anchor, &a, &p)
        );
    }
    let irk = OwnerAnchor {
        server: anchor.server.clone(),
        signer_hex: v["keys"]["irkPubHex"].as_str().unwrap().into(),
    };
    let first: GpuApproval = serde_json::from_value(cases[0]["approval"].clone()).unwrap();
    let p: ApprovalProof = serde_json::from_value(cases[0]["proof"].clone()).unwrap();
    assert!(
        verify(&irk, &first, &p).is_err(),
        "the admin root's signature is not the IRK's"
    );
}

#[test]
fn keyds_pins_are_the_anchor() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let root = "a".repeat(64);
    let irk = "b".repeat(64);
    let put = |name: &str, v: &str| std::fs::write(d.join(name), v).unwrap();
    assert!(OwnerAnchor::from_keyd_state(d).is_err(), "nothing pinned");
    put(
        "policy.json",
        r#"{"serverFqdn":"home.alice.flagship.services"}"#,
    );
    put("owner.json", &format!(r#"{{"irkPubHex":"{irk}"}}"#));
    assert_eq!(
        OwnerAnchor::from_keyd_state(d).unwrap(),
        OwnerAnchor {
            server: "home.alice.flagship.services".into(),
            signer_hex: irk.clone()
        },
        "an account without an admin root: the IRK"
    );
    put(
        "owner.json",
        &format!(r#"{{"irkPubHex":"{irk}","adminRootPubHex":"{root}"}}"#),
    );
    assert_eq!(
        OwnerAnchor::from_keyd_state(d).unwrap().signer_hex,
        root,
        "the admin root, never the IRK, once pinned"
    );
    for bad in [
        r#"{"irkPubHex":"AAAA"}"#,
        r#"{"adminRootPubHex":"zz"}"#,
        "not json",
        "{}",
    ] {
        put("owner.json", bad);
        assert!(OwnerAnchor::from_keyd_state(d).is_err(), "{bad}");
    }
    put("owner.json", &format!(r#"{{"irkPubHex":"{irk}"}}"#));
    for bad in [
        r#"{"serverFqdn":"Home.Alice"}"#,
        r#"{"serverFqdn":"a|b"}"#,
        r#"{"serverFqdn":""}"#,
        "{}",
    ] {
        put("policy.json", bad);
        assert!(OwnerAnchor::from_keyd_state(d).is_err(), "{bad}");
    }
}

fn service(dir: &std::path::Path, anchor: OwnerAnchorSource) -> (SimHost, GpuService) {
    let host = SimHost::new(dir.join("h"), vec![SimGpu::rtx4090(1)]).unwrap();
    let d = host.drivers();
    let s = TestSigner::new(5).unwrap();
    let e = envelope(&sim_payload(2, &d, &[]), &[&s], false, NOW).unwrap();
    let t = CatalogTrust::from_trust_json(&trust_json(&[&s], 1, false)).unwrap();
    let cat = VerifiedCatalog::open(&e, &ReleaseKeyVerifier::new(t, NOW), 0).unwrap();
    let parts = ServiceParts {
        tools: host.tools(),
        runtime: host.runtime(),
        scrub: host.scrubber(),
        sysfs_writer: host.sysfs_writer(),
        packages: None,
    };
    let mut c = ServiceConfig::system(
        dir.join("state"),
        CatalogSource::Loaded(cat),
        sim_host_facts(&d),
    );
    c.sys_root = host.sys_root();
    c.proc_root = host.proc_root();
    c.dev_root = host.dev_root();
    c.cdi_dir = host.cdi_dir();
    c.enforce_root_owned_cdi = false;
    c.run_claims_path = dir.join("run-claims.json");
    c.owner_anchor = anchor;
    let svc = GpuService::new(c, parts).unwrap();
    (host, svc)
}

fn claim(id: &str, a: &GpuApproval, container: &str, sharing: &str) -> Value {
    json!({
        "allocationId": id,
        "app": a.app,
        "operationId": "op",
        "container": container,
        "requirement": {"backend": "nvidia-cuda", "capabilities": ["compute"], "minimumMemoryMiB": 1024, "sharing": sharing},
        "approval": a,
    })
}

fn code(s: &mut GpuService, v: &Value) -> String {
    match s.handle("gpu.claim", v) {
        Ok(r) => r["state"].as_str().unwrap_or_default().to_owned(),
        Err(e) => e.code.to_owned(),
    }
}

#[test]
fn gpud_admits_only_what_the_owner_signed() {
    let dir = tempfile::tempdir().unwrap();
    let owner = TestOwner::new(0x0a);
    let (_h, mut s) = service(dir.path(), OwnerAnchorSource::Fixed(owner.anchor()));
    let exclusive = approval(
        app("app", 1),
        Backend::NvidiaCuda,
        IsolationProfile::GvisorNvproxy,
        &[Capability::Compute],
        true,
        None,
    );
    let plain = claim("a", &exclusive, "flagship-app", "exclusive");
    assert_eq!(code(&mut s, &plain), "forbidden", "no owner signature");

    let stranger = TestOwner::new(0x0b);
    assert_eq!(
        code(&mut s, &stranger.sign_claim(&plain)),
        "forbidden",
        "someone else's key"
    );

    let mut widened = owner.sign_claim(&plain);
    widened["approval"]["secrecy"] = json!(false);
    widened["approval"]["trustDomain"] = json!("family");
    widened["approval"]["ownerConsent"] = json!("consent-family");
    assert_eq!(
        code(&mut s, &widened),
        "forbidden",
        "secrecy dropped and a trust domain added after the owner signed"
    );

    let mut other_box = plain.clone();
    other_box["approvalProof"] =
        serde_json::to_value(owner.prove_for("home2.alice.flagship.services", &exclusive, NOW))
            .unwrap();
    assert_eq!(
        code(&mut s, &other_box),
        "forbidden",
        "the owner's approval for another of their servers"
    );

    let mut foreign_app = owner.sign_claim(&plain);
    foreign_app["approval"]["app"]["appId"] = json!("bob--bank");
    foreign_app["app"]["appId"] = json!("bob--bank");
    assert_eq!(
        code(&mut s, &foreign_app),
        "forbidden",
        "one app's signed approval used for another app"
    );

    let mut extra = owner.sign_claim(&plain);
    extra["approvalProof"]["approved"] = json!(true);
    assert_eq!(code(&mut s, &extra), "bad-request", "unknown proof fields");

    assert_eq!(
        code(&mut s, &owner.sign_claim(&plain)),
        "reserved",
        "the owner's own approval"
    );
}

#[test]
fn only_the_boxs_own_local_ai_runs_unsigned() {
    let dir = tempfile::tempdir().unwrap();
    let (_h, mut s) = service(dir.path(), OwnerAnchorSource::None);
    let local: GpuApproval = serde_json::from_value(json!({
        "app": {"appId": "flagship-local-ai", "installationId": "box", "generation": 1},
        "backend": "nvidia-cuda", "maxCount": 1, "capabilities": ["compute"], "policies": ["exclusive"],
        "isolation": "gvisor-nvproxy", "secrecy": true, "trustDomain": null, "ownerConsent": null,
    }))
    .unwrap();
    let c = "flagship-localai-0123456789abcdef";
    assert!(box_local(&local, c));
    assert!(box_local(&local, "flagship-aitrain-0123456789abcdef"));
    let widen = |f: &dyn Fn(&mut GpuApproval)| {
        let mut a = local.clone();
        f(&mut a);
        a
    };
    let hostile = [
        (
            widen(&|a| {
                a.policies
                    .insert(flagship_gpu::policy::PolicyKind::Cooperative);
            }),
            c,
        ),
        (widen(&|a| a.secrecy = false), c),
        (
            widen(&|a| {
                a.capabilities.insert(Capability::Graphics);
            }),
            c,
        ),
        (widen(&|a| a.max_count = 2), c),
        (widen(&|a| a.trust_domain = Some("family".into())), c),
        (widen(&|a| a.app.installation_id = "other".into()), c),
        (widen(&|a| a.app.app_id = "flagship-local-ai2".into()), c),
        (local.clone(), "flagship-alice--notes"),
        (local.clone(), "flagship-localai-0123"),
        (local.clone(), "flagship-localai-0123456789ABCDEF"),
    ];
    for (i, (a, container)) in hostile.iter().enumerate() {
        assert!(!box_local(a, container), "case {i}");
        assert_eq!(
            code(&mut s, &claim(&format!("h{i}"), a, container, "exclusive")),
            "forbidden",
            "case {i}: no owner key, so nothing wider than local AI"
        );
    }
    assert_eq!(
        code(&mut s, &claim("l", &local, c, "exclusive")),
        "reserved"
    );
}

#[test]
fn a_claim_checks_keyds_current_pins() {
    let dir = tempfile::tempdir().unwrap();
    let keyd = dir.path().join("keyd");
    std::fs::create_dir_all(&keyd).unwrap();
    let owner = TestOwner::new(0x0a);
    let (_h, mut s) = service(dir.path(), OwnerAnchorSource::KeydState(keyd.clone()));
    let a = approval(
        app("app", 1),
        Backend::NvidiaCuda,
        IsolationProfile::GvisorNvproxy,
        &[Capability::Compute],
        true,
        None,
    );
    let signed = owner.sign_claim(&claim("a", &a, "flagship-app", "exclusive"));
    assert_eq!(code(&mut s, &signed), "forbidden", "keyd pins nothing yet");
    std::fs::write(
        keyd.join("policy.json"),
        format!(r#"{{"serverFqdn":"{TEST_SERVER}"}}"#),
    )
    .unwrap();
    std::fs::write(
        keyd.join("owner.json"),
        format!(
            r#"{{"irkPubHex":"{}","adminRootPubHex":"{}"}}"#,
            owner.anchor().signer_hex,
            TestOwner::new(0x0c).anchor().signer_hex
        ),
    )
    .unwrap();
    assert_eq!(
        code(&mut s, &signed),
        "forbidden",
        "the IRK's signature once an admin root is pinned"
    );
    std::fs::write(
        keyd.join("owner.json"),
        format!(
            r#"{{"irkPubHex":"{}","adminRootPubHex":"{}"}}"#,
            "c".repeat(64),
            owner.anchor().signer_hex
        ),
    )
    .unwrap();
    assert_eq!(code(&mut s, &signed), "reserved");
}

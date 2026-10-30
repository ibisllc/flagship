#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use flagship_updater::runtime::manifest::{parse, verify_manifest};
use flagship_updater::verify::Trust;
use serde_json::{Value, json};

const VECTORS: &str =
    include_str!("../../../../packages/protocol/test-vectors/runtime-manifest/vectors.json");

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn every_shared_vector_gets_the_typescript_verdict() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 19);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let file = json!({
            "manifest": c["manifest"],
            "signatures": c["signatures"],
            "pqBindings": c["bindings"],
            "lockJson": c["lockText"],
        });
        let trust = Trust {
            keys: strings(&c["trust"]["keys"]),
            threshold: c["trust"]["threshold"].as_u64().unwrap(),
            pq_key_ids: strings(&c["pin"]["keyIds"]),
            legacy_manifests: strings(&c["pin"]["legacyManifests"]),
        };
        let got = parse(&file.to_string()).and_then(|f| {
            verify_manifest(
                &f,
                &strings(&c["lockSigners"]),
                &trust,
                c["now"].as_u64().unwrap(),
                c["lastSequence"].as_u64(),
            )
        });
        match (c["expect"]["ok"].as_bool().unwrap(), got) {
            (true, Ok(_)) => {}
            (false, Err(e)) => assert_eq!(
                Some(e.code),
                c["expect"]["code"]
                    .as_str()
                    .map(|s| s.to_owned())
                    .as_deref()
                    .map(|s| match s {
                        "bad-manifest" => "bad-manifest",
                        "not-enough-signatures" => "not-enough-signatures",
                        "pq-signature-required" => "pq-signature-required",
                        "lock-mismatch" => "lock-mismatch",
                        "expired" => "expired",
                        "rollback" => "rollback",
                        "signer-revoked" => "signer-revoked",
                        other => panic!("unmapped code {other}"),
                    }),
                "{name}"
            ),
            (want, got) => panic!("{name}: expected ok={want}, got {got:?}"),
        }
    }
}

#[test]
fn the_canonical_bytes_equal_the_typescript_form() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let c = &v["cases"][0];
    let file = json!({"manifest": c["manifest"], "signatures": c["signatures"], "pqBindings": [], "lockJson": c["lockText"]});
    let parsed = parse(&file.to_string()).unwrap();
    assert_eq!(
        parsed.manifest.canonical().unwrap(),
        v["canonicalV1"].as_str().unwrap()
    );
}

#[test]
fn a_malformed_manifest_file_is_refused() {
    for bad in ["", "[]", "{}", r#"{"manifest":{"runtime":"bun"}}"#] {
        assert_eq!(parse(bad).unwrap_err().code, "bad-manifest", "{bad}");
    }
}

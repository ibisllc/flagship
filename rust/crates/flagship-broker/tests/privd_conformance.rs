//! The Rust broker against the shared v1 vectors (packages/privd/tests/vectors/v1-policy.json),
//! which hold the TS broker's verdict for every request in the corpus: the same refusal, code and
//! message, or the same exact command.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use flagship_broker::conformance::{trust_from_json, verdict};
use flagship_broker::podman::EngineKind;
use flagship_broker::policy::PolicyContext;
use serde_json::{Map, Value};

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/privd/tests/vectors/v1-policy.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn every_vector_gets_the_ts_verdict() {
    let v = vectors();
    let defaults = &v["defaults"];
    let default_trust = trust_from_json(&defaults["trust"]).unwrap();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() > 400);
    let mut mismatches = Vec::new();
    for c in cases {
        let pick = |k: &str| c.get(k).unwrap_or(&defaults[k]);
        let engine = EngineKind::parse(pick("engine").as_str().unwrap()).unwrap();
        let mounts_text = pick("mounts").as_str().unwrap().to_owned();
        let mounts = move || mounts_text.clone();
        let trust = c
            .get("trust")
            .map_or_else(|| default_trust.clone(), |t| trust_from_json(t).unwrap());
        let empty = Map::new();
        let args = c["args"].as_object().unwrap_or(&empty);
        let got = verdict(
            c["op"].as_str().unwrap(),
            args,
            &PolicyContext {
                engine,
                mounts: &mounts,
                trust: &trust,
                arch: pick("arch").as_str().unwrap(),
            },
        );
        if got != c["expect"] {
            mismatches.push(format!("{}: ts={} rust={got}", c["name"], c["expect"]));
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

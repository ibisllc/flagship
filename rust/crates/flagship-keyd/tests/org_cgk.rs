//! keyd adopting a rotated org CGK: the shared vectors (TS packages/keyd/tests/orgCgk.test.ts reads
//! the same file) and the `org.pin` / `cgk.orgAdopt` operations end to end.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use flagship_keyd::org_cgk::{OrgCgkPin, check_pin, verify_adoption};
use flagship_keyd::service::KeydService;
use serde_json::{Map, Value, json};
use std::path::PathBuf;

fn vectors(name: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/protocol/test-vectors")
        .join(name)
        .join("vectors.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// `$key` / `$approval` refs as org-authority/vectors.json writes them.
fn resolve(v: &Value, a: &Value) -> Value {
    match v {
        Value::Array(xs) => Value::Array(xs.iter().map(|x| resolve(x, a)).collect()),
        Value::Object(o) => {
            if let Some(Value::String(k)) = o.get("$key") {
                return a["keys"][k]["binding"].clone();
            }
            if let Some(i) = o.get("$approval").and_then(Value::as_u64) {
                return a["approvals"][usize::try_from(i).unwrap()].clone();
            }
            Value::Object(o.iter().map(|(k, x)| (k.clone(), resolve(x, a))).collect())
        }
        _ => v.clone(),
    }
}

fn chain(v: &Value, a: &Value, name: &str) -> Value {
    let c = &v["chains"][name];
    let from = c["from"].as_str().unwrap();
    let src = a["chains"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == from)
        .unwrap();
    let mut entries = resolve(&src["entries"], a).as_array().unwrap().clone();
    if let Some(n) = c.get("take").and_then(Value::as_u64) {
        entries.truncate(usize::try_from(n).unwrap());
    }
    Value::Array(entries)
}

fn args_for(v: &Value, a: &Value, case: &Value) -> Map<String, Value> {
    let mut m = case["args"].as_object().unwrap().clone();
    m.insert("chain".into(), chain(v, a, case["chain"].as_str().unwrap()));
    m
}

fn pin_for(v: &Value, case: &Value) -> OrgCgkPin {
    let mut p = v["pin"].as_object().unwrap().clone();
    if let Some(Value::Object(o)) = case.get("pin") {
        for (k, x) in o {
            p.insert(k.clone(), x.clone());
        }
    }
    check_pin(&Value::Object(p)).unwrap()
}

#[test]
fn shared_vectors() {
    let v = vectors("keyd-org-cgk");
    let a = vectors("org-authority");
    let now = v["now"].as_u64().unwrap();
    for case in v["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let got = verify_adoption(&args_for(&v, &a, case), &pin_for(&v, case), now);
        if case["expect"]["ok"] == true {
            let (key, version) = got.unwrap_or_else(|e| panic!("{name}: refused {e}"));
            assert_eq!(
                version,
                case["expect"]["version"].as_u64().unwrap(),
                "{name}"
            );
            let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(hex, case["expect"]["keyHex"].as_str().unwrap(), "{name}");
        } else {
            let e = got.err().unwrap_or_else(|| panic!("{name}: adopted"));
            assert_eq!(
                e.code,
                case["expect"]["code"].as_str().unwrap(),
                "{name}: {e}"
            );
        }
    }
}

#[test]
fn pin_then_adopt_through_the_service() {
    let v = vectors("keyd-org-cgk");
    let a = vectors("org-authority");
    let now = i64::try_from(v["now"].as_u64().unwrap()).unwrap();
    let dir = std::env::temp_dir().join(format!("keyd-org-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let token = [0x3cu8; 32];
    let mut svc = KeydService::new(
        &[0x42; 32],
        Some(zeroize::Zeroizing::new([0x11; 32])),
        Some(zeroize::Zeroizing::new([0x22; 32])),
        Some(dir.clone()),
        None,
        None,
    )
    .with_org_pin(dir.join("org.json"))
    .with_ceremony(
        zeroize::Zeroizing::new(token),
        now + 60_000,
        Box::new(move || now),
    );
    let call = |svc: &mut KeydService, op: &str, args: Value| {
        svc.handle(op, args.as_object().unwrap())
            .map(|h| Value::Object(h.result))
    };
    let ok = &v["cases"][0];
    let adopt = Value::Object(args_for(&v, &a, ok));
    let e = call(&mut svc, "cgk.orgAdopt", adopt.clone()).unwrap_err();
    assert!(e.message.contains("no org is pinned"), "{}", e.message);
    let mut pin = v["pin"].clone();
    pin["ceremony"] = json!("00".repeat(32));
    assert!(
        call(&mut svc, "org.pin", pin.clone())
            .unwrap_err()
            .message
            .contains("boot ceremony")
    );
    pin["ceremony"] = json!("3c".repeat(32));
    assert_eq!(
        call(&mut svc, "org.pin", pin.clone()).unwrap()["stored"],
        true
    );
    let mut other = pin.clone();
    other["orgId"] = json!("ab".repeat(16));
    assert!(
        call(&mut svc, "org.pin", other)
            .unwrap_err()
            .message
            .contains("already pinned")
    );
    assert_eq!(
        call(&mut svc, "cgk.orgAdopt", adopt.clone()).unwrap()["version"],
        2
    );
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("org.json")).unwrap()).unwrap();
    assert_eq!(saved["cgkVersion"], 2);
    assert_eq!(
        std::fs::read_to_string(dir.join("cgk.key")).unwrap().trim(),
        "62".repeat(32)
    );
    assert!(
        call(&mut svc, "cgk.orgAdopt", adopt)
            .unwrap_err()
            .message
            .starts_with("stale")
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

/// review-cloud: the TS twin is packages/keyd/tests/orgCgk.test.ts ("superseded authority records").
#[test]
fn review_cloud_refuses_a_ring_approved_under_a_superseded_record() {
    let v = vectors("keyd-org-cgk");
    let a = vectors("org-authority");
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/review-cloud-superseded-oar.json");
    let f: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    let mut args = f["args"].as_object().unwrap().clone();
    args.insert("chain".into(), chain(&v, &a, f["chain"].as_str().unwrap()));
    let pin = check_pin(&v["pin"]).unwrap();
    let got = verify_adoption(&args, &pin, v["now"].as_u64().unwrap());
    assert_eq!(got.err().map(|e| e.code), Some("stale-oar"));
}

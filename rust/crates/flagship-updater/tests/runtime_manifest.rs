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

#[test]
fn the_cli_verifies_a_manifest_and_refuses_a_replay_once_the_sequence_is_recorded() {
    use flagship_updater::cli::run;
    // A real lock, signed with a throwaway key, through the repository's own tool, so the file is the published form.
    let dir = std::env::temp_dir().join(format!("flagship-rtm-cli-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let key_hex = "07".repeat(32);
    std::fs::write(dir.join("key"), &key_hex).unwrap();
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");
    let tool = format!("{root}/tools/box-artifact/runtime-manifest.ts");
    let sh = |args: &[&str]| {
        let o = std::process::Command::new("npx")
            .arg("tsx")
            .arg(&tool)
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    sh(&[
        "build",
        "--sequence",
        "4",
        "--issued-at",
        &(now - 1000).to_string(),
        "--out",
        dir.join("u.json").to_str().unwrap(),
    ]);
    sh(&[
        "sign",
        "--manifest",
        dir.join("u.json").to_str().unwrap(),
        "--out",
        dir.join("s.json").to_str().unwrap(),
        "--key-file",
        dir.join("key").to_str().unwrap(),
    ]);
    let pubkey = flagship_crypto::trust::hex(
        &ed25519_dalek::SigningKey::from_bytes(&[7u8; 32])
            .verifying_key()
            .to_bytes(),
    );
    std::fs::write(
        dir.join("trust.json"),
        json!({"keys": [pubkey], "threshold": 1, "pq": {"keyIds": [], "legacyManifests": []}})
            .to_string(),
    )
    .unwrap();
    let s = |v: &[&str]| v.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
    let call = |a: Vec<String>| {
        let (mut o, mut e) = (Vec::new(), Vec::new());
        let c = run(&a, &mut o, &mut e);
        (
            c,
            String::from_utf8(o).unwrap(),
            String::from_utf8(e).unwrap(),
        )
    };
    let m = dir.join("s.json");
    let t = dir.join("trust.json");
    let st = dir.join("state");
    std::fs::create_dir_all(&st).unwrap();
    let args = s(&[
        "runtime",
        "manifest",
        "--manifest",
        m.to_str().unwrap(),
        "--trust",
        t.to_str().unwrap(),
        "--state",
        st.to_str().unwrap(),
    ]);
    let (c, out, e) = call(args.clone());
    assert_eq!(c, 0, "{e}");
    assert!(
        out.starts_with("verified: node 24.22.1 sequence 4 "),
        "{out}"
    );
    assert_eq!(
        std::fs::read_to_string(st.join("runtime-sequence"))
            .unwrap()
            .trim(),
        "4"
    );
    let (c, _, e) = call(args);
    assert_eq!((c, e.trim()), (1, "refused: rollback"));
    // far in the future the same manifest is expired (freeze resistance)
    let late = s(&[
        "runtime",
        "manifest",
        "--manifest",
        m.to_str().unwrap(),
        "--trust",
        t.to_str().unwrap(),
        "--now",
        &(now + 400 * 86_400_000).to_string(),
    ]);
    assert_eq!(call(late).2.trim(), "refused: expired");
    let _ = std::fs::remove_dir_all(&dir);
}

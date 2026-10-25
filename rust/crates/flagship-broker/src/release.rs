//! The release trust this binary was built with: the same release/*.json files
//! scripts/gen-box-release.mjs turns into the TS broker's BOX_RELEASE, so a release install the
//! Rust broker runs is checked against what the running release pins and never against anything
//! the daemon says. The binary itself is pinned by hash in the signed artifact (PINS.json).

use crate::policy::ReleaseTrust;
use serde_json::Value;

const ARTIFACT_TRUST: &str = include_str!("../../../../release/box-artifact-trust.json");
const BOX_RELEASE: &str = include_str!("../../../../release/box-release.json");
const SECURITY_FLOOR: &str = include_str!("../../../../release/security-floor.json");

fn hex_list(v: Option<&Value>) -> Result<Vec<String>, String> {
    let list = v.and_then(Value::as_array).ok_or("expected a list")?;
    list.iter()
        .map(|k| {
            k.as_str()
                .filter(|s| {
                    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
                })
                .map(str::to_owned)
                .ok_or_else(|| "a key is not 64 lowercase hex".to_owned())
        })
        .collect()
}

/// Parse the three release files (gen-box-release.mjs `load`, with its checks).
pub fn parse_trust(trust: &str, release: &str, floor: &str) -> Result<ReleaseTrust, String> {
    let t: Value = serde_json::from_str(trust).map_err(|e| e.to_string())?;
    let r: Value = serde_json::from_str(release).map_err(|e| e.to_string())?;
    let f: Value = serde_json::from_str(floor).map_err(|e| e.to_string())?;
    let threshold = t
        .get("threshold")
        .and_then(Value::as_u64)
        .filter(|n| *n >= 1)
        .ok_or("trust threshold must be >= 1")?;
    let keys = hex_list(t.get("keys"))?;
    if u64::try_from(keys.len()).unwrap_or(0) < threshold {
        return Err("fewer trust keys than the threshold".into());
    }
    let pq = t.get("pq");
    let pq_key_ids = match pq {
        Some(p) => hex_list(p.get("keyIds"))?,
        None => Vec::new(),
    };
    let legacy_manifests = match pq {
        Some(p) => hex_list(p.get("legacyManifests"))?,
        None => Vec::new(),
    };
    let min_sequence = r
        .get("sequence")
        .and_then(Value::as_u64)
        .ok_or("box-release.json sequence must be a non-negative integer")?;
    let node_floor = f
        .get("node")
        .and_then(|n| n.get("minimum"))
        .and_then(Value::as_str)
        .filter(|s| {
            let parts: Vec<&str> = s.split('.').collect();
            parts.len() == 3
                && parts
                    .iter()
                    .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        })
        .ok_or("security-floor node.minimum must be x.y.z")?
        .to_owned();
    Ok(ReleaseTrust {
        keys,
        threshold,
        node_floor,
        min_sequence,
        pq_key_ids,
        legacy_manifests,
    })
}

/// The trust compiled into this binary.
pub fn embedded_trust() -> Result<ReleaseTrust, String> {
    parse_trust(ARTIFACT_TRUST, BOX_RELEASE, SECURITY_FLOOR)
}

/// `amd64` or `arm64` for the box's own architecture (privd's `hostArch`).
pub fn host_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_trust_parses() {
        let t = embedded_trust();
        assert!(
            t.as_ref()
                .is_ok_and(|t| !t.keys.is_empty() && t.threshold >= 1),
            "{t:?}"
        );
    }

    #[test]
    fn a_damaged_trust_file_is_refused() {
        let floor = r#"{"node":{"minimum":"24.22.1"}}"#;
        let rel = r#"{"sequence":1}"#;
        assert!(parse_trust(r#"{"threshold":2,"keys":["aa"]}"#, rel, floor).is_err());
        assert!(
            parse_trust(
                &format!(r#"{{"threshold":2,"keys":["{}"]}}"#, "a".repeat(64)),
                rel,
                floor
            )
            .is_err()
        );
        assert!(
            parse_trust(
                &format!(r#"{{"threshold":1,"keys":["{}"]}}"#, "a".repeat(64)),
                rel,
                r#"{"node":{"minimum":"24"}}"#
            )
            .is_err()
        );
        let ok = parse_trust(
            &format!(
                r#"{{"threshold":1,"keys":["{k}"],"pq":{{"keyIds":["{k}"],"legacyManifests":[]}}}}"#,
                k = "b".repeat(64)
            ),
            rel,
            floor,
        );
        assert_eq!(ok.map(|t| t.pq_key_ids.len()), Ok(1));
    }
}

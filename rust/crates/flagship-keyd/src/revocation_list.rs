//! `.com`'s CA-signed list of the account's revoked device grants (TS
//! `packages/protocol/src/deviceRevocationList.ts`): the same checks in the same order, the same
//! refusal codes. keyd signs master only while it holds a list issued within [`MAX_AGE_MS`], so a
//! daemon that withholds revocations loses master for its admins instead of keeping a revoked
//! device's. The CA keys come from root (`ca-keys.json`), never from the daemon.

use std::collections::BTreeSet;

use serde_json::Value;

pub const TAG: &str = "flagship/device-revocation-list/v1";
pub const MAX_AGE_MS: i64 = 7 * 24 * 60 * 60_000;
pub const SKEW_MS: i64 = 5 * 60_000;
pub const MAX_IDS: usize = 4096;

/// `ca-keys.json` as root wrote it (TS `KeydCaKeys`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaKeys {
    pub keys: Vec<String>,
    pub valid_from: i64,
    pub valid_until: i64,
}

fn is_hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn is_grant_id(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

fn safe_int(v: Option<&Value>) -> Option<i64> {
    let n = crate::service::safe_integer(v)?;
    i64::try_from(n).ok()
}

/// TS `parseKeydCaKeys`.
pub fn parse_ca_keys(v: &Value) -> Option<CaKeys> {
    let o = v.as_object()?;
    if o.get("v").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let keys: Vec<String> = o
        .get("keys")?
        .as_array()?
        .iter()
        .map(|k| k.as_str().filter(|k| is_hex(k, 64)).map(str::to_owned))
        .collect::<Option<_>>()?;
    if keys.len() > 64 {
        return None;
    }
    let valid_from = safe_int(o.get("validFrom"))?;
    let valid_until = safe_int(o.get("validUntil"))?;
    (valid_from <= valid_until).then_some(CaKeys {
        keys,
        valid_from,
        valid_until,
    })
}

/// `ca-keys.json` read now; `None` when missing or damaged.
pub fn load_ca_keys(path: &std::path::Path) -> Option<CaKeys> {
    let text = std::fs::read_to_string(path).ok()?;
    parse_ca_keys(&serde_json::from_str(&text).ok()?)
}

/// `revocation-list.json`'s issuedAt; `None` when missing or damaged.
pub fn load_list_at(path: &std::path::Path) -> Option<i64> {
    let text = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    safe_int(v.get("issuedAt")).filter(|n| *n > 0)
}

/// TS `verifyDeviceRevocationList`: `(issuedAt, grant ids)` or the refusal code.
///
/// # Errors
/// `malformed`, `wrong-account`, `key-not-authorized`, `outside-window`, `future`, `signature`.
pub fn verify(
    wire: &Value,
    irk_hex: &str,
    ca: &CaKeys,
    now: i64,
) -> Result<(i64, Vec<String>), &'static str> {
    let o = wire.as_object().ok_or("malformed")?;
    let fields: BTreeSet<&str> = o.keys().map(String::as_str).collect();
    let want: BTreeSet<&str> = ["grantIds", "irkPubHex", "issuedAt", "keyHex", "signature"]
        .into_iter()
        .collect();
    if fields != want {
        return Err("malformed");
    }
    let irk = o
        .get("irkPubHex")
        .and_then(Value::as_str)
        .filter(|s| is_hex(s, 64))
        .ok_or("malformed")?;
    let issued_at = safe_int(o.get("issuedAt"))
        .filter(|n| *n > 0)
        .ok_or("malformed")?;
    let ids_raw = o
        .get("grantIds")
        .and_then(Value::as_array)
        .ok_or("malformed")?;
    let key_hex = o
        .get("keyHex")
        .and_then(Value::as_str)
        .filter(|s| is_hex(s, 64))
        .ok_or("malformed")?;
    let sig_hex = o
        .get("signature")
        .and_then(Value::as_str)
        .filter(|s| is_hex(s, 128))
        .ok_or("malformed")?;
    if ids_raw.len() > MAX_IDS {
        return Err("malformed");
    }
    let ids: Vec<String> = ids_raw
        .iter()
        .map(|v| v.as_str().filter(|s| is_grant_id(s)).map(str::to_owned))
        .collect::<Option<_>>()
        .ok_or("malformed")?;
    let sorted: Vec<String> = ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if sorted != ids {
        return Err("malformed");
    }
    if irk != irk_hex.to_ascii_lowercase() {
        return Err("wrong-account");
    }
    if !ca.keys.iter().any(|k| k == key_hex) {
        return Err("key-not-authorized");
    }
    if issued_at < ca.valid_from || issued_at > ca.valid_until {
        return Err("outside-window");
    }
    if issued_at > now.saturating_add(SKEW_MS) {
        return Err("future");
    }
    let msg = format!("{TAG}|{irk}|{issued_at}|{}", ids.join(","));
    let k = crate::crypto::from_hex(key_hex)
        .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
        .and_then(|b| ed25519_dalek::VerifyingKey::from_bytes(&b).ok());
    let s = crate::crypto::from_hex(sig_hex).and_then(|b| <[u8; 64]>::try_from(b.as_slice()).ok());
    let good = match (k, s) {
        (Some(k), Some(s)) => k
            .verify_strict(msg.as_bytes(), &ed25519_dalek::Signature::from_bytes(&s))
            .is_ok(),
        _ => false,
    };
    if good {
        Ok((issued_at, ids))
    } else {
        Err("signature")
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;

    #[test]
    fn lists_match_the_shared_vectors() {
        let v: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/protocol/test-vectors/device-revocation-list/vectors.json"
        )))
        .unwrap();
        let ca = parse_ca_keys(&v["caKeys"]).unwrap();
        let irk = v["irkPubHex"].as_str().unwrap();
        let now = v["now"].as_i64().unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert!(cases.len() >= 10);
        for c in cases {
            let got = match verify(&c["list"], irk, &ca, now) {
                Ok(_) => "ok",
                Err(code) => code,
            };
            assert_eq!(got, c["expect"].as_str().unwrap(), "{}", c["name"]);
        }
        let first = &cases[0]["list"];
        let ids: Vec<&str> = first["grantIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        assert_eq!(
            format!(
                "{TAG}|{irk}|{}|{}",
                first["issuedAt"].as_i64().unwrap(),
                ids.join(",")
            ),
            v["canonical"].as_str().unwrap()
        );
    }
}

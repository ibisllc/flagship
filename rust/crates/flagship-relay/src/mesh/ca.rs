//! The CA keys a mesh relay trusts now (TS `relayMeshCaKeys(chain, now)`): the minimum of `@ibisllc/maintainers` the
//! relay needs, ported. The ca-track mandates are verified FORWARD from the baked pin (`verifyMandateChainFromPin`), the
//! authority at `now` is the newest valid mandate whose window holds `now` (`currentAuthority`), and the operational CA
//! keys are those of every `CaEndorsement` lease signed by that holder and live at `now` ± 5 min (`authorizedCaKeys`).
//! An empty answer fails every CA-signed artifact closed (blessings, the directory), never a fall-back.
//!
//! Shared vectors: `packages/protocol/test-vectors/maintainer-ca/vectors.json` (`npx tsx tools/maintainer-ca-vectors.ts`,
//! produced by the TypeScript library over the committed `.maintainers/` snapshot and tampered copies).
//!
//! Differences from the TypeScript, none reachable from a ceremony-written file: timestamps must be the
//! `Date.prototype.toISOString()` form (`YYYY-MM-DDTHH:MM:SS[.sss]Z`), and hex must be lowercase.

use std::path::Path;

use flagship_crypto::entitlements::verify;
use flagship_protocol::parse::encode_lower_hex;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// `MAINTAINER_PINNED_MANDATE_HASH` (`packages/protocol/src/maintainerCa.ts`): the committed `ca` ORIGIN mandate.
pub const MAINTAINER_PINNED_MANDATE_HASH: &str =
    "5016749377de07fd3296e8207539bbe52b40fb58f971d946f4cc8990c7e801ae";
/// `DEFAULT_CLOCK_SKEW_MS` of `caEndorsement.ts`: a lease's window edges are judged ± 5 min.
pub const CA_LEASE_SKEW_MS: i64 = 5 * 60 * 1000;

/// Where a relay gets the CA keys authorized at `now`, lowercase hex.
pub trait CaKeySource: Send + Sync + 'static {
    fn keys(&self, now: u64) -> Vec<String>;
}

/// A fixed set (tests, and a harness that mints its own CA).
#[derive(Debug, Clone)]
pub struct StaticCaKeys(pub Vec<String>);

impl CaKeySource for StaticCaKeys {
    fn keys(&self, _now: u64) -> Vec<String> {
        self.0.clone()
    }
}

/// `YYYY-MM-DDTHH:MM:SS[.sss]Z` → Unix ms.
#[must_use]
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let digits = |from: usize, len: usize| -> Option<i64> {
        let part = b.get(from..from.checked_add(len)?)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    let sep = |at: usize, c: u8| b.get(at) == Some(&c);
    if !(sep(4, b'-') && sep(7, b'-') && sep(10, b'T') && sep(13, b':') && sep(16, b':')) {
        return None;
    }
    let (y, mo, d) = (digits(0, 4)?, digits(5, 2)?, digits(8, 2)?);
    let (h, mi, se) = (digits(11, 2)?, digits(14, 2)?, digits(17, 2)?);
    let ms = match b.get(19) {
        Some(b'Z') if b.len() == 20 => 0,
        Some(b'.') if b.len() == 24 && b.get(23) == Some(&b'Z') => digits(20, 3)?,
        _ => return None,
    };
    if !(1..=12).contains(&mo)
        || !(1..=31).contains(&d)
        || !(0..=23).contains(&h)
        || !(0..=59).contains(&mi)
        || !(0..=59).contains(&se)
    {
        return None;
    }
    // days_from_civil (Howard Hinnant)
    let y = if mo <= 2 { y.checked_sub(1)? } else { y };
    let era = y.div_euclid(400);
    let yoe = y.checked_sub(era.checked_mul(400)?)?;
    let mp = if mo > 2 {
        mo.checked_sub(3)?
    } else {
        mo.checked_add(9)?
    };
    let doy = mp
        .checked_mul(153)?
        .checked_add(2)?
        .checked_div(5)?
        .checked_add(d)?
        .checked_sub(1)?;
    let doe = yoe
        .checked_mul(365)?
        .checked_add(yoe / 4)?
        .checked_sub(yoe / 100)?
        .checked_add(doy)?;
    let days = era
        .checked_mul(146_097)?
        .checked_add(doe)?
        .checked_sub(719_468)?;
    days.checked_mul(86_400_000)?
        .checked_add(h.checked_mul(3_600_000)?)?
        .checked_add(mi.checked_mul(60_000)?)?
        .checked_add(se.checked_mul(1000)?)?
        .checked_add(ms)
}

fn lower_hex(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `validateField`: no `|`, no C0 control byte, no DEL.
fn field_ok(s: &str) -> bool {
    !s.chars()
        .any(|c| c == '|' || (c as u32) <= 0x1f || c as u32 == 0x7f)
}

fn str_field<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k)?.as_str()
}

fn uint_field(v: &Value, k: &str) -> Option<String> {
    let x = v.get(k)?;
    let n = x.as_u64().or_else(|| {
        let f = x.as_f64()?;
        (f.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&f)).then_some(f as u64)
    })?;
    (n <= 9_007_199_254_740_991).then(|| n.to_string())
}

/// `canonicalMandate` (`maintainers/mandate/v1|…`); `None` when the envelope is not one.
#[must_use]
pub fn mandate_canonical(m: &Value) -> Option<String> {
    if str_field(m, "kind")? != "Mandate" || m.get("version")?.as_u64()? != 1 {
        return None;
    }
    let text = |k: &str| str_field(m, k).filter(|s| field_ok(s));
    let mandate_id = text("mandateId")?;
    let track = text("track")?;
    let holder = str_field(m, "holder").filter(|h| lower_hex(h, 64))?;
    let issued_at = text("issuedAt")?;
    let expires_at = text("expiresAt")?;
    let successors: Vec<&str> = m
        .get("successors")?
        .as_array()?
        .iter()
        .map(|s| s.as_str().filter(|s| lower_hex(s, 64)))
        .collect::<Option<_>>()?;
    let rule = m.get("approvalRule")?;
    if str_field(rule, "kind")? != "threshold" {
        return None;
    }
    let threshold = uint_field(rule, "threshold")?;
    let min_succ = uint_field(m, "minSuccessors")?;
    let max_dur = uint_field(m, "maxDurationSeconds")?;
    let def_dur = uint_field(m, "defaultDurationSeconds")?;
    let project = m.get("project").filter(|p| !p.is_null());
    let pfield = |k: &str| -> Option<String> {
        match project.and_then(|p| p.get(k)) {
            None | Some(Value::Null) => Some(String::new()),
            Some(x) => x.as_str().filter(|s| field_ok(s)).map(str::to_owned),
        }
    };
    let tracks: Vec<String> = match project.and_then(|p| p.get("tracks")) {
        None | Some(Value::Null) => Vec::new(),
        Some(t) => t
            .as_array()?
            .iter()
            .map(|x| {
                x.as_str()
                    .filter(|s| field_ok(s) && !s.contains(','))
                    .map(str::to_owned)
            })
            .collect::<Option<_>>()?,
    };
    let signed_by = str_field(m, "signedBy").filter(|h| lower_hex(h, 64))?;
    Some(
        [
            "maintainers/mandate/v1".to_owned(),
            mandate_id.to_owned(),
            track.to_owned(),
            holder.to_owned(),
            issued_at.to_owned(),
            expires_at.to_owned(),
            successors.join(","),
            threshold,
            min_succ,
            max_dur,
            def_dur,
            pfield("name")?,
            pfield("contact")?,
            pfield("homepage")?,
            tracks.join(","),
            signed_by.to_owned(),
        ]
        .join("|"),
    )
}

/// `mandatePinHash`.
#[must_use]
pub fn mandate_pin_hash(m: &Value) -> Option<String> {
    Some(encode_lower_hex(&Sha256::digest(
        mandate_canonical(m)?.as_bytes(),
    )))
}

/// `canonicalCaEndorsement` (`maintainers/ca-endorsement/v1|…`).
#[must_use]
pub fn ca_endorsement_canonical(e: &Value) -> Option<String> {
    let text = |k: &str| str_field(e, k).filter(|s| field_ok(s));
    let ca_pubkey = str_field(e, "caPubkey").filter(|h| lower_hex(h, 64))?;
    let signed_by = str_field(e, "signedBy").filter(|h| lower_hex(h, 64))?;
    Some(
        [
            "maintainers/ca-endorsement/v1",
            text("endorsementId")?,
            text("track")?,
            ca_pubkey,
            text("scope")?,
            text("notBefore")?,
            text("notAfter")?,
            text("issuedAt")?,
            signed_by,
        ]
        .join("|"),
    )
}

fn sigs(v: &Value) -> Option<Vec<(String, String)>> {
    v.get("signatures")?
        .as_array()?
        .iter()
        .map(|s| {
            Some((
                str_field(s, "pubkey")?.to_owned(),
                str_field(s, "sig")?.to_owned(),
            ))
        })
        .collect()
}

fn all_signatures_valid(m: &Value) -> bool {
    let (Some(bytes), Some(list)) = (mandate_canonical(m), sigs(m)) else {
        return false;
    };
    !list.is_empty() && list.iter().all(|(p, s)| verify(&bytes, s, p))
}

/// `isMandateShape`.
fn mandate_shape(m: &Value) -> bool {
    str_field(m, "kind") == Some("Mandate")
        && m.get("version").and_then(Value::as_u64) == Some(1)
        && [
            "mandateId",
            "track",
            "holder",
            "issuedAt",
            "expiresAt",
            "signedBy",
        ]
        .iter()
        .all(|k| str_field(m, k).is_some())
        && m.get("successors").is_some_and(Value::is_array)
        && m.get("approvalRule").is_some_and(Value::is_object)
        && m.get("minSuccessors").is_some_and(Value::is_number)
        && m.get("maxDurationSeconds").is_some_and(Value::is_number)
        && m.get("signatures").is_some_and(Value::is_array)
}

fn window(m: &Value) -> Option<(i64, i64)> {
    Some((
        parse_iso_ms(str_field(m, "issuedAt")?)?,
        parse_iso_ms(str_field(m, "expiresAt")?)?,
    ))
}

/// `verifyForwardStep`: `None` when `m` follows `pred`.
fn forward_step(pred: &Value, m: &Value) -> Option<&'static str> {
    if !mandate_shape(m) {
        return Some("envelope-shape-invalid");
    }
    if str_field(m, "track") != str_field(pred, "track") {
        return Some("wrong-track");
    }
    let Some((issued, expires)) = window(m) else {
        return Some("envelope-shape-invalid");
    };
    if expires <= issued {
        return Some("expires-before-issuance");
    }
    let pred_issued = window(pred).map_or(i64::MAX, |w| w.0);
    if issued < pred_issued {
        return Some("issued-before-predecessor");
    }
    if !all_signatures_valid(m) {
        return Some("signature-invalid");
    }
    let signers: Vec<String> = sigs(m)
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.0)
        .collect();
    if !signers
        .iter()
        .any(|s| Some(s.as_str()) == str_field(m, "signedBy"))
    {
        return Some("signed-by-not-in-signatures");
    }
    let successors: Vec<&str> = pred
        .get("successors")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if signers.iter().any(|s| !successors.contains(&s.as_str())) {
        return Some("signer-not-in-successor-set");
    }
    let mut distinct: Vec<&String> = signers.iter().collect();
    distinct.sort();
    distinct.dedup();
    let rule = pred.get("approvalRule");
    let threshold = rule
        .filter(|r| str_field(r, "kind") == Some("threshold"))
        .and_then(|r| r.get("threshold"))
        .and_then(Value::as_u64)
        .filter(|t| *t >= 1);
    match threshold {
        Some(t) if distinct.len() as u64 >= t => {}
        _ => return Some("approval-threshold-unmet"),
    }
    let count = m
        .get("successors")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if (count as u64)
        < pred
            .get("minSuccessors")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX)
    {
        return Some("under-min-successors");
    }
    let max_ms = pred
        .get("maxDurationSeconds")
        .and_then(Value::as_u64)
        .and_then(|s| i64::try_from(s).ok())
        .and_then(|s| s.checked_mul(1000));
    match (max_ms, expires.checked_sub(issued)) {
        (Some(max), Some(w)) if w <= max => None,
        _ => Some("over-max-duration"),
    }
}

/// `verifyMandateChainFromPin`: the accepted chain (root first); empty when the pin is absent or not in the log.
#[must_use]
pub fn verify_mandate_chain_from_pin(pin: &str, mandates: &[Value]) -> Vec<Value> {
    if pin.is_empty() {
        return Vec::new();
    }
    let Some(root_idx) = mandates
        .iter()
        .position(|m| mandate_shape(m) && mandate_pin_hash(m).as_deref() == Some(pin))
    else {
        return Vec::new();
    };
    let Some(root) = mandates.get(root_idx) else {
        return Vec::new();
    };
    let root_ok = window(root).is_some_and(|(i, e)| e > i)
        && all_signatures_valid(root)
        && sigs(root)
            .unwrap_or_default()
            .iter()
            .any(|(p, _)| Some(p.as_str()) == str_field(root, "signedBy"));
    if !root_ok {
        return Vec::new();
    }
    let mut accepted = vec![root.clone()];
    let mut seen = vec![str_field(root, "mandateId").unwrap_or_default().to_owned()];
    for m in mandates.iter().skip(root_idx.saturating_add(1)) {
        if !mandate_shape(m) || str_field(m, "track") != str_field(root, "track") {
            continue;
        }
        let id = str_field(m, "mandateId").unwrap_or_default().to_owned();
        if seen.contains(&id) {
            continue;
        }
        let Some(pred) = accepted.last() else { break };
        if forward_step(pred, m).is_none() {
            accepted.push(m.clone());
            seen.push(id);
        }
    }
    accepted
}

/// `currentAuthority`: the holder of the newest accepted mandate whose window holds `now`.
#[must_use]
pub fn current_authority(chain: &[Value], now: i64) -> Option<String> {
    chain.iter().rev().find_map(|m| {
        let (i, e) = window(m)?;
        (i <= now && now < e).then(|| str_field(m, "holder").map(str::to_owned))?
    })
}

/// `authorizedCaKeys`: the caPubkeys of the valid leases at `now`, deduplicated in order.
#[must_use]
pub fn authorized_ca_keys(endorsements: &[Value], chain: &[Value], now: i64) -> Vec<String> {
    let authority = current_authority(chain, now);
    let mut out: Vec<String> = Vec::new();
    for e in endorsements {
        if str_field(e, "kind") != Some("CaEndorsement")
            || e.get("version").and_then(Value::as_u64) != Some(1)
        {
            continue;
        }
        let (Some(nb), Some(na)) = (
            str_field(e, "notBefore").and_then(parse_iso_ms),
            str_field(e, "notAfter").and_then(parse_iso_ms),
        ) else {
            continue;
        };
        if na <= nb
            || now < nb.saturating_sub(CA_LEASE_SKEW_MS)
            || now >= na.saturating_add(CA_LEASE_SKEW_MS)
        {
            continue;
        }
        let (Some(bytes), Some(list)) = (ca_endorsement_canonical(e), sigs(e)) else {
            continue;
        };
        if !list.iter().all(|(p, s)| verify(&bytes, s, p)) {
            continue;
        }
        let Some(holder) = authority.as_deref() else {
            continue;
        };
        let signed_by = str_field(e, "signedBy").unwrap_or_default();
        if !list.iter().any(|(p, _)| p == signed_by) || signed_by != holder {
            continue;
        }
        let key = str_field(e, "caPubkey").unwrap_or_default().to_owned();
        if !out.contains(&key) {
            out.push(key);
        }
    }
    out
}

/// A `.maintainers/` snapshot: `tracks/ca/mandates/*.json` (filename order) and `ca-endorsements/*.json` (every file
/// but `bundle.json`), verified forward from `pin`.
#[derive(Debug, Clone)]
pub struct MaintainersCa {
    chain: Vec<Value>,
    endorsements: Vec<Value>,
}

impl MaintainersCa {
    #[must_use]
    pub fn new(pin: &str, mandates: &[Value], endorsements: Vec<Value>) -> Self {
        Self {
            chain: verify_mandate_chain_from_pin(pin, mandates),
            endorsements,
        }
    }

    /// # Errors
    /// The folder cannot be read.
    pub fn load(dir: &Path, pin: &str) -> Result<Self, String> {
        let read = |sub: &Path, skip_bundle: bool| -> Result<Vec<Value>, String> {
            let mut names: Vec<std::path::PathBuf> = std::fs::read_dir(sub)
                .map_err(|e| format!("{}: {e}", sub.display()))?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|x| x == "json"))
                .filter(|p| !(skip_bundle && p.file_name().is_some_and(|f| f == "bundle.json")))
                .collect();
            names.sort();
            Ok(names
                .iter()
                .filter_map(|p| std::fs::read_to_string(p).ok())
                .filter_map(|t| serde_json::from_str(&t).ok())
                .collect())
        };
        let mandates = read(&dir.join("tracks/ca/mandates"), false)?;
        let endorsements = read(&dir.join("ca-endorsements"), true)?;
        Ok(Self::new(pin, &mandates, endorsements))
    }

    #[must_use]
    pub fn chain_len(&self) -> usize {
        self.chain.len()
    }
}

impl CaKeySource for MaintainersCa {
    fn keys(&self, now: u64) -> Vec<String> {
        authorized_ca_keys(
            &self.endorsements,
            &self.chain,
            i64::try_from(now).unwrap_or(i64::MAX),
        )
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
mod tests {
    use super::*;

    const VECTORS: &str =
        include_str!("../../../../../packages/protocol/test-vectors/maintainer-ca/vectors.json");

    #[test]
    fn iso_dates_parse_like_date_parse() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_iso_ms("2026-10-19T01:36:06.489Z"),
            Some(1_792_373_766_489)
        );
        assert_eq!(parse_iso_ms("2000-02-29T12:00:00Z"), Some(951_825_600_000));
        for bad in [
            "",
            "2026-10-19",
            "2026-13-01T00:00:00Z",
            "2026-10-19T01:36:06.48Z",
            "x026-10-19T01:36:06Z",
        ] {
            assert_eq!(parse_iso_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_typescript_library_and_this_port_agree() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        for c in v["pinHashes"].as_array().unwrap() {
            assert_eq!(
                mandate_pin_hash(&c["mandate"]),
                c["pinHash"].as_str().map(str::to_owned),
                "{}",
                c["name"]
            );
        }
        for c in v["cases"].as_array().unwrap() {
            let mandates = c["mandates"].as_array().unwrap().clone();
            let endorsements = c["endorsements"].as_array().unwrap().clone();
            let ca = MaintainersCa::new(c["pin"].as_str().unwrap(), &mandates, endorsements);
            assert_eq!(
                ca.chain_len() as u64,
                c["chainLength"].as_u64().unwrap(),
                "{}",
                c["name"]
            );
            for at in c["at"].as_array().unwrap() {
                let want: Vec<String> = at["keys"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|k| k.as_str().unwrap().to_owned())
                    .collect();
                assert_eq!(
                    ca.keys(at["now"].as_u64().unwrap()),
                    want,
                    "{} at {}",
                    c["name"],
                    at["now"]
                );
            }
        }
    }

    #[test]
    fn the_committed_snapshot_authorizes_the_live_ca_key() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.maintainers");
        let ca = MaintainersCa::load(&dir, MAINTAINER_PINNED_MANDATE_HASH).unwrap();
        assert!(ca.chain_len() >= 1);
        let keys = ca.keys(1_793_491_200_000);
        assert_eq!(
            keys,
            vec!["230ad9ed20e56d79e836690e351cb5538fb4aca9e509d9adc9755da81cd235cc".to_owned()]
        );
        assert!(
            MaintainersCa::load(&dir, &"00".repeat(32))
                .unwrap()
                .keys(1_793_491_200_000)
                .is_empty()
        );
    }
}

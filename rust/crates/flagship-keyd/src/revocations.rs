//! What keyd keeps of the owner's revocations and rank orders (`revocations.json`), the port of
//! `noteRevocation` / `HeldRevocations` in `packages/protocol/src/identityAssertion.ts`: same
//! refusal codes in the same order, and the same file bytes.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde_json::{Map, Value};

/// `MASTER_EVIDENCE_SKEW_MS`: a statement dated further ahead than this is refused.
pub const SKEW_MS: i64 = 5 * 60_000;
pub const MAX_GRANTS: usize = 4096;
pub const MAX_KEYS: usize = 4096;
pub const MAX_RANKS: usize = 16384;

const REVOKE_TAG: &str = "flagship/revoke-device-capability-grant/v1";
const GRANT_TAG: &str = "flagship/device-capability-grant/v2";
const RANK_TAG: &str = "flagship/app-rank/v1";

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct HeldRevocations {
    pub grants: BTreeSet<String>,
    pub keys: BTreeSet<String>,
    /// `<appId>|<target>` → (issuedAt, rank) of the latest order keyd holds.
    pub ranks: BTreeMap<String, (u64, String)>,
}

/// One owner-signed statement handed to `evidence.note` (TS `RevocationNote`).
#[derive(Debug, Clone, Copy)]
pub struct Note<'a> {
    pub statement: &'a str,
    pub signature_hex: &'a str,
    pub grant_statement: Option<&'a str>,
    pub grant_signature_hex: Option<&'a str>,
}

fn is_hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn is_grant_id(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

fn is_label(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// `RANK_TARGET`: `device:<hex64>`, `aid:<hex64>`, `share:<hex32>`, `invite:<label>`, `grant:<label>/<hex64>`.
fn is_rank_target(t: &str) -> bool {
    if let Some(k) = t.strip_prefix("device:").or_else(|| t.strip_prefix("aid:")) {
        return is_hex(k, 64);
    }
    if let Some(k) = t.strip_prefix("share:") {
        return is_hex(k, 32);
    }
    if let Some(k) = t.strip_prefix("invite:") {
        return is_label(k);
    }
    if let Some(k) = t.strip_prefix("grant:") {
        return k
            .rsplit_once('/')
            .is_some_and(|(id, aid)| is_label(id) && is_hex(aid, 64));
    }
    false
}

fn is_field(s: &str) -> bool {
    (1..=128).contains(&s.len()) && s.bytes().all(|c| (0x21..=0x7e).contains(&c))
}

fn later_than_skew(at: u64, now: i64) -> bool {
    i64::try_from(at).map_or(true, |a| a > now.saturating_add(SKEW_MS))
}

impl HeldRevocations {
    pub fn grant_revoked(&self, grant_id: &str) -> bool {
        self.grants.contains(grant_id)
    }

    pub fn key_revoked(&self, key: &str) -> bool {
        self.keys.contains(key)
    }

    pub fn latest(&self, app: &str, target: &str) -> Option<&(u64, String)> {
        self.ranks.get(&format!("{app}|{target}"))
    }

    /// TS `loadHeld` on parsed JSON: `None` when the shape is damaged.
    pub fn from_value(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        let strs = |x: Option<&Value>| -> Option<BTreeSet<String>> {
            match x {
                None => Some(BTreeSet::new()),
                Some(Value::Array(a)) => a.iter().map(|y| y.as_str().map(str::to_owned)).collect(),
                Some(_) => None,
            }
        };
        let grants = strs(o.get("grants"))?;
        let keys = strs(o.get("keys"))?;
        let mut ranks = BTreeMap::new();
        match o.get("ranks") {
            None => {}
            Some(Value::Object(m)) => {
                for (k, r) in m {
                    let at = crate::service::safe_integer(r.get("issuedAt"))?;
                    let rank = r.get("rank")?.as_str()?;
                    ranks.insert(k.clone(), (at, rank.to_owned()));
                }
            }
            Some(_) => return None,
        }
        Some(Self {
            grants,
            keys,
            ranks,
        })
    }

    /// `revocations.json` in keyd's state: empty when missing, `None` when unreadable.
    pub fn load(path: Option<&Path>) -> Option<Self> {
        let Some(p) = path else {
            return Some(Self::default());
        };
        match std::fs::read_to_string(p) {
            Ok(text) => serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| Self::from_value(&v)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(Self::default()),
            Err(_) => None,
        }
    }

    /// The stored form, byte for byte what TS `JSON.stringify(held)` writes.
    pub fn to_json(&self) -> String {
        let list =
            |s: &BTreeSet<String>| Value::Array(s.iter().cloned().map(Value::String).collect());
        let mut ranks = Map::new();
        for (k, (at, rank)) in &self.ranks {
            let mut r = Map::new();
            r.insert("issuedAt".into(), Value::from(*at));
            r.insert("rank".into(), Value::String(rank.clone()));
            ranks.insert(k.clone(), Value::Object(r));
        }
        let mut o = Map::new();
        o.insert("grants".into(), list(&self.grants));
        o.insert("keys".into(), list(&self.keys));
        o.insert("ranks".into(), Value::Object(ranks));
        Value::Object(o).to_string()
    }

    /// TS `noteRevocation`: the new state and whether it changed, or why not.
    ///
    /// # Errors
    /// The refusal code, the same as TS.
    pub fn note(
        &self,
        n: &Note<'_>,
        irk_pub_hex: &str,
        admin_root_pub_hex: Option<&str>,
        now: i64,
        verify: &dyn Fn(&str, &[u8], &str) -> bool,
    ) -> Result<(Self, bool), &'static str> {
        let st = n.statement;
        if crate::wire::js_len(st) > 4096 || !is_hex(n.signature_hex, 128) {
            return Err("bad-statement");
        }
        let with_grant = n.grant_statement.is_some() || n.grant_signature_hex.is_some();
        if with_grant {
            match (n.grant_statement, n.grant_signature_hex) {
                (Some(g), Some(s)) if crate::wire::js_len(g) <= 4096 && is_hex(s, 128) => {}
                _ => return Err("bad-statement"),
            }
        }
        let root = admin_root_pub_hex.filter(|r| is_hex(r, 64));
        let mut out = self.clone();
        let p: Vec<&str> = st.split('|').collect();
        let part = |i: usize| p.get(i).copied().unwrap_or_default();
        match part(0) {
            REVOKE_TAG => {
                let at = crate::policy::canonical_decimal(part(4));
                if p.len() != 5
                    || !is_grant_id(part(1))
                    || part(2).is_empty()
                    || !matches!(part(3), "lost" | "stolen" | "decommissioned" | "replaced")
                    || at.is_none()
                {
                    return Err("bad-statement");
                }
                if at.is_some_and(|a| later_than_skew(a, now)) {
                    return Err("future");
                }
                let Some(root) = root else {
                    return Err("no-admin-root");
                };
                if !verify(n.signature_hex, st.as_bytes(), root) {
                    return Err("bad-signature");
                }
                let mut key = None;
                if let (Some(gs), Some(gsig)) = (n.grant_statement, n.grant_signature_hex) {
                    let g: Vec<&str> = gs.split('|').collect();
                    let gp = |i: usize| g.get(i).copied().unwrap_or_default();
                    if gp(0) != GRANT_TAG || g.len() != 8 || !is_hex(gp(4), 64) {
                        return Err("bad-statement");
                    }
                    if gp(1) != part(1) {
                        return Err("wrong-grant");
                    }
                    if !verify(gsig, gs.as_bytes(), root)
                        && !verify(gsig, gs.as_bytes(), irk_pub_hex)
                    {
                        return Err("bad-signature");
                    }
                    key = Some(gp(4));
                }
                let new_grant = !out.grants.contains(part(1));
                let new_key = key.is_some_and(|k| !out.keys.contains(k));
                if (new_grant && out.grants.len() >= MAX_GRANTS)
                    || (new_key && out.keys.len() >= MAX_KEYS)
                {
                    return Err("full");
                }
                out.grants.insert(part(1).to_owned());
                if let Some(k) = key {
                    out.keys.insert(k.to_owned());
                }
                Ok((out, new_grant || new_key))
            }
            RANK_TAG => {
                let at = crate::policy::canonical_decimal(part(4));
                if p.len() != 5
                    || !is_field(part(1))
                    || !is_rank_target(part(2))
                    || !matches!(part(3), "member" | "manager" | "master" | "refused")
                    || at.is_none()
                {
                    return Err("bad-statement");
                }
                let at = at.unwrap_or_default();
                if later_than_skew(at, now) {
                    return Err("future");
                }
                if !verify(n.signature_hex, st.as_bytes(), root.unwrap_or(irk_pub_hex)) {
                    return Err("bad-signature");
                }
                let k = format!("{}|{}", part(1), part(2));
                if let Some((cur_at, cur_rank)) = out.ranks.get(&k)
                    && (*cur_at > at
                        || (*cur_at == at && (cur_rank != "master" || part(3) == "master")))
                {
                    return Ok((out, false));
                }
                if !out.ranks.contains_key(&k) && out.ranks.len() >= MAX_RANKS {
                    return Err("full");
                }
                out.ranks.insert(k, (at, part(3).to_owned()));
                Ok((out, true))
            }
            _ => Err("bad-statement"),
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;

    fn held_of(v: &Value) -> HeldRevocations {
        HeldRevocations::from_value(v).unwrap()
    }

    #[test]
    fn notes_match_the_shared_vectors() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/protocol/test-vectors/identity-assertion/master-evidence.json"
        ))
        .unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        let now = v["now"].as_i64().unwrap();
        let verify = |sig: &str, m: &[u8], pk: &str| -> bool {
            let Some(k) = crate::crypto::from_hex(pk).and_then(|b| <[u8; 32]>::try_from(b).ok())
            else {
                return false;
            };
            let Some(g) = crate::crypto::from_hex(sig).and_then(|b| <[u8; 64]>::try_from(b).ok())
            else {
                return false;
            };
            ed25519_dalek::VerifyingKey::from_bytes(&k).is_ok_and(|k| {
                k.verify_strict(m, &ed25519_dalek::Signature::from_bytes(&g))
                    .is_ok()
            })
        };
        let notes = v["notes"].as_array().unwrap();
        assert!(notes.len() > 15);
        for c in notes {
            let name = c["name"].as_str().unwrap();
            let held = held_of(&c["held"]);
            let n = &c["note"];
            let note = Note {
                statement: n["statement"].as_str().unwrap(),
                signature_hex: n["signatureHex"].as_str().unwrap(),
                grant_statement: n["grantStatement"].as_str(),
                grant_signature_hex: n["grantSignatureHex"].as_str(),
            };
            let got = held.note(
                &note,
                c["anchors"]["irkPubHex"].as_str().unwrap(),
                c["anchors"]["adminRootPubHex"].as_str(),
                now,
                &verify,
            );
            let want = c["expect"].as_str().unwrap();
            match got {
                Err(code) => assert_eq!(code, want, "{name}"),
                Ok((after, changed)) => {
                    assert_eq!("ok", want, "{name}");
                    assert_eq!(Some(changed), c["changed"].as_bool(), "{name}");
                    assert_eq!(after.to_json(), c["heldAfter"].to_string(), "{name}");
                }
            }
        }
    }

    #[test]
    fn a_damaged_file_is_none_and_a_missing_one_is_empty() {
        let dir = std::env::temp_dir().join(format!("keyd-held-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("revocations.json");
        let _ = std::fs::remove_file(&p);
        assert_eq!(
            HeldRevocations::load(Some(&p)),
            Some(HeldRevocations::default())
        );
        std::fs::write(&p, "{not json").unwrap();
        assert_eq!(HeldRevocations::load(Some(&p)), None);
        std::fs::write(&p, r#"{"grants":[1]}"#).unwrap();
        assert_eq!(HeldRevocations::load(Some(&p)), None);
        std::fs::write(&p, r#"{"ranks":{"a|b":{"issuedAt":-1,"rank":"x"}}}"#).unwrap();
        assert_eq!(HeldRevocations::load(Some(&p)), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

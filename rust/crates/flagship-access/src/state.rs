//! The access state file, as `ServiceAccessStore.load` reads it (serviceAccess.ts).

use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// A rank on Flagship's ladder, lowest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Rank {
    Member,
    Manager,
    Master,
}

impl Rank {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Member => "member",
            Self::Manager => "manager",
            Self::Master => "master",
        }
    }

    /// `ladderRole`: older names map onto the ladder (`owner` reads as master), anything else is none.
    #[must_use]
    pub fn ladder(s: Option<&str>) -> Option<Self> {
        match s? {
            "member" | "viewer" => Some(Self::Member),
            "manager" | "editor" => Some(Self::Manager),
            "master" | "admin" | "owner" => Some(Self::Master),
            _ => None,
        }
    }
}

/// An admin's override of an account person in one app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountRank {
    Rank(Rank),
    Refused,
}

impl AccountRank {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "refused" => Some(Self::Refused),
            "member" => Some(Self::Rank(Rank::Member)),
            "manager" => Some(Self::Rank(Rank::Manager)),
            "master" => Some(Self::Rank(Rank::Master)),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Roles {
    pub aids: BTreeMap<String, String>,
    pub invites: BTreeMap<String, String>,
    pub grants: BTreeMap<String, String>,
    pub tiers: BTreeMap<String, String>,
    pub ranks: BTreeMap<String, AccountRank>,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub restricted: bool,
    pub allow: Vec<String>,
    pub groups: BTreeMap<String, Vec<String>>,
    pub roles: Roles,
}

#[derive(Debug, Clone, Default)]
pub struct AccessState {
    /// The mode of an app with no row: members-only once the file was lost or is unreadable.
    pub default_restricted: bool,
    /// The file was present but unreadable: every app is members-only until an admin opens it.
    pub failed_closed: bool,
    pub services: BTreeMap<String, Entry>,
}

fn is_lower_hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn str_map(v: Option<&Value>) -> BTreeMap<String, String> {
    v.and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, x)| x.as_str().map(|s| (k.clone(), s.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

fn rank_key_ok(k: &str) -> bool {
    k.strip_prefix("device:")
        .is_some_and(|h| is_lower_hex(h, 64))
        || k.strip_prefix("share:")
            .is_some_and(|h| is_lower_hex(h, 32))
}

fn read_roles(v: Option<&Value>) -> Roles {
    let Some(r) = v.and_then(Value::as_object) else {
        return Roles::default();
    };
    Roles {
        aids: str_map(r.get("aids")),
        invites: str_map(r.get("invites")),
        grants: str_map(r.get("grants")),
        tiers: str_map(r.get("tiers")),
        ranks: str_map(r.get("ranks"))
            .into_iter()
            .filter(|(k, _)| rank_key_ok(k))
            .filter_map(|(k, v)| AccountRank::parse(&v).map(|r| (k, r)))
            .collect(),
    }
}

/// Lower-cased strings of an array, first occurrence kept (a JS `Set` over the mapped values).
fn lower_set(v: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in v
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let l = s.to_lowercase();
        if !out.contains(&l) {
            out.push(l);
        }
    }
    out
}

fn read_entry(e: &Map<String, Value>) -> Option<Entry> {
    let restricted = match e.get("mode").and_then(Value::as_str)? {
        "open" => false,
        "restricted" => true,
        _ => return None,
    };
    let groups = e
        .get("groups")
        .and_then(Value::as_object)
        .map(|g| {
            g.iter()
                .filter(|(_, m)| m.is_array())
                .map(|(id, m)| (id.clone(), lower_set(Some(m))))
                .collect()
        })
        .unwrap_or_default();
    Some(Entry {
        restricted,
        allow: lower_set(e.get("allow")),
        groups,
        roles: read_roles(e.get("roles")),
    })
}

impl AccessState {
    /// The state from the file's text; `None` when the file does not exist (the normal empty case).
    #[must_use]
    pub fn parse(text: Option<&str>) -> Self {
        let Some(text) = text else {
            return Self::default();
        };
        let Some(raw) = serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|v| v.as_object().cloned())
        else {
            return Self {
                default_restricted: true,
                failed_closed: true,
                services: BTreeMap::new(),
            };
        };
        let default_restricted = raw
            .get("*")
            .and_then(|r| r.get("mode"))
            .and_then(Value::as_str)
            == Some("restricted");
        let services = raw
            .iter()
            .filter(|(k, _)| k.as_str() != "*")
            .filter_map(|(k, v)| Some((k.clone(), read_entry(v.as_object()?)?)))
            .collect();
        Self {
            default_restricted,
            failed_closed: false,
            services,
        }
    }

    /// Members-only (`restricted`) or open.
    #[must_use]
    pub fn restricted(&self, service_ref: &str) -> bool {
        self.services
            .get(service_ref)
            .map_or(self.default_restricted, |e| e.restricted)
    }
}

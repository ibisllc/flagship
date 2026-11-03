//! The access journal's pure rules, the Rust twin of `packages/server-daemon/src/accessJournal.ts`
//! (docs/service-access-gating.md, "One list per app"): the signed entries that changed an app's
//! access, one kept per key, whichever box hands them over.
//!
//! Every entry carries its own proof, so this module never trusts the box that supplied it: it
//! only shapes, keys, orders and hashes entries. Verifying the signatures is the authority
//! contract's job (R4), done before an entry reaches [`AccessJournal::add`]. Applying is
//! idempotent and "latest order wins" per target, so arrival order does not matter.
//!
//! In memory and sans-IO: the caller persists [`AccessJournal::to_json`] durably. The shared
//! vectors (`packages/server-daemon/test-vectors/access-journal.json`) pin the same verdicts in
//! TypeScript and Rust.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Entries kept per app, at most.
pub const JOURNAL_CAP: usize = 20_000;
/// Other servers remembered per app, at most.
pub const PEER_CAP: usize = 64;

/// A shape-checked entry (the JSON it came as, unchanged: its signatures are verified elsewhere).
#[derive(Debug, Clone, PartialEq)]
pub struct AccessEntry(Value);

impl AccessEntry {
    pub fn as_json(&self) -> &Value {
        &self.0
    }

    fn kind(&self) -> &str {
        self.0.get("kind").and_then(Value::as_str).unwrap_or("")
    }
}

/// JavaScript's `String(value)` for the shapes an invite id can take.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_string(Some(x))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

fn is_sig(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str)
        .is_some_and(|s| s.len() == 128 && s.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn obj(v: Option<&Value>) -> Option<&Map<String, Value>> {
    v.and_then(Value::as_object)
}

fn is_str(v: Option<&Value>) -> bool {
    v.is_some_and(Value::is_string)
}

fn is_num(v: Option<&Value>) -> bool {
    v.is_some_and(Value::is_number)
}

/// Shape-check an untrusted entry (no signature check: the applier verifies).
pub fn parse_entry(v: &Value) -> Option<AccessEntry> {
    let r = v.as_object()?;
    let ok = match r.get("kind").and_then(Value::as_str)? {
        kind @ ("rank" | "mode" | "remove") => {
            let o = obj(r.get("order"))?;
            if !is_sig(r.get("signature"))
                || !is_str(o.get("serviceRef"))
                || !is_num(o.get("issuedAt"))
            {
                return None;
            }
            match kind {
                "rank" => is_str(o.get("target")) && is_str(o.get("rank")),
                "mode" => matches!(
                    o.get("mode").and_then(Value::as_str),
                    Some("open" | "restricted")
                ),
                _ => is_str(o.get("aid")),
            }
        }
        "join" => {
            let d = obj(r.get("redeem"));
            obj(r.get("create")).is_some()
                && is_sig(r.get("createSig"))
                && d.is_some_and(|d| {
                    is_str(d.get("secretHash"))
                        && is_str(d.get("visitorAID"))
                        && is_num(d.get("redeemedAt"))
                        && is_sig(d.get("aidSig"))
                })
        }
        "accept" => {
            let a = obj(r.get("accept"));
            obj(r.get("create")).is_some()
                && is_sig(r.get("createSig"))
                && is_sig(r.get("acceptSig"))
                && a.is_some_and(|a| {
                    is_str(a.get("inviteId"))
                        && is_str(a.get("serviceRef"))
                        && is_str(a.get("contactAID"))
                        && is_num(a.get("acceptedAt"))
                })
        }
        "withdraw" => {
            obj(r.get("revoke"))
                .is_some_and(|rv| is_str(rv.get("inviteId")) && is_num(rv.get("issuedAt")))
                && is_sig(r.get("signature"))
        }
        "share" => {
            let g = obj(r.get("grant"));
            if !g.is_some_and(|g| is_str(g.get("shareId")) && is_num(g.get("issuedAt")))
                || !is_sig(r.get("signature"))
            {
                return None;
            }
            match r.get("end") {
                None => true,
                Some(end) => {
                    let e = obj(Some(end))?;
                    is_sig(e.get("signature"))
                        && match e.get("kind").and_then(Value::as_str) {
                            Some("revoke") => obj(e.get("revoke")).is_some(),
                            Some("leave") => obj(e.get("leave")).is_some(),
                            _ => false,
                        }
                }
            }
        }
        _ => false,
    };
    ok.then(|| AccessEntry(v.clone()))
}

/// Which entry an entry supersedes (one per key).
pub fn entry_key(e: &AccessEntry) -> String {
    let v = &e.0;
    let field = |outer: &str, inner: &str| v.get(outer).and_then(|o| o.get(inner));
    match e.kind() {
        "rank" => format!("rank:{}", js_string(field("order", "target"))),
        "mode" => "mode".to_string(),
        "remove" => format!("remove:{}", js_string(field("order", "aid"))),
        "join" => format!(
            "join:{}/{}",
            js_string(field("create", "inviteId")),
            js_string(field("redeem", "visitorAID")).to_lowercase()
        ),
        "accept" => format!(
            "join:{}/{}",
            js_string(field("accept", "inviteId")),
            js_string(field("accept", "contactAID")).to_lowercase()
        ),
        "withdraw" => format!("withdraw:{}", js_string(field("revoke", "inviteId"))),
        "share" => format!("share:{}", js_string(field("grant", "shareId"))),
        _ => String::new(),
    }
}

/// The time that orders entries under one key (later wins for orders; first wins for joins and withdraws).
fn entry_time(e: &AccessEntry) -> f64 {
    let field = |outer: &str, inner: &str| {
        e.0.get(outer)
            .and_then(|o| o.get(inner))
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN)
    };
    match e.kind() {
        "rank" | "mode" | "remove" => field("order", "issuedAt"),
        "join" => field("redeem", "redeemedAt"),
        "accept" => field("accept", "acceptedAt"),
        "withdraw" => field("revoke", "issuedAt"),
        "share" => field("grant", "issuedAt"),
        _ => f64::NAN,
    }
}

fn latest_wins(e: &AccessEntry) -> bool {
    matches!(e.kind(), "rank" | "mode" | "remove")
}

fn has_end(e: &AccessEntry) -> bool {
    e.0.get("end").is_some()
}

/// Whether `e` replaces `prev` under the same key. A share's end is final; otherwise the newer grant.
pub fn supersedes(e: &AccessEntry, prev: &AccessEntry) -> bool {
    if e.kind() == "share" && prev.kind() == "share" {
        if has_end(prev) {
            return false;
        }
        if has_end(e) {
            return true;
        }
        return entry_time(e) > entry_time(prev);
    }
    latest_wins(e) && entry_time(e) > entry_time(prev)
}

/// JSON with sorted keys, as `stableJson` in the TypeScript twin writes it.
fn stable_json(v: &Value, out: &mut String) {
    match v {
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                stable_json(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            let sorted: BTreeMap<&String, &Value> = o.iter().collect();
            for (i, (k, x)) in sorted.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(k.clone()).to_string());
                out.push(':');
                stable_json(x, out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

fn sha256_hex(text: &str) -> String {
    let d = Sha256::digest(text.as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn entry_hash(e: &AccessEntry) -> String {
    let mut s = String::new();
    stable_json(&e.0, &mut s);
    sha256_hex(&s)
}

#[derive(Debug, Default, Clone, PartialEq)]
struct AppJournal {
    entries: BTreeMap<String, AccessEntry>,
    /// Other servers seen running this app (so a restart knows to catch up first).
    peers: Vec<String>,
}

#[derive(Debug, Default)]
pub struct AccessJournal {
    by_app: BTreeMap<String, AppJournal>,
    lost: bool,
}

impl AccessJournal {
    pub fn new() -> Self {
        Self::default()
    }

    /// True when the last load found the journal unreadable: which apps other servers run is unknown, so
    /// every shared app waits for its list from them before letting invited people or co-managers in.
    pub fn was_lost(&self) -> bool {
        self.lost
    }

    /// Load what the caller read from disk. `None` is a missing file (an empty journal); text that is not
    /// a journal empties it and marks it lost.
    pub fn load(&mut self, text: Option<&str>) {
        self.lost = false;
        self.by_app.clear();
        let Some(text) = text else { return };
        let parsed: Option<Value> = serde_json::from_str(text).ok();
        let Some(Value::Object(raw)) = parsed else {
            self.lost = true;
            return;
        };
        for (app, j) in raw {
            let mut entries = BTreeMap::new();
            if let Some(es) = j.get("entries").and_then(Value::as_object) {
                for v in es.values() {
                    if let Some(e) = parse_entry(v) {
                        entries.insert(entry_key(&e), e);
                    }
                }
            }
            let peers = j
                .get("peers")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|p| p.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            self.by_app.insert(app, AppJournal { entries, peers });
        }
    }

    /// The text to write durably.
    pub fn to_json(&self) -> String {
        let mut root = Map::new();
        for (app, j) in &self.by_app {
            let mut o = Map::new();
            o.insert(
                "entries".into(),
                Value::Object(
                    j.entries
                        .iter()
                        .map(|(k, e)| (k.clone(), e.0.clone()))
                        .collect(),
                ),
            );
            o.insert(
                "peers".into(),
                Value::Array(j.peers.iter().cloned().map(Value::String).collect()),
            );
            root.insert(app.clone(), Value::Object(o));
        }
        Value::Object(root).to_string()
    }

    /// Keep an entry; returns whether it is new (or newer than the one it supersedes). A join or withdraw
    /// already held under its key is kept as is.
    pub fn add(&mut self, service_ref: &str, e: AccessEntry) -> bool {
        let key = entry_key(&e);
        let j = self.by_app.entry(service_ref.to_string()).or_default();
        if let Some(prev) = j.entries.get(&key) {
            if entry_hash(prev) == entry_hash(&e) || !supersedes(&e, prev) {
                return false;
            }
        } else if j.entries.len() >= JOURNAL_CAP {
            return false;
        }
        j.entries.insert(key, e);
        true
    }

    pub fn entries(&self, service_ref: &str) -> Vec<&AccessEntry> {
        self.by_app
            .get(service_ref)
            .map(|j| j.entries.values().collect())
            .unwrap_or_default()
    }

    pub fn keys(&self, service_ref: &str) -> Vec<&str> {
        self.by_app
            .get(service_ref)
            .map(|j| j.entries.keys().map(String::as_str).collect())
            .unwrap_or_default()
    }

    /// A short fingerprint of an app's entries: equal on two boxes exactly when they hold the same entries.
    pub fn digest(&self, service_ref: &str) -> String {
        let mut lines: Vec<String> = self
            .by_app
            .get(service_ref)
            .map(|j| {
                j.entries
                    .iter()
                    .map(|(k, e)| format!("{k}={}", entry_hash(e)))
                    .collect()
            })
            .unwrap_or_default();
        lines.sort();
        sha256_hex(&lines.join("\n"))
    }

    pub fn peers(&self, service_ref: &str) -> Vec<String> {
        self.by_app
            .get(service_ref)
            .map(|j| j.peers.clone())
            .unwrap_or_default()
    }

    /// Remember the other servers running an app (union; capped). Returns whether anything changed.
    pub fn note_peers(&mut self, service_ref: &str, fqdns: &[&str]) -> bool {
        if fqdns.is_empty() {
            return false;
        }
        let j = self.by_app.entry(service_ref.to_string()).or_default();
        let mut seen: BTreeSet<String> = j.peers.iter().cloned().collect();
        let mut next = j.peers.clone();
        for f in fqdns {
            let f = f.to_lowercase();
            if seen.insert(f.clone()) {
                next.push(f);
            }
        }
        next.truncate(PEER_CAP);
        if next.len() == j.peers.len() {
            return false;
        }
        j.peers = next;
        true
    }

    pub fn apps(&self) -> Vec<&str> {
        self.by_app.keys().map(String::as_str).collect()
    }

    pub fn forget(&mut self, service_ref: &str) -> bool {
        self.by_app.remove(service_ref).is_some()
    }
}

//! The box's per-app access state (`flagship-access/service-access.json`): mode, allow-list, grants, ranks,
//! withdraws and co-manager records, and every write to it. The Rust twin of `ServiceAccessStore`'s state and
//! mutations in `packages/server-daemon/src/serviceAccess.ts`; the same file shape, read and written the same way.
//!
//! In memory and sans-IO: the server reads the file, applies one change and writes the result durably. The
//! shared vectors (`packages/server-daemon/test-vectors/access-writes.json`) hold the TypeScript store's state
//! after every step, and this one must reach the same.

use serde_json::{Map, Number, Value, json};
use std::collections::BTreeMap;

/// Allow-list size cap per app.
pub const ALLOW_LIST_CAP: usize = 5000;
const DEFAULT_ROW: &str = "*";

fn lower_hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `ladderRole`.
#[must_use]
pub fn ladder_role(s: Option<&str>) -> Option<&'static str> {
    match s? {
        "member" | "viewer" => Some("member"),
        "manager" | "editor" => Some("manager"),
        "master" | "admin" | "owner" => Some("master"),
        _ => None,
    }
}

fn rank_index(r: &str) -> usize {
    match r {
        "master" => 2,
        "manager" => 1,
        _ => 0,
    }
}

fn higher(a: Option<&'static str>, b: &'static str) -> &'static str {
    match a {
        Some(a) if rank_index(a) >= rank_index(b) => a,
        _ => b,
    }
}

/// `cappedTier`.
#[must_use]
pub fn capped_tier(t: Option<&str>) -> bool {
    matches!(t, Some("member" | "co-manager"))
}

fn account_rank_ok(v: &str) -> bool {
    matches!(v, "refused" | "member" | "manager" | "master")
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoManagerRecord {
    pub pub_hex: String,
    pub level: String,
    pub label: String,
    pub server_domain: String,
    pub issued_at: Number,
    pub ended: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Roles {
    pub aids: BTreeMap<String, String>,
    pub invites: BTreeMap<String, String>,
    pub grants: BTreeMap<String, String>,
    pub seq: BTreeMap<String, Number>,
    pub tiers: BTreeMap<String, String>,
    pub creators: BTreeMap<String, String>,
    pub ranks: BTreeMap<String, String>,
    pub evidence: BTreeMap<String, String>,
    pub withdrawn: BTreeMap<String, String>,
    pub co_managers: BTreeMap<String, CoManagerRecord>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub restricted: bool,
    pub allow: Vec<String>,
    /// Insertion order kept (a JS object's own keys), so iteration matches TypeScript.
    pub groups: Vec<(String, Vec<String>)>,
    pub roles: Roles,
}

impl Row {
    fn new(restricted: bool) -> Self {
        Self {
            restricted,
            allow: Vec::new(),
            groups: Vec::new(),
            roles: Roles::default(),
        }
    }

    #[must_use]
    pub fn group(&self, id: &str) -> Option<&Vec<String>> {
        self.groups.iter().find(|(g, _)| g == id).map(|(_, m)| m)
    }

    fn group_mut(&mut self, id: &str) -> &mut Vec<String> {
        if let Some(i) = self.groups.iter().position(|(g, _)| g == id) {
            #[allow(clippy::indexing_slicing)]
            return &mut self.groups[i].1;
        }
        self.groups.push((id.to_owned(), Vec::new()));
        #[allow(clippy::unwrap_used)]
        &mut self.groups.last_mut().unwrap().1
    }

    fn remove_group(&mut self, id: &str) -> Option<Vec<String>> {
        let i = self.groups.iter().position(|(g, _)| g == id)?;
        Some(self.groups.remove(i).1)
    }

    /// The invites a member joined through (their grants), in the groups' order.
    #[must_use]
    pub fn grants_of(&self, aid: &str) -> Vec<String> {
        self.groups
            .iter()
            .filter(|(_, m)| m.iter().any(|x| x == aid))
            .map(|(g, _)| g.clone())
            .collect()
    }
}

/// The whole state file.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Store {
    pub default_restricted: bool,
    /// Insertion order kept, as the TypeScript `Map`.
    pub rows: Vec<(String, Row)>,
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

fn read_roles(v: Option<&Value>) -> Roles {
    let Some(r) = v.filter(|v| v.is_object()) else {
        return Roles::default();
    };
    let mut out = Roles {
        aids: str_map(r.get("aids")),
        invites: str_map(r.get("invites")),
        grants: str_map(r.get("grants")),
        tiers: str_map(r.get("tiers")),
        creators: str_map(r.get("creators")),
        ranks: str_map(r.get("ranks")),
        evidence: str_map(r.get("evidence")),
        withdrawn: str_map(r.get("withdrawn")),
        ..Roles::default()
    };
    if let Some(m) = r.get("coManagers").and_then(Value::as_object) {
        for (id, o) in m {
            if !lower_hex(id, 32) || !o.is_object() {
                continue;
            }
            let Some(pub_hex) = o
                .get("pub")
                .and_then(Value::as_str)
                .filter(|p| lower_hex(p, 64))
            else {
                continue;
            };
            let Some(level) = o
                .get("level")
                .and_then(Value::as_str)
                .filter(|l| matches!(*l, "view" | "manage"))
            else {
                continue;
            };
            let (Some(sd), Some(Value::Number(at))) = (
                o.get("serverDomain").and_then(Value::as_str),
                o.get("issuedAt"),
            ) else {
                continue;
            };
            out.co_managers.insert(
                id.clone(),
                CoManagerRecord {
                    pub_hex: pub_hex.to_owned(),
                    level: level.to_owned(),
                    label: o
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    server_domain: sd.to_owned(),
                    issued_at: at.clone(),
                    ended: o.get("ended").and_then(Value::as_bool) == Some(true),
                },
            );
        }
    }
    out.creators.retain(|_, v| lower_hex(v, 64));
    out.evidence.retain(|_, v| {
        v.len() <= 4400
            && v.get(..128).is_some_and(|s| lower_hex(s, 128))
            && v.get(128..)
                .is_some_and(|s| s.starts_with(":flagship/app-rank/v1|"))
    });
    out.withdrawn.retain(|_, v| {
        v.split_once(':').is_some_and(|(n, s)| {
            !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && lower_hex(s, 128)
        })
    });
    out.ranks.retain(|k, v| {
        let key_ok = k.strip_prefix("device:").is_some_and(|h| lower_hex(h, 64))
            || k.strip_prefix("share:").is_some_and(|h| lower_hex(h, 32));
        key_ok && account_rank_ok(v)
    });
    if let Some(m) = r.get("seq").and_then(Value::as_object) {
        for (k, x) in m {
            if let Value::Number(n) = x {
                out.seq.insert(k.clone(), n.clone());
            }
        }
    }
    out
}

/// Lower-cased strings of an array, first occurrence kept.
fn lower_unique(v: Option<&Value>) -> Vec<String> {
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

fn num_f64(n: &Number) -> f64 {
    n.as_f64().unwrap_or(f64::NAN)
}

fn num(at: u64) -> Number {
    Number::from(at)
}

fn roles_json(r: &Roles) -> Value {
    let m = |b: &BTreeMap<String, String>| {
        Value::Object(
            b.iter()
                .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                .collect(),
        )
    };
    json!({
        "aids": m(&r.aids),
        "invites": m(&r.invites),
        "grants": m(&r.grants),
        "seq": Value::Object(r.seq.iter().map(|(k, v)| (k.clone(), Value::Number(v.clone()))).collect()),
        "tiers": m(&r.tiers),
        "creators": m(&r.creators),
        "ranks": m(&r.ranks),
        "evidence": m(&r.evidence),
        "withdrawn": m(&r.withdrawn),
        "coManagers": Value::Object(r.co_managers.iter().map(|(k, c)| (k.clone(), json!({
            "pub": c.pub_hex, "level": c.level, "label": c.label, "serverDomain": c.server_domain,
            "issuedAt": Value::Number(c.issued_at.clone()), "ended": c.ended,
        }))).collect()),
    })
}

/// Why the state file could not be read: the caller refuses the change (fail closed), never writes over it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unreadable;

impl Store {
    /// The state from the file's text (`None`: no file yet, the empty open state). Text that is not a JSON object
    /// is [`Unreadable`] (`ServiceAccessStore.load` keeps such a file aside and writes the members-only default).
    ///
    /// # Errors
    /// The text is not an access-state object.
    pub fn parse(text: Option<&str>) -> Result<Self, Unreadable> {
        let Some(text) = text else {
            return Ok(Self::default());
        };
        let raw = serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .ok_or(Unreadable)?;
        Ok(Self::from_map(&raw))
    }

    fn from_map(raw: &Map<String, Value>) -> Self {
        let default_restricted = raw
            .get(DEFAULT_ROW)
            .and_then(|r| r.get("mode"))
            .and_then(Value::as_str)
            == Some("restricted");
        let mut rows = Vec::new();
        for (k, e) in raw {
            if k == DEFAULT_ROW {
                continue;
            }
            let restricted = match e.get("mode").and_then(Value::as_str) {
                Some("open") => false,
                Some("restricted") => true,
                _ => continue,
            };
            let groups = e
                .get("groups")
                .and_then(Value::as_object)
                .map(|g| {
                    g.iter()
                        .filter(|(_, m)| m.is_array())
                        .map(|(id, m)| (id.clone(), lower_unique(Some(m))))
                        .collect()
                })
                .unwrap_or_default();
            rows.push((
                k.clone(),
                Row {
                    restricted,
                    allow: lower_unique(e.get("allow")),
                    groups,
                    roles: read_roles(e.get("roles")),
                },
            ));
        }
        Self {
            default_restricted,
            rows,
        }
    }

    /// The file's text (`snapshot`).
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        if self.default_restricted {
            out.insert(
                DEFAULT_ROW.into(),
                json!({ "mode": "restricted", "allow": [], "groups": {} }),
            );
        }
        for (k, r) in &self.rows {
            out.insert(
                k.clone(),
                json!({
                    "mode": if r.restricted { "restricted" } else { "open" },
                    "allow": r.allow,
                    "groups": Value::Object(r.groups.iter().map(|(g, m)| (g.clone(), json!(m))).collect()),
                    "roles": roles_json(&r.roles),
                }),
            );
        }
        Value::Object(out)
    }

    #[must_use]
    pub fn row(&self, r: &str) -> Option<&Row> {
        self.rows.iter().find(|(k, _)| k == r).map(|(_, e)| e)
    }

    fn row_mut(&mut self, r: &str) -> Option<&mut Row> {
        self.rows.iter_mut().find(|(k, _)| k == r).map(|(_, e)| e)
    }

    /// `entry()`: the app's row, made (with the default mode) when it has none.
    pub fn entry(&mut self, r: &str) -> &mut Row {
        if let Some(i) = self.rows.iter().position(|(k, _)| k == r) {
            #[allow(clippy::indexing_slicing)]
            return &mut self.rows[i].1;
        }
        self.rows
            .push((r.to_owned(), Row::new(self.default_restricted)));
        #[allow(clippy::unwrap_used)]
        &mut self.rows.last_mut().unwrap().1
    }

    #[must_use]
    pub fn restricted(&self, r: &str) -> bool {
        self.row(r)
            .map_or(self.default_restricted, |e| e.restricted)
    }

    pub fn forget(&mut self, r: &str) -> bool {
        let before = self.rows.len();
        self.rows.retain(|(k, _)| k != r);
        self.rows.len() != before
    }

    pub fn set_mode(&mut self, r: &str, restricted: bool) {
        self.entry(r).restricted = restricted;
    }

    /// `"ok"` or `"stale"`.
    pub fn apply_mode_order(&mut self, r: &str, restricted: bool, at: u64) -> &'static str {
        let e = self.entry(r);
        if e.roles
            .seq
            .get("mode")
            .is_some_and(|l| at as f64 <= num_f64(l))
        {
            return "stale";
        }
        e.roles.seq.insert("mode".into(), num(at));
        e.restricted = restricted;
        "ok"
    }

    /// `"removed"`, `"absent"` or `"stale"`.
    pub fn apply_remove_order(&mut self, r: &str, aid: &str, at: u64) -> &'static str {
        let aid = aid.to_lowercase();
        let key = format!("remove:{aid}");
        let e = self.entry(r);
        if e.roles
            .seq
            .get(&key)
            .is_some_and(|l| at as f64 <= num_f64(l))
        {
            return "stale";
        }
        e.roles.seq.insert(key, num(at));
        if self.remove_allowed(r, &aid) {
            "removed"
        } else {
            "absent"
        }
    }

    /// Whether the AID was newly added (false also at the cap).
    pub fn add_allowed(&mut self, r: &str, aid: &str, invite_id: Option<&str>) -> bool {
        let aid = aid.to_lowercase();
        let e = self.entry(r);
        let already = e.allow.contains(&aid);
        if !already && e.allow.len() >= ALLOW_LIST_CAP {
            return false;
        }
        if !already {
            e.allow.push(aid.clone());
        }
        if let Some(id) = invite_id.filter(|i| !i.is_empty()) {
            let g = e.group_mut(id);
            if !g.contains(&aid) {
                g.push(aid);
            }
        }
        !already
    }

    pub fn remove_allowed(&mut self, r: &str, aid: &str) -> bool {
        let aid = aid.to_lowercase();
        let Some(e) = self.row_mut(r) else {
            return false;
        };
        let before = e.allow.len();
        e.allow.retain(|x| *x != aid);
        for (_, m) in &mut e.groups {
            m.retain(|x| *x != aid);
        }
        e.groups.retain(|(_, m)| !m.is_empty());
        e.roles.aids.remove(&aid);
        let suffix = format!("/{aid}");
        e.roles.grants.retain(|k, _| !k.ends_with(&suffix));
        e.allow.len() != before
    }

    /// The number of people pruned.
    pub fn revoke_group(&mut self, invite_id: &str, r: Option<&str>) -> usize {
        let mut pruned = 0usize;
        for (k, e) in &mut self.rows {
            if r.is_some_and(|r| r != k) {
                continue;
            }
            if e.group(invite_id).is_none_or(Vec::is_empty) {
                continue;
            }
            let members = e.remove_group(invite_id).unwrap_or_default();
            e.roles.invites.remove(invite_id);
            e.roles.tiers.remove(invite_id);
            e.roles.creators.remove(invite_id);
            let prefix = format!("{invite_id}/");
            e.roles.grants.retain(|k, _| !k.starts_with(&prefix));
            for aid in members {
                if !e.grants_of(&aid).is_empty() {
                    continue;
                }
                let before = e.allow.len();
                e.allow.retain(|x| *x != aid);
                if e.allow.len() != before {
                    pruned = pruned.saturating_add(1);
                }
                e.roles.aids.remove(&aid);
            }
        }
        pruned
    }

    pub fn note_withdrawn(&mut self, r: &str, invite_id: &str, at: u64, sig: &str) {
        let e = self.entry(r);
        if e.roles
            .withdrawn
            .get(invite_id)
            .is_some_and(|v| !v.is_empty())
        {
            return;
        }
        e.roles
            .withdrawn
            .insert(invite_id.to_owned(), format!("{at}:{}", sig.to_lowercase()));
    }

    /// `withdrawn`: the held withdraw's time and signature (unverified).
    #[must_use]
    pub fn withdrawn(&self, r: &str, invite_id: &str) -> Option<(u64, String)> {
        let v = self.row(r)?.roles.withdrawn.get(invite_id)?;
        let (n, s) = v.split_once(':')?;
        if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) || !lower_hex(s, 128) {
            return None;
        }
        // `Number("…")` of a long digit run: beyond u64 it is never a signed time.
        Some((n.parse().ok()?, s.to_owned()))
    }

    #[must_use]
    pub fn bound_through(&self, r: &str, invite_id: &str) -> usize {
        self.row(r)
            .and_then(|e| e.group(invite_id))
            .map_or(0, Vec::len)
    }

    #[must_use]
    pub fn removed_after(&self, r: &str, aid: &str, at: u64) -> bool {
        self.row(r)
            .and_then(|e| e.roles.seq.get(&format!("remove:{}", aid.to_lowercase())))
            .is_some_and(|l| num_f64(l) >= at as f64)
    }

    #[must_use]
    pub fn services_with_invite(&self, invite_id: &str) -> Vec<String> {
        self.rows
            .iter()
            .filter(|(_, e)| {
                e.group(invite_id).is_some()
                    || e.roles.creators.contains_key(invite_id)
                    || e.roles.tiers.contains_key(invite_id)
            })
            .map(|(k, _)| k.clone())
            .collect()
    }

    #[must_use]
    pub fn grants(&self, r: &str, aid: &str) -> Vec<String> {
        self.row(r)
            .map(|e| e.grants_of(&aid.to_lowercase()))
            .unwrap_or_default()
    }

    pub fn set_invite_tier(&mut self, r: &str, invite_id: &str, tier: &str) {
        let e = self.entry(r);
        let was = e.roles.tiers.get(invite_id).map(String::as_str);
        if was == Some(tier) || capped_tier(was) {
            return;
        }
        e.roles.tiers.insert(invite_id.to_owned(), tier.to_owned());
    }

    #[must_use]
    pub fn invite_tier(&self, r: &str, invite_id: &str) -> Option<&str> {
        self.row(r)?
            .roles
            .tiers
            .get(invite_id)
            .map(String::as_str)
            .filter(|t| matches!(*t, "admin" | "member" | "co-manager"))
    }

    pub fn set_invite_creator(&mut self, r: &str, invite_id: &str, pub_hex: &str) {
        let e = self.entry(r);
        if e.roles
            .creators
            .get(invite_id)
            .is_some_and(|v| !v.is_empty())
        {
            return;
        }
        e.roles
            .creators
            .insert(invite_id.to_owned(), pub_hex.to_lowercase());
    }

    #[must_use]
    pub fn invite_creator(&self, r: &str, invite_id: &str) -> Option<&str> {
        self.row(r)?
            .roles
            .creators
            .get(invite_id)
            .map(String::as_str)
    }

    fn unset_rank(e: Option<&Row>, invite_id: &str, default_role: &str) -> &'static str {
        if e.and_then(|e| e.roles.tiers.get(invite_id))
            .map(String::as_str)
            == Some("admin")
        {
            return ladder_role(Some(default_role)).unwrap_or("member");
        }
        "member"
    }

    /// `roleOf`: an admin order on the person, else the highest of their grants; `None` when none was set.
    #[must_use]
    pub fn role_of(&self, r: &str, aid: &str, default_role: &str) -> Option<&'static str> {
        let e = self.row(r)?;
        let aid = aid.to_lowercase();
        if let Some(d) = ladder_role(e.roles.aids.get(&aid).map(String::as_str)) {
            return Some(d);
        }
        let mut best: Option<&'static str> = None;
        let mut any_set = false;
        for id in e.grants_of(&aid) {
            let set = ladder_role(
                e.roles
                    .grants
                    .get(&format!("{id}/{aid}"))
                    .map(String::as_str),
            )
            .or_else(|| ladder_role(e.roles.invites.get(&id).map(String::as_str)));
            let tier = e.roles.tiers.get(&id).map(String::as_str);
            if set.is_some() || capped_tier(tier) || tier == Some("admin") {
                any_set = true;
            }
            best = Some(higher(
                best,
                set.unwrap_or_else(|| Self::unset_rank(Some(e), &id, default_role)),
            ));
        }
        if any_set { best } else { None }
    }

    pub fn remove_if_ungranted(&mut self, r: &str, aid: &str) -> bool {
        let Some(e) = self.row(r) else { return false };
        if !e.grants_of(&aid.to_lowercase()).is_empty() {
            return false;
        }
        self.remove_allowed(r, aid)
    }

    /// `setRole` for an invited target (`aid`, `invite`, `grant`): `"ok"` or `"stale"`.
    pub fn set_role(
        &mut self,
        r: &str,
        target: &RoleTarget,
        target_key: &str,
        role: &str,
        at: u64,
        evidence: Option<&str>,
    ) -> &'static str {
        let e = self.entry(r);
        if e.roles
            .seq
            .get(target_key)
            .is_some_and(|l| at as f64 <= num_f64(l))
        {
            return "stale";
        }
        e.roles.seq.insert(target_key.to_owned(), num(at));
        match evidence.filter(|v| !v.is_empty()) {
            Some(v) if role == "master" => {
                e.roles.evidence.insert(target_key.to_owned(), v.to_owned());
            }
            _ => {
                e.roles.evidence.remove(target_key);
            }
        }
        match target {
            RoleTarget::Aid(aid) => {
                e.roles.aids.insert(aid.clone(), role.to_owned());
            }
            RoleTarget::Invite(id) => {
                e.roles.invites.insert(id.clone(), role.to_owned());
            }
            RoleTarget::Grant(id, aid) => {
                e.roles
                    .grants
                    .insert(format!("{id}/{aid}"), role.to_owned());
            }
        }
        "ok"
    }

    /// `"applied"`, `"unchanged"` or `"stale"`.
    pub fn note_co_manager(
        &mut self,
        r: &str,
        share_id: &str,
        rec: CoManagerRecord,
    ) -> &'static str {
        let e = self.entry(r);
        if let Some(prev) = e.roles.co_managers.get(share_id) {
            if prev.ended {
                return if rec.ended { "unchanged" } else { "stale" };
            }
            if prev.pub_hex != rec.pub_hex {
                return "stale";
            }
            let (a, b) = (num_f64(&rec.issued_at), num_f64(&prev.issued_at));
            if !rec.ended && a <= b {
                return if (a - b).abs() < f64::EPSILON {
                    "unchanged"
                } else {
                    "stale"
                };
            }
        }
        let rec = CoManagerRecord {
            pub_hex: rec.pub_hex.to_lowercase(),
            server_domain: rec.server_domain.to_lowercase(),
            ..rec
        };
        e.roles.co_managers.insert(share_id.to_owned(), rec);
        "applied"
    }

    /// `coManagerRecord`: the journal's record of the co-manager holding `pub_hex` in an app.
    #[must_use]
    pub fn co_manager_record(&self, r: &str, pub_hex: &str) -> Option<(String, &CoManagerRecord)> {
        let p = pub_hex.to_lowercase();
        self.row(r)?
            .roles
            .co_managers
            .iter()
            .find(|(_, c)| c.pub_hex == p)
            .map(|(k, c)| (k.clone(), c))
    }

    /// `"ok"` or `"stale"`.
    pub fn set_account_rank(
        &mut self,
        r: &str,
        target_key: &str,
        rank: &str,
        at: u64,
        evidence: Option<&str>,
    ) -> &'static str {
        let e = self.entry(r);
        if e.roles
            .seq
            .get(target_key)
            .is_some_and(|l| at as f64 <= num_f64(l))
        {
            return "stale";
        }
        e.roles.seq.insert(target_key.to_owned(), num(at));
        e.roles.ranks.insert(target_key.to_owned(), rank.to_owned());
        match evidence.filter(|v| !v.is_empty()) {
            Some(v) if rank == "master" => {
                e.roles.evidence.insert(target_key.to_owned(), v.to_owned());
            }
            _ => {
                e.roles.evidence.remove(target_key);
            }
        }
        "ok"
    }

    /// `importEntry`: a copied app's mode, allow-list, groups and roles, replacing this box's.
    pub fn import_entry(&mut self, r: &str, v: &Value) {
        let mut allow: Vec<String> = Vec::new();
        for a in v
            .get("allow")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let a = a.to_lowercase();
            if lower_hex(&a, 64) && !allow.contains(&a) {
                allow.push(a);
            }
        }
        allow.truncate(ALLOW_LIST_CAP);
        let mut groups: Vec<(String, Vec<String>)> = Vec::new();
        for (id, aids) in v
            .get("groups")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            let kept: Vec<String> = aids
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_lowercase)
                .filter(|a| allow.contains(a))
                .collect();
            if !kept.is_empty() {
                groups.push((id.clone(), kept));
            }
        }
        let mut roles = read_roles(v.get("roles"));
        roles.aids.retain(|a, _| allow.contains(a));
        roles.grants.retain(|k, _| {
            let mut parts = k.split('/');
            let (id, aid) = (
                parts.next().unwrap_or_default(),
                parts.next().unwrap_or_default(),
            );
            groups
                .iter()
                .any(|(g, m)| g == id && m.iter().any(|x| x == aid))
        });
        let row = Row {
            restricted: v.get("mode").and_then(Value::as_str) == Some("restricted"),
            allow,
            groups,
            roles,
        };
        match self.row_mut(r) {
            Some(e) => *e = row,
            None => self.rows.push((r.to_owned(), row)),
        }
    }
}

/// An invited target of a rank order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoleTarget {
    Aid(String),
    Invite(String),
    Grant(String, String),
}

/// Two states are the same file (key order aside; numbers by value).
#[must_use]
pub fn same_state(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same_state(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| same_state(v, w)))
        }
        _ => a == b,
    }
}

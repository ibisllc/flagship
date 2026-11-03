//! Applying a handed-over access-journal entry (docs/service-access-gating.md "One list per app"): the Rust twin of
//! `applyEntry` (+ `joinFromPeer`, `bindJoin`, `withdrawnHere`, `creatorRefusal`) in `serviceAccess.ts`, the
//! withdraw verifier (`buildInviteWithdrawVerifier`) and the rank applier (`buildRankEntryApplier` in
//! `memberRoles.ts`). The proof is verified here against the people this box verified ([`People`]); the result and
//! the state after it match the TypeScript store's on the shared vectors (`test-vectors/access-writes.json`).

use crate::access_entry::{
    EntryTrust, InviteTier, Verdict, Verified, VerifiedCreate, verify_entry,
};
use crate::access_journal::AccessEntry;
use crate::people::{People, Person, Tier};
use crate::store::{CoManagerRecord, RoleTarget, Store, ladder_role};
use flagship_crypto::access_orders::{
    AppRankOrder, AppRankTarget, app_rank_canonical, parse_app_rank_target, verify_app_rank,
};
use flagship_crypto::service_invite::{RevokeServiceInvite, verify_revoke as verify_invite_revoke};
use serde_json::{Number, Value};

/// What applying a handed-over entry did (`EntryResult`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryResult {
    Applied,
    Unchanged,
    Stale,
    Refused,
    Skipped,
}

impl EntryResult {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Unchanged => "unchanged",
            Self::Stale => "stale",
            Self::Refused => "refused",
            Self::Skipped => "skipped",
        }
    }
}

/// The box facts an application reads besides the state and the people.
#[derive(Debug, Clone, Copy)]
pub struct Facts<'a> {
    pub installed: bool,
    /// Apps whose list is being caught up after a restart (invited people and co-managers wait).
    pub catching_up: &'a [String],
    pub now_ms: u64,
}

/// The access questions over the state, the people and the catch-up hold (`ServiceAccessStore`'s readers).
#[derive(Debug, Clone, Copy)]
pub struct View<'a> {
    pub store: &'a Store,
    pub people: &'a People,
    pub catching_up: &'a [String],
}

fn lower_hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn rank_key(p: &Person) -> String {
    match p {
        Person::Device { pub_hex, .. } => format!("device:{pub_hex}"),
        Person::CoManager(c) => format!("share:{}", c.share_id),
    }
}

impl View<'_> {
    fn catching(&self, r: &str) -> bool {
        self.catching_up.iter().any(|x| x == r)
    }

    /// `accountRank`: `None` when refused (or a co-manager while the list catches up).
    #[must_use]
    pub fn account_rank(&self, r: &str, p: &Person) -> Option<&'static str> {
        let set = self
            .store
            .row(r)
            .and_then(|e| e.roles.ranks.get(&rank_key(p)))
            .map(String::as_str);
        if set == Some("refused") {
            return None;
        }
        if matches!(p, Person::CoManager(_)) && self.catching(r) {
            return None;
        }
        if let Some(s) = ladder_role(set).filter(|_| set.is_some_and(|s| s != "refused")) {
            return Some(s);
        }
        Some(match p {
            Person::Device {
                tier: Tier::Admin, ..
            } => "master",
            _ => "manager",
        })
    }

    /// `isAllowed`.
    #[must_use]
    pub fn is_allowed(&self, r: &str, key: &str) -> bool {
        let k = key.to_lowercase();
        if let Some(p) = self.people.classify(&k) {
            return self.account_rank(r, &p).is_some();
        }
        if self.catching(r) {
            return false;
        }
        self.store.row(r).is_some_and(|e| e.allow.contains(&k))
    }

    /// `coManagerKeys`: this server's co-managers, then the journal's records of other servers' still standing.
    #[must_use]
    pub fn co_manager_keys(&self, r: &str) -> Vec<String> {
        let mut out: Vec<String> = self
            .people
            .co_managers
            .iter()
            .map(|c| c.pub_hex.clone())
            .collect();
        if let Some(e) = self.store.row(r) {
            for c in e.roles.co_managers.values() {
                if c.ended
                    || c.server_domain == self.people.anchors.server_domain
                    || out.contains(&c.pub_hex)
                {
                    continue;
                }
                out.push(c.pub_hex.clone());
            }
        }
        out
    }

    /// `coManagerInviteStanding(...).ok`.
    #[must_use]
    pub fn co_manager_may_invite(&self, r: &str, pub_hex: &str) -> bool {
        let p = pub_hex.to_lowercase();
        let (share_id, level) = match self.people.classify(&p) {
            Some(Person::CoManager(c)) => (c.share_id, c.level),
            Some(_) => return false,
            None => match self.store.co_manager_record(r, &p) {
                Some((id, c))
                    if !c.ended && c.server_domain != self.people.anchors.server_domain =>
                {
                    (id, c.level.clone())
                }
                _ => return false,
            },
        };
        if level != "manage" || self.catching(r) {
            return false;
        }
        let set = self
            .store
            .row(r)
            .and_then(|e| e.roles.ranks.get(&format!("share:{share_id}")))
            .map(String::as_str);
        !matches!(set, Some("refused" | "member"))
    }

    /// The signers this box takes for an invite create in an app (`verifyComCreate`'s candidates), and the admins.
    #[must_use]
    pub fn entry_trust(&self, r: &str, installed: bool, now_ms: u64, strict: bool) -> EntryTrust {
        let a = &self.people.anchors;
        let mut create: Vec<(String, InviteTier)> = Vec::new();
        if let Some(root) = &a.admin_root_hex {
            create.push((root.clone(), InviteTier::Admin));
        }
        for d in &self.people.devices {
            let tier = if a.pinned() && d.tier == Tier::Member {
                InviteTier::Member
            } else {
                InviteTier::Admin
            };
            create.push((d.pub_hex.clone(), tier));
        }
        if !a.pinned() {
            if let Some(aid) = &a.owner_aid_hex {
                create.push((aid.clone(), InviteTier::Admin));
            }
            create.push((a.owner_irk_hex.clone(), InviteTier::Admin));
        }
        for k in self.co_manager_keys(r) {
            create.push((k, InviteTier::CoManager));
        }
        let admin_signers = if strict {
            Vec::new()
        } else {
            let t = self.people.admin_trust(now_ms);
            let mut s: Vec<String> = Vec::new();
            match &t.admin_root_hex {
                None => s.push(t.owner_irk_hex.clone()),
                Some(root) => {
                    s.push(root.clone());
                    for d in &self.people.devices {
                        if d.tier == Tier::Admin
                            && self
                                .people
                                .admin_signed_at(|k| k == d.pub_hex, now_ms, false)
                        {
                            s.push(d.pub_hex.clone());
                        }
                    }
                }
            }
            s
        };
        EntryTrust {
            admin_signers,
            create_signers: create,
            installed: if installed {
                vec![r.to_owned()]
            } else {
                Vec::new()
            },
        }
    }
}

/// `withdrawAdminSigned`: an admin's withdraw (or, on a box with no admin root, the owner AID's).
fn withdraw_admin_signed(
    people: &People,
    rv: &RevokeServiceInvite,
    sig: &str,
    now_ms: u64,
) -> bool {
    people.admin_signed_at(
        |k| verify_invite_revoke(rv, sig, k),
        now_ms,
        people.anchors.strict,
    ) || (!people.anchors.pinned()
        && people
            .anchors
            .owner_aid_hex
            .as_deref()
            .is_some_and(|aid| verify_invite_revoke(rv, sig, aid)))
}

/// `buildInviteWithdrawVerifier`: the apps a signed withdraw may prune.
fn withdraw_refs(v: &View<'_>, rv: &RevokeServiceInvite, sig: &str, now_ms: u64) -> Vec<String> {
    let refs = v.store.services_with_invite(&rv.invite_id);
    if refs.is_empty() {
        return refs;
    }
    if withdraw_admin_signed(v.people, rv, sig, now_ms) {
        return refs;
    }
    refs.into_iter()
        .filter(|r| {
            let tier = v.store.invite_tier(r, &rv.invite_id);
            if !matches!(tier, Some("member" | "co-manager")) {
                return false;
            }
            let Some(creator) = v.store.invite_creator(r, &rv.invite_id) else {
                return false;
            };
            if !verify_invite_revoke(rv, sig, creator) {
                return false;
            }
            if tier == Some("co-manager") {
                return v.co_manager_may_invite(r, creator);
            }
            v.people
                .classify(creator)
                .and_then(|p| v.account_rank(r, &p))
                .is_some_and(|k| k != "member")
        })
        .collect()
}

fn tier_str(t: InviteTier) -> &'static str {
    match t {
        InviteTier::Admin => "admin",
        InviteTier::Member => "member",
        InviteTier::CoManager => "co-manager",
    }
}

/// `joinFromPeer` + `bindJoin`.
fn join(
    store: &mut Store,
    people: &People,
    f: &Facts<'_>,
    r: &str,
    c: &VerifiedCreate,
    aid: &str,
    at: u64,
) -> EntryResult {
    if store.grants(r, aid).contains(&c.invite_id) {
        return EntryResult::Unchanged;
    }
    if c.expires_at.is_some_and(|e| at > e) {
        return EntryResult::Refused;
    }
    let cap = c.max_redemptions.unwrap_or(1);
    if cap > 0 && u64::try_from(store.bound_through(r, &c.invite_id)).unwrap_or(u64::MAX) >= cap {
        return EntryResult::Refused;
    }
    if store.removed_after(r, aid, at) {
        return EntryResult::Stale;
    }
    // withdrawnHere
    if let Some((issued_at, sig)) = store.withdrawn(r, &c.invite_id) {
        let rv = RevokeServiceInvite {
            invite_id: c.invite_id.clone(),
            issued_at,
        };
        if withdraw_admin_signed(people, &rv, &sig, f.now_ms)
            || verify_invite_revoke(&rv, &sig, &c.creator_pub)
        {
            return EntryResult::Refused;
        }
    }
    // creatorRefusal
    if c.tier != InviteTier::Admin {
        let view = View {
            store: &*store,
            people,
            catching_up: f.catching_up,
        };
        let recorded = store
            .invite_creator(r, &c.invite_id)
            .unwrap_or(&c.creator_pub)
            .to_owned();
        let ok = if c.tier == InviteTier::CoManager {
            view.co_manager_may_invite(r, &recorded)
        } else {
            people
                .classify(&recorded)
                .and_then(|p| view.account_rank(r, &p))
                .is_some_and(|k| k != "member")
        };
        if !ok {
            return EntryResult::Refused;
        }
    }
    store.set_invite_tier(r, &c.invite_id, tier_str(c.tier));
    store.set_invite_creator(r, &c.invite_id, &c.creator_pub);
    let added = store.add_allowed(r, aid, Some(&c.invite_id));
    let view = View {
        store: &*store,
        people,
        catching_up: f.catching_up,
    };
    if !added && !view.is_allowed(r, aid) {
        return EntryResult::Refused;
    }
    EntryResult::Applied
}

/// The rank applier (`buildRankEntryApplier`): an admin-signed `flagship/app-rank/v1` order for an installed app.
fn apply_rank(
    store: &mut Store,
    people: &People,
    f: &Facts<'_>,
    r: &str,
    e: &Value,
) -> EntryResult {
    let Some(o) = e.get("order") else {
        return EntryResult::Refused;
    };
    let (Some(sr), Some(target), Some(rank), Some(at)) = (
        o.get("serviceRef").and_then(Value::as_str),
        o.get("target").and_then(Value::as_str),
        o.get("rank").and_then(Value::as_str),
        o.get("issuedAt").and_then(Value::as_u64),
    ) else {
        return EntryResult::Refused;
    };
    let order = AppRankOrder {
        service_ref: sr.to_owned(),
        target: target.to_owned(),
        rank: rank.to_owned(),
        issued_at: at,
    };
    let Ok(canonical) = app_rank_canonical(&order) else {
        return EntryResult::Refused;
    };
    let sig = e
        .get("signature")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if sr != r || !f.installed || !lower_hex(&sig.to_ascii_lowercase(), 128) {
        return EntryResult::Refused;
    }
    if !people.admin_signed_at(
        |k| verify_app_rank(&order, sig, k),
        f.now_ms,
        people.anchors.strict,
    ) {
        return EntryResult::Refused;
    }
    let evidence = format!("{}:{canonical}", sig.to_ascii_lowercase());
    let stale_or_applied = |s: &str| {
        if s == "stale" {
            EntryResult::Stale
        } else {
            EntryResult::Applied
        }
    };
    match parse_app_rank_target(target) {
        Some(AppRankTarget::Device { pub_hex }) => match people.classify(&pub_hex) {
            Some(p @ Person::Device { .. }) => stale_or_applied(store.set_account_rank(
                r,
                &rank_key(&p),
                rank,
                at,
                Some(&evidence),
            )),
            _ => EntryResult::Refused,
        },
        Some(AppRankTarget::Share { .. }) => {
            stale_or_applied(store.set_account_rank(r, target, rank, at, Some(&evidence)))
        }
        Some(t) => {
            let Some(role) =
                ladder_role(Some(rank)).filter(|_| matches!(rank, "member" | "manager" | "master"))
            else {
                return EntryResult::Refused;
            };
            let rt = match t {
                AppRankTarget::Aid { aid } => RoleTarget::Aid(aid),
                AppRankTarget::Invite { invite_id } => RoleTarget::Invite(invite_id),
                AppRankTarget::Grant { invite_id, aid } => RoleTarget::Grant(invite_id, aid),
                _ => return EntryResult::Refused,
            };
            let view = View {
                store: &*store,
                people,
                catching_up: f.catching_up,
            };
            match &rt {
                RoleTarget::Aid(aid) | RoleTarget::Grant(_, aid) => {
                    let owner = people.anchors.owner_aid_hex.as_deref() == Some(aid.as_str());
                    if owner || people.classify(aid).is_some() || !view.is_allowed(r, aid) {
                        return EntryResult::Refused;
                    }
                    if let RoleTarget::Grant(id, aid) = &rt
                        && !store.grants(r, aid).contains(id)
                    {
                        return EntryResult::Refused;
                    }
                }
                RoleTarget::Invite(_) => {}
            }
            stale_or_applied(store.set_role(r, &rt, target, role, at, Some(&evidence)))
        }
        None => EntryResult::Refused,
    }
}

/// Apply one handed-over entry for app `r` (`sync.apply`: rank entries to the rank applier, the rest to `applyEntry`).
pub fn apply_entry(
    store: &mut Store,
    people: &People,
    f: &Facts<'_>,
    r: &str,
    entry: &AccessEntry,
) -> EntryResult {
    let e = entry.as_json();
    if e.get("kind").and_then(Value::as_str) == Some("rank") {
        return apply_rank(store, people, f, r, e);
    }
    let trust = View {
        store: &*store,
        people,
        catching_up: f.catching_up,
    }
    .entry_trust(r, f.installed, f.now_ms, people.anchors.strict);
    match verify_entry(entry, r, &trust) {
        Verdict::Refused => {
            // A withdraw is kept whatever signed it (a join through the invite checks it later); verify_entry
            // never refuses a well-formed one.
            EntryResult::Refused
        }
        Verdict::Skipped => EntryResult::Skipped,
        Verdict::Verified(v) => match v {
            Verified::Mode { mode, issued_at } => {
                if store.apply_mode_order(r, mode == "restricted", issued_at) == "ok" {
                    EntryResult::Applied
                } else {
                    EntryResult::Stale
                }
            }
            Verified::Remove { aid, issued_at } => {
                match store.apply_remove_order(r, &aid, issued_at) {
                    "stale" => EntryResult::Stale,
                    "removed" => EntryResult::Applied,
                    _ => EntryResult::Unchanged,
                }
            }
            Verified::Withdraw {
                invite_id,
                issued_at,
                signature,
                ..
            } => {
                let rv = RevokeServiceInvite {
                    invite_id: invite_id.clone(),
                    issued_at,
                };
                let view = View {
                    store: &*store,
                    people,
                    catching_up: f.catching_up,
                };
                let prunes = withdraw_refs(&view, &rv, &signature, f.now_ms)
                    .iter()
                    .any(|x| x == r);
                store.note_withdrawn(r, &invite_id, issued_at, &signature);
                if !prunes {
                    return EntryResult::Unchanged;
                }
                if store.revoke_group(&invite_id, Some(r)) > 0 {
                    EntryResult::Applied
                } else {
                    EntryResult::Unchanged
                }
            }
            Verified::Join {
                create,
                visitor_aid,
                redeemed_at,
            } => join(store, people, f, r, &create, &visitor_aid, redeemed_at),
            Verified::Accept {
                create,
                contact_aid,
                accepted_at,
            } => join(store, people, f, r, &create, &contact_aid, accepted_at),
            Verified::Share {
                share_id,
                member_pub,
                level,
                label,
                server_domain,
                issued_at,
                ended,
            } => {
                let rec = CoManagerRecord {
                    pub_hex: member_pub,
                    level,
                    label,
                    server_domain,
                    issued_at: Number::from(issued_at),
                    ended,
                };
                match store.note_co_manager(r, &share_id, rec) {
                    "applied" => EntryResult::Applied,
                    "unchanged" => EntryResult::Unchanged,
                    _ => EntryResult::Stale,
                }
            }
        },
    }
}

/// Whether the journal may keep `entry` for app `r`: its proof verifies classically against this box's people
/// (journal entries carry no hybrid signature; the assurance policy's gate is on application, not on keeping).
#[must_use]
pub fn admissible(
    store: &Store,
    people: &People,
    f: &Facts<'_>,
    r: &str,
    entry: &AccessEntry,
) -> bool {
    let e = entry.as_json();
    if e.get("kind").and_then(Value::as_str) == Some("rank") {
        let t = people.admin_trust(f.now_ms);
        let sig = e
            .get("signature")
            .and_then(Value::as_str)
            .unwrap_or_default();
        return e
            .get("order")
            .is_some_and(|o| crate::rank::verify_rank_entry(o, sig, r, f.installed, &t));
    }
    let trust = View {
        store,
        people,
        catching_up: f.catching_up,
    }
    .entry_trust(r, f.installed, f.now_ms, false);
    !matches!(verify_entry(entry, r, &trust), Verdict::Refused)
}

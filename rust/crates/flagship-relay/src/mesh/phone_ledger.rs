//! The phone's bare name across the mesh (relay-mesh.md §8). Each account's phone ledger lives on the first reachable
//! `full` relay in chunk A's rendezvous ranking (`phone_ledger_ranking`); that relay (L) runs the ledger rules
//! (`ledgerAcquire`, `ledgerRenew`, `ledgerRelease`, `liveEntry` of `packages/protocol/src/phoneRoute.ts`, ported below)
//! on its own in-memory table and signs a 60 s phone route grant for the relay holding the phone (P). P keeps the phone's
//! tunnel, runs the claim checks itself (the phone's presented admin grant chain under the log's admin root), asks L over
//! the bridge, and announces L's grant to every peer. Nothing about it goes to `.com`.
//!
//! [`MeshPhoneCom`] is P's side behind `phone.rs`'s `PhoneCom`, so the phone session code is unchanged.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use flagship_crypto::relay_mesh::{
    PHONE_ROUTE_GRANT_TTL_MS, PhoneItem, PhoneRouteGrant, account_hash, check_phone_item,
    phone_ledger_ranking, phone_route_grant_canonical, sign_canonical,
};
use serde_json::{Value, json};

use super::{Mesh, now, wire};
use crate::authority::BoxFut;
use crate::phone::{
    Eligibility, Entry, Holder, LEASE_MS, LedgerOp, LedgerResult, PhoneCom, parse_eligibility,
};

/// How long P waits for L.
const LEDGER_WAIT: Duration = Duration::from_secs(5);

/// L's table: one entry per bare hostname.
#[derive(Debug, Default)]
pub struct Ledger {
    entries: HashMap<String, Entry>,
    next_qid: u64,
}

fn live(e: &Entry, now: u64) -> Entry {
    if e.holder.is_some() && e.lease_until > now {
        e.clone()
    } else {
        Entry {
            generation: e.generation,
            holder: None,
            lease_until: 0,
        }
    }
}

fn valid_holder(h: &Holder) -> bool {
    (1..=64).contains(&h.relay_id.len())
        && (1..=64).contains(&h.session_id.len())
        && h.phone_route_pub.len() == 64
        && h.phone_route_pub
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `ledgerAcquire`: only while vacant, only for exactly the next generation.
pub fn ledger_acquire(
    e: &Entry,
    generation: u64,
    holder: &Holder,
    now: u64,
) -> Result<Entry, &'static str> {
    if !(1..=flagship_protocol::parse::MAX_SAFE_INTEGER).contains(&generation)
        || !valid_holder(holder)
    {
        return Err("malformed");
    }
    if live(e, now).holder.is_some() {
        return Err("route-held");
    }
    if generation != e.generation.saturating_add(1) {
        return Err("stale-generation");
    }
    Ok(Entry {
        generation,
        holder: Some(holder.clone()),
        lease_until: now.saturating_add(LEASE_MS),
    })
}

/// `ledgerRenew`: the current generation's own session, before its lease lapsed.
pub fn ledger_renew(
    e: &Entry,
    generation: u64,
    session_id: &str,
    now: u64,
) -> Result<Entry, &'static str> {
    if generation != e.generation {
        return Err("stale-generation");
    }
    if e.holder.as_ref().is_none_or(|h| h.session_id != session_id) {
        return Err("not-holder");
    }
    if e.lease_until <= now {
        return Err("expired");
    }
    Ok(Entry {
        lease_until: now.saturating_add(LEASE_MS),
        ..e.clone()
    })
}

/// `ledgerRelease`: the generation stays.
pub fn ledger_release(e: &Entry, generation: u64, session_id: &str) -> Result<Entry, &'static str> {
    if generation != e.generation {
        return Err("stale-generation");
    }
    if e.holder.as_ref().is_none_or(|h| h.session_id != session_id) {
        return Err("not-holder");
    }
    Ok(Entry {
        generation: e.generation,
        holder: None,
        lease_until: 0,
    })
}

fn code_of(s: &str) -> &'static str {
    match s {
        "route-held" => "route-held",
        "stale-generation" => "stale-generation",
        "not-holder" => "not-holder",
        "expired" => "expired",
        _ => "malformed",
    }
}

impl Mesh {
    fn account_of_host(&self, host: &str) -> Option<String> {
        host.strip_suffix(&self.0.cfg.apex)
            .and_then(|h| h.strip_suffix('.'))
            .filter(|a| !a.is_empty() && !a.contains('.'))
            .map(str::to_owned)
    }

    /// §8.1: the first reachable `full` relay in the account's ranking (self, or a live bridge).
    #[must_use]
    pub fn ledger_relay(&self, account: &str) -> Option<String> {
        let me = self.relay_id().to_owned();
        let ranking = self
            .with_state(|s| {
                phone_ledger_ranking(account, s.directory.as_ref().map(|d| &d.body), Some(&s.log))
                    .ok()
            })
            .flatten()?;
        if ranking.is_empty() && self.is_full() {
            return Some(me);
        }
        ranking
            .into_iter()
            .find(|r| *r == me || self.peer(r).is_some_and(|p| p.is_synced()))
    }

    fn entry(&self, host: &str) -> Entry {
        let seen = self
            .with_state(|s| s.store.max_phone_generation(host))
            .unwrap_or(0);
        self.0
            .ledger
            .lock()
            .ok()
            .map(|mut l| {
                l.entries
                    .entry(host.to_owned())
                    .or_insert(Entry {
                        generation: seen,
                        holder: None,
                        lease_until: 0,
                    })
                    .clone()
            })
            .unwrap_or(Entry {
                generation: seen,
                holder: None,
                lease_until: 0,
            })
    }

    fn set_entry(&self, host: &str, e: Entry) {
        if let Ok(mut l) = self.0.ledger.lock() {
            l.entries.insert(host.to_owned(), e);
        }
    }

    fn sign_grant(
        &self,
        host: &str,
        e: &Entry,
        holder_relay: &str,
    ) -> Option<(PhoneRouteGrant, String)> {
        let h = e.holder.as_ref()?;
        let t = now();
        let g = PhoneRouteGrant {
            hostname: host.to_owned(),
            phone_route_pub: h.phone_route_pub.clone(),
            generation: e.generation,
            holder_relay_id: holder_relay.to_owned(),
            ledger_relay_id: self.relay_id().to_owned(),
            issued_at: t,
            not_after: t.saturating_add(PHONE_ROUTE_GRANT_TTL_MS),
        };
        let c = phone_route_grant_canonical(&g).ok()?;
        Some((g, sign_canonical(&self.0.key, &c)))
    }

    /// L: answer one phone request from P (`from` is P's relay id). `None` when it is not a phone request.
    fn ledger_answer(&self, v: &Value, from: &str) -> Option<Value> {
        let qid = wire::qid_echo(v);
        let t = now();
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
        match v.get("type").and_then(Value::as_str)? {
            "phone-begin" => {
                let account = s("account")?;
                if self.ledger_relay(&account).as_deref() != Some(self.relay_id()) {
                    return Some(
                        json!({"type": "phone-begun", "qid": qid, "ok": false, "code": "not-ledger"}),
                    );
                }
                let host = format!("{account}.{}", self.0.cfg.apex);
                let e = live(&self.entry(&host), t);
                let mut out = json!({"type": "phone-begun", "qid": qid, "ok": true,
                    "generation": e.generation.saturating_add(1), "vacant": e.holder.is_none()});
                if e.holder.is_some()
                    && let Some(o) = out.as_object_mut()
                {
                    o.insert("holderGeneration".into(), json!(e.generation));
                }
                Some(out)
            }
            "phone-claim" => {
                let host = s("hostname")?;
                let generation = v.get("generation").and_then(Value::as_u64).unwrap_or(0);
                let h = v.get("holder")?;
                let holder = Holder {
                    relay_id: h.get("relayId")?.as_str()?.to_owned(),
                    session_id: h.get("sessionId")?.as_str()?.to_owned(),
                    phone_route_pub: h.get("phoneRoutePub")?.as_str()?.to_owned(),
                };
                let e = self.entry(&host);
                let refused = |code: &str, e: &Entry| json!({"type": "phone-claimed", "qid": qid, "ok": false, "code": code, "generation": e.generation});
                if holder.relay_id != from || self.account_of_host(&host).is_none() {
                    return Some(refused("malformed", &e));
                }
                match ledger_acquire(&e, generation, &holder, t) {
                    Err(code) => Some(refused(code, &e)),
                    Ok(next) => {
                        let grant = self.sign_grant(&host, &next, from);
                        self.set_entry(&host, next.clone());
                        let (g, sig) = grant?;
                        Some(
                            json!({"type": "phone-claimed", "qid": qid, "ok": true, "generation": next.generation,
                            "grant": wire::grant_to_json(&g), "grantSignature": sig}),
                        )
                    }
                }
            }
            "phone-renew" => {
                let host = s("hostname")?;
                let generation = v.get("generation").and_then(Value::as_u64).unwrap_or(0);
                let session = s("sessionId").unwrap_or_default();
                let e = self.entry(&host);
                match ledger_renew(&e, generation, &session, t) {
                    Err(code) => Some(
                        json!({"type": "phone-claimed", "qid": qid, "ok": false, "code": code}),
                    ),
                    Ok(next) if next.holder.as_ref().is_some_and(|h| h.relay_id == from) => {
                        let grant = self.sign_grant(&host, &next, from);
                        self.set_entry(&host, next);
                        let (g, sig) = grant?;
                        Some(json!({"type": "phone-claimed", "qid": qid, "ok": true,
                            "grant": wire::grant_to_json(&g), "grantSignature": sig}))
                    }
                    Ok(_) => Some(
                        json!({"type": "phone-claimed", "qid": qid, "ok": false, "code": "not-holder"}),
                    ),
                }
            }
            "phone-release" => {
                let host = s("hostname")?;
                let generation = v.get("generation").and_then(Value::as_u64).unwrap_or(0);
                let session = s("sessionId").unwrap_or_default();
                let e = self.entry(&host);
                if e.holder.as_ref().is_some_and(|h| h.relay_id != from) {
                    return Some(
                        json!({"type": "phone-claimed", "qid": qid, "ok": false, "code": "not-holder",
                        "generation": e.generation}),
                    );
                }
                match ledger_release(&e, generation, &session) {
                    Err(code) => Some(
                        json!({"type": "phone-claimed", "qid": qid, "ok": false, "code": code}),
                    ),
                    Ok(next) => {
                        self.set_entry(&host, next);
                        let vacant = json!({"type": "phone-vacant", "hostname": host, "generation": generation});
                        self.broadcast(&vacant);
                        if let Some(p) = self.hooks().and_then(|h| h.phone.clone()) {
                            p.pushed(&host, generation, true);
                        }
                        Some(json!({"type": "phone-claimed", "qid": qid, "ok": true}))
                    }
                }
            }
            _ => None,
        }
    }

    /// A phone message on a bridge: L's requests, or L's vacancy notice.
    pub(crate) fn on_phone_message(&self, peer: &super::bridge::Peer, v: &Value) {
        if v.get("type").and_then(Value::as_str) == Some("phone-vacant") {
            let (Some(h), Some(g)) = (
                v.get("hostname").and_then(Value::as_str),
                v.get("generation").and_then(Value::as_u64),
            ) else {
                return;
            };
            if let Some(p) = self.hooks().and_then(|x| x.phone.clone()) {
                p.pushed(h, g, true);
            }
            return;
        }
        if let Some(answer) = self.ledger_answer(v, &peer.relay_id) {
            peer.send_json(&answer);
        }
    }

    /// P: one request to the account's ledger relay (itself, or over the bridge).
    async fn ledger_call(&self, account: &str, mut msg: Value) -> Option<Value> {
        let l = self.ledger_relay(account)?;
        let qid = self
            .0
            .ledger
            .lock()
            .ok()
            .map(|mut x| {
                x.next_qid = x.next_qid.wrapping_add(1);
                x.next_qid
            })
            .unwrap_or(0);
        if let Some(o) = msg.as_object_mut() {
            o.insert("qid".into(), wire::qid_wire(qid));
        }
        if l == self.relay_id() {
            return self.ledger_answer(&msg, self.relay_id());
        }
        self.peer(&l)?.request(qid, &msg, LEDGER_WAIT).await
    }

    /// P: store and announce the grant L signed (checked like any phone item).
    fn adopt_own_grant(&self, reply: &Value) -> bool {
        let (Some(g), Some(sig)) = (
            reply.get("grant").and_then(wire::grant_from_json),
            reply.get("grantSignature").and_then(Value::as_str),
        ) else {
            return false;
        };
        let item = PhoneItem {
            grant: g,
            signature: sig.to_owned(),
        };
        let me = self.relay_id().to_owned();
        let ok = self
            .with_ctx(|ctx, store| {
                check_phone_item(&item, &me, ctx).map(|()| store.insert_phone(item.clone()))
            })
            .is_some_and(|r| r.is_ok());
        if ok {
            self.announce(wire::item_to_json(&wire::WireItem::Phone(item)));
        }
        ok
    }

    /// P: drop and withdraw this relay's phone item for a host.
    fn withdraw_own_phone(&self, host: &str) {
        let me = self.relay_id().to_owned();
        let issued = self
            .with_state(|s| {
                let had = s
                    .store
                    .phone_items(host)
                    .into_iter()
                    .find(|p| p.grant.holder_relay_id == me)
                    .map(|p| p.grant.issued_at);
                if had.is_some() {
                    s.store.remove_phone(host, &me);
                }
                had
            })
            .flatten();
        if let Some(issued) = issued {
            self.sign_and_announce_withdraw("phone", host, issued);
        }
    }

    /// Eligibility from the grants a phone presented (§8.2): `[{grant, signatureHex, signerRoot}]` under the log's admin
    /// root for the account; a grant id the log revoked counts as revoked.
    #[must_use]
    pub fn presented_eligibility(&self, account: &str, grants: &Value) -> Option<Eligibility> {
        let ah = account_hash(account).ok()?;
        let (admin_root, revoked) = self.with_state(|s| {
            let root = s
                .log
                .authorities
                .get(&ah)
                .and_then(|a| a.admin_root_pub.clone());
            let revoked: Vec<String> = s.log.revoked_grants.keys().cloned().collect();
            (root, revoked)
        })?;
        let list: Vec<Value> = grants
            .as_array()?
            .iter()
            .take(8)
            .filter_map(|g| {
                let mut o = g.get("grant")?.as_object()?.clone();
                o.insert("signatureHex".into(), g.get("signatureHex")?.clone());
                o.insert(
                    "signerRoot".into(),
                    g.get("signerRoot").cloned().unwrap_or(Value::Null),
                );
                let revoked_now = o
                    .get("grantId")
                    .and_then(Value::as_str)
                    .map(flagship_crypto::relay_mesh::relay_log_grant_id)
                    .is_some_and(|id| revoked.contains(&id));
                if revoked_now {
                    o.insert("revokedAt".into(), json!(1));
                } else {
                    o.remove("revokedAt");
                }
                Some(Value::Object(o))
            })
            .collect();
        parse_eligibility(&json!({"adminRootPub": admin_root, "grants": list}))
    }
}

/// P's side of the phone ledger in mesh mode.
#[derive(Debug, Clone)]
pub struct MeshPhoneCom(pub Mesh);

impl PhoneCom for MeshPhoneCom {
    fn read<'a>(&'a self, hostname: &'a str) -> BoxFut<'a, Option<Entry>> {
        Box::pin(async move {
            let account = self.0.account_of_host(hostname)?;
            let r = self
                .0
                .ledger_call(&account, json!({"type": "phone-begin", "account": account}))
                .await?;
            if r.get("ok") == Some(&Value::Bool(false)) {
                return None;
            }
            let next = r.get("generation")?.as_u64()?;
            let vacant = r.get("vacant").and_then(Value::as_bool).unwrap_or(true);
            Some(Entry {
                generation: next.saturating_sub(1),
                holder: (!vacant).then(|| Holder {
                    relay_id: String::new(),
                    session_id: String::new(),
                    phone_route_pub: String::new(),
                }),
                lease_until: if vacant { 0 } else { u64::MAX },
            })
        })
    }

    fn apply<'a>(&'a self, op: LedgerOp) -> BoxFut<'a, Option<LedgerResult>> {
        Box::pin(async move {
            let m = &self.0;
            let entry = |generation: u64| Entry {
                generation,
                holder: None,
                lease_until: 0,
            };
            match op {
                LedgerOp::Acquire {
                    hostname,
                    generation,
                    holder,
                } => {
                    let account = m.account_of_host(&hostname)?;
                    let r = m
                        .ledger_call(&account, json!({"type": "phone-claim", "hostname": hostname, "generation": generation,
                            "holder": {"relayId": holder.relay_id, "sessionId": holder.session_id, "phoneRoutePub": holder.phone_route_pub}}))
                        .await?;
                    let g = r
                        .get("generation")
                        .and_then(Value::as_u64)
                        .unwrap_or(generation);
                    if r.get("ok") == Some(&Value::Bool(true)) && m.adopt_own_grant(&r) {
                        return Some(LedgerResult::Ok(Entry {
                            generation,
                            holder: Some(holder),
                            lease_until: now().saturating_add(LEASE_MS),
                        }));
                    }
                    let code = r
                        .get("code")
                        .and_then(Value::as_str)
                        .map_or("malformed", code_of);
                    Some(LedgerResult::Refused(code, entry(g)))
                }
                LedgerOp::Renew {
                    hostname,
                    generation,
                    session_id,
                } => {
                    let account = m.account_of_host(&hostname)?;
                    let r = m
                        .ledger_call(
                            &account,
                            json!({"type": "phone-renew", "hostname": hostname,
                            "generation": generation, "sessionId": session_id}),
                        )
                        .await?;
                    if r.get("ok") == Some(&Value::Bool(true)) && m.adopt_own_grant(&r) {
                        return Some(LedgerResult::Ok(Entry {
                            generation,
                            holder: None,
                            lease_until: now().saturating_add(LEASE_MS),
                        }));
                    }
                    m.withdraw_own_phone(&hostname);
                    let code = r
                        .get("code")
                        .and_then(Value::as_str)
                        .map_or("expired", code_of);
                    Some(LedgerResult::Refused(code, entry(generation)))
                }
                LedgerOp::Release {
                    hostname,
                    generation,
                    session_id,
                } => {
                    m.withdraw_own_phone(&hostname);
                    let account = m.account_of_host(&hostname)?;
                    let r = m
                        .ledger_call(
                            &account,
                            json!({"type": "phone-release", "hostname": hostname,
                            "generation": generation, "sessionId": session_id}),
                        )
                        .await?;
                    if r.get("ok") == Some(&Value::Bool(true)) {
                        return Some(LedgerResult::Ok(entry(generation)));
                    }
                    let code = r
                        .get("code")
                        .and_then(Value::as_str)
                        .map_or("malformed", code_of);
                    Some(LedgerResult::Refused(code, entry(generation)))
                }
            }
        })
    }

    fn eligibility<'a>(&'a self, _account: &'a str) -> BoxFut<'a, Option<Eligibility>> {
        Box::pin(async { None })
    }
}

/// The presented-grant judge `PhoneRoutes::new_mesh` takes.
#[must_use]
pub fn presented(mesh: &Mesh) -> Arc<crate::phone::PresentedEligibility> {
    let m = mesh.clone();
    Arc::new(move |account: &str, grants: &Value| m.presented_eligibility(account, grants))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
mod tests {
    use super::*;

    fn holder(s: &str) -> Holder {
        Holder {
            relay_id: "iad1".into(),
            session_id: s.into(),
            phone_route_pub: "ab".repeat(32),
        }
    }

    #[test]
    fn the_ledger_rules_match_phone_route_ts() {
        let e = Entry {
            generation: 0,
            holder: None,
            lease_until: 0,
        };
        assert_eq!(
            ledger_acquire(&e, 2, &holder("a"), 10),
            Err("stale-generation")
        );
        let held = ledger_acquire(&e, 1, &holder("a"), 10).unwrap();
        assert_eq!(held.lease_until, 10 + LEASE_MS);
        assert_eq!(
            ledger_acquire(&held, 2, &holder("b"), 20),
            Err("route-held")
        );
        assert_eq!(ledger_renew(&held, 1, "b", 20), Err("not-holder"));
        assert_eq!(ledger_renew(&held, 2, "a", 20), Err("stale-generation"));
        assert_eq!(
            ledger_renew(&held, 1, "a", held.lease_until),
            Err("expired")
        );
        let lapsed = held.lease_until;
        assert!(
            ledger_acquire(&held, 2, &holder("b"), lapsed).is_ok(),
            "a lapsed lease is vacant"
        );
        let released = ledger_release(&held, 1, "a").unwrap();
        assert_eq!((released.generation, released.holder.is_none()), (1, true));
        assert_eq!(
            ledger_acquire(
                &e,
                1,
                &Holder {
                    session_id: String::new(),
                    ..holder("a")
                },
                1
            ),
            Err("malformed")
        );
    }
}

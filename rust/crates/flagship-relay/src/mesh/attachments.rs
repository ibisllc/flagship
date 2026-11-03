//! The attachment store (relay-mesh.md §5.2, §5.4, §5.5): every valid box, legacy and phone item this relay has seen,
//! kept per name and per relay. Items are checked by chunk A's `check_attachment_item` / `check_phone_item` before they
//! are inserted (the caller holds the log and the directory); the store keeps the newest item per (name, relay), answers
//! the winner by `compare_attachments` / `compare_phone_items` among unexpired items, applies withdrawals and enforces
//! the caps (an item from another relay with the oldest `issuedAt` goes first; a relay never evicts its own).

use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};

use flagship_crypto::relay_mesh::{
    AttachmentItem, AttachmentKind, HomeAttachment, MESH_STORE_MAX_BOX_ITEMS,
    MESH_STORE_MAX_PER_RELAY, MESH_STORE_MAX_PHONE_ITEMS, MeshItem, PHONE_GENERATION_MEMORY_MS,
    PhoneItem, RelayWithdraw, account_of_pod_name, compare_attachments, compare_phone_items,
    name_hash, withdraw_covers,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    pub box_items: usize,
    pub per_relay: usize,
    pub phone_items: usize,
}

impl Default for Caps {
    fn default() -> Self {
        Self {
            box_items: MESH_STORE_MAX_BOX_ITEMS,
            per_relay: MESH_STORE_MAX_PER_RELAY,
            phone_items: MESH_STORE_MAX_PHONE_ITEMS,
        }
    }
}

/// What an insert did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inserted {
    /// New, or newer than what this relay had for the name.
    Stored,
    /// The same or an older item than the one held: nothing changed.
    Stale,
}

#[derive(Debug)]
pub struct Store {
    self_id: String,
    apex: String,
    caps: Caps,
    /// serverFqdn → one item per relay (the attachment's `relayId`).
    boxes: HashMap<String, Vec<AttachmentItem>>,
    /// bare hostname → one item per holder relay.
    phones: HashMap<String, Vec<PhoneItem>>,
    by_account: HashMap<String, BTreeSet<String>>,
    /// bare hostname → ledger relay → (highest generation it signed, the latest `notAfter` seen with it): what a new
    /// ledger relay starts above (§8.2). Forgotten per relay when it is dropped, and per entry
    /// `PHONE_GENERATION_MEMORY_MS` after its `notAfter`.
    generations: HashMap<String, HashMap<String, (u64, u64)>>,
    /// nameHash → serverFqdn, for the log's `box-register` entries (which name a hash only).
    by_hash: HashMap<String, String>,
    per_relay: HashMap<String, usize>,
    box_count: usize,
    phone_count: usize,
}

impl Store {
    #[must_use]
    pub fn new(self_id: &str, apex: &str, caps: Caps) -> Self {
        Self {
            self_id: self_id.to_owned(),
            apex: apex.to_owned(),
            caps,
            boxes: HashMap::new(),
            phones: HashMap::new(),
            by_account: HashMap::new(),
            generations: HashMap::new(),
            by_hash: HashMap::new(),
            per_relay: HashMap::new(),
            box_count: 0,
            phone_count: 0,
        }
    }

    #[must_use]
    pub fn box_count(&self) -> usize {
        self.box_count
    }

    #[must_use]
    pub fn phone_count(&self) -> usize {
        self.phone_count
    }

    #[must_use]
    pub fn per_relay(&self) -> &HashMap<String, usize> {
        &self.per_relay
    }

    fn bump(&mut self, relay: &str, up: bool) {
        let c = self.per_relay.entry(relay.to_owned()).or_insert(0);
        *c = if up {
            c.saturating_add(1)
        } else {
            c.saturating_sub(1)
        };
        if *c == 0 {
            self.per_relay.remove(relay);
        }
    }

    /// Insert a checked attachment item.
    pub fn insert_box(&mut self, item: AttachmentItem) -> Inserted {
        let name = item.attachment.server_fqdn.clone();
        let relay = item.attachment.relay_id.clone();
        if let Some(list) = self.boxes.get_mut(&name)
            && let Some(had) = list.iter_mut().find(|x| x.attachment.relay_id == relay)
        {
            if compare_attachments(&item, had) != Ordering::Greater {
                return Inserted::Stale;
            }
            *had = item;
            return Inserted::Stored;
        }
        if relay != self.self_id {
            if self.per_relay.get(&relay).copied().unwrap_or(0) >= self.caps.per_relay {
                self.evict_box(Some(&relay));
            }
            if self.box_count >= self.caps.box_items {
                self.evict_box(None);
            }
        }
        if let Some(account) = account_of_pod_name(&name, &self.apex) {
            self.by_account
                .entry(account.to_owned())
                .or_default()
                .insert(name.clone());
        }
        if !self.boxes.contains_key(&name)
            && let Ok(h) = name_hash(&name)
        {
            self.by_hash.insert(h, name.clone());
        }
        self.boxes.entry(name).or_default().push(item);
        self.box_count = self.box_count.saturating_add(1);
        self.bump(&relay, true);
        Inserted::Stored
    }

    /// Drop the item from another relay (or from `only`) with the oldest `issuedAt`.
    fn evict_box(&mut self, only: Option<&str>) {
        let mut oldest: Option<(String, String, u64)> = None;
        for (name, list) in &self.boxes {
            for i in list {
                let r = &i.attachment.relay_id;
                if *r == self.self_id || only.is_some_and(|o| o != r) {
                    continue;
                }
                if oldest.as_ref().is_none_or(|o| i.attachment.issued_at < o.2) {
                    oldest = Some((name.clone(), r.clone(), i.attachment.issued_at));
                }
            }
        }
        if let Some((name, relay, _)) = oldest {
            self.remove_box_where(&name, |i| i.attachment.relay_id == relay);
        }
    }

    fn remove_box_where(&mut self, name: &str, pred: impl Fn(&AttachmentItem) -> bool) -> usize {
        let Some(list) = self.boxes.get_mut(name) else {
            return 0;
        };
        let mut gone: Vec<String> = Vec::new();
        list.retain(|i| {
            let drop = pred(i);
            if drop {
                gone.push(i.attachment.relay_id.clone());
            }
            !drop
        });
        let empty = list.is_empty();
        for r in &gone {
            self.bump(r, false);
        }
        self.box_count = self.box_count.saturating_sub(gone.len());
        if empty {
            self.boxes.remove(name);
            if let Ok(h) = name_hash(name) {
                self.by_hash.remove(&h);
            }
            if let Some(account) = account_of_pod_name(name, &self.apex)
                && let Some(set) = self.by_account.get_mut(account)
            {
                set.remove(name);
                if set.is_empty() {
                    self.by_account.remove(account);
                }
            }
        }
        gone.len()
    }

    /// Drop one relay's item for a name (`refuse not-holder`, a superseded own attachment).
    pub fn remove_box(&mut self, name: &str, relay: &str) -> bool {
        self.remove_box_where(name, |i| i.attachment.relay_id == relay) > 0
    }

    fn remember_generation(&mut self, item: &PhoneItem) {
        let g = &item.grant;
        if !self.generations.contains_key(&g.hostname)
            && self.generations.len() >= self.caps.phone_items
        {
            let oldest = self
                .generations
                .iter()
                .map(|(h, m)| (h, m.values().map(|(_, u)| *u).max().unwrap_or(0)))
                .min_by_key(|(_, u)| *u)
                .map(|(h, _)| h.clone());
            if let Some(h) = oldest {
                self.generations.remove(&h);
            }
        }
        let e = self
            .generations
            .entry(g.hostname.clone())
            .or_default()
            .entry(g.ledger_relay_id.clone())
            .or_insert((0, 0));
        e.0 = e.0.max(g.generation);
        e.1 = e.1.max(g.not_after);
    }

    /// §8.4: the highest generation among the live phone items held for a host (0 when none).
    #[must_use]
    pub fn highest_live(&self, host: &str, now: u64) -> u64 {
        self.phones
            .get(host)
            .and_then(|l| {
                l.iter()
                    .filter(|i| i.grant.not_after > now)
                    .map(|i| i.grant.generation)
                    .max()
            })
            .unwrap_or(0)
    }

    /// Insert a checked phone item.
    pub fn insert_phone(&mut self, item: PhoneItem) -> Inserted {
        self.remember_generation(&item);
        let host = item.grant.hostname.clone();
        let holder = item.grant.holder_relay_id.clone();
        if let Some(list) = self.phones.get_mut(&host)
            && let Some(had) = list.iter_mut().find(|x| x.grant.holder_relay_id == holder)
        {
            if compare_phone_items(&item, had) != Ordering::Greater {
                return Inserted::Stale;
            }
            *had = item;
            return Inserted::Stored;
        }
        if holder != self.self_id && self.phone_count >= self.caps.phone_items {
            let oldest = self
                .phones
                .iter()
                .flat_map(|(h, l)| l.iter().map(move |i| (h, i)))
                .filter(|(_, i)| i.grant.holder_relay_id != self.self_id)
                .min_by_key(|(_, i)| i.grant.issued_at)
                .map(|(h, i)| (h.clone(), i.grant.holder_relay_id.clone()));
            if let Some((h, r)) = oldest {
                self.remove_phone(&h, &r);
            }
        }
        self.phones.entry(host).or_default().push(item);
        self.phone_count = self.phone_count.saturating_add(1);
        Inserted::Stored
    }

    pub fn remove_phone(&mut self, host: &str, holder: &str) -> bool {
        let Some(list) = self.phones.get_mut(host) else {
            return false;
        };
        let before = list.len();
        list.retain(|i| i.grant.holder_relay_id != holder);
        let gone = before.saturating_sub(list.len());
        if list.is_empty() {
            self.phones.remove(host);
        }
        self.phone_count = self.phone_count.saturating_sub(gone);
        gone > 0
    }

    /// Apply a checked withdrawal: the named relay's item(s) for the subject at or before `withdrawnIssuedAt`.
    pub fn withdraw(&mut self, w: &RelayWithdraw) -> bool {
        if w.subject_kind == "box" {
            return self.remove_box_where(&w.subject, |i| {
                withdraw_covers(w, &MeshItem::Attachment(i.clone()))
            }) > 0;
        }
        let Some(list) = self.phones.get_mut(&w.subject) else {
            return false;
        };
        let before = list.len();
        list.retain(|i| !withdraw_covers(w, &MeshItem::Phone(i.clone())));
        let gone = before.saturating_sub(list.len());
        if list.is_empty() {
            self.phones.remove(&w.subject);
        }
        self.phone_count = self.phone_count.saturating_sub(gone);
        gone > 0
    }

    /// Every item of a relay (it was revoked, or left the directory).
    pub fn remove_relay(&mut self, relay: &str) {
        let names: Vec<String> = self.boxes.keys().cloned().collect();
        for n in names {
            self.remove_box_where(&n, |i| i.attachment.relay_id == relay);
        }
        let hosts: Vec<String> = self.phones.keys().cloned().collect();
        for h in hosts {
            self.remove_phone(&h, relay);
        }
        self.generations.retain(|_, m| {
            m.remove(relay);
            !m.is_empty()
        });
    }

    /// Keep only the box items `keep` accepts (re-checked after the log or the directory changed).
    pub fn retain_boxes(
        &mut self,
        names: Option<&[String]>,
        keep: impl Fn(&AttachmentItem) -> bool,
    ) {
        let all: Vec<String> = match names {
            Some(n) => n.to_vec(),
            None => self.boxes.keys().cloned().collect(),
        };
        for n in all {
            self.remove_box_where(&n, |i| !keep(i));
        }
    }

    pub fn retain_phones(&mut self, keep: impl Fn(&PhoneItem) -> bool) {
        let hosts: Vec<String> = self.phones.keys().cloned().collect();
        for h in hosts {
            if let Some(list) = self.phones.get_mut(&h) {
                let before = list.len();
                list.retain(&keep);
                let gone = before.saturating_sub(list.len());
                self.phone_count = self.phone_count.saturating_sub(gone);
                if list.is_empty() {
                    self.phones.remove(&h);
                }
            }
        }
    }

    /// Drop expired items (they would never win again).
    pub fn sweep(&mut self, now: u64) {
        let names: Vec<String> = self.boxes.keys().cloned().collect();
        for n in names {
            self.remove_box_where(&n, |i| i.attachment.not_after <= now);
        }
        self.retain_phones(|p| p.grant.not_after > now);
        self.generations.retain(|_, m| {
            m.retain(|_, (_, until)| until.saturating_add(PHONE_GENERATION_MEMORY_MS) > now);
            !m.is_empty()
        });
    }

    /// §5.2: the winning unexpired attachment for a name.
    #[must_use]
    pub fn winner(&self, name: &str, now: u64) -> Option<&AttachmentItem> {
        self.boxes
            .get(name)?
            .iter()
            .filter(|i| i.attachment.not_after > now)
            .max_by(|a, b| compare_attachments(a, b))
    }

    /// §8.4: the winning unexpired phone item for a bare hostname.
    #[must_use]
    pub fn phone_winner(&self, host: &str, now: u64) -> Option<&PhoneItem> {
        self.phones
            .get(host)?
            .iter()
            .filter(|i| i.grant.not_after > now)
            .max_by(|a, b| compare_phone_items(a, b))
    }

    #[must_use]
    pub fn box_items(&self, name: &str) -> Vec<AttachmentItem> {
        self.boxes.get(name).cloned().unwrap_or_default()
    }

    #[must_use]
    pub fn phone_items(&self, host: &str) -> Vec<PhoneItem> {
        self.phones.get(host).cloned().unwrap_or_default()
    }

    /// Every item (the full dump after a bridge's `sync`).
    #[must_use]
    pub fn all(&self) -> (Vec<AttachmentItem>, Vec<PhoneItem>) {
        (
            self.boxes.values().flatten().cloned().collect(),
            self.phones.values().flatten().cloned().collect(),
        )
    }

    /// The highest generation remembered for a host (a new ledger relay starts above it, §8.2).
    #[must_use]
    pub fn max_phone_generation(&self, host: &str) -> u64 {
        let items = self
            .phones
            .get(host)
            .and_then(|l| l.iter().map(|i| i.grant.generation).max())
            .unwrap_or(0);
        let seen = self
            .generations
            .get(host)
            .and_then(|m| m.values().map(|(g, _)| *g).max())
            .unwrap_or(0);
        items.max(seen)
    }

    /// §7.3 inputs: the account's winning, unexpired attachments, and whether any of them is legacy.
    #[must_use]
    pub fn account_attachments(&self, account: &str, now: u64) -> (Vec<HomeAttachment>, bool) {
        let mut out = Vec::new();
        let mut legacy = false;
        for name in self.by_account.get(account).into_iter().flatten() {
            if let Some(w) = self.winner(name, now) {
                legacy |= w.kind == AttachmentKind::Legacy;
                out.push(HomeAttachment {
                    relay_id: w.attachment.relay_id.clone(),
                    attached_at: w.attachment.attached_at,
                });
            }
        }
        (out, legacy)
    }

    #[must_use]
    pub fn name_of_hash(&self, hash: &str) -> Option<String> {
        self.by_hash.get(hash).cloned()
    }

    #[must_use]
    pub fn names_of_box(&self, box_pub: &str) -> Vec<String> {
        self.boxes
            .iter()
            .filter(|(_, l)| l.iter().any(|i| i.attachment.box_pub == box_pub))
            .map(|(n, _)| n.clone())
            .collect()
    }

    #[must_use]
    pub fn accounts(&self) -> Vec<String> {
        self.by_account.keys().cloned().collect()
    }
}

// ── the mesh's side: boxes on this relay, items from peers ───────────────

use std::sync::Arc;

use flagship_crypto::relay_mesh::{
    AttachmentHolder, attachment_refusal_code, check_attachment_item, check_phone_item,
    check_withdraw, relay_withdraw_canonical, sign_canonical,
};
use serde_json::Value;

use super::{LocalBox, Mesh, now, wire};
use crate::hub::Tunnel;

impl Mesh {
    /// A box's HELLO was accepted and its tunnel registered here (§9.2). A box that did not offer `mesh-v1` is
    /// announced as legacy at once (§5.3); a `mesh-v1` box has [`MeshConfig::legacy_wait`] to attach first.
    ///
    /// [`MeshConfig::legacy_wait`]: super::MeshConfig::legacy_wait
    pub fn on_box_registered(&self, pod: &str, tunnel: &Arc<Tunnel>, box_pub: &str, mesh_v1: bool) {
        let pod = pod.to_ascii_lowercase();
        self.with_state(|s| {
            s.local.insert(
                pod.clone(),
                LocalBox {
                    tunnel: Arc::clone(tunnel),
                    box_pub: box_pub.to_ascii_lowercase(),
                    mesh_v1,
                    registered_at: now(),
                    attached: false,
                    legacy_at: None,
                    last_hint_at: None,
                },
            );
        });
        if !mesh_v1 {
            self.mint_legacy(&pod);
        }
    }

    /// An ATTACHMENT frame from a box on this relay: the answer's payload (§9.1).
    pub fn on_attachment(&self, pod: &str, tunnel_id: u64, payload: &[u8]) -> Vec<u8> {
        let pod = pod.to_ascii_lowercase();
        let parsed = wire::parse_attachment_frame(payload)
            .and_then(|(a, sig)| Some((wire::attachment_from_json(&a)?, sig)));
        let Some((a, signature)) = parsed else {
            return wire::attachment_result_payload(Some("mismatch"));
        };
        let local = self
            .with_state(|s| {
                s.local
                    .get(&pod)
                    .filter(|b| b.tunnel.id == tunnel_id)
                    .map(|b| b.box_pub.clone())
            })
            .flatten();
        let Some(box_pub) = local else {
            return wire::attachment_result_payload(Some("mismatch"));
        };
        let item = AttachmentItem {
            kind: AttachmentKind::Box,
            attachment: a,
            signature,
        };
        let me = self.relay_id().to_owned();
        let verdict = self.with_ctx(|ctx, store| {
            let holder = AttachmentHolder {
                relay_id: &me,
                box_pub: &box_pub,
                server_fqdn: &pod,
            };
            check_attachment_item(&item, ctx, Some(&holder))
                .map(|()| store.insert_box(item.clone()))
        });
        match verdict {
            Some(Ok(_)) => {
                self.with_state(|s| {
                    if let Some(b) = s.local.get_mut(&pod) {
                        b.attached = true;
                    }
                });
                self.announce(wire::item_to_json(&wire::WireItem::Attachment(item)));
                self.clear_negative(&pod);
                self.maybe_colocate(&pod);
                wire::attachment_result_payload(None)
            }
            Some(Err(reason)) => {
                self.log(&format!("{pod}: attachment refused ({reason})"));
                wire::attachment_result_payload(Some(attachment_refusal_code(reason)))
            }
            None => wire::attachment_result_payload(Some("mismatch")),
        }
    }

    /// The box's tunnel closed: forget it and withdraw this relay's attachment for it (§5.4).
    pub fn on_box_closed(&self, pod: &str, tunnel_id: u64) {
        let pod = pod.to_ascii_lowercase();
        let gone = self
            .with_state(|s| {
                if s.local.get(&pod).is_some_and(|b| b.tunnel.id == tunnel_id) {
                    s.local.remove(&pod);
                    true
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if gone {
            self.withdraw_own_box(&pod);
        }
    }

    /// Remove and withdraw this relay's own item for a pod.
    pub(crate) fn withdraw_own_box(&self, pod: &str) {
        let me = self.relay_id().to_owned();
        let issued = self
            .with_state(|s| {
                let had = s
                    .store
                    .box_items(pod)
                    .into_iter()
                    .find(|i| i.attachment.relay_id == me)
                    .map(|i| i.attachment.issued_at);
                if had.is_some() {
                    s.store.remove_box(pod, &me);
                }
                had
            })
            .flatten();
        if let Some(issued) = issued {
            self.sign_and_announce_withdraw("box", pod, issued);
        }
    }

    pub(crate) fn sign_and_announce_withdraw(&self, kind: &str, subject: &str, issued: u64) {
        let w = RelayWithdraw {
            subject_kind: kind.to_owned(),
            subject: subject.to_owned(),
            relay_id: self.relay_id().to_owned(),
            withdrawn_issued_at: issued,
            at: now(),
        };
        if let Ok(c) = relay_withdraw_canonical(&w) {
            let sig = sign_canonical(&self.0.key, &c);
            self.announce_withdraw(wire::withdraw_to_json(&w, &sig));
        }
    }

    /// An item from a peer: verified by chunk A's checks, then stored. False when refused. A phone item in a query
    /// `answer` is checked as announced by its grant's holder (L's signature binds it, §15.4.1); in an `announce`, by
    /// the peer that sent it.
    pub(crate) fn accept_item(&self, item: wire::WireItem, from: &str, answer: bool) -> bool {
        let me = self.relay_id().to_owned();
        match item {
            wire::WireItem::Attachment(a) => {
                let name = a.attachment.server_fqdn.clone();
                let ok = self
                    .with_ctx(|ctx, store| {
                        if store
                            .box_items(&name)
                            .iter()
                            .any(|x| x.signature == a.signature && x.attachment == a.attachment)
                        {
                            return true;
                        }
                        if check_attachment_item(&a, ctx, None).is_err() {
                            return false;
                        }
                        store.insert_box(a.clone());
                        true
                    })
                    .unwrap_or(false);
                if ok {
                    self.on_superseded(&name);
                }
                ok
            }
            wire::WireItem::Phone(p) => {
                let host = p.grant.hostname.clone();
                let generation = p.grant.generation;
                let announcer = if answer {
                    p.grant.holder_relay_id.clone()
                } else {
                    from.to_owned()
                };
                let ok = self
                    .with_ctx(|ctx, store| {
                        let highest = store.highest_live(&p.grant.hostname, ctx.now);
                        if check_phone_item(&p, &announcer, ctx, highest).is_err() {
                            return false;
                        }
                        store.insert_phone(p.clone());
                        true
                    })
                    .unwrap_or(false);
                if ok
                    && p.grant.holder_relay_id != me
                    && let Some(routes) = self.hooks().and_then(|h| h.phone.clone())
                {
                    routes.pushed(&host, generation, false);
                }
                ok
            }
            wire::WireItem::Mailbox {
                pik_pub_hex,
                epoch,
                sig_hex,
                relay_id,
            } => {
                if relay_id != from {
                    return false;
                }
                let list = [crate::payload::MailboxAnnouncement {
                    pik_pub_hex,
                    epoch: epoch as f64,
                    sig_hex,
                }];
                let Some(ids) = crate::mailbox::verify_announcements(&list, now()) else {
                    return false;
                };
                // The announcement does not name the relay: the first holder keeps the id until it withdraws it (§7.6).
                self.with_state(|s| {
                    for id in ids {
                        let l = s.remote_mailboxes.entry(id).or_default();
                        if let Some(e) = l.iter_mut().find(|(r, _)| r == from) {
                            e.1 = epoch;
                        } else if l.len() < MAILBOX_CANDIDATES_MAX {
                            l.push((from.to_owned(), epoch));
                        }
                    }
                });
                true
            }
        }
    }

    /// A box that moved: once another relay's attachment wins for a name held here, this relay withdraws its own
    /// (§5.2: a superseded relay forwards like any entry relay).
    fn on_superseded(&self, name: &str) {
        let me = self.relay_id().to_owned();
        let t = now();
        let superseded = self
            .with_state(|s| {
                let winner = s
                    .store
                    .winner(name, t)
                    .map(|w| w.attachment.relay_id.clone());
                winner.is_some_and(|w| w != me)
                    && s.store
                        .box_items(name)
                        .iter()
                        .any(|i| i.attachment.relay_id == me)
            })
            .unwrap_or(false);
        if superseded {
            self.withdraw_own_box(name);
        }
    }

    /// A withdrawal from a peer (§5.4): signed by the relay it names, else ignored.
    pub(crate) fn accept_withdraw(&self, w: &RelayWithdraw, sig: &str) -> bool {
        self.with_ctx(|ctx, store| {
            if check_withdraw(w, sig, ctx).is_err() {
                return false;
            }
            store.withdraw(w);
            true
        })
        .unwrap_or(false)
    }

    // ── peer-backup mailboxes (§7.6) ─────────────────────────────────────

    /// A box here announced mailboxes (already verified by the hub): announce them to every peer.
    pub fn on_mailbox_announce(&self, list: &[crate::payload::MailboxAnnouncement]) {
        for a in list {
            if !a.epoch.is_finite() || a.epoch < 0.0 {
                continue;
            }
            let item = wire::WireItem::Mailbox {
                pik_pub_hex: a.pik_pub_hex.clone(),
                epoch: a.epoch as u64,
                sig_hex: a.sig_hex.clone(),
                relay_id: self.relay_id().to_owned(),
            };
            self.with_state(|s| {
                s.local_mail.insert(
                    crate::mailbox::mailbox_id(&a.pik_pub_hex, a.epoch as u64),
                    item.clone(),
                );
            });
            self.announce(wire::item_to_json(&item));
        }
    }

    /// Boxes here stopped holding these mailboxes: forget them and tell every peer (`mailbox-withdraw`, §7.6).
    pub fn on_mailbox_withdraw(&self, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        self.with_state(|s| {
            for id in ids {
                s.local_mail.remove(id);
            }
        });
        for chunk in ids.chunks(MAILBOX_WITHDRAW_MAX) {
            self.broadcast(&serde_json::json!({"type": "mailbox-withdraw", "ids": chunk}));
        }
    }

    /// A peer's `mailbox-withdraw`: removes only the mailbox ids that peer holds. False when it is not the shape.
    pub(crate) fn accept_mailbox_withdraw(&self, v: &Value, from: &str) -> bool {
        let Some(ids) = v.get("ids").and_then(Value::as_array) else {
            return false;
        };
        if ids.len() > MAILBOX_WITHDRAW_MAX {
            return false;
        }
        self.with_state(|s| {
            for id in ids.iter().filter_map(Value::as_str) {
                if let Some(l) = s.remote_mailboxes.get_mut(id) {
                    l.retain(|(r, _)| r != from);
                    if l.is_empty() {
                        s.remote_mailboxes.remove(id);
                    }
                }
            }
        });
        true
    }

    /// A peer's bridge went down: the mailboxes it held are no longer reachable through it.
    pub(crate) fn forget_mailboxes_of(&self, relay: &str) {
        self.with_state(|s| {
            s.remote_mailboxes.retain(|_, l| {
                l.retain(|(r, _)| r != relay);
                !l.is_empty()
            });
        });
    }

    pub(crate) fn local_mailbox_items(&self) -> Vec<Value> {
        self.with_state(|s| s.local_mail.values().map(wire::item_to_json).collect())
            .unwrap_or_default()
    }

    /// The relay whose box holds this mailbox, when it is not here.
    #[must_use]
    pub fn mailbox_holder(&self, id: &str) -> Option<String> {
        self.with_state(|s| {
            s.remote_mailboxes
                .get(id)
                .and_then(|l| l.first())
                .map(|(r, _)| r.clone())
        })
        .flatten()
    }

    /// Carry a mailbox request to the relay whose box holds it (§7.6, §15.4.1): `OPEN {kind:"pb-mail", length}`, the
    /// envelope (≤ 1 MiB) as DATA; the answer is a `u32` BE status then the reply, up to the holder's CLOSE. `None`: not
    /// delivered.
    pub async fn forward_mail(
        &self,
        id: &str,
        envelope: &[u8],
    ) -> Option<crate::mailbox::MailAnswer> {
        if envelope.len() > BRIDGED_MAIL_MAX {
            return None;
        }
        let holder = self.mailbox_holder(id)?;
        let peer = self.peer(&holder)?;
        let h = peer
            .tunnel
            .open_stream_kind(
                id,
                "pb-mail",
                Some(envelope.len() as u64),
                envelope.to_vec(),
            )
            .ok()?;
        let refusal = peer.expect_refusal(h.id);
        let read = async {
            let mut buf = Vec::new();
            while let Some(chunk) = h.down.pop().await {
                h.tunnel.consumed(h.id, chunk.len());
                buf.extend_from_slice(&chunk);
                if buf.len() > BRIDGED_MAIL_MAX.saturating_add(4) {
                    return None;
                }
            }
            let (status, body) = buf.split_at_checked(4)?;
            let status = u32::from_be_bytes(status.try_into().ok()?);
            Some(crate::mailbox::MailAnswer {
                status: u16::try_from(status).ok()?,
                body: body.to_vec(),
            })
        };
        let answer = tokio::select! {
            a = tokio::time::timeout(std::time::Duration::from_secs(130), read) => a.ok().flatten(),
            _ = refusal => None,
        };
        h.tunnel.close_stream(h.id);
        answer
    }

    /// The holder's side of a bridged mailbox request.
    pub(crate) fn on_bridged_mail(
        &self,
        peer: &Arc<super::bridge::Peer>,
        id: u32,
        mailbox: &str,
        length: Option<u64>,
    ) {
        let Some(reg) = self.hooks().and_then(|h| h.mailboxes.clone()) else {
            return peer.refuse(id, "not-holder");
        };
        let Some(length) = length
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n > 0 && *n <= BRIDGED_MAIL_MAX)
        else {
            return peer.refuse(id, "hop");
        };
        if !reg.has(mailbox) {
            return peer.refuse(id, "not-holder");
        }
        let Ok(h) = peer.tunnel.accept_stream(id, mailbox) else {
            return peer.refuse(id, "busy");
        };
        let mailbox = mailbox.to_owned();
        tokio::spawn(async move {
            let request = async {
                let mut buf = Vec::with_capacity(length);
                while buf.len() < length {
                    let chunk = h.down.pop().await?;
                    h.tunnel.consumed(h.id, chunk.len());
                    buf.extend_from_slice(&chunk);
                }
                (buf.len() == length).then_some(buf)
            };
            let answer =
                match tokio::time::timeout(std::time::Duration::from_secs(30), request).await {
                    Ok(Some(env)) => reg.deliver(&mailbox, &env).await,
                    _ => None,
                };
            if let Some(a) = answer {
                let mut out = u32::from(a.status).to_be_bytes().to_vec();
                out.extend_from_slice(&a.body);
                if h.tunnel.send_data(h.id, out).await {
                    let start = std::time::Instant::now();
                    while h.tunnel.stream_queued(h.id) > 0
                        && !h.tunnel.is_closed()
                        && start.elapsed() < std::time::Duration::from_secs(30)
                    {
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    }
                }
            }
            h.tunnel.close_stream(h.id);
        });
    }
}

/// Most mailbox ids in one `mailbox-withdraw` (§7.6).
pub const MAILBOX_WITHDRAW_MAX: usize = 500;
/// Relays remembered as waiting to hold one mailbox id after its first holder.
const MAILBOX_CANDIDATES_MAX: usize = 4;

/// A bridged mailbox envelope's limit (§7.6: "the same 1 MiB cap").
const BRIDGED_MAIL_MAX: usize = 1024 * 1024;

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
mod tests {
    use super::*;
    use flagship_crypto::relay_mesh::{BoxAttachment, PhoneRouteGrant};

    const APEX: &str = "flagship.services";

    fn phone(
        holder: &str,
        ledger: &str,
        generation: u64,
        issued: u64,
        not_after: u64,
    ) -> PhoneItem {
        let hostname = format!("alice.{APEX}");
        PhoneItem {
            grant: PhoneRouteGrant {
                hostname: hostname.clone(),
                phone_route_pub: "ab".repeat(32),
                generation,
                holder_relay_id: holder.into(),
                ledger_relay_id: ledger.into(),
                issued_at: issued,
                not_after,
            },
            signature: "cd".repeat(64),
            claim: flagship_crypto::serving::RouteClaim {
                account: "alice".into(),
                phone_route_pub: "ab".repeat(32),
                hostname,
                generation,
                session_nonce: "5e".repeat(16),
                issued_at: issued,
            },
            claim_signature: "ef".repeat(64),
        }
    }

    #[test]
    fn generation_memory_is_per_ledger_dropped_with_it_and_forgotten() {
        let host = format!("alice.{APEX}");
        let mut s = Store::new("iad1", APEX, Caps::default());
        s.insert_phone(phone("ams1", "rog1", 900, 10, 70));
        s.insert_phone(phone("fra1", "iad1", 5, 10, 70));
        assert_eq!(s.highest_live(&host, 20), 900);
        assert_eq!(s.highest_live(&host, 70), 0, "nothing live");
        s.sweep(70);
        assert_eq!(
            s.max_phone_generation(&host),
            900,
            "remembered after the items lapse"
        );
        // The rogue ledger is retired: its generations go with it.
        s.remove_relay("rog1");
        assert_eq!(s.max_phone_generation(&host), 5);
        s.sweep(70 + PHONE_GENERATION_MEMORY_MS);
        assert_eq!(s.max_phone_generation(&host), 0, "forgotten");
    }

    fn item(relay: &str, kind: AttachmentKind, reg_gen: u64, issued: u64) -> AttachmentItem {
        AttachmentItem {
            kind,
            attachment: BoxAttachment {
                server_fqdn: format!("home.alice.{APEX}"),
                box_pub: "ab".repeat(32),
                reg_gen,
                relay_id: relay.into(),
                attached_at: 1,
                issued_at: issued,
                not_after: issued + 1000,
            },
            signature: "cd".repeat(64),
        }
    }

    #[test]
    fn newest_wins_and_box_beats_legacy() {
        let mut s = Store::new("iad1", APEX, Caps::default());
        let name = format!("home.alice.{APEX}");
        assert_eq!(
            s.insert_box(item("ams1", AttachmentKind::Legacy, 1, 100)),
            Inserted::Stored
        );
        assert_eq!(
            s.insert_box(item("iad1", AttachmentKind::Box, 1, 50)),
            Inserted::Stored
        );
        assert_eq!(s.winner(&name, 60).unwrap().attachment.relay_id, "iad1");
        assert_eq!(
            s.insert_box(item("ams1", AttachmentKind::Box, 1, 200)),
            Inserted::Stored
        );
        assert_eq!(s.winner(&name, 210).unwrap().attachment.relay_id, "ams1");
        assert_eq!(
            s.insert_box(item("ams1", AttachmentKind::Box, 1, 150)),
            Inserted::Stale
        );
        assert_eq!(s.box_count(), 2);
        let (h, legacy) = s.account_attachments("alice", 210);
        assert_eq!((h.len(), legacy), (1, false));
        let w = RelayWithdraw {
            subject_kind: "box".into(),
            subject: name.clone(),
            relay_id: "ams1".into(),
            withdrawn_issued_at: 200,
            at: 300,
        };
        assert!(s.withdraw(&w));
        assert_eq!(s.winner(&name, 210).unwrap().attachment.relay_id, "iad1");
        assert!(s.winner(&name, 2000).is_none(), "expired items never win");
    }

    #[test]
    fn caps_evict_the_oldest_foreign_item_never_our_own() {
        let caps = Caps {
            box_items: 2,
            per_relay: 10,
            phone_items: 1,
        };
        let mut s = Store::new("iad1", APEX, caps);
        let mut mine = item("iad1", AttachmentKind::Box, 1, 1);
        mine.attachment.server_fqdn = format!("a.alice.{APEX}");
        s.insert_box(mine);
        let mut old = item("ams1", AttachmentKind::Box, 1, 5);
        old.attachment.server_fqdn = format!("b.alice.{APEX}");
        s.insert_box(old);
        let mut new = item("fra1", AttachmentKind::Box, 1, 9);
        new.attachment.server_fqdn = format!("c.alice.{APEX}");
        s.insert_box(new);
        assert_eq!(s.box_count(), 2);
        assert!(s.winner(&format!("a.alice.{APEX}"), 2).is_some());
        assert!(s.winner(&format!("b.alice.{APEX}"), 6).is_none());
        let p = |holder: &str, generation: u64| phone(holder, "iad1", generation, 10, 70);
        s.insert_phone(p("ams1", 1));
        s.insert_phone(p("fra1", 2));
        assert_eq!(s.phone_count(), 1);
        assert_eq!(
            s.phone_winner(&format!("alice.{APEX}"), 20)
                .unwrap()
                .grant
                .holder_relay_id,
            "fra1"
        );
    }
}

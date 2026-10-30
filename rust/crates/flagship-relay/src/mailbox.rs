//! Peer-backup mailboxes on the hub (`docs/peer-backup.md` section 5.3; `mailboxRelay.ts`). A holder's tunnel announces
//! `mailboxId(pik, epoch)` signed by its PIK; owners POST a sealed envelope to `/pb/m/<mailboxId>` and the hub carries it over that
//! tunnel and back. The hub sees mailbox ids, sizes and timing; it keeps nothing once the reply is sent, and nothing at all across
//! restarts.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use flagship_crypto::entitlements::verify;
use flagship_protocol::parse::encode_lower_hex;
use sha2::{Digest, Sha256};

use crate::authority::BoxFut;
use crate::payload::MailboxAnnouncement;

pub const PB_MAILBOX_EPOCH_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const TAG_MAILBOX: &str = "flagship/pb-mailbox/v1";
const TAG_MAILBOX_ANNOUNCE: &str = "flagship/pb-mailbox-announce/v1";

#[must_use]
pub const fn mailbox_epoch(now_ms: u64) -> u64 {
    now_ms / PB_MAILBOX_EPOCH_MS
}

/// `SHA-256("flagship/pb-mailbox/v1|<pik>|<epoch>")[0..16]`, lowercase hex.
#[must_use]
pub fn mailbox_id(pik_pub_hex: &str, epoch: u64) -> String {
    let d = Sha256::digest(format!("{TAG_MAILBOX}|{pik_pub_hex}|{epoch}").as_bytes());
    encode_lower_hex(d.get(..16).unwrap_or(&[]))
}

#[must_use]
pub fn canonical_announce(pik_pub_hex: &str, epoch: u64) -> String {
    format!("{TAG_MAILBOX_ANNOUNCE}|{pik_pub_hex}|{epoch}")
}

/// The mailbox ids an announcement list proves, or `None` when any entry is bad: an epoch more than one away from now, an epoch
/// that is not a whole number, or a signature that is not the PIK's over the announcement.
#[must_use]
pub fn verify_announcements(list: &[MailboxAnnouncement], now_ms: u64) -> Option<Vec<String>> {
    let now_epoch = mailbox_epoch(now_ms);
    let mut out = Vec::with_capacity(list.len());
    for a in list {
        if !a.epoch.is_finite()
            || a.epoch < 0.0
            || a.epoch.fract() != 0.0
            || a.epoch > 9_007_199_254_740_991.0
        {
            return None;
        }
        let epoch = a.epoch as u64;
        if epoch.saturating_add(1) < now_epoch || epoch > now_epoch.saturating_add(1) {
            return None;
        }
        if !verify(
            &canonical_announce(&a.pik_pub_hex, epoch),
            &a.sig_hex,
            &a.pik_pub_hex,
        ) {
            return None;
        }
        out.push(mailbox_id(&a.pik_pub_hex, epoch));
    }
    Some(out)
}

/// What the holder's tunnel answered: the status and the sealed reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailAnswer {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Carries one envelope to a holder over its tunnel and back.
pub trait MailDeliver: Send + Sync + 'static {
    fn deliver<'a>(&'a self, mailbox_id: &'a str, envelope: &'a [u8]) -> BoxFut<'a, MailAnswer>;
}

type Route = (u64, Arc<dyn MailDeliver>);

#[derive(Default)]
pub struct MailboxRegistry {
    routes: Mutex<HashMap<String, Route>>,
}

impl std::fmt::Debug for MailboxRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailboxRegistry")
            .field("size", &self.size())
            .finish()
    }
}

impl MailboxRegistry {
    /// Points these mailbox ids at a tunnel. A later announcement for the same id wins, and ids the owner no longer announces
    /// are dropped.
    pub fn register(&self, ids: &[String], owner: u64, deliver: &Arc<dyn MailDeliver>) {
        if let Ok(mut r) = self.routes.lock() {
            r.retain(|id, (o, _)| *o != owner || ids.contains(id));
            for id in ids {
                r.insert(id.clone(), (owner, Arc::clone(deliver)));
            }
        }
    }

    /// The tunnel closed.
    pub fn drop_owner(&self, owner: u64) {
        if let Ok(mut r) = self.routes.lock() {
            r.retain(|_, (o, _)| *o != owner);
        }
    }

    #[must_use]
    pub fn has(&self, id: &str) -> bool {
        self.routes.lock().is_ok_and(|r| r.contains_key(id))
    }

    #[must_use]
    pub fn size(&self) -> usize {
        self.routes.lock().map_or(0, |r| r.len())
    }

    /// `None` when no tunnel holds the mailbox.
    pub async fn deliver(&self, id: &str, envelope: &[u8]) -> Option<MailAnswer> {
        let d = self
            .routes
            .lock()
            .ok()?
            .get(id)
            .map(|(_, d)| Arc::clone(d))?;
        Some(d.deliver(id, envelope).await)
    }
}

//! Legacy attachments (relay-mesh.md §5.3): a box that did not offer `mesh-v1` (or offered it and sent no attachment
//! within 10 s) is announced by its `full` relay with a relay-signed attachment, TTL 3 min, renewed every minute while
//! the tunnel is up. Always beaten by a box-signed one; an `entry` relay never mints one.

use std::time::Duration;

use flagship_crypto::relay_mesh::{
    AttachmentHolder, AttachmentItem, AttachmentKind, BoxAttachment, check_attachment_item,
    legacy_attachment_canonical, relay_log_box, sign_canonical,
};

use super::{Mesh, ms, now, wire};

impl Mesh {
    pub(crate) fn spawn_legacy(&self) -> tokio::task::AbortHandle {
        let me = self.clone();
        let renew = self.0.cfg.legacy_ttl.checked_div(3).unwrap_or_default();
        let every = renew
            .min(Duration::from_secs(1))
            .max(Duration::from_millis(20));
        tokio::spawn(async move {
            let mut t = tokio::time::interval(every);
            loop {
                t.tick().await;
                me.legacy_pass();
            }
        })
        .abort_handle()
    }

    /// Mint or renew the legacy attachments that are due.
    pub fn legacy_pass(&self) {
        let t = now();
        let wait = ms(self.0.cfg.legacy_wait);
        let renew = ms(self.0.cfg.legacy_ttl) / 3;
        let me = self.relay_id().to_owned();
        let due: Vec<String> = self
            .with_state(|s| {
                s.local
                    .iter()
                    .filter(|(pod, b)| {
                        let signed_here = s.store.winner(pod, t).is_some_and(|w| {
                            w.kind == AttachmentKind::Box && w.attachment.relay_id == me
                        });
                        let waited = !b.mesh_v1 || t.saturating_sub(b.registered_at) >= wait;
                        let renew_due = b.legacy_at.is_none_or(|l| t.saturating_sub(l) >= renew);
                        !signed_here && waited && renew_due
                    })
                    .map(|(p, _)| p.clone())
                    .collect()
            })
            .unwrap_or_default();
        for pod in due {
            self.mint_legacy(&pod);
        }
    }

    /// Sign and announce a legacy attachment for a local box. False when this relay may not (an `entry` relay, a box
    /// the log does not register under this key, or a box that has since attached to another relay).
    pub(crate) fn mint_legacy(&self, pod: &str) -> bool {
        if !self.is_full() {
            return false;
        }
        let t = now();
        let me = self.relay_id().to_owned();
        let ttl = ms(self.0.cfg.legacy_ttl).max(1);
        let Some(Some((box_pub, registered_at, reg_gen))) = self.with_state(|s| {
            let b = s.local.get(pod)?;
            let reg = relay_log_box(&s.log, pod)?;
            if reg.box_pub != b.box_pub {
                return None;
            }
            // The box attached elsewhere after it attached here: that relay announces it, not this one.
            let elsewhere = s.store.winner(pod, t).is_some_and(|w| {
                w.attachment.relay_id != me
                    && (w.kind == AttachmentKind::Box || w.attachment.attached_at > b.registered_at)
            });
            (!elsewhere).then(|| (b.box_pub.clone(), b.registered_at, reg.reg_gen))
        }) else {
            return false;
        };
        let a = BoxAttachment {
            server_fqdn: pod.to_owned(),
            box_pub: box_pub.clone(),
            reg_gen,
            relay_id: me.clone(),
            attached_at: registered_at.min(t),
            issued_at: t,
            not_after: t.saturating_add(ttl),
        };
        let Ok(c) = legacy_attachment_canonical(&a) else {
            return false;
        };
        let item = AttachmentItem {
            kind: AttachmentKind::Legacy,
            attachment: a,
            signature: sign_canonical(&self.0.key, &c),
        };
        let ok = self
            .with_ctx(|ctx, store| {
                let holder = AttachmentHolder {
                    relay_id: &me,
                    box_pub: &box_pub,
                    server_fqdn: pod,
                };
                check_attachment_item(&item, ctx, Some(&holder))
                    .map(|()| store.insert_box(item.clone()))
            })
            .is_some_and(|r| r.is_ok());
        if ok {
            self.with_state(|s| {
                if let Some(b) = s.local.get_mut(pod) {
                    b.legacy_at = Some(t);
                }
            });
            self.announce(wire::item_to_json(&wire::WireItem::Attachment(item)));
        }
        ok
    }
}

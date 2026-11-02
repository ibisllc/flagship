//! Account homes and moves (relay-mesh.md §7.3, §9.3, §10.3). Every relay computes an account's home from the same
//! replicated data (chunk A's `account_home`): an accepted move whose target holds a box of the account, else the relay
//! holding most of its boxes. A holder that is not the home hints its `mesh-v1` boxes to `co-locate`; a home that moves
//! an account signs the move, announces it and hints each local box `locality`, 2 s apart.

use std::time::Duration;

use flagship_crypto::relay_mesh::{
    ACCOUNT_MOVE_HINT_SPACING_MS, ACCOUNT_MOVE_TTL_MS, AccountMove, MOVE_HINT_TTL_MS, MoveHint,
    RelayKind, account_hash, account_home, account_move_canonical, account_of_pod_name,
    check_account_move, move_hint_canonical, sign_canonical, verify_relay_blessing,
};
use serde_json::Value;

use super::{AcceptedMove, Mesh, ms, now, wire};
use crate::frame::{FRAME_MOVE_HINT, Frame};

impl Mesh {
    /// §7.3: the account's home, from the store and the accepted moves.
    #[must_use]
    pub fn account_home(&self, account: &str) -> Option<String> {
        let ah = account_hash(account).ok()?;
        let t = now();
        self.with_state(|s| {
            let (atts, _) = s.store.account_attachments(account, t);
            let mv = s.moves.get(&ah).map(|m| (m.to.clone(), m.not_after));
            account_home(
                &atts,
                s.directory.as_ref().map(|d| &d.body),
                mv.as_ref().map(|(to, na)| (to.as_str(), *na)),
                t,
            )
        })
        .flatten()
    }

    /// The ledger of moves, for tests and ops: `(accountHash, to)`.
    #[must_use]
    pub fn accepted_moves(&self) -> Vec<(String, String)> {
        self.with_state(|s| {
            s.moves
                .iter()
                .map(|(h, m)| (h.clone(), m.to.clone()))
                .collect()
        })
        .unwrap_or_default()
    }

    /// Send a `mesh-v1` box on this relay a signed move hint toward `to` (§9.3), with `to`'s blessing as the target.
    pub(crate) fn send_hint(&self, pod: &str, to: &str, reason: &str) -> bool {
        let t = now();
        let Some((target, raw)) = self.held_blessing(to) else {
            return false;
        };
        if target.body.relay_kind != RelayKind::Full
            || verify_relay_blessing(&target, &self.ca_keys(), t, &self.0.cfg.apex).is_err()
        {
            return false;
        }
        let local = self
            .with_state(|s| {
                s.local
                    .get(pod)
                    .filter(|b| b.mesh_v1)
                    .map(|b| (b.tunnel.clone(), b.box_pub.clone()))
            })
            .flatten();
        let Some((tunnel, box_pub)) = local else {
            return false;
        };
        let hint = MoveHint {
            server_fqdn: pod.to_owned(),
            box_pub,
            from_relay_id: self.relay_id().to_owned(),
            to_relay_id: to.to_owned(),
            reason: reason.to_owned(),
            issued_at: t,
            not_after: t.saturating_add(MOVE_HINT_TTL_MS),
        };
        let Ok(c) = move_hint_canonical(&hint) else {
            return false;
        };
        let sig = sign_canonical(&self.0.key, &c);
        tunnel.send_control(Frame::new(
            0,
            FRAME_MOVE_HINT,
            wire::move_hint_payload(&hint, &sig, &raw.to_string()),
        ));
        self.with_state(|s| {
            if let Some(b) = s.local.get_mut(pod) {
                b.last_hint_at = Some(t);
            }
        });
        self.0
            .stats
            .hints_sent
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.log(&format!("{pod}: {reason} hint to {to}"));
        true
    }

    /// A box here whose account's home is another relay gets a `co-locate` hint (at most every 10 min from here).
    pub(crate) fn maybe_colocate(&self, pod: &str) {
        let me = self.relay_id().to_owned();
        let Some(account) = account_of_pod_name(pod, &self.0.cfg.apex).map(str::to_owned) else {
            return;
        };
        let t = now();
        let every = ms(self.0.cfg.colocate_every);
        let due = self
            .with_state(|s| {
                s.local.get(pod).is_some_and(|b| {
                    b.mesh_v1
                        && b.attached
                        && b.last_hint_at.is_none_or(|h| t.saturating_sub(h) >= every)
                }) && s
                    .store
                    .winner(pod, t)
                    .is_some_and(|w| w.attachment.relay_id == me)
            })
            .unwrap_or(false);
        if !due {
            return;
        }
        if let Some(home) = self.account_home(&account)
            && home != me
        {
            self.send_hint(pod, &home, "co-locate");
        }
    }

    pub(crate) fn spawn_homes(&self) -> tokio::task::AbortHandle {
        let me = self.clone();
        let every = self
            .0
            .cfg
            .colocate_every
            .min(Duration::from_secs(30))
            .max(Duration::from_millis(50));
        tokio::spawn(async move {
            let mut t = tokio::time::interval(every);
            loop {
                t.tick().await;
                let pods: Vec<String> = me
                    .with_state(|s| {
                        s.local
                            .iter()
                            .filter(|(_, b)| b.mesh_v1)
                            .map(|(p, _)| p.clone())
                            .collect()
                    })
                    .unwrap_or_default();
                for p in pods {
                    me.maybe_colocate(&p);
                }
            }
        })
        .abort_handle()
    }

    /// `account-move` from a peer (§10.3): only from the relay this relay computes as the home, one per account per
    /// [`super::MeshConfig::min_move`].
    pub(crate) fn accept_account_move(&self, v: &Value, _from: &str) -> bool {
        let Some((mv, sig)) = wire::account_move_from_json(v) else {
            return false;
        };
        let t = now();
        let apex = self.0.cfg.apex.clone();
        let accounts = self
            .with_state(|s| {
                let mut a = s.store.accounts();
                a.extend(
                    s.local
                        .keys()
                        .filter_map(|p| account_of_pod_name(p, &apex).map(str::to_owned)),
                );
                a
            })
            .unwrap_or_default();
        let account = accounts
            .into_iter()
            .find(|a| account_hash(a).is_ok_and(|h| h == mv.account_hash));
        // A relay that holds nothing of the account takes the move's own `fromRelayId` as the expected home (§15.4.1):
        // it routes nothing for the account either way.
        let expected = match &account {
            Some(a) => self.account_home(a),
            None => Some(mv.from_relay_id.clone()),
        };
        let min_move = ms(self.0.cfg.min_move);
        let last = self
            .with_state(|s| s.moves.get(&mv.account_hash).map(|m| m.accepted_at))
            .flatten()
            .and_then(|at| (t.saturating_sub(at) < min_move).then_some(t));
        let ok = self
            .with_ctx(|ctx, _| check_account_move(&mv, &sig, expected.as_deref(), last, ctx))
            .is_some_and(|r| r.is_ok());
        if ok {
            self.with_state(|s| {
                s.moves.insert(
                    mv.account_hash.clone(),
                    AcceptedMove {
                        to: mv.to_relay_id.clone(),
                        not_after: mv.not_after,
                        accepted_at: t,
                        json: v.clone(),
                    },
                );
            });
            self.log(&format!(
                "account {}… moves {} → {}",
                mv.account_hash.get(..8).unwrap_or_default(),
                mv.from_relay_id,
                mv.to_relay_id
            ));
        }
        ok
    }

    /// The home moves an account to `to` (§10.3): signed, accepted here, announced, then a `locality` hint to each local
    /// `mesh-v1` box of the account, 2 s apart.
    pub(crate) fn move_account(&self, account: &str, to: &str) {
        let Ok(ah) = account_hash(account) else {
            return;
        };
        let t = now();
        let mv = AccountMove {
            account_hash: ah.clone(),
            from_relay_id: self.relay_id().to_owned(),
            to_relay_id: to.to_owned(),
            issued_at: t,
            not_after: t.saturating_add(ACCOUNT_MOVE_TTL_MS),
        };
        let Ok(c) = account_move_canonical(&mv) else {
            return;
        };
        let json = wire::account_move_to_json(&mv, &sign_canonical(&self.0.key, &c));
        self.with_state(|s| {
            s.moves.insert(
                ah,
                AcceptedMove {
                    to: to.to_owned(),
                    not_after: mv.not_after,
                    accepted_at: t,
                    json: json.clone(),
                },
            );
        });
        self.broadcast(&json);
        self.0
            .stats
            .moves_sent
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.log(&format!("moving account {account} to {to}"));
        let pods: Vec<String> = self
            .with_state(|s| {
                s.local
                    .iter()
                    .filter(|(p, b)| {
                        b.mesh_v1 && account_of_pod_name(p, &self.0.cfg.apex) == Some(account)
                    })
                    .map(|(p, _)| p.clone())
                    .collect()
            })
            .unwrap_or_default();
        let me = self.clone();
        let to = to.to_owned();
        tokio::spawn(async move {
            for (i, p) in pods.iter().enumerate() {
                if i > 0 {
                    tokio::time::sleep(Duration::from_millis(ACCOUNT_MOVE_HINT_SPACING_MS)).await;
                }
                me.send_hint(p, &to, "locality");
            }
        });
    }

    /// Drain (§10.4): mark draining (`/api/health` 503, `load.draining`) and send each `mesh-v1` box a `retire` hint to
    /// its account's best other `full` relay, spread over the first half of `grace`.
    ///
    /// Returns whether a target was found (then `mesh-v1` boxes get no DRAIN_NOTICE, §15.4.1).
    pub fn start_draining(&self, grace: Duration) -> bool {
        self.with_state(|s| s.draining = true);
        let me = self.relay_id().to_owned();
        let pods: Vec<String> = self
            .with_state(|s| {
                s.local
                    .iter()
                    .filter(|(_, b)| b.mesh_v1)
                    .map(|(p, _)| p.clone())
                    .collect()
            })
            .unwrap_or_default();
        let target = self.best_other_relay();
        let Some(target) = target else { return false };
        let mesh = self.clone();
        let spread = grace.checked_div(2).unwrap_or_default();
        let gap = spread
            .checked_div(u32::try_from(pods.len().max(1)).unwrap_or(u32::MAX))
            .unwrap_or_default();
        tokio::spawn(async move {
            for p in pods {
                if target != me {
                    mesh.send_hint(&p, &target, "retire");
                }
                tokio::time::sleep(gap).await;
            }
        });
        true
    }

    /// The lowest-load `full` relay other than this one with a live bridge (same region first).
    fn best_other_relay(&self) -> Option<String> {
        let me = self.relay_id().to_owned();
        let (relays, region) = self
            .with_state(|s| {
                let dir = s
                    .directory
                    .as_ref()
                    .map(|d| d.body.relays.clone())
                    .unwrap_or_default();
                let region = dir
                    .iter()
                    .find(|r| r.relay_id == me)
                    .map(|r| r.region.clone());
                (dir, region)
            })
            .unwrap_or_default();
        relays
            .into_iter()
            .filter(|r| r.relay_id != me && r.relay_kind == RelayKind::Full)
            .filter_map(|r| {
                let p = self.peer(&r.relay_id)?;
                let load = p.load();
                if load.is_some_and(|l| l.draining) {
                    return None;
                }
                let ratio = load.map_or(u64::MAX, |l| {
                    l.tunnels
                        .saturating_mul(1000)
                        .checked_div(l.capacity.max(1))
                        .unwrap_or(u64::MAX)
                });
                Some((Some(&r.region) != region.as_ref(), ratio, r.relay_id))
            })
            .min()
            .map(|(_, _, id)| id)
    }
}

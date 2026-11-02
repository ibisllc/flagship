//! Rebalancing (relay-mesh.md §10.1–10.2): the home counts, per account, visitor bytes and streams by entry relay in
//! one-minute buckets over the last hour; every interval (± a sixth) it asks chunk A's pure `rebalance_decision` and
//! moves the account when it says so. Phone traffic is not counted.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use flagship_crypto::relay_mesh::{
    REBALANCE_BUCKET_MS, REBALANCE_WINDOW_MS, RebalanceRelay, RebalanceWindow, account_hash,
    rebalance_decision,
};

use super::{Mesh, ms, now};

type Bucket = (u64, HashMap<String, (u64, u64)>);

/// Per account: `(minute, entry relay → (bytes, streams))`, newest last.
#[derive(Debug, Default)]
pub struct Traffic {
    per: HashMap<String, VecDeque<Bucket>>,
}

impl Traffic {
    pub fn add(&mut self, account: &str, entry: &str, bytes: u64, streams: u64, now: u64) {
        let minute = now / REBALANCE_BUCKET_MS;
        let q = self.per.entry(account.to_owned()).or_default();
        if q.back().is_none_or(|(m, _)| *m != minute) {
            q.push_back((minute, HashMap::new()));
        }
        if let Some((_, b)) = q.back_mut() {
            let e = b.entry(entry.to_owned()).or_insert((0, 0));
            e.0 = e.0.saturating_add(bytes);
            e.1 = e.1.saturating_add(streams);
        }
        let oldest = minute.saturating_sub(REBALANCE_WINDOW_MS / REBALANCE_BUCKET_MS);
        while q.front().is_some_and(|(m, _)| *m < oldest) {
            q.pop_front();
        }
    }

    /// The last hour per entry relay.
    #[must_use]
    pub fn window(&self, account: &str, now: u64) -> Vec<RebalanceWindow> {
        let oldest =
            (now / REBALANCE_BUCKET_MS).saturating_sub(REBALANCE_WINDOW_MS / REBALANCE_BUCKET_MS);
        let mut sum: HashMap<String, (u64, u64)> = HashMap::new();
        for (m, b) in self.per.get(account).into_iter().flatten() {
            if *m < oldest {
                continue;
            }
            for (r, (bytes, streams)) in b {
                let e = sum.entry(r.clone()).or_insert((0, 0));
                e.0 = e.0.saturating_add(*bytes);
                e.1 = e.1.saturating_add(*streams);
            }
        }
        let mut out: Vec<RebalanceWindow> = sum
            .into_iter()
            .map(|(relay_id, (bytes, streams))| RebalanceWindow {
                relay_id,
                bytes,
                streams,
            })
            .collect();
        out.sort_by(|a, b| a.relay_id.cmp(&b.relay_id));
        out
    }

    #[must_use]
    pub fn accounts(&self) -> Vec<String> {
        self.per.keys().cloned().collect()
    }

    pub fn clear(&mut self, account: &str) {
        self.per.remove(account);
    }
}

impl Mesh {
    /// Count visitor bytes for an account on this (home) relay; `entry` is the relay the visitor reached (`None`: here).
    pub fn count_traffic(&self, account: &str, entry: Option<&str>, bytes: u64, streams: u64) {
        let entry = entry.unwrap_or(&self.0.cfg.relay_id).to_owned();
        if let Ok(mut t) = self.0.traffic.lock() {
            t.add(account, &entry, bytes, streams, now());
        }
    }

    pub(crate) fn spawn_rebalance(&self) -> tokio::task::AbortHandle {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                let base = me.0.cfg.rebalance_every;
                let jitter = ms(base) / 6;
                let mut r = [0u8; 8];
                let _ = getrandom::fill(&mut r);
                let j = u64::from_le_bytes(r)
                    .checked_rem(jitter.saturating_mul(2).max(1))
                    .unwrap_or(0);
                let wait = ms(base).saturating_sub(jitter).saturating_add(j);
                tokio::time::sleep(Duration::from_millis(wait.max(10))).await;
                me.rebalance_now();
            }
        })
        .abort_handle()
    }

    /// One rebalancing pass over the accounts this relay is home for. Returns the moves made.
    pub fn rebalance_now(&self) -> Vec<(String, String)> {
        let me = self.relay_id().to_owned();
        let t = now();
        let accounts = self
            .0
            .traffic
            .lock()
            .map(|x| x.accounts())
            .unwrap_or_default();
        let relays: Vec<RebalanceRelay> = self
            .with_state(|s| {
                s.directory
                    .as_ref()
                    .map(|d| d.body.relays.clone())
                    .unwrap_or_default()
            })
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.relay_id != me)
            .map(|r| {
                let load = self.peer(&r.relay_id).and_then(|p| p.load());
                RebalanceRelay {
                    relay_id: r.relay_id,
                    relay_kind: r.relay_kind,
                    last_load_at: load.map(|l| l.at),
                    draining: load.is_some_and(|l| l.draining),
                    tunnels: load.map_or(0, |l| l.tunnels),
                    capacity: load.map_or(0, |l| l.capacity),
                }
            })
            .collect();
        let min_move = ms(self.0.cfg.min_move);
        let mut moved = Vec::new();
        for account in accounts {
            if self.account_home(&account).as_deref() != Some(me.as_str()) {
                continue;
            }
            let Ok(ah) = account_hash(&account) else {
                continue;
            };
            let window = self
                .0
                .traffic
                .lock()
                .map(|x| x.window(&account, t))
                .unwrap_or_default();
            let (last, legacy) = self
                .with_state(|s| {
                    let last = s
                        .moves
                        .get(&ah)
                        .map(|m| m.accepted_at)
                        .and_then(|at| (t.saturating_sub(at) < min_move).then_some(t));
                    let legacy = s.store.account_attachments(&account, t).1
                        || s.local.iter().any(|(p, b)| {
                            !b.mesh_v1
                                && flagship_crypto::relay_mesh::account_of_pod_name(
                                    p,
                                    &self.0.cfg.apex,
                                ) == Some(account.as_str())
                        });
                    (last, legacy)
                })
                .unwrap_or((None, true));
            if let Ok(to) = rebalance_decision(&me, &window, &relays, last, legacy, t) {
                self.move_account(&account, &to);
                if let Ok(mut x) = self.0.traffic.lock() {
                    x.clear(&account);
                }
                moved.push((account, to));
            }
        }
        moved
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
mod tests {
    use super::*;

    #[test]
    fn buckets_roll_over_the_hour() {
        let mut t = Traffic::default();
        t.add("alice", "ams1", 100, 1, 0);
        t.add("alice", "ams1", 50, 1, 30_000);
        t.add("alice", "iad1", 10, 1, 120_000);
        let w = t.window("alice", 120_000);
        assert_eq!(w.len(), 2);
        assert_eq!(
            (w[0].relay_id.as_str(), w[0].bytes, w[0].streams),
            ("ams1", 150, 2)
        );
        assert!(
            t.window("alice", REBALANCE_WINDOW_MS + 200_000)
                .iter()
                .all(|x| x.relay_id == "iad1")
        );
    }
}

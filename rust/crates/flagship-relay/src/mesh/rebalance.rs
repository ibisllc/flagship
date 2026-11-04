//! Rebalancing (relay-mesh.md §10.1–10.2): the home counts, per account, visitor bytes and streams by entry relay in
//! one-minute buckets over the last hour; every interval (± a sixth) it asks chunk A's pure `rebalance_decision` and
//! moves the account when it says so. Phone traffic is not counted.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use flagship_crypto::relay_mesh::{
    REBALANCE_BUCKET_MS, REBALANCE_CLIENT_BYTES_CAP, REBALANCE_CLIENTS_PER_BUCKET_MAX,
    REBALANCE_WINDOW_MS, RebalanceRelay, RebalanceWindow, account_hash, rebalance_decision,
};

use super::{Mesh, ms, now};

/// The client key of a bridged stream that carried none (§10.1).
pub const CLIENT_UNKNOWN: &str = "?";
/// The shared key past `REBALANCE_CLIENTS_PER_BUCKET_MAX` distinct ones in a bucket.
pub const CLIENT_OVERFLOW: &str = "~";

/// entry relay → client key → bytes, for one minute.
type Bucket = (u64, HashMap<String, HashMap<String, u64>>);

/// Per account: completed sessions by minute, entry relay and client key, newest last (§10.1).
#[derive(Debug, Default)]
pub struct Traffic {
    per: HashMap<String, VecDeque<Bucket>>,
    /// Every decision this home made, by outcome: `move` or the §10.2 refusal reason (ops, as the TS relay reports).
    decisions: std::collections::BTreeMap<&'static str, u64>,
}

impl Traffic {
    /// One completed session of `account` that reached the home through `entry`, from client key `client`.
    pub fn add(&mut self, account: &str, entry: &str, client: &str, bytes: u64, now: u64) {
        let minute = now / REBALANCE_BUCKET_MS;
        let q = self.per.entry(account.to_owned()).or_default();
        if q.back().is_none_or(|(m, _)| *m != minute) {
            q.push_back((minute, HashMap::new()));
        }
        if let Some((_, b)) = q.back_mut() {
            let clients = b.entry(entry.to_owned()).or_default();
            let key = if clients.contains_key(client)
                || clients.len() < REBALANCE_CLIENTS_PER_BUCKET_MAX
            {
                client
            } else {
                CLIENT_OVERFLOW
            };
            let e = clients.entry(key.to_owned()).or_insert(0);
            *e = e.saturating_add(bytes);
        }
        let oldest = minute.saturating_sub(REBALANCE_WINDOW_MS / REBALANCE_BUCKET_MS);
        while q.front().is_some_and(|(m, _)| *m < oldest) {
            q.pop_front();
        }
    }

    /// The last hour per entry relay: `streams` = distinct client keys, `bytes` = Σ min(key's bytes, 8 MiB).
    #[must_use]
    pub fn window(&self, account: &str, now: u64) -> Vec<RebalanceWindow> {
        let oldest =
            (now / REBALANCE_BUCKET_MS).saturating_sub(REBALANCE_WINDOW_MS / REBALANCE_BUCKET_MS);
        let mut sum: HashMap<&str, HashMap<&str, u64>> = HashMap::new();
        for (m, b) in self.per.get(account).into_iter().flatten() {
            if *m < oldest {
                continue;
            }
            for (r, clients) in b {
                let per = sum.entry(r.as_str()).or_default();
                for (c, bytes) in clients {
                    let e = per.entry(c.as_str()).or_insert(0);
                    *e = e.saturating_add(*bytes);
                }
            }
        }
        let mut out: Vec<RebalanceWindow> = sum
            .into_iter()
            .map(|(relay_id, clients)| RebalanceWindow {
                relay_id: relay_id.to_owned(),
                bytes: clients.values().fold(0u64, |a, b| {
                    a.saturating_add((*b).min(REBALANCE_CLIENT_BYTES_CAP))
                }),
                streams: clients.len() as u64,
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

    fn decided(&mut self, outcome: &'static str) {
        let e = self.decisions.entry(outcome).or_insert(0);
        *e = e.saturating_add(1);
    }

    /// `{ moves, decisions }` for `/api/stats` (§10.2).
    #[must_use]
    pub fn decisions_json(&self) -> serde_json::Value {
        serde_json::json!({
            "moves": self.decisions.get("move").copied().unwrap_or(0),
            "decisions": self.decisions,
        })
    }
}

/// One visitor session's byte counts on the home (§10.1). It is recorded when the last handle drops, and only when it
/// completed: the box sent bytes and the visitor sent bytes after its ClientHello.
pub struct SessionCount {
    mesh: Mesh,
    account: String,
    entry: Option<String>,
    client: String,
    initial: AtomicU64,
    up: AtomicU64,
    down: AtomicU64,
}

impl std::fmt::Debug for SessionCount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionCount")
            .field("account", &self.account)
            .finish_non_exhaustive()
    }
}

fn add(a: &AtomicU64, n: usize) {
    let n = u64::try_from(n).unwrap_or(u64::MAX);
    a.fetch_add(n, Ordering::Relaxed);
}

impl SessionCount {
    /// The ClientHello the entry peeked (not a sign the session completed).
    pub fn initial(&self, n: usize) {
        add(&self.initial, n);
    }

    /// Visitor → box bytes after the ClientHello.
    pub fn up(&self, n: usize) {
        add(&self.up, n);
    }

    /// Box → visitor bytes.
    pub fn down(&self, n: usize) {
        add(&self.down, n);
    }

    fn completed(&self) -> Option<u64> {
        let (i, u, d) = (
            self.initial.load(Ordering::Relaxed),
            self.up.load(Ordering::Relaxed),
            self.down.load(Ordering::Relaxed),
        );
        (u > 0 && d > 0).then(|| i.saturating_add(u).saturating_add(d))
    }
}

impl Drop for SessionCount {
    fn drop(&mut self) {
        if let Some(bytes) = self.completed() {
            self.mesh
                .count_session(&self.account, self.entry.as_deref(), &self.client, bytes);
        }
    }
}

impl Mesh {
    /// Record one completed visitor session for an account on this (home) relay; `entry` is the relay the visitor
    /// reached (`None`: here), `client` its client key (§10.1).
    pub fn count_session(&self, account: &str, entry: Option<&str>, client: &str, bytes: u64) {
        let entry = entry.unwrap_or(&self.0.cfg.relay_id).to_owned();
        if let Ok(mut t) = self.0.traffic.lock() {
            t.add(account, &entry, client, bytes, now());
        }
    }

    /// The rebalancing window this relay holds for an account (ops and tests, §10.1).
    #[must_use]
    pub fn traffic_window(&self, account: &str) -> Vec<RebalanceWindow> {
        self.0
            .traffic
            .lock()
            .map(|t| t.window(account, now()))
            .unwrap_or_default()
    }

    /// A session counter for a visitor of `account` (recorded when it drops, if it completed).
    #[must_use]
    pub fn session_count(
        &self,
        account: &str,
        entry: Option<String>,
        client: String,
    ) -> SessionCount {
        SessionCount {
            mesh: self.clone(),
            account: account.to_owned(),
            entry,
            client,
            initial: AtomicU64::new(0),
            up: AtomicU64::new(0),
            down: AtomicU64::new(0),
        }
    }

    /// The client key of a visitor socket: by its IP, or by `ip:port` with the test-only `client_key_by_port`.
    #[must_use]
    pub fn visitor_key(&self, addr: std::net::SocketAddr) -> String {
        if self.0.cfg.client_key_by_port {
            self.client_key(&addr.to_string())
        } else {
            self.client_key(&addr.ip().to_string())
        }
    }

    /// This relay's opaque key for a visitor address (§6.4 `client`): HMAC-SHA256 under a per-process random key
    /// (over `u64be(0) ‖ address`), the first 8 bytes as hex. The holder never learns the address.
    #[must_use]
    pub fn client_key(&self, address: &str) -> String {
        let mac = flagship_crypto::relay_mesh::bridge_mac(&self.0.client_secret, 0, address);
        mac.get(..16).unwrap_or(CLIENT_UNKNOWN).to_owned()
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
            let d = rebalance_decision(&me, &window, &relays, last, legacy, t);
            if let Ok(mut x) = self.0.traffic.lock() {
                x.decided(d.as_ref().map_or_else(|why| *why, |_| "move"));
            }
            if let Ok(to) = d {
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
        t.add("alice", "ams1", "c1", 100, 0);
        t.add("alice", "ams1", "c2", 50, 30_000);
        t.add("alice", "iad1", "c3", 10, 120_000);
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

    #[test]
    fn one_client_counts_once_and_at_most_8_mib() {
        let mut t = Traffic::default();
        for _ in 0..600 {
            t.add("alice", "ams1", "c1", 1 << 20, 0);
        }
        let w = t.window("alice", 0);
        assert_eq!(
            (w[0].streams, w[0].bytes),
            (1, REBALANCE_CLIENT_BYTES_CAP),
            "600 sessions from one address are one client, capped"
        );
        for i in 0..REBALANCE_CLIENTS_PER_BUCKET_MAX + 10 {
            t.add("bob", "ams1", &format!("k{i}"), 1, 0);
        }
        assert_eq!(
            t.window("bob", 0)[0].streams,
            REBALANCE_CLIENTS_PER_BUCKET_MAX as u64 + 1,
            "later keys share the overflow key"
        );
    }
}

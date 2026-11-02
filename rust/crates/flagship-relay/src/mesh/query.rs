//! Queries (relay-mesh.md §7.2 step 4): when the store holds no attachment for a pod name the log says exists, ask
//! every peer with a live bridge, single-flight per name, for 1.5 s; the first valid answer that beats the store wins.
//! A miss is remembered for 10 s (≤ 50,000 names, oldest first out).

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::Ordering;

use flagship_crypto::relay_mesh::{MESH_NEG_CACHE_MAX, MESH_NEG_CACHE_MS};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};

use super::{Mesh, now, wire};

#[derive(Debug, Default)]
struct QState {
    next: u64,
    flights: HashMap<String, watch::Receiver<Option<bool>>>,
    negative: HashMap<String, u64>,
    order: VecDeque<String>,
    waiting: HashMap<u64, mpsc::UnboundedSender<(String, Value)>>,
}

#[derive(Debug, Default)]
pub struct Queries {
    st: Mutex<QState>,
}

impl Mesh {
    /// Ask the peers about `name` (a pod name), skipping `exclude` (the relay that just refused it). True when the
    /// store now holds a winner other than `exclude`.
    pub async fn query(&self, name: &str, exclude: Option<&str>) -> bool {
        let name = name.to_ascii_lowercase();
        let t = now();
        let (rx, mine) = {
            let Ok(mut q) = self.0.queries.st.lock() else {
                return false;
            };
            if exclude.is_none() && q.negative.get(&name).is_some_and(|until| *until > t) {
                self.0.stats.negative_hits.fetch_add(1, Ordering::Relaxed);
                return false;
            }
            match q.flights.get(&name) {
                Some(rx) if exclude.is_none() => (rx.clone(), None),
                _ => {
                    let (tx, rx) = watch::channel(None);
                    q.flights.insert(name.clone(), rx.clone());
                    q.next = q.next.wrapping_add(1);
                    let qid = q.next;
                    let (wtx, wrx) = mpsc::unbounded_channel();
                    q.waiting.insert(qid, wtx);
                    (rx, Some((tx, qid, wrx)))
                }
            }
        };
        let Some((tx, qid, mut answers)) = mine else {
            let mut rx = rx;
            let got = rx.wait_for(Option::is_some).await.ok().and_then(|v| *v);
            return got.unwrap_or(false);
        };
        let peers: Vec<_> = self
            .live_peers()
            .into_iter()
            .filter(|p| Some(p.relay_id.as_str()) != exclude && p.is_synced())
            .collect();
        let msg = json!({"type": "query", "qid": wire::qid_wire(qid), "name": name});
        for p in &peers {
            p.send_json(&msg);
        }
        self.0.stats.queries_sent.fetch_add(1, Ordering::Relaxed);
        let me = self.relay_id().to_owned();
        let found_now = |m: &Mesh| {
            m.winner_of(&name).is_some_and(|(r, _)| {
                Some(r.as_str()) != exclude && (r == me || m.peer(&r).is_some())
            })
        };
        let mut found = found_now(self);
        let mut answered = 0usize;
        let deadline = tokio::time::Instant::now()
            .checked_add(self.0.cfg.query_timeout)
            .unwrap_or_else(tokio::time::Instant::now);
        while !found && answered < peers.len() {
            let next = tokio::time::timeout_at(deadline, answers.recv()).await;
            let Ok(Some((from, v))) = next else { break };
            answered = answered.saturating_add(1);
            for item in v
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(i) = wire::item_from_json(item) {
                    self.accept_item(i, &from, true);
                }
            }
            found = found_now(self);
        }
        if let Ok(mut q) = self.0.queries.st.lock() {
            q.waiting.remove(&qid);
            q.flights.remove(&name);
            if found {
                self.0.stats.query_hits.fetch_add(1, Ordering::Relaxed);
            } else if exclude.is_none() {
                q.negative
                    .insert(name.clone(), t.saturating_add(MESH_NEG_CACHE_MS));
                q.order.push_back(name.clone());
                while q.order.len() > MESH_NEG_CACHE_MAX {
                    if let Some(old) = q.order.pop_front() {
                        q.negative.remove(&old);
                    }
                }
            }
        }
        let _ = tx.send(Some(found));
        found
    }

    /// An `answer` from a peer: hand it to the query that asked.
    pub(crate) fn on_answer(&self, peer: &super::bridge::Peer, qid: u64, v: &Value) {
        let tx = self
            .0
            .queries
            .st
            .lock()
            .ok()
            .and_then(|q| q.waiting.get(&qid).cloned());
        if let Some(tx) = tx {
            let _ = tx.send((peer.relay_id.clone(), v.clone()));
        }
    }

    /// Forget a name's negative entry (a box just attached here).
    pub(crate) fn clear_negative(&self, name: &str) {
        if let Ok(mut q) = self.0.queries.st.lock() {
            q.negative.remove(name);
        }
    }
}

//! Bridges between relays (relay-mesh.md §6): a WebSocket on the hub port's `/mesh`, dialled by the relay with the
//! bytewise-smaller id, mutually authenticated by relay-key signatures over both nonces and both ids (chunk A's
//! `check_bridge_auth`). Text messages are JSON control (§6.3), binary messages exactly one v1 frame each: streams the
//! entry relay opens toward the holder (`OPEN {sni, kind, hop:1}`, `DATA`, `CLOSE`, `STREAM_CREDIT`), with credit always
//! on (§6.4). Everything a peer sends is verified before use; bad items are dropped and counted per peer.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use flagship_crypto::relay_mesh::{
    self as rm, AttachmentKind, BridgeAuth, BridgeAuthCheck, MESH_ANNOUNCE_BATCH_MAX,
    MESH_CONTROL_MAX_BYTES, MESH_LOAD_INTERVAL_MS, MESH_PEER_CUT_MS, MESH_PEER_MAX_QUEUED_BYTES,
    MESH_PEER_MAX_STREAMS, MESH_PEER_OPEN_BURST, MESH_PEER_OPEN_RATE, MESH_PEER_OVER_LIMIT_MS,
    MESH_PEER_QUERY_BURST, MESH_PEER_QUERY_RATE, MeshCheckContext, bridge_auth_canonical,
    check_bridge_auth, sign_canonical,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use super::{Mesh, ms, now, wire};
use crate::frame::{
    self, Decoded, FRAME_CLOSE, FRAME_CLOSE_REMOTE, FRAME_DATA, FRAME_OPEN, FRAME_STREAM_CREDIT,
    TypeSet,
};
use crate::hub::{HubConfig, StreamHandle, Tunnel};
use crate::payload;

pub const MESH_PATH: &str = "/mesh";
/// The control message types this relay speaks (`sync.features`).
const FEATURES: [&str; 2] = ["stream-credit-v1", "pb-mail"];
/// How often the announcer flushes (§5.5 asks for within 1 s).
const FLUSH_EVERY: Duration = Duration::from_millis(200);
/// A head goes to one peer at most this often (§6.3).
const HEAD_EVERY: Duration = Duration::from_secs(5);
/// How long the holder waits for a bridged stream's first bytes.
const FIRST_DATA_WAIT: Duration = Duration::from_secs(10);

/// Items and withdrawals waiting for the next flush to every peer.
#[derive(Debug, Default)]
pub struct Outbox {
    items: Vec<Value>,
    withdraws: Vec<Value>,
}

#[derive(Debug)]
pub(crate) enum Out {
    Text(String),
    Binary(Vec<u8>),
    Close(u16, String),
}

/// A token bucket (§6.4, §7.2).
#[derive(Debug)]
struct Bucket {
    tokens: f64,
    rate: f64,
    burst: f64,
    at: Instant,
}

impl Bucket {
    fn new(rate: u32, burst: u32) -> Self {
        Self {
            tokens: f64::from(burst),
            rate: f64::from(rate),
            burst: f64::from(burst),
            at: Instant::now(),
        }
    }

    fn take(&mut self) -> bool {
        let t = Instant::now();
        let refill = t.saturating_duration_since(self.at).as_secs_f64() * self.rate;
        self.tokens = (self.tokens + refill).min(self.burst);
        self.at = t;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// A peer's last `load` (§6.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerLoad {
    pub tunnels: u64,
    pub capacity: u64,
    pub draining: bool,
    pub at: u64,
}

#[derive(Debug)]
struct PeerState {
    last_heard: Instant,
    synced: bool,
    directory_version: u64,
    load: Option<PeerLoad>,
    refusals: HashMap<u32, oneshot::Sender<String>>,
    replies: HashMap<u64, oneshot::Sender<Value>>,
    log_sent: u64,
    last_head_at: Option<Instant>,
    pending_head: Option<Value>,
    queries: Bucket,
    opens: Bucket,
    over_since: Option<Instant>,
    rejected: u64,
    opened_here: u64,
    refused_here: u64,
}

/// One authenticated bridge.
#[derive(Debug)]
pub struct Peer {
    pub relay_id: String,
    /// This relay dialled it.
    pub dialed: bool,
    pub(crate) tunnel: Arc<Tunnel>,
    out: mpsc::UnboundedSender<Out>,
    st: Mutex<PeerState>,
    closed: AtomicBool,
    closed_tx: watch::Sender<bool>,
}

impl Peer {
    fn new(
        relay_id: &str,
        dialed: bool,
        cfg: Arc<HubConfig>,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<Out>) {
        let (out, rx) = mpsc::unbounded_channel();
        let (closed_tx, _) = watch::channel(false);
        let p = Arc::new(Self {
            relay_id: relay_id.to_owned(),
            dialed,
            tunnel: Tunnel::new_bridge(cfg, dialed),
            out,
            st: Mutex::new(PeerState {
                last_heard: Instant::now(),
                synced: false,
                directory_version: 0,
                load: None,
                refusals: HashMap::new(),
                replies: HashMap::new(),
                log_sent: 0,
                last_head_at: None,
                pending_head: None,
                queries: Bucket::new(MESH_PEER_QUERY_RATE, MESH_PEER_QUERY_BURST),
                opens: Bucket::new(MESH_PEER_OPEN_RATE, MESH_PEER_OPEN_BURST),
                over_since: None,
                rejected: 0,
                opened_here: 0,
                refused_here: 0,
            }),
            closed: AtomicBool::new(false),
            closed_tx,
        });
        (p, rx)
    }

    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    #[must_use]
    pub fn is_synced(&self) -> bool {
        self.st.lock().is_ok_and(|s| s.synced)
    }

    /// Close the bridge: its streams end, every waiter gets nothing.
    pub fn close(&self, code: u16, reason: &str) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.out.send(Out::Close(code, reason.to_owned()));
        self.tunnel.close();
        if let Ok(mut s) = self.st.lock() {
            s.refusals.clear();
            s.replies.clear();
        }
        let _ = self.closed_tx.send(true);
    }

    pub(crate) fn send_json(&self, v: &Value) {
        if !self.is_closed() {
            let _ = self.out.send(Out::Text(v.to_string()));
        }
    }

    /// A newer head: at most one per 5 s; a later one waits for the announcer.
    pub(crate) fn send_head(&self, msg: &Value) {
        let now_ok = self.st.lock().is_ok_and(|mut s| {
            let ok = s.last_head_at.is_none_or(|t| t.elapsed() >= HEAD_EVERY);
            if ok {
                s.last_head_at = Some(Instant::now());
                s.pending_head = None;
            } else {
                s.pending_head = Some(msg.clone());
            }
            ok
        });
        if now_ok {
            self.send_json(msg);
        }
    }

    fn flush_head(&self) {
        let due = self.st.lock().ok().and_then(|mut s| {
            if s.last_head_at.is_none_or(|t| t.elapsed() >= HEAD_EVERY) {
                let m = s.pending_head.take();
                if m.is_some() {
                    s.last_head_at = Some(Instant::now());
                }
                m
            } else {
                None
            }
        });
        if let Some(m) = due {
            self.send_json(&m);
        }
    }

    /// An item, entry, head or directory from this peer failed verification.
    pub(crate) fn reject(&self) {
        if let Ok(mut s) = self.st.lock() {
            s.rejected = s.rejected.saturating_add(1);
        }
    }

    pub(crate) fn log_sent(&self) -> u64 {
        self.st.lock().map_or(0, |s| s.log_sent)
    }

    pub(crate) fn set_log_sent(&self, seq: u64) {
        if let Ok(mut s) = self.st.lock() {
            s.log_sent = s.log_sent.max(seq);
        }
    }

    pub(crate) fn directory_version(&self) -> u64 {
        self.st.lock().map_or(0, |s| s.directory_version)
    }

    #[must_use]
    pub fn load(&self) -> Option<PeerLoad> {
        self.st.lock().ok().and_then(|s| s.load)
    }

    pub(crate) fn heard(&self) {
        if let Ok(mut s) = self.st.lock() {
            s.last_heard = Instant::now();
        }
    }

    /// The holder refuses a bridged stream: `refuse` then `CLOSE`, in order on the one channel.
    pub(crate) fn refuse(&self, stream: u32, code: &str) {
        if let Ok(mut s) = self.st.lock() {
            s.refused_here = s.refused_here.saturating_add(1);
        }
        self.send_json(&json!({"type": "refuse", "stream": stream, "code": code}));
        if let Ok(b) = frame::encode_frame(&frame::Frame::new(stream, FRAME_CLOSE, Vec::new())) {
            let _ = self.out.send(Out::Binary(b));
        }
    }

    pub(crate) fn expect_refusal(&self, stream: u32) -> oneshot::Receiver<String> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut s) = self.st.lock() {
            s.refusals.insert(stream, tx);
        }
        rx
    }

    fn forget_refusal(&self, stream: u32) {
        if let Ok(mut s) = self.st.lock() {
            s.refusals.remove(&stream);
        }
    }

    /// Send a request carrying `qid` and wait for the reply that names it.
    pub(crate) async fn request(&self, qid: u64, msg: &Value, wait: Duration) -> Option<Value> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut s) = self.st.lock() {
            s.replies.insert(qid, tx);
        }
        self.send_json(msg);
        let got = tokio::time::timeout(wait, rx)
            .await
            .ok()
            .and_then(Result::ok);
        if let Ok(mut s) = self.st.lock() {
            s.replies.remove(&qid);
        }
        got
    }

    fn reply(&self, qid: u64, v: Value) -> bool {
        let tx = self.st.lock().ok().and_then(|mut s| s.replies.remove(&qid));
        tx.is_some_and(|t| t.send(v).is_ok())
    }

    /// The inbound query limit (§7.2); a peer over it for 60 s straight is cut for 10 min (§11).
    fn take_query(&self) -> (bool, bool) {
        let Ok(mut s) = self.st.lock() else {
            return (false, false);
        };
        if s.queries.take() {
            s.over_since = None;
            return (true, false);
        }
        let since = *s.over_since.get_or_insert_with(Instant::now);
        (
            false,
            since.elapsed() >= Duration::from_millis(MESH_PEER_OVER_LIMIT_MS),
        )
    }

    fn take_open(&self) -> bool {
        self.st.lock().is_ok_and(|mut s| {
            s.opened_here = s.opened_here.saturating_add(1);
            s.opens.take()
        })
    }

    #[must_use]
    pub fn stats_json(&self) -> Value {
        let s = self.st.lock();
        let (rejected, opened, refused, synced, heard, load) =
            s.as_ref().map_or((0, 0, 0, false, 0, None), |s| {
                (
                    s.rejected,
                    s.opened_here,
                    s.refused_here,
                    s.synced,
                    u64::try_from(s.last_heard.elapsed().as_millis()).unwrap_or(u64::MAX),
                    s.load,
                )
            });
        json!({"relayId": self.relay_id, "dialed": self.dialed, "synced": synced, "rejected": rejected,
            "opens": opened, "refusals": refused, "lastHeardMs": heard, "streams": self.tunnel.stream_count(),
            "load": load.map(|l| json!({"tunnels": l.tunnels, "capacity": l.capacity, "draining": l.draining}))})
    }
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    let _ = getrandom::fill(&mut b);
    flagship_crypto::trust::hex(&b)
}

fn bridge_hub_config() -> Arc<HubConfig> {
    Arc::new(HubConfig {
        max_streams_per_tunnel: MESH_PEER_MAX_STREAMS,
        tunnel_queue_bytes: MESH_PEER_MAX_QUEUED_BYTES,
        ..HubConfig::default()
    })
}

async fn next_text<S>(ws: &mut WebSocketStream<S>, wait: Duration) -> Option<Value>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    tokio::time::timeout(wait, async {
        loop {
            match ws.next().await? {
                Ok(Message::Text(t)) if t.len() <= MESH_CONTROL_MAX_BYTES => {
                    return serde_json::from_str::<Value>(t.as_str()).ok();
                }
                Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => {}
                _ => return None,
            }
        }
    })
    .await
    .ok()
    .flatten()
}

async fn close_ws<S>(mut ws: WebSocketStream<S>, code: u16, reason: &str)
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let _ = ws
        .send(Message::Close(Some(CloseFrame {
            code: CloseCode::from(code),
            reason: reason.to_owned().into(),
        })))
        .await;
    let _ = ws.close(None).await;
}

impl Mesh {
    /// This relay's `mesh-auth`: role, both ids, both nonces, `at`, its blessing (or `null` without one) and the
    /// relay-key signature.
    fn auth_message(
        &self,
        role: &str,
        peer: &str,
        server_nonce: &str,
        client_nonce: &str,
    ) -> Value {
        let at = now();
        let b = BridgeAuth {
            role: role.to_owned(),
            signer_relay_id: self.relay_id().to_owned(),
            peer_relay_id: peer.to_owned(),
            server_nonce: server_nonce.to_owned(),
            client_nonce: client_nonce.to_owned(),
            at,
        };
        let sig = bridge_auth_canonical(&b)
            .map(|c| sign_canonical(&self.0.key, &c))
            .unwrap_or_default();
        let blessing = self
            .with_state(|s| s.own.as_ref().map(|o| o.raw.clone()))
            .flatten()
            .unwrap_or(Value::Null);
        let nonce = if role == "client" {
            client_nonce
        } else {
            server_nonce
        };
        json!({"type": "mesh-auth", "v": 1, "relayId": self.relay_id(), "peer": peer, "nonce": nonce, "at": at,
            "blessing": blessing, "sig": sig})
    }

    /// Check a peer's `mesh-auth` (`peer_role` is the peer's). On success: the peer id and whether its blessing came
    /// from this relay's held copy (it restarted without one and gets it back).
    fn check_auth(
        &self,
        v: &Value,
        peer_role: &str,
        self_nonce: &str,
    ) -> Result<(String, Option<Value>), &'static str> {
        let Some(auth) = wire::mesh_auth_from_json(v) else {
            return Err("bad-signature");
        };
        let held = self.held_blessing(&auth.relay_id);
        let keys = self.ca_keys();
        let outcome = self.with_state(|s| {
            let ctx = MeshCheckContext {
                services_apex: &self.0.cfg.apex,
                log: &s.log,
                directory: s.directory.as_ref().map(|d| &d.body),
                now: now(),
            };
            check_bridge_auth(&BridgeAuthCheck {
                auth: &auth,
                role: peer_role,
                self_relay_id: &self.0.cfg.relay_id,
                self_nonce,
                held_blessing: held.as_ref().map(|(b, _)| b),
                ca_keys: &keys,
                ctx,
            })
            .cloned()
        });
        let blessing = match outcome {
            Some(Ok(b)) => b,
            Some(Err(r)) => return Err(r),
            None => return Err("stale"),
        };
        if self.is_banned(&auth.relay_id) {
            return Err("revoked");
        }
        let raw = v.get("blessing").filter(|b| !b.is_null()).cloned();
        match raw {
            Some(r) => {
                self.adopt_blessing(&blessing, &r);
                Ok((auth.relay_id, None))
            }
            None => Ok((auth.relay_id, held.map(|(_, r)| r))),
        }
    }

    fn is_banned(&self, relay: &str) -> bool {
        let t = now();
        self.0
            .banned
            .lock()
            .is_ok_and(|b| b.get(relay).is_some_and(|until| *until > t))
    }

    /// Accept a `/mesh` WebSocket (the acceptor side of §6.2), then run the bridge until it closes.
    pub async fn accept_bridge<S>(&self, mut ws: WebSocketStream<S>)
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let step = self.0.cfg.bridge.step;
        let ns = random_hex(32);
        let hello = json!({"type": "mesh-hello", "v": 1, "relayId": self.relay_id(), "nonce": ns, "at": now()});
        if ws
            .send(Message::Text(hello.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
        let Some(v) = next_text(&mut ws, step).await else {
            return close_ws(ws, 4401, "stale").await;
        };
        let (peer, held) = match self.check_auth(&v, "client", &ns) {
            Ok(x) => x,
            Err(r) => {
                self.log(&format!("bridge refused: {r}"));
                return close_ws(ws, 4401, r).await;
            }
        };
        let nc = v
            .get("nonce")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let reply = self.auth_message("server", &peer, &ns, &nc);
        if ws
            .send(Message::Text(reply.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
        if let Some(b) = held {
            let _ = ws
                .send(Message::Text(
                    json!({"type": "blessing", "blessing": b})
                        .to_string()
                        .into(),
                ))
                .await;
        }
        self.run_link(ws, &peer, false).await;
    }

    /// Dial a peer (the dialer side of §6.2) and run the bridge until it closes. Returns whether it authenticated.
    pub async fn dial_bridge(&self, peer: &str) -> bool {
        let url = self.0.cfg.peer_urls.get(peer).cloned().or_else(|| {
            self.with_state(|s| {
                rm::directory_relay(s.directory.as_ref().map(|d| &d.body), peer)
                    .map(|e| format!("wss://{}:8443{MESH_PATH}", e.tunnel_host))
            })
            .flatten()
        });
        let Some(url) = url else { return false };
        let Ok(req) = url.as_str().into_client_request() else {
            return false;
        };
        let Ok(mut ws) = crate::serving_feed::connect_ws(req, self.0.cfg.bridge.dial).await else {
            return false;
        };
        let step = self.0.cfg.bridge.step;
        let Some(hello) = next_text(&mut ws, step).await else {
            close_ws(ws, 4401, "stale").await;
            return false;
        };
        let ns = hello
            .get("nonce")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if hello.get("type").and_then(Value::as_str) != Some("mesh-hello")
            || hello.get("relayId").and_then(Value::as_str) != Some(peer)
        {
            close_ws(ws, 4401, "wrong-peer").await;
            return false;
        }
        let nc = random_hex(32);
        let auth = self.auth_message("client", peer, &ns, &nc);
        if ws
            .send(Message::Text(auth.to_string().into()))
            .await
            .is_err()
        {
            return false;
        }
        let Some(v) = next_text(&mut ws, step).await else {
            close_ws(ws, 4401, "stale").await;
            return false;
        };
        match self.check_auth(&v, "server", &nc) {
            Ok((id, held)) if id == peer => {
                if let Some(b) = held {
                    let _ = ws
                        .send(Message::Text(
                            json!({"type": "blessing", "blessing": b})
                                .to_string()
                                .into(),
                        ))
                        .await;
                }
            }
            Ok(_) => {
                close_ws(ws, 4401, "wrong-peer").await;
                return false;
            }
            Err(r) => {
                self.log(&format!("bridge to {peer} refused: {r}"));
                close_ws(ws, 4401, r).await;
                return false;
            }
        }
        self.run_link(ws, peer, true).await;
        true
    }

    /// Keep the bridge dialled by the smaller id when both exist (§6.1).
    fn register_peer(&self, p: &Arc<Peer>) -> bool {
        let canonical = (p.dialed && self.relay_id() < p.relay_id.as_str())
            || (!p.dialed && p.relay_id.as_str() < self.relay_id());
        let old = {
            let Ok(mut peers) = self.0.peers.lock() else {
                return false;
            };
            match peers.get(&p.relay_id) {
                Some(o) if !o.is_closed() && !canonical => return false,
                _ => peers.insert(p.relay_id.clone(), Arc::clone(p)),
            }
        };
        if let Some(o) = old {
            o.close(1000, "replaced");
        }
        true
    }

    async fn run_link<S>(&self, ws: WebSocketStream<S>, peer_id: &str, dialed: bool)
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (peer, mut rx) = Peer::new(peer_id, dialed, bridge_hub_config());
        if !self.register_peer(&peer) {
            return close_ws(ws, 4409, "duplicate").await;
        }
        self.log(&format!("bridge up: {peer_id}"));
        let (mut sink, mut stream) = ws.split();
        let ping_every = self.0.cfg.bridge.ping;
        let writer = {
            let tunnel = Arc::clone(&peer.tunnel);
            tokio::spawn(async move {
                let mut ping = tokio::time::interval(ping_every);
                ping.tick().await;
                loop {
                    let woke = tunnel.wake.notified();
                    while let Some(f) = tunnel.next_frame() {
                        if sink.send(Message::Binary(f.into())).await.is_err() {
                            return;
                        }
                    }
                    tokio::select! {
                        _ = woke => {}
                        o = rx.recv() => match o {
                            Some(Out::Text(t)) => if sink.send(Message::Text(t.into())).await.is_err() { return },
                            Some(Out::Binary(b)) => if sink.send(Message::Binary(b.into())).await.is_err() { return },
                            Some(Out::Close(code, reason)) => {
                                let _ = sink.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))).await;
                                let _ = sink.close().await;
                                return;
                            }
                            None => return,
                        },
                        _ = ping.tick() => if sink.send(Message::Ping(Vec::new().into())).await.is_err() { return },
                    }
                }
            })
        };
        self.send_sync(&peer);
        let down = self.0.cfg.bridge.down;
        let mut watchdog = tokio::time::interval(
            down.checked_div(3)
                .unwrap_or(down)
                .max(Duration::from_millis(10)),
        );
        let mut closed = peer.closed_tx.subscribe();
        let types = TypeSet {
            stream_credit: true,
            ..TypeSet::V1
        };
        loop {
            let msg = tokio::select! {
                m = stream.next() => m,
                _ = closed.changed() => break,
                _ = watchdog.tick() => {
                    let silent = peer.st.lock().map_or(Duration::MAX, |s| s.last_heard.elapsed());
                    if silent >= down {
                        peer.close(1001, "silent");
                        break;
                    }
                    continue;
                }
            };
            peer.heard();
            match msg {
                Some(Ok(Message::Binary(b))) => match frame::decode_frame_with(&b, types) {
                    Decoded::Ok {
                        stream_id,
                        frame_type,
                        payload,
                        consumed,
                    } if consumed == b.len() => {
                        self.on_bridge_frame(&peer, stream_id, frame_type, payload.to_vec());
                    }
                    _ => {
                        peer.close(1002, "one whole frame per binary message");
                        break;
                    }
                },
                Some(Ok(Message::Text(t))) => {
                    if t.len() > MESH_CONTROL_MAX_BYTES {
                        peer.close(1009, "control message too large");
                        break;
                    }
                    if let Ok(v) = serde_json::from_str::<Value>(t.as_str())
                        && v.is_object()
                    {
                        self.on_control(&peer, &v);
                    } else {
                        peer.reject();
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
            }
        }
        peer.close(1000, "closed");
        if let Ok(mut peers) = self.0.peers.lock()
            && peers.get(peer_id).is_some_and(|x| Arc::ptr_eq(x, &peer))
        {
            peers.remove(peer_id);
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
        self.log(&format!("bridge down: {peer_id}"));
    }

    fn load_json(&self) -> Value {
        let tunnels = self.with_state(|s| s.local.len() as u64).unwrap_or(0);
        let draining = self.with_state(|s| s.draining).unwrap_or(false);
        json!({"tunnels": tunnels, "capacity": self.0.cfg.capacity, "draining": draining})
    }

    /// After auth: `sync`, the full dump, `sync-done` (§6.3).
    fn send_sync(&self, p: &Arc<Peer>) {
        let head = self
            .with_state(|s| {
                s.newest_head
                    .as_ref()
                    .map(|(h, sig)| wire::head_to_json(h, sig))
            })
            .flatten()
            .unwrap_or(Value::Null);
        p.send_json(
            &json!({"type": "sync", "directoryVersion": self.directory_version(), "head": head,
            "features": FEATURES, "load": self.load_json()}),
        );
        let me = self.relay_id().to_owned();
        let (boxes, phones) = self.with_state(|s| s.store.all()).unwrap_or_default();
        let mut items: Vec<Value> = boxes
            .into_iter()
            .map(|a| wire::item_to_json(&wire::WireItem::Attachment(a)))
            .collect();
        items.extend(
            phones
                .into_iter()
                .filter(|x| x.grant.holder_relay_id == me)
                .map(|x| wire::item_to_json(&wire::WireItem::Phone(x))),
        );
        items.extend(self.local_mailbox_items());
        for chunk in items.chunks(MESH_ANNOUNCE_BATCH_MAX) {
            p.send_json(&json!({"type": "announce", "items": chunk}));
        }
        p.send_json(&json!({"type": "sync-done"}));
        let t = now();
        let moves: Vec<Value> = self
            .with_state(|s| {
                s.moves
                    .values()
                    .filter(|m| m.not_after > t)
                    .map(|m| m.json.clone())
                    .collect()
            })
            .unwrap_or_default();
        for m in moves {
            p.send_json(&m);
        }
        self.push_log(p);
    }

    /// Queue items for every peer (flushed within [`FLUSH_EVERY`]).
    pub(crate) fn announce(&self, item: Value) {
        if let Ok(mut o) = self.0.outbox.lock() {
            o.items.push(item);
        }
    }

    pub(crate) fn announce_withdraw(&self, w: Value) {
        if let Ok(mut o) = self.0.outbox.lock() {
            o.withdraws.push(w);
        }
    }

    pub(crate) fn broadcast(&self, msg: &Value) {
        for p in self.live_peers() {
            p.send_json(msg);
        }
    }

    pub(crate) fn spawn_announcer(&self) -> tokio::task::AbortHandle {
        let me = self.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(FLUSH_EVERY);
            let mut last_load = Instant::now();
            let mut last_sweep = Instant::now();
            loop {
                t.tick().await;
                let (items, withdraws) =
                    me.0.outbox
                        .lock()
                        .map(|mut o| {
                            (
                                std::mem::take(&mut o.items),
                                std::mem::take(&mut o.withdraws),
                            )
                        })
                        .unwrap_or_default();
                let peers = me.live_peers();
                for p in &peers {
                    for c in items.chunks(MESH_ANNOUNCE_BATCH_MAX) {
                        p.send_json(&json!({"type": "announce", "items": c}));
                    }
                    for c in withdraws.chunks(MESH_ANNOUNCE_BATCH_MAX) {
                        p.send_json(&json!({"type": "withdraw", "items": c}));
                    }
                    p.flush_head();
                }
                if last_load.elapsed() >= Duration::from_millis(MESH_LOAD_INTERVAL_MS) {
                    last_load = Instant::now();
                    let mut load = me.load_json();
                    if let Some(o) = load.as_object_mut() {
                        o.insert("type".into(), json!("load"));
                    }
                    for p in &peers {
                        p.send_json(&load);
                    }
                }
                if last_sweep.elapsed() >= Duration::from_secs(5) {
                    last_sweep = Instant::now();
                    let t = now();
                    me.with_state(|s| {
                        s.store.sweep(t);
                        s.moves.retain(|_, m| {
                            m.not_after > t
                                || t.saturating_sub(m.accepted_at) < ms(me.0.cfg.min_move)
                        });
                        s.remote_mailboxes.retain(|_, (_, epoch)| {
                            epoch.saturating_add(1) >= crate::mailbox::mailbox_epoch(t)
                        });
                    });
                    if let Ok(mut b) = me.0.banned.lock() {
                        b.retain(|_, until| *until > t);
                    }
                }
            }
        })
        .abort_handle()
    }

    /// Keep one dial loop per peer this relay dials (the bytewise-larger ids in the directory, §6.1).
    pub(crate) fn spawn_dialers(&self) -> tokio::task::AbortHandle {
        let me = self.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(Duration::from_secs(1));
            loop {
                t.tick().await;
                me.sync_dialers();
            }
        })
        .abort_handle()
    }

    pub(crate) fn sync_dialers(&self) {
        let me = self.relay_id().to_owned();
        let want: Vec<String> = self
            .with_state(|s| {
                s.directory
                    .as_ref()
                    .map(|d| {
                        d.body
                            .relays
                            .iter()
                            .filter(|r| {
                                r.relay_id.as_str() > me.as_str()
                                    && !s.log.revoked_relays.contains_key(&r.relay_id)
                            })
                            .map(|r| r.relay_id.clone())
                            .collect()
                    })
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        let Ok(mut dialers) = self.0.dialers.lock() else {
            return;
        };
        dialers.retain(|id, h| {
            let keep = want.contains(id) && !h.is_finished();
            if !keep {
                h.abort();
            }
            keep
        });
        for id in want {
            if dialers.contains_key(&id) || self.is_banned(&id) {
                continue;
            }
            let m = self.clone();
            let peer = id.clone();
            let h = tokio::spawn(async move { m.dial_loop(&peer).await }).abort_handle();
            dialers.insert(id, h);
        }
    }

    async fn dial_loop(&self, peer: &str) {
        let b = self.0.cfg.bridge;
        let mut backoff = b.backoff_min;
        loop {
            if self.peer(peer).is_some() || self.is_banned(peer) {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
            if self.dial_bridge(peer).await {
                backoff = b.backoff_min;
            }
            let cap = u64::try_from(backoff.as_millis()).unwrap_or(1).max(1);
            let mut r = [0u8; 8];
            let _ = getrandom::fill(&mut r);
            let wait = u64::from_le_bytes(r).checked_rem(cap).unwrap_or(0);
            tokio::time::sleep(Duration::from_millis(wait)).await;
            backoff = backoff.saturating_mul(2).min(b.backoff_max);
        }
    }

    // ── frames ────────────────────────────────────────────────────────────

    fn on_bridge_frame(&self, peer: &Arc<Peer>, id: u32, frame_type: u8, payload: Vec<u8>) {
        match frame_type {
            FRAME_OPEN => self.on_bridge_open(peer, id, &payload),
            FRAME_DATA => peer.tunnel.on_peer_data(id, payload),
            FRAME_CLOSE | FRAME_CLOSE_REMOTE => peer.tunnel.remote_close(id, false),
            FRAME_STREAM_CREDIT => {
                if let Some(n) = payload::parse_credit(&payload) {
                    peer.tunnel.on_peer_credit(id, n);
                }
            }
            _ => {}
        }
    }

    /// A bridged OPEN (§6.4): one hop only; the holder admits it, or refuses with a code.
    fn on_bridge_open(&self, peer: &Arc<Peer>, id: u32, payload: &[u8]) {
        let Some(payload::BridgeOpen {
            sni,
            kind,
            hop,
            length,
        }) = payload::parse_bridge_open(payload)
        else {
            return peer.refuse(id, "hop");
        };
        if hop != 1 {
            return peer.refuse(id, "hop");
        }
        if !peer.take_open() {
            return peer.refuse(id, "busy");
        }
        match kind.as_str() {
            "tls" => {
                if let Err(code) = self.holder_admits(&sni) {
                    return peer.refuse(id, code);
                }
                let Ok(h) = peer.tunnel.accept_stream(id, &sni) else {
                    return peer.refuse(id, "busy");
                };
                let Some(router) = self.hooks().map(|h| h.router.clone()) else {
                    return peer.refuse(id, "not-holder");
                };
                let entry = peer.relay_id.clone();
                tokio::spawn(async move {
                    let first = tokio::time::timeout(FIRST_DATA_WAIT, h.down.pop()).await;
                    let Ok(Some(first)) = first else {
                        h.tunnel.close_stream(h.id);
                        return;
                    };
                    h.tunnel.consumed(h.id, first.len());
                    let (local, remote) = tokio::io::duplex(64 * 1024);
                    tokio::spawn(async move {
                        router
                            .route_local(local, sni, first, Instant::now(), Some(entry))
                            .await;
                    });
                    pump(remote, h, None).await;
                });
            }
            "pb-mail" => self.on_bridged_mail(peer, id, &sni, length),
            _ => peer.refuse(id, "hop"),
        }
    }

    /// The entry side of §7.2 step 5: OPEN on the holder's bridge and wait for its first bytes or its refusal. A refused
    /// or unreachable forward hands the visitor's socket back.
    ///
    /// # Errors
    /// The refusal code (`not-holder`, `apps-off`, `revoked`, `busy`, `stale`, `hop`) or `unreachable`, and the socket.
    pub async fn forward<S>(
        &self,
        sock: S,
        holder: &str,
        key: Option<&str>,
        sni: &str,
        initial: Vec<u8>,
    ) -> Result<(), (String, S)>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let Some(peer) = self.peer(holder) else {
            return Err(("unreachable".into(), sock));
        };
        // Not fresh: only a box the last applied log still registers may be forwarded (it may be exempt, §4.6); the
        // holder re-checks its exemption.
        if !self.fresh() && !key.is_some_and(|pod| self.log_knows(pod)) {
            return Err(("stale".into(), sock));
        }
        let Ok(h) = peer.tunnel.open_stream_kind(sni, "tls", None, initial) else {
            return Err(("busy".into(), sock));
        };
        let refusal = peer.expect_refusal(h.id);
        let mut closed = peer.closed_tx.subscribe();
        let first = tokio::select! {
            r = refusal => {
                h.tunnel.close_stream(h.id);
                return Err((r.unwrap_or_else(|_| "unreachable".into()), sock));
            }
            f = h.down.pop() => f,
            _ = closed.changed() => return Err(("unreachable".into(), sock)),
        };
        peer.forget_refusal(h.id);
        match first {
            Some(chunk) => {
                h.tunnel.consumed(h.id, chunk.len());
                self.0.stats.forwarded.fetch_add(1, Ordering::Relaxed);
                pump(sock, h, Some(chunk)).await;
                Ok(())
            }
            // Any end before the holder's first byte is a refusal (§15.4.1): closed at the hold, never re-queried.
            None => {
                h.tunnel.close_stream(h.id);
                Err(("closed".into(), sock))
            }
        }
    }

    /// A holder refused `not-holder`: drop its attachment for the pod (§7.2 step 5).
    pub fn drop_item(&self, pod: &str, relay: &str) {
        self.with_state(|s| s.store.remove_box(pod, relay));
    }

    // ── control ───────────────────────────────────────────────────────────

    fn on_control(&self, peer: &Arc<Peer>, v: &Value) {
        let t = v.get("type").and_then(Value::as_str).unwrap_or_default();
        match t {
            "sync" => {
                let version = v
                    .get("directoryVersion")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if let Ok(mut s) = peer.st.lock() {
                    s.directory_version = version;
                }
                self.on_load(peer, v.get("load"));
                if let Some((h, sig)) = v.get("head").and_then(wire::head_from_json) {
                    self.offer_head(&h, &sig, Some(&peer.relay_id));
                }
                if version < self.directory_version() {
                    self.send_directory(peer);
                }
            }
            "sync-done" => {
                if let Ok(mut s) = peer.st.lock() {
                    s.synced = true;
                }
            }
            "announce" => {
                for item in v
                    .get("items")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let ok = wire::item_from_json(item)
                        .is_some_and(|i| self.accept_item(i, &peer.relay_id, false));
                    if !ok {
                        peer.reject();
                    }
                }
            }
            "withdraw" => {
                for w in v
                    .get("items")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let ok = wire::withdraw_from_json(w)
                        .is_some_and(|(w, sig)| self.accept_withdraw(&w, &sig));
                    if !ok {
                        peer.reject();
                    }
                }
            }
            "query" => {
                let (ok, cut) = peer.take_query();
                if cut {
                    self.cut(peer);
                    return;
                }
                let qid = v.get("qid").and_then(Value::as_u64).unwrap_or(0);
                if !ok {
                    peer.send_json(
                        &json!({"type": "answer", "qid": qid, "items": [], "busy": true}),
                    );
                    return;
                }
                let name = v.get("name").and_then(Value::as_str).unwrap_or_default();
                peer.send_json(
                    &json!({"type": "answer", "qid": qid, "items": self.answer_items(name)}),
                );
            }
            "answer" => {
                let qid = v.get("qid").and_then(Value::as_u64).unwrap_or(0);
                self.on_answer(peer, qid, v);
            }
            "head" => {
                if let Some((h, sig)) = wire::head_from_json(v) {
                    self.offer_head(&h, &sig, Some(&peer.relay_id));
                } else {
                    peer.reject();
                }
            }
            "log" => {
                let entries: Vec<_> = v
                    .get("entries")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(wire::log_entry_from_json).collect())
                    .unwrap_or_default();
                self.apply_entries(&entries, &peer.relay_id);
                if let Some(top) = entries.iter().map(|(e, _)| e.sequence).max() {
                    peer.set_log_sent(top);
                }
            }
            "log-since" => {
                let since = v.get("since").and_then(Value::as_u64).unwrap_or(0);
                peer.send_json(&json!({"type": "log", "entries": self.log_since(since)}));
            }
            "directory" => {
                if let Some(d) = v.get("directory").and_then(wire::directory_from_json) {
                    self.adopt_directory(&d, v.get("directory").cloned().unwrap_or(Value::Null));
                }
                for raw in v
                    .get("blessings")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(b) = wire::blessing_from_json(raw) {
                        self.adopt_blessing(&b, raw);
                    }
                }
            }
            "blessing" => {
                let raw = v.get("blessing").cloned().unwrap_or(Value::Null);
                let ok =
                    wire::blessing_from_json(&raw).is_some_and(|b| self.adopt_blessing(&b, &raw));
                if !ok {
                    peer.reject();
                }
            }
            "load" => self.on_load(peer, Some(v)),
            "account-move" => {
                if !self.accept_account_move(v, &peer.relay_id) {
                    peer.reject();
                }
            }
            "refuse" => {
                let stream = v
                    .get("stream")
                    .and_then(Value::as_u64)
                    .and_then(|s| u32::try_from(s).ok());
                let code = v
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("not-holder")
                    .to_owned();
                if let Some(id) = stream {
                    let tx = peer.st.lock().ok().and_then(|mut s| s.refusals.remove(&id));
                    if let Some(tx) = tx {
                        let _ = tx.send(code);
                    }
                }
            }
            "phone-begun" | "phone-claimed" | "phone-renewed" | "phone-released"
            | "mail-answer" => {
                let qid = v.get("qid").and_then(Value::as_u64).unwrap_or(0);
                peer.reply(qid, v.clone());
            }
            "phone-begin" | "phone-claim" | "phone-renew" | "phone-release" | "phone-vacant" => {
                self.on_phone_message(peer, v);
            }
            _ => {}
        }
    }

    fn on_load(&self, peer: &Arc<Peer>, v: Option<&Value>) {
        let Some(v) = v else { return };
        let load = PeerLoad {
            tunnels: v.get("tunnels").and_then(Value::as_u64).unwrap_or(0),
            capacity: v.get("capacity").and_then(Value::as_u64).unwrap_or(0),
            draining: v.get("draining").and_then(Value::as_bool).unwrap_or(false),
            at: now(),
        };
        if let Ok(mut s) = peer.st.lock() {
            s.load = Some(load);
        }
    }

    /// A peer over its query limit for a minute straight: cut for 10 min and flagged (§11).
    fn cut(&self, peer: &Arc<Peer>) {
        self.log(&format!(
            "cutting {} for 10 min (over its limit)",
            peer.relay_id
        ));
        if let Ok(mut b) = self.0.banned.lock() {
            b.insert(
                peer.relay_id.clone(),
                now().saturating_add(MESH_PEER_CUT_MS),
            );
        }
        peer.close(4429, "over-limit");
    }

    /// Box and legacy items for a pod name; the phone items held for a bare name.
    fn answer_items(&self, name: &str) -> Vec<Value> {
        let name = name.to_ascii_lowercase();
        self.with_state(|s| {
            let mut out: Vec<Value> = s
                .store
                .box_items(&name)
                .into_iter()
                .map(|a| wire::item_to_json(&wire::WireItem::Attachment(a)))
                .collect();
            out.extend(
                s.store
                    .phone_items(&name)
                    .into_iter()
                    .map(|p| wire::item_to_json(&wire::WireItem::Phone(p))),
            );
            out
        })
        .unwrap_or_default()
    }

    /// Who holds this pod's attachments in the store, by kind (tests).
    #[must_use]
    pub fn store_holders(&self, pod: &str) -> Vec<(String, bool)> {
        self.with_state(|s| {
            s.store
                .box_items(pod)
                .into_iter()
                .map(|i| (i.attachment.relay_id, i.kind == AttachmentKind::Box))
                .collect()
        })
        .unwrap_or_default()
    }
}

/// Splice a byte stream (a visitor socket, or the holder's end of a duplex) with a bridge stream, credit returned as
/// bytes reach the stream.
pub(crate) async fn pump<S>(io: S, h: StreamHandle, first_down: Option<Vec<u8>>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut rd, mut wr) = tokio::io::split(io);
    let h = Arc::new(h);
    let up = {
        let h = Arc::clone(&h);
        async move {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                let n = match rd.read(&mut buf).await {
                    Ok(0) | Err(_) => {
                        // The bytes already queued toward the peer still go before the CLOSE.
                        let start = Instant::now();
                        while h.tunnel.stream_queued(h.id) > 0
                            && !h.tunnel.is_closed()
                            && start.elapsed() < Duration::from_secs(30)
                        {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        }
                        return;
                    }
                    Ok(n) => n,
                };
                if !h
                    .tunnel
                    .send_data(h.id, buf.get(..n).unwrap_or_default().to_vec())
                    .await
                {
                    return;
                }
            }
        }
    };
    let down = {
        let h = Arc::clone(&h);
        async move {
            if let Some(c) = first_down
                && wr.write_all(&c).await.is_err()
            {
                return;
            }
            while let Some(chunk) = h.down.pop().await {
                if wr.write_all(&chunk).await.is_err() {
                    h.down.abort();
                    return;
                }
                h.tunnel.consumed(h.id, chunk.len());
            }
            let _ = wr.shutdown().await;
        }
    };
    tokio::pin!(down);
    let mut closed = h.tunnel.closed_signal();
    let down_done = tokio::select! {
        () = up => false,
        () = &mut down => true,
        _ = closed.wait_for(|c| *c) => false,
    };
    h.tunnel.close_stream(h.id);
    h.down.end();
    if !down_done {
        let _ = tokio::time::timeout(Duration::from_secs(30), down).await;
    }
}

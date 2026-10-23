//! Tunnel hub (`apps/web/src/tunnel/tunnelHub.ts`): one WebSocket per box carrying the v1
//! frame protocol. HELLO admission, registration, snapshot broadcasts, REQUEST_TRANSFER, the
//! multiplexed stream table and the negotiated extensions live here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Notify, watch};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use crate::allocator::SetKey;
use crate::flow::{DEFAULT_QUANTUM, FairQueue, RecvWindow, STREAM_INITIAL_WINDOW, SendWindow};
use crate::frame::{
    self, FRAME_CLOSE, FRAME_CLOSE_REMOTE, FRAME_DATA, FRAME_DRAIN_NOTICE, FRAME_HELLO,
    FRAME_OUTBOUND_CREDIT, FRAME_OUTBOUND_OPEN, FRAME_REQUEST_TRANSFER, FRAME_STREAM_CREDIT, Frame,
    FrameDecoder, TypeSet,
};
use crate::hello::{self, AuthFailure, HelloAuthority, ParsedHello};
use crate::payload::{
    self, CAPABILITY_DRAIN_V1, CAPABILITY_STREAM_CREDIT_V1, HelloAckTrust, OUTBOUND_STREAM_ID_BASE,
    is_outbound_stream_id,
};
use crate::pipe::{Budget, DownQueue, PushError};
use crate::registry::Registry;
use crate::throttle::{Meter, account_from_canonical};

/// Frames coalesced into one WebSocket message. Small enough that a batch already handed to
/// the socket delays a newly queued stream by little.
const WRITE_BATCH_BYTES: usize = 64 * 1024;

pub type SharedRegistry = Arc<Mutex<Registry<Arc<Tunnel>>>>;

/// Supplies the relay blessing and signs the box's HELLO nonce with the blessed key.
pub trait BlessingSource: Send + Sync + 'static {
    fn trust_for(&self, nonce_hex: &str) -> Option<HelloAckTrust>;
}

#[derive(Debug, Clone)]
pub struct HubConfig {
    pub apex: String,
    pub max_hello_age_ms: f64,
    pub max_streams_per_tunnel: usize,
    /// Per-stream queue bound, each direction.
    pub stream_queue_bytes: usize,
    /// Per-tunnel bound on bytes queued toward visitors, and toward the box.
    pub tunnel_queue_bytes: usize,
    /// Most control frames queued toward a box that is not reading.
    pub max_control_frames: usize,
    /// How long a v1 tunnel reader waits on a full visitor queue before closing that stream.
    pub slow_receiver_grace: Duration,
    pub max_ws_message: usize,
    /// Offer `stream-credit-v1` / `drain-v1` to boxes that ask.
    pub offer_stream_credit: bool,
    pub offer_drain: bool,
}

impl Default for HubConfig {
    fn default() -> Self {
        Self {
            apex: crate::allocator::DEFAULT_APEX.to_owned(),
            max_hello_age_ms: hello::DEFAULT_MAX_HELLO_AGE_MS,
            max_streams_per_tunnel: 512,
            stream_queue_bytes: STREAM_INITIAL_WINDOW as usize,
            tunnel_queue_bytes: 16 * 1024 * 1024,
            max_control_frames: 8192,
            slow_receiver_grace: Duration::from_secs(2),
            max_ws_message: 4 * 1024 * 1024,
            offer_stream_credit: true,
            offer_drain: true,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Negotiated {
    pub stream_credit: bool,
    pub drain: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenError {
    TooManyStreams,
    TunnelClosed,
}

#[derive(Debug)]
struct StreamEntry {
    down: Arc<DownQueue>,
    recv: Option<RecvWindow>,
    remote_closed: bool,
}

#[derive(Debug)]
struct State {
    control: std::collections::VecDeque<Frame>,
    data: FairQueue,
    streams: HashMap<u32, StreamEntry>,
    next_id: u32,
    negotiated: Negotiated,
    pod_canonical: Option<String>,
}

/// One connected box. Cloned as `Arc<Tunnel>` into the registry.
#[derive(Debug)]
pub struct Tunnel {
    pub id: u64,
    state: Mutex<State>,
    wake: Notify,
    /// Wakes visitor readers waiting for room in their uplink lane.
    up_space: Notify,
    closed: AtomicBool,
    closed_tx: watch::Sender<bool>,
    budget: Arc<Budget>,
    cfg: Arc<HubConfig>,
}

static NEXT_TUNNEL_ID: AtomicU64 = AtomicU64::new(1);

/// A hub-opened stream as the SNI router sees it.
#[derive(Debug)]
pub struct StreamHandle {
    pub id: u32,
    pub down: Arc<DownQueue>,
    pub tunnel: Arc<Tunnel>,
}

impl Tunnel {
    fn new(cfg: Arc<HubConfig>) -> Arc<Self> {
        let (closed_tx, _) = watch::channel(false);
        Arc::new(Self {
            id: NEXT_TUNNEL_ID.fetch_add(1, Ordering::Relaxed),
            state: Mutex::new(State {
                control: std::collections::VecDeque::new(),
                data: FairQueue::new(DEFAULT_QUANTUM),
                streams: HashMap::new(),
                next_id: 1,
                negotiated: Negotiated::default(),
                pod_canonical: None,
            }),
            wake: Notify::new(),
            up_space: Notify::new(),
            closed: AtomicBool::new(false),
            closed_tx,
            budget: Budget::new(cfg.tunnel_queue_bytes),
            cfg,
        })
    }

    pub fn pod_canonical(&self) -> Option<String> {
        self.state.lock().ok().and_then(|s| s.pod_canonical.clone())
    }

    pub fn negotiated(&self) -> Negotiated {
        self.state.lock().map(|s| s.negotiated).unwrap_or_default()
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub fn closed_signal(&self) -> watch::Receiver<bool> {
        self.closed_tx.subscribe()
    }

    pub fn stream_count(&self) -> usize {
        self.state.lock().map_or(0, |s| s.streams.len())
    }

    pub fn queued_to_box(&self) -> usize {
        self.state.lock().map_or(0, |s| s.data.total_bytes())
    }

    pub fn queued_to_visitors(&self) -> usize {
        self.budget.used()
    }

    /// Queue a control frame. A box that stops reading long enough to fill the control
    /// queue is closed rather than buffered without bound.
    pub fn send_control(&self, f: Frame) {
        if self.is_closed() {
            return;
        }
        let overflow = match self.state.lock() {
            Ok(mut s) => {
                if s.control.len() >= self.cfg.max_control_frames {
                    true
                } else {
                    s.control.push_back(f);
                    false
                }
            }
            Err(_) => true,
        };
        if overflow {
            self.close();
        } else {
            self.wake.notify_one();
        }
    }

    /// Open a stream toward the box (`OPEN` then `DATA initial`).
    pub fn open_stream(
        self: &Arc<Self>,
        sni: &str,
        initial: Vec<u8>,
    ) -> Result<StreamHandle, OpenError> {
        if self.is_closed() {
            return Err(OpenError::TunnelClosed);
        }
        let down = DownQueue::new(self.cfg.stream_queue_bytes, self.budget.clone());
        let id = {
            let mut s = self.state.lock().map_err(|_| OpenError::TunnelClosed)?;
            if s.streams.len() >= self.cfg.max_streams_per_tunnel {
                return Err(OpenError::TooManyStreams);
            }
            let mut id = s.next_id;
            while s.streams.contains_key(&id) {
                id = if id >= OUTBOUND_STREAM_ID_BASE - 1 {
                    1
                } else {
                    id.saturating_add(1)
                };
            }
            s.next_id = if id >= OUTBOUND_STREAM_ID_BASE - 1 {
                1
            } else {
                id.saturating_add(1)
            };
            let credit = s.negotiated.stream_credit;
            s.streams.insert(
                id,
                StreamEntry {
                    down: down.clone(),
                    recv: credit.then(RecvWindow::default),
                    remote_closed: false,
                },
            );
            s.data.open(id, credit.then(SendWindow::default));
            s.control.push_back(payload::open_frame(id, sni));
            s.data.push(id, initial);
            id
        };
        self.wake.notify_one();
        Ok(StreamHandle {
            id,
            down,
            tunnel: self.clone(),
        })
    }

    /// Room for more visitor bytes on this stream (per-stream and per-tunnel bounds).
    fn uplink_has_room(&self, id: u32) -> bool {
        self.state
            .lock()
            .map(|s| {
                s.data.queued_bytes(id) < self.cfg.stream_queue_bytes
                    && s.data.total_bytes() < self.cfg.tunnel_queue_bytes
            })
            .unwrap_or(false)
    }

    /// Queue visitor bytes for the box, waiting while the stream's lane is full.
    pub async fn send_data(&self, id: u32, data: Vec<u8>) -> bool {
        loop {
            let room = self.up_space.notified();
            if self.is_closed() {
                return false;
            }
            if self.uplink_has_room(id) {
                break;
            }
            let mut closed = self.closed_signal();
            tokio::select! {
                _ = room => {}
                _ = closed.changed() => return false,
            }
        }
        let ok = self
            .state
            .lock()
            .map(|mut s| s.data.push(id, data))
            .unwrap_or(false);
        self.wake.notify_one();
        ok
    }

    /// The visitor's sink accepted `n` bytes of this stream: return credit if negotiated.
    pub fn consumed(&self, id: u32, n: usize) {
        let grant = self.state.lock().ok().and_then(|mut s| {
            s.streams
                .get_mut(&id)
                .and_then(|e| e.recv.as_mut())
                .and_then(|r| r.on_consumed(n))
        });
        if let Some(g) = grant
            && let Ok(f) = payload::stream_credit_frame(id, g)
        {
            self.send_control(f);
        }
    }

    /// The visitor side is finished: tell the box (`CLOSE`, as the TS hub does on end/close)
    /// unless the box closed first.
    pub fn close_stream(&self, id: u32) {
        let notify_box = match self.state.lock() {
            Ok(mut s) => {
                let had = s.streams.remove(&id);
                s.data.remove(id);
                had.is_some_and(|e| !e.remote_closed)
            }
            Err(_) => false,
        };
        self.up_space.notify_waiters();
        if notify_box {
            self.send_control(Frame::new(id, FRAME_CLOSE, Vec::new()));
        }
    }

    /// Box closed (or broke) a stream: drain what is queued, then FIN the visitor.
    fn remote_close(&self, id: u32, abort: bool) {
        let entry = self.state.lock().ok().and_then(|mut s| {
            s.data.remove(id);
            s.streams.get_mut(&id).map(|e| {
                e.remote_closed = true;
                e.down.clone()
            })
        });
        if let Some(d) = entry {
            if abort { d.abort() } else { d.end() }
        }
        self.up_space.notify_waiters();
    }

    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let downs: Vec<Arc<DownQueue>> = self
            .state
            .lock()
            .map(|mut s| s.streams.drain().map(|(_, e)| e.down).collect())
            .unwrap_or_default();
        for d in downs {
            d.end();
        }
        let _ = self.closed_tx.send(true);
        self.wake.notify_one();
        self.up_space.notify_waiters();
    }

    /// Next batch of frames for the writer: control first, then fairly scheduled DATA,
    /// coalesced up to `max_bytes` (receivers treat the carrier as a byte stream).
    fn next_batch(&self, max_bytes: usize) -> Vec<u8> {
        let mut out = Vec::new();
        let Ok(mut s) = self.state.lock() else {
            return out;
        };
        while out.len() < max_bytes {
            if let Some(f) = s.control.pop_front() {
                let _ = frame::encode_frame_into(f.stream_id, f.frame_type, &f.payload, &mut out);
                continue;
            }
            let room = max_bytes.saturating_sub(out.len()).clamp(1, 64 * 1024);
            let Some((id, chunk)) = s.data.pop(room) else {
                break;
            };
            let _ = frame::encode_frame_into(id, FRAME_DATA, &chunk, &mut out);
        }
        drop(s);
        if !out.is_empty() {
            self.up_space.notify_waiters();
        }
        out
    }
}

pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// Everything a tunnel session needs from the relay.
#[derive(Clone)]
pub struct HubContext {
    pub cfg: Arc<HubConfig>,
    pub registry: SharedRegistry,
    pub authority: Arc<dyn HelloAuthority>,
    pub blessing: Option<Arc<dyn BlessingSource>>,
    pub meter: Option<Arc<dyn Meter>>,
    /// Every live tunnel, for drain.
    pub live: Arc<Mutex<HashMap<u64, Arc<Tunnel>>>>,
    pub draining: Arc<AtomicBool>,
}

impl std::fmt::Debug for HubContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HubContext")
            .field("cfg", &self.cfg)
            .finish_non_exhaustive()
    }
}

fn broadcast_snapshot(reg: &Registry<Arc<Tunnel>>, key: &SetKey) {
    let Some(snap) = reg.snapshot_by_key(key) else {
        return;
    };
    let members = reg.members_of(key);
    for (fqdn, holder) in &snap.slot_holders {
        let f = payload::domain_granted_frame(fqdn, holder);
        for t in &members {
            t.send_control(f.clone());
        }
    }
}

enum Step {
    Continue,
    Close(u16, &'static str),
}

struct Session {
    ctx: HubContext,
    tunnel: Arc<Tunnel>,
    registered: Option<String>,
    last_issued_at: f64,
    decoder: FrameDecoder,
}

impl Session {
    fn ack(&self, ok: bool, reason: Option<&str>, trust: Option<&HelloAckTrust>, caps: &[&str]) {
        self.tunnel
            .send_control(payload::hello_ack_frame(ok, reason, trust, caps));
    }

    fn capabilities(&self, offered: &[String]) -> (Vec<&'static str>, Negotiated) {
        let wants = |c: &str| offered.iter().any(|o| o == c);
        let n = Negotiated {
            stream_credit: self.ctx.cfg.offer_stream_credit && wants(CAPABILITY_STREAM_CREDIT_V1),
            drain: self.ctx.cfg.offer_drain && wants(CAPABILITY_DRAIN_V1),
        };
        let mut caps = Vec::new();
        if n.stream_credit {
            caps.push(CAPABILITY_STREAM_CREDIT_V1);
        }
        if n.drain {
            caps.push(CAPABILITY_DRAIN_V1);
        }
        (caps, n)
    }

    async fn admit(&self, h: &ParsedHello) -> Result<Vec<String>, AuthFailure> {
        hello::structural_checks(
            h,
            now_ms(),
            self.ctx.cfg.max_hello_age_ms,
            &self.ctx.cfg.apex,
        )?;
        let verified = self.ctx.authority.authenticate(h, now_ms()).await?;
        if self.ctx.authority.evicted(h).await {
            return Err(AuthFailure::new("replaced", 1008));
        }
        let grants: Vec<&hello::AppGrant> = verified
            .iter()
            .filter_map(|i| h.app_grants.get(*i))
            .collect();
        let hosts = hello::app_grant_hosts(&grants);
        hello::build_claimed_canonicals(
            &h.root_entitlement.pod_canonical,
            h.service_entitlement.as_ref(),
            &hosts,
            &h.root_entitlement.username,
            &self.ctx.cfg.apex,
        )
        .map_err(|r| AuthFailure::new(r, 1008))
    }

    fn register(&mut self, pc: &str, canonicals: &[String]) {
        let Ok(mut reg) = self.ctx.registry.lock() else {
            return;
        };
        let r = reg.register(pc, self.tunnel.clone(), canonicals, now_ms() as u64);
        for k in &r.affected_sets {
            broadcast_snapshot(&reg, k);
        }
    }

    async fn on_frame(&mut self, f: Frame) -> Step {
        let Some(pc) = self.registered.clone() else {
            return self.on_first_frame(f).await;
        };
        match f.frame_type {
            FRAME_HELLO => self.on_hello_refresh(&pc, &f.payload).await,
            FRAME_REQUEST_TRANSFER => {
                if let Some(fqdn) = payload::parse_request_transfer(&f.payload)
                    && let Ok(mut reg) = self.ctx.registry.lock()
                    && let Ok((key, _)) = reg.request_transfer(&pc, &fqdn)
                {
                    broadcast_snapshot(&reg, &key);
                }
                Step::Continue
            }
            FRAME_OUTBOUND_OPEN => {
                self.tunnel.send_control(payload::outbound_result_frame(
                    f.stream_id,
                    false,
                    Some("disabled"),
                ));
                Step::Continue
            }
            FRAME_OUTBOUND_CREDIT => Step::Continue,
            FRAME_DATA | FRAME_CLOSE | FRAME_CLOSE_REMOTE if is_outbound_stream_id(f.stream_id) => {
                Step::Continue
            }
            FRAME_DATA => {
                self.on_data(f.stream_id, f.payload, &pc).await;
                Step::Continue
            }
            FRAME_CLOSE | FRAME_CLOSE_REMOTE => {
                self.tunnel.remote_close(f.stream_id, false);
                Step::Continue
            }
            FRAME_STREAM_CREDIT => {
                if let Some(n) = payload::parse_credit(&f.payload) {
                    if let Ok(mut s) = self.tunnel.state.lock() {
                        s.data.grant(f.stream_id, n);
                    }
                    self.tunnel.wake.notify_one();
                }
                Step::Continue
            }
            _ => Step::Continue,
        }
    }

    async fn on_first_frame(&mut self, f: Frame) -> Step {
        if f.frame_type != FRAME_HELLO {
            self.ack(false, Some("expected HELLO as first frame"), None, &[]);
            return Step::Close(1002, "no HELLO");
        }
        let h = match hello::parse_hello(&f.payload) {
            Ok(h) => h,
            Err(r) => {
                self.ack(false, Some(r), None, &[]);
                return Step::Close(1002, "bad HELLO");
            }
        };
        let canonicals = match self.admit(&h).await {
            Ok(c) => c,
            Err(e) => {
                self.ack(false, Some(&e.reason), None, &[]);
                return Step::Close(e.close_code, "auth failed");
            }
        };
        let pc = h.root_entitlement.pod_canonical.clone();
        let (caps, negotiated) = self.capabilities(&h.capabilities);
        if let Ok(mut s) = self.tunnel.state.lock() {
            s.negotiated = negotiated;
            s.pod_canonical = Some(pc.clone());
        }
        self.decoder.set_types(TypeSet {
            drain_notice: false,
            stream_credit: negotiated.stream_credit,
        });
        self.registered = Some(pc.clone());
        self.last_issued_at = h.issued_at;
        let trust = self
            .ctx
            .blessing
            .as_ref()
            .and_then(|b| b.trust_for(&h.nonce_hex));
        self.ack(true, None, trust.as_ref(), &caps);
        self.register(&pc, &canonicals);
        Step::Continue
    }

    async fn on_hello_refresh(&mut self, pc: &str, payload: &[u8]) -> Step {
        let h = match hello::parse_hello(payload) {
            Ok(h) => h,
            Err(r) => {
                self.ack(false, Some(r), None, &[]);
                return Step::Continue;
            }
        };
        if h.root_entitlement.pod_canonical != pc {
            self.ack(false, Some("HELLO podCanonical changed mid-WS"), None, &[]);
            return Step::Close(1008, "podCanonical changed");
        }
        if h.issued_at <= self.last_issued_at {
            self.ack(
                false,
                Some("HELLO issuedAt did not advance (replay?)"),
                None,
                &[],
            );
            return Step::Continue;
        }
        let canonicals = match self.admit(&h).await {
            Ok(c) => c,
            Err(e) if e.reason == "replaced" => {
                self.ack(false, Some("replaced"), None, &[]);
                return Step::Close(1008, "replaced");
            }
            Err(e) => {
                self.ack(false, Some(&e.reason), None, &[]);
                return Step::Continue;
            }
        };
        self.last_issued_at = h.issued_at;
        let negotiated = self.tunnel.negotiated();
        let mut caps = Vec::new();
        if negotiated.stream_credit {
            caps.push(CAPABILITY_STREAM_CREDIT_V1);
        }
        if negotiated.drain {
            caps.push(CAPABILITY_DRAIN_V1);
        }
        let trust = self
            .ctx
            .blessing
            .as_ref()
            .and_then(|b| b.trust_for(&h.nonce_hex));
        self.ack(true, None, trust.as_ref(), &caps);
        self.register(pc, &canonicals);
        Step::Continue
    }

    async fn on_data(&mut self, id: u32, data: Vec<u8>, pc: &str) {
        let n = data.len();
        let (down, credited) = {
            let Ok(mut s) = self.tunnel.state.lock() else {
                return;
            };
            let Some(e) = s.streams.get_mut(&id) else {
                return;
            };
            if e.remote_closed {
                return;
            }
            let overrun = e.recv.as_mut().is_some_and(|r| r.on_data(n).is_err());
            if overrun {
                drop(s);
                self.kill_stream(id);
                return;
            }
            (e.down.clone(), e.recv.is_some())
        };
        let pushed = if credited {
            down.try_push(data).map_err(|(e, _)| e)
        } else {
            down.push_within(data, self.ctx.cfg.slow_receiver_grace)
                .await
        };
        match pushed {
            Ok(()) => {}
            Err(PushError::Full) => {
                self.kill_stream(id);
                return;
            }
            Err(PushError::Closed) => return,
        }
        if let Some(m) = &self.ctx.meter {
            let account = account_from_canonical(pc, &self.ctx.cfg.apex);
            m.add(account.as_deref(), n);
            let wait = m.throttle_delay(account.as_deref(), n);
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
        }
    }

    /// A stream broke its bounds (slow visitor under v1, or credit overrun): drop the
    /// visitor and tell the box.
    fn kill_stream(&self, id: u32) {
        self.tunnel.remote_close(id, true);
        if let Ok(mut s) = self.tunnel.state.lock() {
            s.streams.remove(&id);
        }
        self.tunnel
            .send_control(Frame::new(id, FRAME_CLOSE, Vec::new()));
    }
}

/// Run one tunnel over an accepted WebSocket until it closes.
pub async fn run_tunnel<S>(ws: WebSocketStream<S>, ctx: HubContext)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let tunnel = Tunnel::new(ctx.cfg.clone());
    if let Ok(mut live) = ctx.live.lock() {
        live.insert(tunnel.id, tunnel.clone());
    }
    let (mut sink, mut stream) = ws.split();
    let flush = Arc::new(Notify::new());
    let close_frame: Arc<Mutex<Option<(u16, &'static str)>>> = Arc::new(Mutex::new(None));

    let writer = {
        let tunnel = tunnel.clone();
        let flush = flush.clone();
        let close_frame = close_frame.clone();
        let max = ctx.cfg.max_ws_message.min(WRITE_BATCH_BYTES);
        tokio::spawn(async move {
            loop {
                let woke = tunnel.wake.notified();
                let flushed = flush.notified();
                let batch = tunnel.next_batch(max);
                if !batch.is_empty() {
                    if sink.send(Message::Binary(batch.into())).await.is_err() {
                        break;
                    }
                    continue;
                }
                if tunnel.is_closed() {
                    break;
                }
                tokio::select! {
                    _ = woke => {}
                    _ = flushed => {
                        if sink.flush().await.is_err() {
                            break;
                        }
                    }
                }
            }
            let frame = close_frame.lock().ok().and_then(|c| *c);
            let msg = frame.map(|(code, reason)| CloseFrame {
                code: CloseCode::from(code),
                reason: reason.into(),
            });
            let _ = sink.send(Message::Close(msg)).await;
            let _ = sink.close().await;
        })
    };

    let mut session = Session {
        ctx: ctx.clone(),
        tunnel: tunnel.clone(),
        registered: None,
        last_issued_at: 0.0,
        decoder: FrameDecoder::new(TypeSet::V1, ctx.cfg.max_ws_message),
    };
    let mut closed = tunnel.closed_signal();
    'read: loop {
        let msg = tokio::select! {
            m = stream.next() => m,
            _ = closed.changed() => break 'read,
        };
        let bytes = match msg {
            Some(Ok(Message::Binary(b))) => b.to_vec(),
            Some(Ok(Message::Text(t))) => t.as_bytes().to_vec(),
            Some(Ok(Message::Ping(_))) => {
                flush.notify_one();
                continue;
            }
            Some(Ok(Message::Pong(_) | Message::Frame(_))) => continue,
            Some(Ok(Message::Close(_)) | Err(_)) | None => break,
        };
        if session.decoder.push(&bytes).is_err() {
            session.ack(false, Some("frame decode error"), None, &[]);
            set_close(&close_frame, 1002, "frame decode error");
            break;
        }
        loop {
            match session.decoder.next_frame() {
                Ok(Some(f)) => {
                    if let Step::Close(code, why) = session.on_frame(f).await {
                        set_close(&close_frame, code, why);
                        break 'read;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    session.ack(false, Some(&e.0), None, &[]);
                    set_close(&close_frame, 1002, "frame decode error");
                    break 'read;
                }
            }
        }
    }

    // When the hub refused the box, let the queued ack reach it before the socket goes; when
    // the box went away, close at once so nothing is routed to a dead tunnel meanwhile.
    let refused = close_frame.lock().is_ok_and(|c| c.is_some());
    if refused {
        if let Ok(mut s) = tunnel.state.lock() {
            s.data = FairQueue::new(DEFAULT_QUANTUM);
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            while !writer.is_finished() && tunnel.state.lock().is_ok_and(|s| !s.control.is_empty())
            {
                tunnel.wake.notify_one();
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
    }
    tunnel.close();
    if let Some(pc) = &session.registered
        && let Ok(mut reg) = ctx.registry.lock()
    {
        let id = tunnel.id;
        if let Some(r) = reg.unregister_if(pc, |t| t.id == id) {
            for k in &r.affected_sets {
                broadcast_snapshot(&reg, k);
            }
        }
    }
    if let Ok(mut live) = ctx.live.lock() {
        live.remove(&tunnel.id);
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), writer).await;
}

fn set_close(c: &Mutex<Option<(u16, &'static str)>>, code: u16, why: &'static str) {
    if let Ok(mut g) = c.lock()
        && g.is_none()
    {
        *g = Some((code, why));
    }
}

/// Send `DRAIN_NOTICE {graceMs}` to every tunnel that negotiated `drain-v1`; a v1 box would
/// treat the frame as a protocol error, so it gets nothing and simply sees the close.
pub fn announce_drain(live: &Mutex<HashMap<u64, Arc<Tunnel>>>, grace: Duration) -> usize {
    let tunnels: Vec<Arc<Tunnel>> = live
        .lock()
        .map(|l| l.values().cloned().collect())
        .unwrap_or_default();
    let body = format!("{{\"graceMs\":{}}}", grace.as_millis());
    let mut n = 0usize;
    for t in tunnels {
        if t.negotiated().drain {
            t.send_control(Frame::new(0, FRAME_DRAIN_NOTICE, body.clone().into_bytes()));
            n = n.saturating_add(1);
        }
    }
    n
}

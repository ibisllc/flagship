//! The hub side of box-initiated outbound streams (`outboundRelay.ts`, `docs/ai-privacy-and-staging.md` section 4). An
//! authenticated box asks for `host:443`; the relay resolves the name, refuses anything that is not a public unicast
//! address, connects, and splices bytes under the credit window. The box runs TLS end to end with the destination, so the relay
//! only ever sees ciphertext. It logs only totals across every box (streams per destination, bytes, refusals by reason): a
//! per-call line could be matched to one box's activity, so there is none.

// Statistics counters: a u64 total of streams or bytes cannot realistically overflow.
#![allow(clippy::arithmetic_side_effects)]

use std::collections::HashMap;
use std::io;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use super::budget::{BoxBudget, Limits};
use super::policy::{is_public_unicast, vet_outbound_host};
use crate::authority::BoxFut;
use crate::frame::{
    FRAME_CLOSE, FRAME_CLOSE_REMOTE, FRAME_DATA, FRAME_OUTBOUND_CREDIT, FRAME_OUTBOUND_OPEN, Frame,
};
use crate::payload::{self, OUTBOUND_INITIAL_WINDOW, OUTBOUND_MAX_CHUNK, is_outbound_stream_id};

/// Frames to the box. The hub's tunnel implements it.
pub trait Sink: Send + Sync + 'static {
    fn send(&self, f: Frame);
}

pub trait Resolve: Send + Sync + 'static {
    /// Every address record of `host`; `Err` when the name does not resolve.
    fn resolve<'a>(&'a self, host: &'a str) -> BoxFut<'a, Result<Vec<IpAddr>, ()>>;
}

pub trait Connect: Send + Sync + 'static {
    fn connect<'a>(&'a self, addr: IpAddr, port: u16) -> BoxFut<'a, io::Result<TcpStream>>;
}

/// Which hosts may be reached (`docs/outbound-hosts.md`).
pub trait HostPolicy: Send + Sync + 'static {
    fn allowed<'a>(&'a self, host: &'a str) -> BoxFut<'a, bool>;
    /// Per-host totals across every box; best effort.
    fn report(&self, rows: Vec<HostRow>);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostRow {
    pub host: String,
    pub streams: u64,
    pub up: u64,
    pub down: u64,
    pub refused: u64,
}

/// The system resolver and a plain TCP connect.
#[derive(Debug, Default, Clone, Copy)]
pub struct System;

impl Resolve for System {
    fn resolve<'a>(&'a self, host: &'a str) -> BoxFut<'a, Result<Vec<IpAddr>, ()>> {
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((host, 0)).await.map_err(|_| ())?;
            Ok(addrs.map(|a| a.ip()).collect())
        })
    }
}

impl Connect for System {
    fn connect<'a>(&'a self, addr: IpAddr, port: u16) -> BoxFut<'a, io::Result<TcpStream>> {
        Box::pin(TcpStream::connect((addr, port)))
    }
}

/// No `.com` to ask: the known AI providers and nothing else.
#[derive(Debug, Default, Clone, Copy)]
pub struct KnownHostsPolicy;

impl HostPolicy for KnownHostsPolicy {
    fn allowed<'a>(&'a self, host: &'a str) -> BoxFut<'a, bool> {
        Box::pin(async move {
            super::budget::KNOWN_AI_HOSTS.contains(&host.to_ascii_lowercase().as_str())
        })
    }
    fn report(&self, _rows: Vec<HostRow>) {}
}

#[derive(Debug, Clone)]
pub struct Options {
    pub max_streams_per_box: usize,
    pub limits: Limits,
    pub connect_timeout: Duration,
    pub idle_timeout: Duration,
    pub allowed_ports: Vec<u16>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            max_streams_per_box: 8,
            limits: Limits::default(),
            connect_timeout: Duration::from_secs(10),
            idle_timeout: Duration::from_secs(300),
            allowed_ports: vec![443],
        }
    }
}

/// Hosts totalled per flush; more than this in 15 minutes are not counted by name.
const MAX_HOSTS_PER_FLUSH: usize = 500;

#[derive(Debug, Default)]
struct HostTotals {
    streams: u64,
    up: u64,
    down: u64,
    refused: u64,
}

#[derive(Debug, Default)]
struct Stats {
    streams: u64,
    by_destination: HashMap<String, u64>,
    by_host: HashMap<String, HostTotals>,
    up: u64,
    down: u64,
    refused: HashMap<String, u64>,
}

/// Provider API hosts counted by name; a suffix entry (leading `.`) covers a whole zone.
const KNOWN_LABELS: [(&str, &str); 17] = [
    ("api.openai.com", "api.openai.com"),
    ("api.anthropic.com", "api.anthropic.com"),
    (
        "generativelanguage.googleapis.com",
        "generativelanguage.googleapis.com",
    ),
    ("aiplatform.googleapis.com", "vertex-ai"),
    ("openrouter.ai", "openrouter.ai"),
    ("api.mistral.ai", "api.mistral.ai"),
    ("api.groq.com", "api.groq.com"),
    ("api.together.xyz", "api.together.xyz"),
    ("api.deepseek.com", "api.deepseek.com"),
    ("api.x.ai", "api.x.ai"),
    ("api.fireworks.ai", "api.fireworks.ai"),
    ("api.perplexity.ai", "api.perplexity.ai"),
    ("api.cohere.com", "api.cohere.com"),
    ("api.cerebras.ai", "api.cerebras.ai"),
    ("router.huggingface.co", "huggingface"),
    (".openai.azure.com", "azure-openai"),
    (".amazonaws.com", "aws"),
];

/// The name a destination is counted under in the totals: a known provider by name, everything else as `other`.
#[must_use]
pub fn destination_label(host: &str) -> &'static str {
    let h = host.to_ascii_lowercase();
    for (m, label) in KNOWN_LABELS {
        if m.starts_with('.') {
            if h.ends_with(m) {
                return label;
            }
        } else if h == m {
            return label;
        }
    }
    "other"
}

pub struct OutboundRelay {
    o: Options,
    budgets: Mutex<HashMap<String, Arc<Mutex<BoxBudget>>>>,
    stats: Mutex<Stats>,
    resolver: Arc<dyn Resolve>,
    connector: Arc<dyn Connect>,
    policy: Arc<dyn HostPolicy>,
}

impl std::fmt::Debug for OutboundRelay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutboundRelay")
            .field("options", &self.o)
            .finish_non_exhaustive()
    }
}

impl OutboundRelay {
    pub fn new(
        o: Options,
        resolver: Arc<dyn Resolve>,
        connector: Arc<dyn Connect>,
        policy: Arc<dyn HostPolicy>,
    ) -> Arc<Self> {
        Arc::new(Self {
            o,
            budgets: Mutex::new(HashMap::new()),
            stats: Mutex::new(Stats::default()),
            resolver,
            connector,
            policy,
        })
    }

    /// Logs and resets the totals since the last flush; `None` when idle. Per-host totals go to the policy (`.com`).
    pub fn flush_stats(&self) -> Option<String> {
        let t = std::mem::take(&mut *self.stats.lock().ok()?);
        if t.streams == 0 && t.refused.is_empty() {
            return None;
        }
        let list = |m: &HashMap<String, u64>| {
            let mut v: Vec<_> = m.iter().collect();
            v.sort();
            v.iter()
                .map(|(k, n)| format!("{k}:{n}"))
                .collect::<Vec<_>>()
                .join(",")
        };
        let (to, refused) = (list(&t.by_destination), list(&t.refused));
        let line = format!(
            "[outbound-relay] streams={}{} up={} down={}{}",
            t.streams,
            if to.is_empty() {
                String::new()
            } else {
                format!(" to={to}")
            },
            t.up,
            t.down,
            if refused.is_empty() {
                String::new()
            } else {
                format!(" refused={refused}")
            },
        );
        let rows: Vec<HostRow> = t
            .by_host
            .into_iter()
            .map(|(host, v)| HostRow {
                host,
                streams: v.streams,
                up: v.up,
                down: v.down,
                refused: v.refused,
            })
            .collect();
        if !rows.is_empty() {
            self.policy.report(rows);
        }
        Some(line)
    }

    /// One session per authenticated tunnel. Budgets are keyed by the box's verified pod canonical.
    pub fn session(self: &Arc<Self>, pod_canonical: &str, sink: Arc<dyn Sink>) -> OutboundSession {
        let key = pod_canonical.to_ascii_lowercase();
        let budget = {
            let mut m = self
                .budgets
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            Arc::clone(
                m.entry(key.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(BoxBudget::new(self.o.limits)))),
            )
        };
        if let Ok(mut b) = budget.lock() {
            b.sessions = b.sessions.saturating_add(1);
        }
        OutboundSession {
            relay: Arc::clone(self),
            key,
            budget,
            sink,
            streams: Arc::new(Mutex::new(HashMap::new())),
            closed: AtomicBool::new(false),
        }
    }

    fn count_refusal(&self, reason: &str) {
        if let Ok(mut s) = self.stats.lock() {
            *s.refused.entry(reason.to_owned()).or_default() += 1;
        }
    }

    fn host_totals<R>(&self, host: &str, f: impl FnOnce(&mut HostTotals) -> R) -> Option<R> {
        let mut s = self.stats.lock().ok()?;
        if !s.by_host.contains_key(host) && s.by_host.len() >= MAX_HOSTS_PER_FLUSH {
            return None;
        }
        Some(f(s.by_host.entry(host.to_owned()).or_default()))
    }
}

enum Cmd {
    Data(Vec<u8>),
    Credit(u32),
    BoxClose,
}

pub struct OutboundSession {
    relay: Arc<OutboundRelay>,
    key: String,
    budget: Arc<Mutex<BoxBudget>>,
    sink: Arc<dyn Sink>,
    streams: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<Cmd>>>>,
    closed: AtomicBool,
}

impl std::fmt::Debug for OutboundSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutboundSession")
            .field("box", &self.key)
            .finish_non_exhaustive()
    }
}

impl OutboundSession {
    #[must_use]
    pub fn active_streams(&self) -> usize {
        self.streams.lock().map_or(0, |m| m.len())
    }

    /// Handles an outbound-space frame. Returns false when it is not one.
    pub fn handle_frame(&self, f: Frame) -> bool {
        if f.frame_type == FRAME_OUTBOUND_OPEN {
            self.on_open(&f);
            return true;
        }
        if !is_outbound_stream_id(f.stream_id) {
            return false;
        }
        let cmd = match f.frame_type {
            FRAME_OUTBOUND_CREDIT => payload::parse_credit(&f.payload).map(Cmd::Credit),
            FRAME_DATA => Some(Cmd::Data(f.payload)),
            FRAME_CLOSE | FRAME_CLOSE_REMOTE => Some(Cmd::BoxClose),
            _ => return false,
        };
        if let Some(cmd) = cmd
            && let Ok(m) = self.streams.lock()
            && let Some(tx) = m.get(&f.stream_id)
        {
            let _ = tx.send(cmd);
        }
        true
    }

    /// The tunnel closed: drop every upstream without telling the box.
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut m) = self.streams.lock() {
            m.clear();
        }
        if let Ok(mut b) = self.budget.lock() {
            b.sessions = b.sessions.saturating_sub(1);
            if b.sessions == 0 && b.streams == 0 {
                drop(b);
                if let Ok(mut all) = self.relay.budgets.lock() {
                    all.remove(&self.key);
                }
            }
        }
    }

    fn refuse(&self, stream_id: u32, reason: &str) {
        self.relay.count_refusal(reason);
        self.sink.send(payload::outbound_result_frame(
            stream_id,
            false,
            Some(reason),
        ));
    }

    fn on_open(&self, f: &Frame) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let Some(req) =
            payload::parse_outbound_open(&f.payload).filter(|_| is_outbound_stream_id(f.stream_id))
        else {
            return self.refuse(f.stream_id, "bad-request");
        };
        let host = vet_outbound_host(&req.host);
        if self
            .streams
            .lock()
            .is_ok_and(|m| m.contains_key(&f.stream_id))
        {
            return self.refuse(f.stream_id, "duplicate-stream");
        }
        if !self.relay.o.allowed_ports.contains(&req.port) {
            return self.refuse(f.stream_id, "forbidden-port");
        }
        let Some(host) = host else {
            return self.refuse(f.stream_id, "forbidden-host");
        };
        {
            let Ok(mut b) = self.budget.lock() else {
                return self.refuse(f.stream_id, "rate-limited");
            };
            if b.streams >= self.relay.o.max_streams_per_box {
                drop(b);
                return self.refuse(f.stream_id, "too-many-streams");
            }
            if !b.opens.try_take(1.0) {
                drop(b);
                return self.refuse(f.stream_id, "rate-limited");
            }
            b.streams = b.streams.saturating_add(1);
        }
        let (tx, rx) = mpsc::unbounded_channel();
        if let Ok(mut m) = self.streams.lock() {
            m.insert(f.stream_id, tx);
        }
        let run = StreamRun {
            relay: Arc::clone(&self.relay),
            budget: Arc::clone(&self.budget),
            sink: Arc::clone(&self.sink),
            streams: Arc::clone(&self.streams),
            id: f.stream_id,
            host,
            port: req.port,
        };
        tokio::spawn(run.go(rx));
    }
}

struct StreamRun {
    relay: Arc<OutboundRelay>,
    budget: Arc<Mutex<BoxBudget>>,
    sink: Arc<dyn Sink>,
    streams: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<Cmd>>>>,
    id: u32,
    host: String,
    port: u16,
}

#[derive(Default)]
struct Totals {
    up: u64,
    down: u64,
}

impl StreamRun {
    fn fail(&self, reason: &str) {
        self.relay.count_refusal(reason);
        self.relay.host_totals(&self.host, |h| h.refused += 1);
        self.sink
            .send(payload::outbound_result_frame(self.id, false, Some(reason)));
    }

    /// End of a stream that connected: totals, and CLOSE_REMOTE when the box did not close it.
    fn finish(&self, t: &Totals, notify_box: bool) {
        if notify_box {
            self.sink
                .send(Frame::new(self.id, FRAME_CLOSE_REMOTE, Vec::new()));
        }
        if let Ok(mut s) = self.relay.stats.lock() {
            s.streams += 1;
            *s.by_destination
                .entry(destination_label(&self.host).to_owned())
                .or_default() += 1;
            s.up += t.up;
            s.down += t.down;
        }
        self.relay.host_totals(&self.host, |h| {
            h.streams += 1;
            h.up += t.up;
            h.down += t.down;
        });
    }

    async fn spend(&self, n: usize) {
        let wait = self
            .budget
            .lock()
            .map_or(Duration::ZERO, |mut b| b.bytes.spend(n as f64));
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }

    async fn dial(&self, rx: &mut mpsc::UnboundedReceiver<Cmd>) -> Option<TcpStream> {
        let o = &self.relay.o;
        let admitted = self
            .budget
            .lock()
            .is_ok_and(|mut b| b.admit_host(&self.host));
        if !admitted || !self.relay.policy.allowed(&self.host).await {
            self.fail("forbidden-host");
            return None;
        }
        let addrs = match self.relay.resolver.resolve(&self.host).await {
            Ok(a) if !a.is_empty() => a,
            _ => {
                self.fail("dns-failed");
                return None;
            }
        };
        // Every record must be public: a name with one private record is refused outright rather than "picking the safe
        // one", so it cannot be steered.
        if !addrs.iter().all(|a| is_public_unicast(&a.to_string())) {
            self.fail("forbidden-address");
            return None;
        }
        let Some(first) = addrs.first().copied() else {
            self.fail("dns-failed");
            return None;
        };
        let connect = tokio::time::timeout(
            o.connect_timeout,
            self.relay.connector.connect(first, self.port),
        );
        tokio::pin!(connect);
        loop {
            tokio::select! {
                r = &mut connect => {
                    return match r {
                        Ok(Ok(s)) => Some(s),
                        _ => { self.fail("connect-failed"); None }
                    };
                }
                cmd = rx.recv() => {
                    // The box gave up (or broke the protocol) before the connection opened.
                    if matches!(cmd, None | Some(Cmd::BoxClose | Cmd::Data(_))) {
                        return None;
                    }
                }
            }
        }
    }

    async fn go(self, mut rx: mpsc::UnboundedReceiver<Cmd>) {
        let _guard = Guard {
            streams: Arc::clone(&self.streams),
            budget: Arc::clone(&self.budget),
            relay: Arc::clone(&self.relay),
            id: self.id,
        };
        let Some(stream) = self.dial(&mut rx).await else {
            return;
        };
        self.sink
            .send(payload::outbound_result_frame(self.id, true, None));
        let (mut rd, mut wr) = stream.into_split();
        let window = u64::from(OUTBOUND_INITIAL_WINDOW);
        let mut credit: u64 = window;
        let mut outstanding: u64 = 0;
        let mut t = Totals::default();
        let mut buf = vec![0u8; OUTBOUND_MAX_CHUNK];
        let idle = self.relay.o.idle_timeout;
        loop {
            let room = usize::try_from(credit.min(OUTBOUND_MAX_CHUNK as u64)).unwrap_or(0);
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    // The session closed: drop the upstream without telling the box.
                    None => return self.finish(&t, false),
                    Some(Cmd::Credit(n)) => credit = (credit + u64::from(n)).min(window * 4),
                    Some(Cmd::BoxClose) => {
                        let _ = wr.shutdown().await;
                        return self.finish(&t, false);
                    }
                    Some(Cmd::Data(bytes)) => {
                        let n = bytes.len() as u64;
                        if outstanding + n > window {
                            // Past the window: the box broke the protocol. Drop the stream rather than buffer without bound.
                            return self.finish(&t, true);
                        }
                        if n == 0 { continue; }
                        outstanding += n;
                        t.up += n;
                        if wr.write_all(&bytes).await.is_err() { return self.finish(&t, true); }
                        self.spend(bytes.len()).await;
                        outstanding -= n;
                        if let Ok(f) = payload::outbound_credit_frame(self.id, u32::try_from(n).unwrap_or(u32::MAX)) {
                            self.sink.send(f);
                        }
                    }
                },
                r = rd.read(buf.get_mut(..room).unwrap_or(&mut [])), if room > 0 => match r {
                    Ok(0) | Err(_) => return self.finish(&t, true),
                    Ok(n) => {
                        t.down += n as u64;
                        credit -= n as u64;
                        self.sink.send(Frame::new(self.id, FRAME_DATA, buf.get(..n).unwrap_or(&[]).to_vec()));
                        self.spend(n).await;
                    }
                },
                () = tokio::time::sleep(idle) => return self.finish(&t, true),
            }
        }
    }
}

/// Releases the stream's slot however the task ends.
struct Guard {
    streams: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<Cmd>>>>,
    budget: Arc<Mutex<BoxBudget>>,
    relay: Arc<OutboundRelay>,
    id: u32,
}

impl Drop for Guard {
    fn drop(&mut self) {
        if let Ok(mut m) = self.streams.lock() {
            m.remove(&self.id);
        }
        if let Ok(mut b) = self.budget.lock() {
            b.streams = b.streams.saturating_sub(1);
        }
        let _ = &self.relay;
    }
}

//! Raw-TCP SNI router (`apps/web/src/tunnel/sniRouter.ts`): peek the ClientHello, pick the
//! tunnel, splice. TLS is never terminated here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, watch};

use crate::hub::{SharedRegistry, StreamHandle, Tunnel};
use crate::sni::{ClientHelloReader, SniLimits, SniStatus};
use crate::throttle::{Meter, account_from_canonical};

pub const HOLD_TIMEOUT: Duration = Duration::from_secs(4);
pub const HOLD_POLL_INTERVAL: Duration = Duration::from_millis(100);
pub const MAX_DELAYED_DROPS: usize = 2048;
pub const NUDGE_BOX_PATH: &str = "/internal/route-nudge";

#[derive(Debug, Clone)]
pub struct RouterConfig {
    pub sni: SniLimits,
    pub hold_timeout: Duration,
    pub hold_poll_interval: Duration,
    pub max_delayed_drops: usize,
    /// ClientHellos being read at once; past it new connections are refused at accept.
    pub max_pending_hellos: usize,
    /// Bytes a parked visitor may send before its claim lands.
    pub max_parked_bytes: usize,
    pub read_chunk: usize,
    pub apex: String,
}

impl Default for RouterConfig {
    fn default() -> Self {
        Self {
            sni: SniLimits::default(),
            hold_timeout: HOLD_TIMEOUT,
            hold_poll_interval: HOLD_POLL_INTERVAL,
            max_delayed_drops: MAX_DELAYED_DROPS,
            max_pending_hellos: 4096,
            max_parked_bytes: 64 * 1024,
            read_chunk: 16 * 1024,
            apex: crate::allocator::DEFAULT_APEX.to_owned(),
        }
    }
}

/// `routerStats`: counters only.
#[derive(Debug, Default)]
pub struct RouterStats {
    pub routed: AtomicU64,
    pub bad: AtomicU64,
    pub parked: AtomicU64,
    pub released: AtomicU64,
    pub hold_timeouts: AtomicU64,
    pub no_box_registered: AtomicU64,
    pub no_user: AtomicU64,
    pub refused_busy: AtomicU64,
    pub peek_timeouts: AtomicU64,
}

fn bump(c: &AtomicU64) {
    c.fetch_add(1, Ordering::Relaxed);
}

/// Domain → the claim its single park group is waiting for.
type ParkLot = HashMap<String, watch::Receiver<Option<Arc<Tunnel>>>>;

#[derive(Clone)]
pub struct Router {
    pub cfg: Arc<RouterConfig>,
    pub registry: SharedRegistry,
    pub meter: Option<Arc<dyn Meter>>,
    pub stats: Arc<RouterStats>,
    delayed: Arc<AtomicUsize>,
    pending: Arc<Semaphore>,
    /// Single-flight park groups: one nudge + one poll per unresolved domain.
    parked: Arc<Mutex<ParkLot>>,
    active: Arc<AtomicUsize>,
}

impl std::fmt::Debug for Router {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Router")
            .field("cfg", &self.cfg)
            .finish_non_exhaustive()
    }
}

enum Peek {
    Hello(String, Vec<u8>),
    Drop,
}

impl Router {
    pub fn new(cfg: RouterConfig, registry: SharedRegistry, meter: Option<Arc<dyn Meter>>) -> Self {
        let pending = Arc::new(Semaphore::new(cfg.max_pending_hellos.max(1)));
        Self {
            cfg: Arc::new(cfg),
            registry,
            meter,
            stats: Arc::new(RouterStats::default()),
            delayed: Arc::new(AtomicUsize::new(0)),
            pending,
            parked: Arc::new(Mutex::new(HashMap::new())),
            active: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Visitor connections currently spliced to a tunnel.
    pub fn active_streams(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }

    pub async fn run(self, listener: TcpListener, mut stop: watch::Receiver<bool>) {
        loop {
            tokio::select! {
                _ = stop.changed() => return,
                r = listener.accept() => {
                    let Ok((sock, _)) = r else { continue };
                    let Ok(permit) = self.pending.clone().try_acquire_owned() else {
                        bump(&self.stats.refused_busy);
                        drop(sock);
                        continue;
                    };
                    let me = self.clone();
                    tokio::spawn(async move { me.handle(sock, permit).await });
                }
            }
        }
    }

    async fn peek(&self, sock: &mut TcpStream) -> Peek {
        let mut reader = ClientHelloReader::new(self.cfg.sni);
        let mut chunk = vec![0u8; self.cfg.read_chunk.max(1)];
        let read = async {
            loop {
                let n = match sock.read(&mut chunk).await {
                    Ok(0) | Err(_) => return None,
                    Ok(n) => n,
                };
                match reader.push(chunk.get(..n).unwrap_or_default()) {
                    SniStatus::NeedMore(_) => continue,
                    SniStatus::Reject(_) => return Some(None),
                    SniStatus::Done(info) => return Some(Some(info.sni.clone())),
                }
            }
        };
        match tokio::time::timeout(self.cfg.sni.deadline, read).await {
            Err(_) => {
                bump(&self.stats.peek_timeouts);
                Peek::Drop
            }
            Ok(None) => Peek::Drop,
            Ok(Some(None)) | Ok(Some(Some(None))) => {
                bump(&self.stats.bad);
                Peek::Drop
            }
            Ok(Some(Some(Some(sni)))) => Peek::Hello(sni, reader.into_raw()),
        }
    }

    async fn handle(&self, mut sock: TcpStream, permit: tokio::sync::OwnedSemaphorePermit) {
        let peeked = self.peek(&mut sock).await;
        drop(permit);
        let Peek::Hello(sni, initial) = peeked else {
            return;
        };
        let (found, nudgeable, user) = match self.registry.lock() {
            Ok(r) => (
                r.find_by_sni(&sni),
                r.is_nudgeable_sni(&sni),
                r.user_of_sni(&sni),
            ),
            Err(_) => return,
        };
        if let Some(t) = found {
            bump(&self.stats.routed);
            self.pipe(sock, t, &sni, initial).await;
            return;
        }
        if nudgeable {
            self.park(sock, sni, initial, user).await;
            return;
        }
        if user.is_some() {
            bump(&self.stats.no_box_registered);
            self.delayed_drop(sock).await;
            return;
        }
        bump(&self.stats.no_user);
    }

    /// Hold a first-party miss for the same time a parked one waits, then close, saying
    /// nothing: the close time tells a prober nothing about the account.
    async fn delayed_drop(&self, mut sock: TcpStream) {
        let prev = self.delayed.fetch_add(1, Ordering::AcqRel);
        if prev >= self.cfg.max_delayed_drops {
            self.delayed.fetch_sub(1, Ordering::AcqRel);
            return;
        }
        let mut sink = [0u8; 1024];
        let _ = tokio::time::timeout(self.cfg.hold_timeout, async {
            while let Ok(n) = sock.read(&mut sink).await {
                if n == 0 {
                    break;
                }
            }
        })
        .await;
        self.delayed.fetch_sub(1, Ordering::AcqRel);
    }

    /// Park until a box claims `sni` (single-flight per domain), reading at most
    /// `max_parked_bytes` from the visitor meanwhile, then replay everything in order.
    async fn park(
        &self,
        mut sock: TcpStream,
        sni: String,
        mut initial: Vec<u8>,
        user: Option<String>,
    ) {
        bump(&self.stats.parked);
        let domain = sni.to_lowercase();
        let mut rx = {
            let Ok(mut lot) = self.parked.lock() else {
                return;
            };
            match lot.get(&domain) {
                Some(rx) => rx.clone(),
                None => {
                    let (tx, rx) = watch::channel(None);
                    lot.insert(domain.clone(), rx.clone());
                    let me = self.clone();
                    let d = domain.clone();
                    tokio::spawn(async move { me.await_claim(d, user, tx).await });
                    rx
                }
            }
        };
        let mut buf = vec![0u8; 4096];
        let claimed = loop {
            if let Some(t) = rx.borrow().clone() {
                break Some(t);
            }
            tokio::select! {
                c = rx.changed() => {
                    if c.is_err() {
                        break rx.borrow().clone();
                    }
                }
                r = sock.read(&mut buf) => match r {
                    Ok(0) | Err(_) => return,
                    Ok(n) => {
                        if initial.len().saturating_add(n) > self.cfg.sni.max_raw_bytes.saturating_add(self.cfg.max_parked_bytes) {
                            return;
                        }
                        initial.extend_from_slice(buf.get(..n).unwrap_or_default());
                    }
                },
            }
        };
        match claimed {
            Some(t) => {
                bump(&self.stats.released);
                self.pipe(sock, t, &domain, initial).await;
            }
            None => bump(&self.stats.hold_timeouts),
        }
    }

    async fn await_claim(
        &self,
        domain: String,
        user: Option<String>,
        tx: watch::Sender<Option<Arc<Tunnel>>>,
    ) {
        if let Some(u) = user {
            let boxes = self
                .registry
                .lock()
                .map(|r| r.tunnels_for_user(&u))
                .unwrap_or_default();
            for t in boxes {
                nudge(&t, &domain);
            }
        }
        let found = tokio::time::timeout(self.cfg.hold_timeout, async {
            loop {
                tokio::time::sleep(self.cfg.hold_poll_interval).await;
                if let Some(t) = self
                    .registry
                    .lock()
                    .ok()
                    .and_then(|r| r.find_by_sni(&domain))
                {
                    return t;
                }
            }
        })
        .await
        .ok();
        if let Ok(mut lot) = self.parked.lock() {
            lot.remove(&domain);
        }
        let _ = tx.send(found);
    }

    /// Splice the visitor to the tunnel: OPEN, DATA(initial), then both directions bounded.
    pub async fn pipe(&self, sock: TcpStream, tunnel: Arc<Tunnel>, sni: &str, initial: Vec<u8>) {
        let account = tunnel
            .pod_canonical()
            .and_then(|pc| account_from_canonical(&pc, &self.cfg.apex));
        if let Some(m) = &self.meter {
            m.add(account.as_deref(), initial.len());
        }
        let first_wait = self
            .meter
            .as_ref()
            .map(|m| m.throttle_delay(account.as_deref(), initial.len()));
        let Ok(handle) = tunnel.open_stream(sni, initial) else {
            return;
        };
        self.active.fetch_add(1, Ordering::AcqRel);
        let _ = sock.set_nodelay(true);
        let (rd, wr) = sock.into_split();
        let handle = Arc::new(handle);
        let up = {
            let h = handle.clone();
            let me = self.clone();
            let account = account.clone();
            async move {
                if let Some(w) = first_wait.filter(|w| !w.is_zero()) {
                    tokio::time::sleep(w).await;
                }
                me.uplink(rd, &h, account.as_deref()).await;
            }
        };
        let down = downlink(wr, handle.clone());
        tokio::pin!(down);
        let mut closed = handle.tunnel.closed_signal();
        let down_done = tokio::select! {
            _ = up => false,
            _ = &mut down => true,
            _ = closed.wait_for(|c| *c) => false,
        };
        handle.tunnel.close_stream(handle.id);
        handle.down.end();
        if !down_done {
            let _ = tokio::time::timeout(Duration::from_secs(30), down).await;
        }
        self.active.fetch_sub(1, Ordering::AcqRel);
    }

    async fn uplink(&self, mut rd: OwnedReadHalf, h: &StreamHandle, account: Option<&str>) {
        let mut buf = vec![0u8; self.cfg.read_chunk.max(1)];
        loop {
            let n = match rd.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            let chunk = buf.get(..n).unwrap_or_default().to_vec();
            if !h.tunnel.send_data(h.id, chunk).await {
                return;
            }
            if let Some(m) = &self.meter {
                m.add(account, n);
                let wait = m.throttle_delay(account, n);
                if !wait.is_zero() {
                    tokio::time::sleep(wait).await;
                }
            }
        }
    }
}

/// Box → visitor until the queue ends (box CLOSE) or is aborted; credit returns as bytes
/// reach the socket.
async fn downlink(mut wr: OwnedWriteHalf, h: Arc<StreamHandle>) {
    while let Some(chunk) = h.down.pop().await {
        if wr.write_all(&chunk).await.is_err() {
            h.down.abort();
            h.tunnel.close_stream(h.id);
            return;
        }
        h.tunnel.consumed(h.id, chunk.len());
    }
    let _ = wr.shutdown().await;
}

/// `deliverNudgeToBox`: a synthetic `POST /internal/route-nudge` over a fresh stream; the
/// box's reply is discarded.
pub fn nudge(t: &Arc<Tunnel>, domain: &str) -> bool {
    let Some(host) = t.pod_canonical() else {
        return false;
    };
    let body = format!("{{\"domain\":{}}}", crate::json::str_lit(domain));
    let req = format!(
        "POST {NUDGE_BOX_PATH} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let Ok(h) = t.open_stream(&host, req.into_bytes()) else {
        return false;
    };
    let h = Arc::new(h);
    tokio::spawn(async move {
        let _ = tokio::time::timeout(Duration::from_secs(30), async {
            while h.down.pop().await.is_some() {}
        })
        .await;
        h.tunnel.close_stream(h.id);
    });
    true
}

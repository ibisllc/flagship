//! The relay's one connection to `.com`'s serving feed (`serving-wiring.md` §1 "Feed", §2; the TypeScript
//! `servingFeedClient.ts`): revocations are applied with `apply_revocation_entries` under the revocation key pinned in
//! this relay's config (`FLAGSHIP_SERVING_REVOCATION_PUB`, never learnt from the feed) and acked; a gap is filled from
//! `/api/internal/serving-revocations?since=N`; `changed` re-reads a box; every frame (and pong) is contact, which the
//! gate's lost-contact rule counts on. Nothing is persisted: a fresh process reads from 0. The phone-route frames
//! (`phone-route`, `phone-eligibility`) are ignored: this relay has no phone route.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use flagship_crypto::serving::{
    RevocationApply, RevocationEntry, RevocationKind, apply_revocation_entries,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::com::HttpGet;
use crate::serving::ServingGate;

#[derive(Debug, Clone)]
pub struct FeedConfig {
    /// `.com`'s base URL (https); the feed is its `wss:` twin.
    pub com_base_url: String,
    pub secret: String,
    pub relay_id: String,
    /// The pinned revocation public key, 64 lowercase hex.
    pub revocation_key: String,
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    /// WebSocket ping cadence; a pong is contact too.
    pub ping_every: Duration,
}

impl FeedConfig {
    #[must_use]
    pub fn new(com_base_url: &str, secret: &str, relay_id: &str, revocation_key: &str) -> Self {
        Self {
            com_base_url: com_base_url.trim_end_matches('/').to_owned(),
            secret: secret.to_owned(),
            relay_id: relay_id.to_owned(),
            revocation_key: revocation_key.to_owned(),
            initial_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(30),
            ping_every: Duration::from_secs(20),
        }
    }
}

#[derive(Debug, Default)]
pub struct FeedStats {
    pub connected: AtomicBool,
    pub reconnects: AtomicU64,
    pub bad_entries: AtomicU64,
}

impl FeedStats {
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "connected": self.connected.load(Ordering::Relaxed),
            "reconnects": self.reconnects.load(Ordering::Relaxed),
            "badEntries": self.bad_entries.load(Ordering::Relaxed),
        })
    }
}

/// Parse one `{entry, signature}`; `None` when the entry is not one (counted as a bad entry).
fn signed_entry(entry: &Value, signature: &Value) -> Option<(RevocationEntry, String)> {
    let s = |k: &str| entry.get(k)?.as_str().map(str::to_owned);
    let n = |k: &str| entry.get(k)?.as_u64();
    Some((
        RevocationEntry {
            sequence: n("sequence")?,
            kind: RevocationKind::parse(&s("kind")?).ok()?,
            account: s("account")?,
            subject: s("subject")?,
            generation: n("generation")?,
            revoked_at: n("revokedAt")?,
        },
        signature.as_str()?.to_owned(),
    ))
}

struct Inner<H: HttpGet> {
    cfg: FeedConfig,
    gate: ServingGate,
    http: Arc<H>,
    stats: Arc<FeedStats>,
    /// Acks to the current connection.
    out: Mutex<Option<mpsc::UnboundedSender<String>>>,
    catching_up: tokio::sync::Mutex<()>,
    catch_up_again: AtomicBool,
    log: Box<dyn Fn(&str) + Send + Sync>,
    /// The phone routes: `phone-route` and `phone-eligibility` frames, and a resync on reconnect.
    phone: Mutex<Option<crate::phone::PhoneRoutes>>,
}

pub struct ServingFeedClient<H: HttpGet> {
    inner: Arc<Inner<H>>,
}

impl<H: HttpGet> std::fmt::Debug for ServingFeedClient<H> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServingFeedClient")
            .field("relay", &self.inner.cfg.relay_id)
            .finish_non_exhaustive()
    }
}

fn feed_url(cfg: &FeedConfig) -> String {
    let base = &cfg.com_base_url;
    let ws = base
        .strip_prefix("http://")
        .map(|r| format!("ws://{r}"))
        .or_else(|| base.strip_prefix("https://").map(|r| format!("wss://{r}")))
        .unwrap_or_else(|| base.clone());
    format!(
        "{ws}/api/internal/serving-feed?relay={}",
        crate::com::segment(&cfg.relay_id)
    )
}

type Ws = tokio_tungstenite::WebSocketStream<Box<dyn Stream>>;

trait Stream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> Stream for T {}

async fn dial(cfg: &FeedConfig) -> Result<Ws, String> {
    let url = feed_url(cfg);
    let mut req = url
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    req.headers_mut().insert(
        "authorization",
        format!("Bearer {}", cfg.secret)
            .parse()
            .map_err(|_| "control secret is not a header value".to_owned())?,
    );
    let uri = req.uri().clone();
    let host = uri.host().ok_or("feed url has no host")?.to_owned();
    let tls = uri.scheme_str() == Some("wss");
    let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
    let tcp = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::TcpStream::connect((host.as_str(), port)),
    )
    .await
    .map_err(|_| "connect timed out".to_owned())?
    .map_err(|e| e.to_string())?;
    let _ = tcp.set_nodelay(true);
    let stream: Box<dyn Stream> = if tls {
        let roots =
            rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
        let name =
            rustls::pki_types::ServerName::try_from(host.clone()).map_err(|e| e.to_string())?;
        let s = tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(name, tcp)
            .await
            .map_err(|e| e.to_string())?;
        Box::new(s)
    } else {
        Box::new(tcp)
    };
    let (ws, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::client_async(req, stream),
    )
    .await
    .map_err(|_| "handshake timed out".to_owned())?
    .map_err(|e| e.to_string())?;
    Ok(ws)
}

impl<H: HttpGet> ServingFeedClient<H> {
    /// `http` must send the services control secret (`UreqGet::with_bearer`).
    pub fn new(
        cfg: FeedConfig,
        gate: ServingGate,
        http: H,
        log: Box<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                cfg,
                gate,
                http: Arc::new(http),
                stats: Arc::new(FeedStats::default()),
                out: Mutex::new(None),
                catching_up: tokio::sync::Mutex::new(()),
                catch_up_again: AtomicBool::new(false),
                log,
                phone: Mutex::new(None),
            }),
        }
    }

    /// Hand the feed's phone frames to these routes.
    pub fn set_phone(&self, routes: crate::phone::PhoneRoutes) {
        if let Ok(mut p) = self.inner.phone.lock() {
            *p = Some(routes);
        }
    }

    #[must_use]
    pub fn stats(&self) -> Arc<FeedStats> {
        Arc::clone(&self.inner.stats)
    }

    /// Connect, and reconnect with jittered backoff, until the task is aborted.
    pub fn spawn(&self) -> tokio::task::JoinHandle<()> {
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            let mut backoff = inner.cfg.initial_backoff;
            let mut ever = false;
            loop {
                if let Ok(ws) = dial(&inner.cfg).await {
                    let saw = run_connection(&inner, ws, &mut ever).await;
                    if saw {
                        backoff = inner.cfg.initial_backoff;
                    }
                }
                inner.stats.connected.store(false, Ordering::Relaxed);
                if let Ok(mut o) = inner.out.lock() {
                    *o = None;
                }
                let half = backoff.as_millis() as u64 / 2;
                let jitter = {
                    let mut b = [0u8; 8];
                    let _ = getrandom::fill(&mut b);
                    u64::from_le_bytes(b).checked_rem(half.max(1)).unwrap_or(0)
                };
                tokio::time::sleep(Duration::from_millis(half.saturating_add(jitter))).await;
                backoff = backoff.saturating_mul(2).min(inner.cfg.max_backoff);
                inner.stats.reconnects.fetch_add(1, Ordering::Relaxed);
            }
        })
    }
}

/// One connection's life; true when it carried at least one frame.
async fn run_connection<H: HttpGet>(inner: &Arc<Inner<H>>, ws: Ws, ever: &mut bool) -> bool {
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    if let Ok(mut o) = inner.out.lock() {
        *o = Some(tx);
    }
    inner.stats.connected.store(true, Ordering::Relaxed);
    let hello = serde_json::json!({"type": "hello", "since": inner.gate.revocations().sequence})
        .to_string();
    if sink.send(Message::Text(hello.into())).await.is_err() {
        return false;
    }
    let mut ping = tokio::time::interval(inner.cfg.ping_every);
    ping.tick().await;
    let mut saw = false;
    loop {
        tokio::select! {
            m = stream.next() => {
                let text = match m {
                    Some(Ok(Message::Text(t))) => t.to_string(),
                    Some(Ok(Message::Binary(b))) => String::from_utf8_lossy(&b).into_owned(),
                    Some(Ok(Message::Pong(_))) => { inner.gate.note_contact(); continue; }
                    Some(Ok(Message::Ping(_) | Message::Frame(_))) => continue,
                    Some(Ok(Message::Close(_)) | Err(_)) | None => return saw,
                };
                let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                if !frame.is_object() { continue; }
                inner.gate.note_contact();
                if !saw {
                    saw = true;
                    // `changed` frames sent while the feed was down were missed.
                    if *ever {
                        let gate = inner.gate.clone();
                        tokio::spawn(async move { gate.refresh_all().await });
                        if let Some(p) = inner.phone.lock().ok().and_then(|p| p.clone()) {
                            tokio::spawn(async move { p.resync().await });
                        }
                    }
                    *ever = true;
                }
                on_frame(inner, &frame);
            }
            out = rx.recv() => {
                let Some(out) = out else { return saw };
                if sink.send(Message::Text(out.into())).await.is_err() { return saw; }
            }
            _ = ping.tick() => {
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() { return saw; }
            }
        }
    }
}

fn on_frame<H: HttpGet>(inner: &Arc<Inner<H>>, f: &Value) {
    match f.get("type").and_then(Value::as_str) {
        Some("revocation") => {
            let (Some(e), Some(sig)) = (f.get("entry"), f.get("signature")) else {
                return;
            };
            if !e.is_object() || !sig.is_string() {
                return;
            }
            match signed_entry(e, sig) {
                Some(entry) => apply(inner, &[entry]),
                None => {
                    inner.stats.bad_entries.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        Some("beat") => {
            let Some(seq) = f.get("sequence").and_then(Value::as_u64) else {
                return;
            };
            inner.gate.note_latest_sequence(seq);
            if seq > inner.gate.revocations().sequence {
                spawn_catch_up(inner);
            }
        }
        Some("phone-route") => {
            let (Some(h), Some(g)) = (
                f.get("hostname").and_then(Value::as_str),
                f.get("generation").and_then(Value::as_u64),
            ) else {
                return;
            };
            if let Some(p) = inner.phone.lock().ok().and_then(|p| p.clone()) {
                p.pushed(h, g, f.get("vacant") == Some(&Value::Bool(true)));
            }
        }
        Some("phone-eligibility") => {
            if let (Some(u), Some(p)) = (
                f.get("username").and_then(Value::as_str),
                inner.phone.lock().ok().and_then(|p| p.clone()),
            ) {
                let u = u.to_owned();
                tokio::spawn(async move { p.eligibility_changed(&u).await });
            }
        }
        Some("changed") => {
            let (Some(u), Some(b)) = (
                f.get("username").and_then(Value::as_str),
                f.get("boxPub").and_then(Value::as_str),
            ) else {
                return;
            };
            let (gate, u, b) = (inner.gate.clone(), u.to_owned(), b.to_owned());
            tokio::spawn(async move { gate.changed(&u, &b).await });
        }
        _ => {}
    }
}

fn ack<H: HttpGet>(inner: &Inner<H>, sequence: u64) {
    if let Ok(o) = inner.out.lock()
        && let Some(tx) = o.as_ref()
    {
        let _ = tx.send(serde_json::json!({"type": "ack", "sequence": sequence}).to_string());
    }
}

/// Apply in order; a gap reads the log since the last applied entry.
fn apply<H: HttpGet>(inner: &Arc<Inner<H>>, entries: &[(RevocationEntry, String)]) {
    let gate = &inner.gate;
    match apply_revocation_entries(&gate.revocations(), entries, &inner.cfg.revocation_key) {
        RevocationApply::Applied { state, applied } => {
            for (e, _) in entries {
                gate.note_latest_sequence(e.sequence);
            }
            let seq = state.sequence;
            if applied > 0 {
                gate.adopt_revocations(state);
            }
            ack(inner, seq);
        }
        RevocationApply::Gap { .. } => spawn_catch_up(inner),
        RevocationApply::BadSignature { at } | RevocationApply::Malformed { at } => {
            inner.stats.bad_entries.fetch_add(1, Ordering::Relaxed);
            (inner.log)(&format!("[serving-feed] refused revocation entry {at}"));
        }
    }
}

fn spawn_catch_up<H: HttpGet>(inner: &Arc<Inner<H>>) {
    let inner = Arc::clone(inner);
    tokio::spawn(async move { catch_up(&inner).await });
}

/// Single flight; a gap noticed while one runs reruns it once it ends.
async fn catch_up<H: HttpGet>(inner: &Arc<Inner<H>>) {
    inner.catch_up_again.store(true, Ordering::SeqCst);
    // A request that lands just as the running pass ends is picked up by the re-check after the guard is dropped.
    while inner.catch_up_again.load(Ordering::SeqCst) {
        let Ok(guard) = inner.catching_up.try_lock() else {
            return;
        };
        catch_up_pass(inner).await;
        drop(guard);
    }
}

async fn catch_up_pass<H: HttpGet>(inner: &Arc<Inner<H>>) {
    while inner.catch_up_again.swap(false, Ordering::SeqCst) {
        let gate = &inner.gate;
        let since = gate.revocations().sequence;
        let url = format!(
            "{}/api/internal/serving-revocations?since={since}",
            inner.cfg.com_base_url
        );
        let http = Arc::clone(&inner.http);
        let Ok(Ok((200, body))) = tokio::task::spawn_blocking(move || http.get_json(&url)).await
        else {
            break;
        };
        let (Some(list), Some(latest)) = (
            body.get("entries").and_then(Value::as_array),
            body.get("sequence").and_then(Value::as_u64),
        ) else {
            break;
        };
        gate.note_contact();
        gate.note_latest_sequence(latest);
        let entries: Vec<(RevocationEntry, String)> = list
            .iter()
            .filter_map(|e| signed_entry(e.get("entry")?, e.get("signature")?))
            .collect();
        match apply_revocation_entries(&gate.revocations(), &entries, &inner.cfg.revocation_key) {
            RevocationApply::Applied { state, applied } => {
                let seq = state.sequence;
                if applied > 0 {
                    gate.adopt_revocations(state);
                }
                ack(inner, seq);
                // A paged answer: keep reading while it moved us and more is known.
                if applied > 0 && seq < latest {
                    inner.catch_up_again.store(true, Ordering::SeqCst);
                }
            }
            RevocationApply::Gap { at }
            | RevocationApply::BadSignature { at }
            | RevocationApply::Malformed { at } => {
                inner.stats.bad_entries.fetch_add(1, Ordering::Relaxed);
                (inner.log)(&format!("[serving-feed] catch-up stopped at entry {at}"));
                break;
            }
        }
    }
}

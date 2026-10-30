//! The hub port's HTTP surface (`server.ts`): the tunnel upgrade at `/tunnel`, `GET /api/health`, `GET /api/stats` (guarded by the
//! hub's shared secret) and the peer-backup mailbox route `POST /pb/m/<id>` (`mailboxRelayRoute.ts`). Everything else is a 404.
//! Custom-domain pushes (a Pro feature on its own branch) and the gossip fan-out (dropped by owner decision: no relay broadcast) are
//! not served.

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{CONNECTION, CONTENT_TYPE, HeaderValue, UPGRADE};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};

use crate::hub::{self, HubContext};
use crate::mailbox::MailboxRegistry;
use crate::router::Router;

pub const TUNNEL_PATH: &str = "/tunnel";
/// Envelopes in flight across the machine.
const MAX_MAIL_IN_FLIGHT: usize = 16;

pub struct HttpApp {
    pub hub: HubContext,
    pub router: Arc<Router>,
    pub mailboxes: Option<Arc<MailboxRegistry>>,
    /// `x-usage-secret` for `/api/stats`; `None` turns the route off (503).
    pub stats_secret: Option<String>,
    pub service: String,
    pub header_timeout: Duration,
    started: Instant,
    mail_in_flight: AtomicUsize,
}

impl std::fmt::Debug for HttpApp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpApp")
            .field("service", &self.service)
            .finish_non_exhaustive()
    }
}

impl HttpApp {
    #[must_use]
    pub fn new(
        hub: HubContext,
        router: Arc<Router>,
        mailboxes: Option<Arc<MailboxRegistry>>,
        stats_secret: Option<String>,
        header_timeout: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            hub,
            router,
            mailboxes,
            stats_secret,
            service: "flagship.services".to_owned(),
            header_timeout,
            started: Instant::now(),
            mail_in_flight: AtomicUsize::new(0),
        })
    }
}

type Resp = Response<Full<Bytes>>;

fn json(status: StatusCode, body: &serde_json::Value) -> Resp {
    let mut r = Response::new(Full::new(Bytes::from(body.to_string())));
    *r.status_mut() = status;
    r.headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}

fn error(status: StatusCode, message: &str) -> Resp {
    json(status, &serde_json::json!({ "error": message }))
}

/// `2026-10-30T18:00:00.000Z` from a Unix time, without a date library.
#[allow(clippy::arithmetic_side_effects)] // civil-date math on bounded values (days fit an i64 by construction)
fn iso(secs: u64, millis: u32) -> String {
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rem = secs % 86_400;
    // civil_from_days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn now_iso() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    iso(d.as_secs(), d.subsec_millis())
}

/// Resident memory in bytes on Linux (`/proc/self/statm`), else `None`.
fn rss_bytes() -> Option<u64> {
    let pages: u64 = std::fs::read_to_string("/proc/self/statm")
        .ok()?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    Some(pages.saturating_mul(4096))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn health(app: &HttpApp) -> Resp {
    json(
        StatusCode::OK,
        &serde_json::json!({
            "ok": true,
            "service": app.service,
            "surface": "services",
            "runtime": "rust",
            "version": env!("CARGO_PKG_VERSION"),
            "uptimeMs": u64::try_from(app.started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "memory": { "rss": rss_bytes() },
            "tunnelsOnline": app.hub.live.lock().map_or(0, |l| l.len()),
            "pid": std::process::id(),
            "now": now_iso(),
        }),
    )
}

fn stats(app: &HttpApp, req: &Request<Incoming>) -> Resp {
    let Some(secret) = &app.stats_secret else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "stats are off (USAGE_REPORT_SECRET missing)",
        );
    };
    let given = req
        .headers()
        .get("x-usage-secret")
        .map_or(&[][..], |v| v.as_bytes());
    if !constant_time_eq(given, secret.as_bytes()) {
        return error(StatusCode::FORBIDDEN, "forbidden");
    }
    let s = &app.router.stats;
    let n = |c: &std::sync::atomic::AtomicU64| c.load(Ordering::Relaxed);
    json(
        StatusCode::OK,
        &serde_json::json!({
            "service": app.service,
            "uptimeSec": app.started.elapsed().as_secs(),
            "tunnelsOnline": app.hub.live.lock().map_or(0, |l| l.len()),
            "router": {
                "routed": n(&s.routed), "bad": n(&s.bad), "parked": n(&s.parked), "released": n(&s.released),
                "holdTimeouts": n(&s.hold_timeouts), "noBoxRegistered": n(&s.no_box_registered), "noUser": n(&s.no_user),
                "refusedBusy": n(&s.refused_busy), "peekTimeouts": n(&s.peek_timeouts), "activeStreams": app.router.active_streams(),
            },
            "now": now_iso(),
        }),
    )
}

fn upgrade_ok(req: &Request<Incoming>) -> Option<String> {
    let h = req.headers();
    let has = |name: hyper::header::HeaderName, want: &str| {
        h.get(name)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case(want)))
    };
    if req.method() != Method::GET || !has(UPGRADE, "websocket") || !has(CONNECTION, "upgrade") {
        return None;
    }
    if h.get("sec-websocket-version").and_then(|v| v.to_str().ok()) != Some("13") {
        return None;
    }
    let key = h.get("sec-websocket-key")?;
    Some(derive_accept_key(key.as_bytes()))
}

fn tunnel(app: &Arc<HttpApp>, mut req: Request<Incoming>) -> Resp {
    if app.hub.draining.load(Ordering::Acquire) {
        return error(StatusCode::SERVICE_UNAVAILABLE, "draining");
    }
    let Some(accept) = upgrade_ok(&req) else {
        return error(StatusCode::BAD_REQUEST, "a WebSocket upgrade is required");
    };
    let ctx = app.hub.clone();
    let ws_cfg = WebSocketConfig::default()
        .max_message_size(Some(ctx.cfg.max_ws_message))
        .max_frame_size(Some(ctx.cfg.max_ws_message));
    let on_upgrade = hyper::upgrade::on(&mut req);
    tokio::spawn(async move {
        if let Ok(up) = on_upgrade.await {
            let ws = WebSocketStream::from_raw_socket(TokioIo::new(up), Role::Server, Some(ws_cfg))
                .await;
            hub::run_tunnel(ws, ctx).await;
        }
    });
    let mut r = Response::new(Full::new(Bytes::new()));
    *r.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    r.headers_mut()
        .insert(UPGRADE, HeaderValue::from_static("websocket"));
    r.headers_mut()
        .insert(CONNECTION, HeaderValue::from_static("Upgrade"));
    if let Ok(v) = HeaderValue::from_str(&accept) {
        r.headers_mut().insert("sec-websocket-accept", v);
    }
    r
}

async fn mailbox(app: &Arc<HttpApp>, id: &str, req: Request<Incoming>) -> Resp {
    let Some(reg) = &app.mailboxes else {
        return error(StatusCode::NOT_FOUND, "not found");
    };
    if id.len() != 32 || !id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return error(StatusCode::BAD_REQUEST, "bad mailbox");
    }
    let octet = req
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/octet-stream"));
    let body = match Limited::new(req.into_body(), crate::mail::MAIL_MAX_ENVELOPE)
        .collect()
        .await
    {
        Ok(b) => b.to_bytes(),
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "too large"),
    };
    if !octet || body.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "send the sealed envelope as application/octet-stream",
        );
    }
    if !reg.has(id) {
        return error(StatusCode::NOT_FOUND, "that holder isn't connected here");
    }
    if app.mail_in_flight.fetch_add(1, Ordering::AcqRel) >= MAX_MAIL_IN_FLIGHT {
        app.mail_in_flight.fetch_sub(1, Ordering::AcqRel);
        let mut r = error(StatusCode::SERVICE_UNAVAILABLE, "busy");
        r.headers_mut()
            .insert("retry-after", HeaderValue::from_static("5"));
        return r;
    }
    let answer = reg.deliver(id, &body).await;
    app.mail_in_flight.fetch_sub(1, Ordering::AcqRel);
    match answer {
        None => error(StatusCode::NOT_FOUND, "that holder isn't connected here"),
        Some(a) if a.status != 200 => error(
            if a.status == 504 {
                StatusCode::GATEWAY_TIMEOUT
            } else {
                StatusCode::BAD_GATEWAY
            },
            "the holder didn't answer",
        ),
        Some(a) => {
            let mut r = Response::new(Full::new(Bytes::from(a.body)));
            r.headers_mut().insert(
                CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            );
            r.headers_mut()
                .insert("cache-control", HeaderValue::from_static("no-store"));
            r
        }
    }
}

async fn handle(app: Arc<HttpApp>, req: Request<Incoming>) -> Result<Resp, Infallible> {
    let path = req.uri().path().to_owned();
    let method = req.method().clone();
    Ok(match (method, path.as_str()) {
        (_, TUNNEL_PATH) => tunnel(&app, req),
        (Method::GET, "/api/health") => health(&app),
        (Method::GET, "/api/stats") => stats(&app, &req),
        (Method::POST, p) if p.starts_with("/pb/m/") => {
            mailbox(&app, p.trim_start_matches("/pb/m/"), req).await
        }
        _ => error(StatusCode::NOT_FOUND, "not found"),
    })
}

/// Serves one connection until it closes (a tunnel upgrade keeps it open as a WebSocket).
pub async fn serve_connection(sock: TcpStream, app: Arc<HttpApp>) {
    let _ = sock.set_nodelay(true);
    let timeout = app.header_timeout;
    let svc_app = Arc::clone(&app);
    let svc = service_fn(move |req| handle(Arc::clone(&svc_app), req));
    let conn = hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(timeout)
        .keep_alive(true)
        .serve_connection(TokioIo::new(sock), svc)
        .with_upgrades();
    let _ = conn.await;
}

//! Wiring: the SNI passthrough listener (:443 → :8443 internal), the tunnel hub WebSocket
//! (`/tunnel` behind Fly's TLS on :8443 → :3000) and the PROXY echo (:8444 → :3001).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use crate::hello::HelloAuthority;
use crate::hub::{self, BlessingSource, HubConfig, HubContext, SharedRegistry};
use crate::registry::Registry;
use crate::router::{Router, RouterConfig};
use crate::throttle::Meter;

pub const TUNNEL_PATH: &str = "/tunnel";

#[derive(Debug, Clone)]
pub struct RelayConfig {
    pub hub: HubConfig,
    pub router: RouterConfig,
    /// Production data plane: refuse an authority that verifies no signature (the TS hub's
    /// "refusing to start on surface=services without irkLookup").
    pub require_verified_authority: bool,
    pub max_tunnels: usize,
    pub max_echo_conns: usize,
    pub ws_handshake_timeout: Duration,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            hub: HubConfig::default(),
            router: RouterConfig::default(),
            require_verified_authority: true,
            max_tunnels: 20_000,
            max_echo_conns: 1024,
            ws_handshake_timeout: Duration::from_secs(10),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartError {
    UnverifiedAuthority,
    Bind(String),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnverifiedAuthority => f.write_str(
                "refusing to start the production data plane with an authority that verifies no signatures",
            ),
            Self::Bind(e) => write!(f, "bind failed: {e}"),
        }
    }
}

impl std::error::Error for StartError {}

pub struct Listeners {
    pub sni: TcpListener,
    pub hub: TcpListener,
    pub echo: Option<TcpListener>,
}

impl std::fmt::Debug for Listeners {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Listeners").finish_non_exhaustive()
    }
}

pub struct RunningRelay {
    pub sni_addr: SocketAddr,
    pub hub_addr: SocketAddr,
    pub echo_addr: Option<SocketAddr>,
    pub registry: SharedRegistry,
    pub router: Router,
    ctx: HubContext,
    stop_accept: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}

impl std::fmt::Debug for RunningRelay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunningRelay")
            .field("sni_addr", &self.sni_addr)
            .field("hub_addr", &self.hub_addr)
            .finish_non_exhaustive()
    }
}

pub struct Collaborators {
    pub authority: Arc<dyn HelloAuthority>,
    pub blessing: Option<Arc<dyn BlessingSource>>,
    pub meter: Option<Arc<dyn Meter>>,
}

impl std::fmt::Debug for Collaborators {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Collaborators").finish_non_exhaustive()
    }
}

pub fn start(cfg: RelayConfig, l: Listeners, c: Collaborators) -> Result<RunningRelay, StartError> {
    if cfg.require_verified_authority && !c.authority.verifies_signatures() {
        return Err(StartError::UnverifiedAuthority);
    }
    let addr = |x: &TcpListener| x.local_addr().map_err(|e| StartError::Bind(e.to_string()));
    let sni_addr = addr(&l.sni)?;
    let hub_addr = addr(&l.hub)?;
    let echo_addr = l.echo.as_ref().map(addr).transpose()?;
    let registry: SharedRegistry = Arc::new(Mutex::new(Registry::new(&cfg.hub.apex)));
    let mut router_cfg = cfg.router.clone();
    router_cfg.apex.clone_from(&cfg.hub.apex);
    let ctx = HubContext {
        cfg: Arc::new(cfg.hub.clone()),
        registry: registry.clone(),
        authority: c.authority,
        blessing: c.blessing,
        meter: c.meter.clone(),
        live: Arc::new(Mutex::new(HashMap::new())),
        draining: Arc::new(AtomicBool::new(false)),
    };
    let router = Router::new(router_cfg, registry.clone(), c.meter);
    let (stop_accept, stop_rx) = watch::channel(false);
    let mut tasks = Vec::new();
    tasks.push(tokio::spawn(router.clone().run(l.sni, stop_rx.clone())));
    tasks.push(tokio::spawn(run_hub(
        l.hub,
        ctx.clone(),
        cfg.clone(),
        stop_rx.clone(),
    )));
    if let Some(e) = l.echo {
        tasks.push(tokio::spawn(crate::echo::run_echo(
            e,
            cfg.max_echo_conns,
            stop_rx,
        )));
    }
    Ok(RunningRelay {
        sni_addr,
        hub_addr,
        echo_addr,
        registry,
        router,
        ctx,
        stop_accept,
        tasks,
    })
}

async fn run_hub(
    listener: TcpListener,
    ctx: HubContext,
    cfg: RelayConfig,
    mut stop: watch::Receiver<bool>,
) {
    let permits = Arc::new(Semaphore::new(cfg.max_tunnels.max(1)));
    loop {
        tokio::select! {
            _ = stop.changed() => return,
            r = listener.accept() => {
                let Ok((sock, _)) = r else { continue };
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    drop(sock);
                    continue;
                };
                let ctx = ctx.clone();
                let timeout = cfg.ws_handshake_timeout;
                tokio::spawn(async move {
                    accept_tunnel(sock, ctx, timeout).await;
                    drop(permit);
                });
            }
        }
    }
}

async fn accept_tunnel(sock: TcpStream, ctx: HubContext, timeout: Duration) {
    if ctx.draining.load(Ordering::Acquire) {
        return;
    }
    let _ = sock.set_nodelay(true);
    let ws_cfg = WebSocketConfig::default()
        .max_message_size(Some(ctx.cfg.max_ws_message))
        .max_frame_size(Some(ctx.cfg.max_ws_message));
    // The error type is fixed by tungstenite's handshake `Callback` trait.
    #[allow(clippy::result_large_err)]
    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        if req.uri().path() == TUNNEL_PATH {
            Ok(resp)
        } else {
            let mut e = ErrorResponse::new(None);
            *e.status_mut() = StatusCode::NOT_FOUND;
            Err(e)
        }
    };
    let accepted = tokio::time::timeout(
        timeout,
        tokio_tungstenite::accept_hdr_async_with_config(sock, check, Some(ws_cfg)),
    )
    .await;
    if let Ok(Ok(ws)) = accepted {
        hub::run_tunnel(ws, ctx).await;
    }
}

impl RunningRelay {
    pub fn tunnel_count(&self) -> usize {
        self.ctx.live.lock().map_or(0, |l| l.len())
    }

    /// Stop accepting, warn boxes that negotiated `drain-v1`, wait up to `grace` for spliced
    /// streams to finish, then close every tunnel. Returns how many streams were cut.
    pub async fn drain(&self, grace: Duration) -> usize {
        self.ctx.draining.store(true, Ordering::Release);
        let _ = self.stop_accept.send(true);
        hub::announce_drain(&self.ctx.live, grace);
        let _ = tokio::time::timeout(grace, async {
            while self.router.active_streams() > 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        let cut = self.router.active_streams();
        let tunnels: Vec<_> = self
            .ctx
            .live
            .lock()
            .map(|l| l.values().cloned().collect())
            .unwrap_or_default();
        for t in tunnels {
            t.close();
        }
        cut
    }

    pub async fn shutdown(self) {
        let _ = self.drain(Duration::ZERO).await;
        for t in self.tasks {
            t.abort();
        }
    }
}

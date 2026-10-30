//! The `.services` data plane as one process: the SNI passthrough router, the tunnel hub (WebSocket, health, stats and the
//! mailbox route on one port), the PROXY-protocol address echo, `.com`-backed authority, metering and the relay blessing.
//! Configured by the environment the TypeScript hub reads (`flagship_relay::config`). SIGINT and SIGTERM drain: stop
//! accepting, warn boxes, wait for streams up to `FLAGSHIP_DRAIN_GRACE_MS`, report the usage still unreported, exit.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use flagship_relay::authority::DirectoryAuthority;
use flagship_relay::blessing::{DEFAULT_REFRESH, HubBlessing, load_or_create_key};
use flagship_relay::com::{ComDirectory, Ttls, UreqGet};
use flagship_relay::config::Settings;
use flagship_relay::hub::BlessingSource;
use flagship_relay::mailbox::MailboxRegistry;
use flagship_relay::outbound::com_policy::{ComHostPolicy, HttpPost, Ttls as PolicyTtls, UreqPost};
use flagship_relay::outbound::{HostPolicy, KnownHostsPolicy, Options, OutboundRelay, System};
use flagship_relay::relay::{self, Collaborators, Listeners, RelayConfig};
use flagship_relay::throttle::{Meter, over_quota_bytes_per_sec};
use flagship_relay::usage::{UsageConfig, UsageMeter};
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};

const OUTBOUND_STATS_EVERY: Duration = Duration::from_secs(15 * 60);

#[allow(clippy::print_stdout)]
fn log(line: &str) {
    println!("{line}");
}

fn main() {
    let vars: HashMap<String, String> = std::env::vars().collect();
    let settings = match Settings::from_vars(&vars) {
        Ok(s) => s,
        Err(e) => {
            log(&format!("flagship-relay: {e}"));
            std::process::exit(2);
        }
    };
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log(&format!("flagship-relay: no runtime: {e}"));
            std::process::exit(1);
        }
    };
    if let Err(e) = rt.block_on(run(settings)) {
        log(&format!("flagship-relay: {e}"));
        std::process::exit(1);
    }
}

async fn bind(host: &str, port: u16) -> Result<TcpListener, String> {
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|e| format!("bad listen address {host}:{port}: {e}"))?;
    TcpListener::bind(addr)
        .await
        .map_err(|e| format!("cannot listen on {addr}: {e}"))
}

fn batch_id() -> String {
    let mut b = [0u8; 16];
    // If the OS generator fails the id repeats; `.com` then drops the duplicate batch (an under-count), which is this
    // meter's documented failure direction.
    if getrandom::fill(&mut b).is_err() {
        b = [0; 16];
    }
    flagship_crypto::trust::hex(&b)
}

async fn run(s: Settings) -> Result<(), String> {
    let post: Arc<dyn HttpPost> = Arc::new(UreqPost::new(Duration::from_secs(10)));

    let authority = DirectoryAuthority::new(ComDirectory::new(
        &s.com_base_url,
        UreqGet::new(Duration::from_secs(10)),
        Ttls::default(),
    ));

    let key = load_or_create_key(s.hub_key_path.as_deref())
        .map_err(|e| format!("no randomness for the hub key: {e}"))?;
    let blessing = Arc::new(HubBlessing::new(
        key,
        &s.hub_host,
        &s.com_base_url,
        s.control_secret.as_deref(),
        Box::new(log),
    ));
    log(&format!(
        "relay-blessing provider started hubKey=ok host={}",
        s.hub_host
    ));
    let _blessing_task = blessing.spawn(Arc::clone(&post), DEFAULT_REFRESH);

    let usage = match &s.usage_secret {
        Some(secret) => {
            let mut cfg = UsageConfig::new(&format!("{}/api/usage/report", s.com_base_url), secret);
            cfg.flush_interval = s.usage_flush;
            if let Some(bps) = over_quota_bytes_per_sec(s.over_quota_kbps.as_deref()) {
                cfg.throttle_bytes_per_sec = bps;
            }
            let m = UsageMeter::new(cfg, Box::new(batch_id))
                .map(Arc::new)
                .ok_or("FLAGSHIP_OVER_QUOTA_KBPS is not a usable rate")?;
            let _usage_task = m.spawn(Arc::clone(&post));
            log(&format!(
                "usage metering ON -> {}/api/usage/report",
                s.com_base_url
            ));
            Some(m)
        }
        None => None,
    };

    let outbound = s.outbound.then(|| {
        let policy: Arc<dyn HostPolicy> = match &s.usage_secret {
            Some(secret) => Arc::new(ComHostPolicy::new(
                &s.com_base_url,
                secret,
                UreqPost::new(Duration::from_secs(10)),
                PolicyTtls::default(),
            )),
            None => Arc::new(KnownHostsPolicy),
        };
        OutboundRelay::new(
            Options::default(),
            Arc::new(System),
            Arc::new(System),
            policy,
        )
    });
    if let Some(o) = &outbound {
        let o = Arc::clone(o);
        tokio::spawn(async move {
            let mut t = tokio::time::interval(OUTBOUND_STATS_EVERY);
            t.tick().await;
            loop {
                t.tick().await;
                let o = Arc::clone(&o);
                if let Ok(Some(line)) = tokio::task::spawn_blocking(move || o.flush_stats()).await {
                    log(&line);
                }
            }
        });
    }

    let listeners = Listeners {
        sni: bind(&s.host, s.sni_port).await?,
        hub: bind(&s.host, s.hub_port).await?,
        echo: match s.echo_port {
            Some(p) => Some(bind(&s.host, p).await?),
            None => None,
        },
    };

    let cfg = {
        let mut c = RelayConfig::default();
        c.hub.apex.clone_from(&s.apex);
        c
    };
    let collab = Collaborators {
        authority: Arc::new(authority),
        blessing: Some(Arc::clone(&blessing) as Arc<dyn BlessingSource>),
        meter: usage.clone().map(|m| m as Arc<dyn Meter>),
        outbound,
        mailboxes: s.pb_mail.then(|| Arc::new(MailboxRegistry::default())),
        stats_secret: s.usage_secret.clone(),
    };
    let running = relay::start(cfg, listeners, collab).map_err(|e| e.to_string())?;
    log(&format!(
        "SNI router listening on :{} (raw TCP / TLS passthrough)",
        running.sni_addr.port()
    ));
    if let Some(a) = running.echo_addr {
        log(&format!(
            "relay echo listening on :{} (PROXY protocol)",
            a.port()
        ));
    }
    log(&format!(
        "flagshipserver.com listening on :{}",
        running.hub_addr.port()
    ));
    log(&format!("tunnel hub: ws://{}/tunnel", running.hub_addr));

    let mut int = signal(SignalKind::interrupt()).map_err(|e| e.to_string())?;
    let mut term = signal(SignalKind::terminate()).map_err(|e| e.to_string())?;
    tokio::select! {
        _ = int.recv() => {}
        _ = term.recv() => {}
    }
    log(&format!(
        "draining: {} tunnel(s), grace {} ms",
        running.tunnel_count(),
        s.drain_grace.as_millis()
    ));
    let cut = running.drain(s.drain_grace).await;
    log(&format!("drained, {cut} stream(s) cut"));
    if let Some(m) = usage {
        let post = Arc::clone(&post);
        let _ = tokio::task::spawn_blocking(move || m.flush_all(post.as_ref())).await;
    }
    running.shutdown().await;
    Ok(())
}

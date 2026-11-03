//! The `.services` data plane as one process: the SNI passthrough router, the tunnel hub (WebSocket, health, stats and the
//! mailbox route on one port), the PROXY-protocol address echo, `.com`-backed authority, metering and the relay blessing.
//! Configured by the environment the TypeScript hub reads (`flagship_relay::config`). SIGINT and SIGTERM drain: stop
//! accepting, warn boxes, wait for streams up to `FLAGSHIP_DRAIN_GRACE_MS`, report the usage still unreported, exit.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use flagship_relay::authority::Directory;
use flagship_relay::authority::DirectoryAuthority;
use flagship_relay::blessing::{DEFAULT_REFRESH, HubBlessing, load_or_create_key};
use flagship_relay::com::{ComDirectory, Ttls, UreqGet};
use flagship_relay::config::Settings;
use flagship_relay::hub::BlessingSource;
use flagship_relay::mailbox::MailboxRegistry;
#[cfg(feature = "conformance")]
use flagship_relay::mesh::StaticCaKeys;
use flagship_relay::mesh::log_authority::{LogDirectory, MeshServingFetch};
use flagship_relay::mesh::phone_ledger::{MeshPhoneCom, presented};
use flagship_relay::mesh::{
    CaKeySource, HttpFeed, HttpIssuer, MaintainersCa, Mesh, MeshConfig, MeshParts, SealedFeed,
};
use flagship_relay::outbound::com_policy::{ComHostPolicy, HttpPost, Ttls as PolicyTtls, UreqPost};
use flagship_relay::outbound::{HostPolicy, KnownHostsPolicy, Options, OutboundRelay};
use flagship_relay::phone::{ComPhone, PhoneConfig, PhoneRoutes};
use flagship_relay::relay::{self, Collaborators, Listeners, RelayConfig};
use flagship_relay::serving::{ComServingFetch, GateConfig, ServingGate};
use flagship_relay::serving_feed::{FeedConfig, ServingFeedClient};
use flagship_relay::throttle::{Meter, over_quota_bytes_per_sec};
use flagship_relay::usage::{UsageConfig, UsageMeter};
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};

#[cfg(not(feature = "conformance"))]
fn outbound_resolver() -> Arc<dyn flagship_relay::outbound::Resolve> {
    Arc::new(flagship_relay::outbound::System)
}

#[cfg(not(feature = "conformance"))]
fn outbound_connector() -> Arc<dyn flagship_relay::outbound::Connect> {
    Arc::new(flagship_relay::outbound::System)
}

/// `<host>=<public address>=<local ip:port>`: the host resolves to the public address (so every address rule still
/// runs on it) and a dial to that address on 443 goes to the local upstream. Test builds only.
#[cfg(feature = "conformance")]
mod conformance {
    use std::net::{IpAddr, SocketAddr};
    use std::sync::Arc;

    use flagship_relay::authority::BoxFut;
    use flagship_relay::outbound::{Connect, Resolve, System};

    #[derive(Debug, Clone)]
    pub struct Upstream {
        host: String,
        public: IpAddr,
        local: SocketAddr,
    }

    pub fn upstream() -> Option<Upstream> {
        let v = std::env::var("FLAGSHIP_OUTBOUND_CONFORMANCE_UPSTREAM").ok()?;
        let mut p = v.split('=');
        Some(Upstream {
            host: p.next()?.to_owned(),
            public: p.next()?.parse().ok()?,
            local: p.next()?.parse().ok()?,
        })
    }

    impl Resolve for Upstream {
        fn resolve<'a>(&'a self, host: &'a str) -> BoxFut<'a, Result<Vec<IpAddr>, ()>> {
            if host.eq_ignore_ascii_case(&self.host) {
                let a = self.public;
                return Box::pin(async move { Ok(vec![a]) });
            }
            System.resolve(host)
        }
    }

    impl Connect for Upstream {
        fn connect<'a>(
            &'a self,
            addr: IpAddr,
            port: u16,
        ) -> BoxFut<'a, std::io::Result<tokio::net::TcpStream>> {
            if addr == self.public && port == 443 {
                return Box::pin(tokio::net::TcpStream::connect(self.local));
            }
            System.connect(addr, port)
        }
    }

    pub fn resolver() -> Arc<dyn Resolve> {
        upstream().map_or_else(
            || Arc::new(System) as Arc<dyn Resolve>,
            |u| Arc::new(u) as Arc<dyn Resolve>,
        )
    }

    pub fn connector() -> Arc<dyn Connect> {
        upstream().map_or_else(
            || Arc::new(System) as Arc<dyn Connect>,
            |u| Arc::new(u) as Arc<dyn Connect>,
        )
    }
}

#[cfg(feature = "conformance")]
fn outbound_resolver() -> Arc<dyn flagship_relay::outbound::Resolve> {
    conformance::resolver()
}

#[cfg(feature = "conformance")]
fn outbound_connector() -> Arc<dyn flagship_relay::outbound::Connect> {
    conformance::connector()
}

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

/// The CA keys a mesh relay trusts: the maintainer chain from the folder, or (conformance builds only) a fixed list.
fn mesh_ca(m: &flagship_relay::config::MeshSettings) -> Result<Arc<dyn CaKeySource>, String> {
    #[cfg(feature = "conformance")]
    if let Ok(keys) = std::env::var("FLAGSHIP_MESH_CA_KEYS") {
        return Ok(Arc::new(StaticCaKeys(
            keys.split(',')
                .map(|k| k.trim().to_ascii_lowercase())
                .collect(),
        )));
    }
    let ca = MaintainersCa::load(&m.maintainers_dir, &m.maintainer_pin)?;
    if ca.chain_len() == 0 {
        return Err(format!(
            "no ca-track mandate under {} verifies from the pin",
            m.maintainers_dir.display()
        ));
    }
    Ok(Arc::new(ca))
}

/// The sealed feed (§4.5.1); conformance builds read a clear one with `FLAGSHIP_RELAY_FEED_PLAIN=1` (local harnesses).
fn mesh_feed_cipher(
    s: &Settings,
    m: &flagship_relay::config::MeshSettings,
) -> Arc<dyn flagship_relay::mesh::FeedDecrypt> {
    #[cfg(feature = "conformance")]
    if std::env::var("FLAGSHIP_RELAY_FEED_PLAIN").as_deref() == Ok("1") {
        return Arc::new(flagship_relay::mesh::PlainFeed);
    }
    SealedFeed::new(&s.apex, &m.relay_id, m.key_seed)
}

/// The relay mesh's parts (relay-mesh.md §15.4): the log-backed authority and serving gate, the mesh phone ledger.
struct MeshWiring {
    mesh: Mesh,
    gate: ServingGate,
    phone: Option<PhoneRoutes>,
}

fn build_mesh(
    s: &Settings,
    m: &flagship_relay::config::MeshSettings,
) -> Result<MeshWiring, String> {
    let mut cfg = MeshConfig::new(&m.relay_id, &s.apex, m.kind, &m.log_pub);
    cfg.refuse_new_after = s.serving_refuse_new;
    cfg.close_all_after = s.serving_close_all;
    cfg.peer_urls.clone_from(&m.peer_urls);
    cfg.peer_addrs.clone_from(&m.peer_addrs);
    cfg.client_key_by_port = m.client_key_by_port;
    if let Some(d) = m.feed_poll {
        cfg.feed_poll = d;
    }
    if let Some(d) = m.rebalance {
        cfg.rebalance_every = d;
    }
    if let Some(d) = m.min_move {
        cfg.min_move = d;
        cfg.colocate_every = cfg.colocate_every.min(d);
    }
    if let Some(c) = m.capacity {
        cfg.capacity = c;
    }
    if let Some(d) = m.attach_ttl {
        cfg.legacy_ttl = d;
    }
    let parts = MeshParts {
        feed: HttpFeed::new(&m.feed_url),
        decrypt: mesh_feed_cipher(s, m),
        ca: mesh_ca(m)?,
        issuer: HttpIssuer::new(&s.com_base_url),
    };
    let mesh = Mesh::new(
        cfg,
        ed25519_dalek::SigningKey::from_bytes(&m.key_seed),
        parts,
        Box::new(log),
    )?;
    let gate = ServingGate::new(
        Arc::new(MeshServingFetch(mesh.clone())),
        GateConfig {
            refuse_new_after: s.serving_refuse_new,
            close_all_after: s.serving_close_all,
            check_every: s.serving_check,
            keep_indefinite_on_lost: true,
            ..GateConfig::default()
        },
        Box::new(log),
    );
    let phone = s.phone_route.then(|| {
        PhoneRoutes::new_mesh(
            &m.relay_id,
            &s.apex,
            Arc::new(MeshPhoneCom(mesh.clone())),
            presented(&mesh),
            PhoneConfig::default(),
            Box::new(log),
        )
    });
    Ok(MeshWiring { mesh, gate, phone })
}

async fn run(s: Settings) -> Result<(), String> {
    let post: Arc<dyn HttpPost> = Arc::new(UreqPost::new(Duration::from_secs(10)));
    let wiring = match &s.mesh {
        Some(m) => Some(build_mesh(&s, m)?),
        None => None,
    };

    let directory = ComDirectory::new(
        &s.com_base_url,
        UreqGet::new(Duration::from_secs(10)),
        Ttls::default(),
    );
    let authority = DirectoryAuthority::new(directory.clone());

    // The serving authority (serving-wiring.md §2): on when this relay is given `.com`'s revocation public key. It then
    // fails closed: no new tunnels after 60 s without a frame from `.com`'s feed, every tunnel closed after 10 min.
    let mut serving_tasks = Vec::new();
    let serving = match (&s.serving_revocation_pub, &s.control_secret) {
        _ if wiring.is_some() => None,
        (Some(pubkey), Some(secret)) => {
            let dir = directory.clone();
            let fetch = ComServingFetch::new(
                &s.com_base_url,
                UreqGet::new(Duration::from_secs(5)).with_bearer(secret),
                Box::new(move |u: String| {
                    let dir = dir.clone();
                    Box::pin(async move {
                        let k = dir.account(&u).await?;
                        Some(k.admin_root_pub_hex.unwrap_or(k.irk_pub_hex))
                    })
                }),
            );
            let gate = ServingGate::new(
                Arc::new(fetch),
                GateConfig {
                    refuse_new_after: s.serving_refuse_new,
                    close_all_after: s.serving_close_all,
                    check_every: s.serving_check,
                    ..GateConfig::default()
                },
                Box::new(log),
            );
            let feed = ServingFeedClient::new(
                FeedConfig::new(&s.com_base_url, secret, &s.relay_id, pubkey),
                gate.clone(),
                UreqGet::new(Duration::from_secs(10)).with_bearer(secret),
                Box::new(log),
            );
            // The phone's bare name (plan H3) rides on the serving authority: `.com`'s ledger and eligibility.
            let phone = s.phone_route.then(|| {
                PhoneRoutes::new(
                    &s.relay_id,
                    &s.apex,
                    Arc::new(ComPhone::new(&s.com_base_url, secret)),
                    PhoneConfig::default(),
                    Box::new(log),
                )
            });
            if let Some(p) = &phone {
                feed.set_phone(p.clone());
            }
            serving_tasks.push(gate.spawn());
            serving_tasks.push(feed.spawn());
            log(&format!(
                "serving authority ON (feed {}/api/internal/serving-feed)",
                s.com_base_url
            ));
            Some((gate, feed.stats(), phone))
        }
        _ => None,
    };

    // Mesh mode: the relay key (from its seed) signs HELLO_ACK and the blessing is asked for with proof of possession
    // (relay-mesh.md §3.2); otherwise today's hub key and shared-secret blessing.
    let blessing: Arc<dyn BlessingSource> = match &wiring {
        Some(w) => {
            log(&format!(
                "relay mesh ON relayId={} relayKey={} kind={}",
                w.mesh.relay_id(),
                w.mesh.relay_pub(),
                if w.mesh.is_full() { "full" } else { "entry" }
            ));
            Arc::new(w.mesh.clone())
        }
        None => {
            let key = load_or_create_key(s.hub_key_path.as_deref())
                .map_err(|e| format!("no randomness for the hub key: {e}"))?;
            let b = Arc::new(HubBlessing::new(
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
            let _blessing_task = b.spawn(Arc::clone(&post), DEFAULT_REFRESH);
            b
        }
    };
    if let Some(w) = &wiring {
        serving_tasks.push(w.gate.spawn());
    }

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
            outbound_resolver(),
            outbound_connector(),
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
        c.trust_fly_client_ip = s.trust_fly_client_ip;
        c
    };
    let authority: Arc<dyn flagship_relay::hello::HelloAuthority> = match &wiring {
        Some(w) => Arc::new(DirectoryAuthority::new(LogDirectory(w.mesh.clone()))),
        None => Arc::new(authority),
    };
    let collab = Collaborators {
        authority,
        blessing: Some(blessing),
        meter: usage.clone().map(|m| m as Arc<dyn Meter>),
        outbound,
        mailboxes: s.pb_mail.then(|| Arc::new(MailboxRegistry::default())),
        stats_secret: s.usage_secret.clone(),
        serving: match &wiring {
            Some(w) => Some(w.gate.clone()),
            None => serving.as_ref().map(|(g, _, _)| g.clone()),
        },
        serving_feed: serving.as_ref().map(|(_, f, _)| Arc::clone(f)),
        phone: match &wiring {
            Some(w) => w.phone.clone(),
            None => serving.as_ref().and_then(|(_, _, p)| p.clone()),
        },
    };
    let running = relay::start_with_mesh(cfg, listeners, collab, wiring.map(|w| w.mesh))
        .map_err(|e| e.to_string())?;
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
    for t in serving_tasks {
        t.abort();
    }
    running.shutdown().await;
    Ok(())
}

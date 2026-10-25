//! `flagship-broker serve`: the privd v1 socket for the TS daemon and the typed v2 socket for
//! core, under systemd (`flagship-broker.service`, written by the daemon's rustStack module).
//!
//! Environment (all optional; defaults are the box's paths):
//! - `FLAGSHIP_BROKER_V1_SOCKET` (`/run/flagship-broker/privd.sock`), `FLAGSHIP_BROKER_V1_UIDS` (`0`),
//!   `FLAGSHIP_BROKER_V1_GROUP` (the daemon's group: the socket becomes `root:<group>` 0660)
//! - `FLAGSHIP_BROKER_SOCKET` (`/run/flagship-broker/broker.sock`), `FLAGSHIP_BROKER_TYPED_UIDS`
//!   (none: the typed socket refuses everyone until core's uid is listed)
//! - `FLAGSHIP_BROKER_STATE` (`/var/lib/flagship-broker`), `FLAGSHIP_BROKER_FILES_ROOT`
//!   (`/var/lib/flagship-files`)
//! - `FLAGSHIP_BROKER_ENGINE_FILE` (`/var/lib/flagship/engine-active`), read for every v1 request;
//!   `FLAGSHIP_BROKER_ENGINE` (`podman` or `docker`, default `docker`) only while that file is absent
//!
//! `flagship-broker check-v1` reads v1 requests as JSON lines on stdin and prints each verdict
//! (the shared-vector shape, conformance.rs); it executes nothing.
//! - `FLAGSHIP_BROKER_AUTHORITY_KEYS`: `keyId:hex32,…`, the pinned capability authorities. With
//!   none, every capability-bearing operation is refused; the read-only ones still answer.

use flagship_broker::audit::Audit;
use flagship_broker::capability::Ed25519Authority;
use flagship_broker::conformance;
use flagship_broker::peer::{KernelPeerCredentials, PeerPolicy};
use flagship_broker::podman::{ENGINE_ACTIVE_FILE, EngineKind, read_active_engine};
use flagship_broker::policy::ReleaseTrust;
use flagship_broker::privd::{V1Environment, V1Factory, V1Limits};
use flagship_broker::release::{embedded_trust, host_arch};
use flagship_broker::runner::{SystemRunner, group_id};
use flagship_broker::server::{ServerLimits, serve};
use flagship_broker::state::BrokerState;
use flagship_broker::typed::{
    BrokerConfig, Parts, SandboxNetwork, SecretStore, SystemClock, TypedBroker, TypedFactory,
};
use flagship_runtime::workload::SandboxDns;
use flagship_runtime::{Engine, InstallationId, OciCli, SecretHandle, SystemExecutor};
use std::io::{BufRead, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

fn env_path(name: &str, default: &str) -> PathBuf {
    std::env::var_os(name).map_or_else(|| PathBuf::from(default), PathBuf::from)
}

fn id_list(name: &str, default: &[u32]) -> Result<Vec<u32>, String> {
    let Ok(v) = std::env::var(name) else {
        return Ok(default.to_vec());
    };
    v.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.parse::<u32>()
                .map_err(|_| format!("{name} must be a comma-separated list of uids"))
        })
        .collect()
}

fn hex32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        let at = i.checked_mul(2)?;
        *b = u8::from_str_radix(s.get(at..at.checked_add(2)?)?, 16).ok()?;
    }
    Some(out)
}

fn authority() -> Result<Ed25519Authority, String> {
    let mut a = Ed25519Authority::new();
    let Ok(v) = std::env::var("FLAGSHIP_BROKER_AUTHORITY_KEYS") else {
        return Ok(a);
    };
    for item in v.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let (id, key) = item
            .split_once(':')
            .ok_or("FLAGSHIP_BROKER_AUTHORITY_KEYS entries are keyId:hex")?;
        let key = hex32(key).ok_or("an authority key is not 32 bytes of hex")?;
        a = a.with_key(id, key).map_err(|e| e.to_string())?;
    }
    Ok(a)
}

/// The box as the v1 policy sees it: the engine the box runs now (read for every request, so a
/// move to Podman after the broker started is followed), the host's mount table, and the
/// release trust compiled into this binary.
#[derive(Debug)]
struct BoxEnvironment {
    engine_file: PathBuf,
    engine_fallback: EngineKind,
    trust: ReleaseTrust,
}

impl V1Environment for BoxEnvironment {
    fn engine(&self) -> EngineKind {
        read_active_engine(&self.engine_file, self.engine_fallback)
    }
    fn mounts(&self) -> String {
        std::fs::read_to_string("/proc/self/mounts").unwrap_or_default()
    }
    fn trust(&self) -> &ReleaseTrust {
        &self.trust
    }
    fn arch(&self) -> &str {
        host_arch()
    }
}

/// `check-v1`: one verdict per request line; nothing runs.
fn check_v1() -> Result<(), String> {
    let trust = embedded_trust()?;
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let req: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        let v = conformance::check(&req, &trust);
        writeln!(out, "{v}").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// No secrets are handed to the broker yet (core's effect port is not written).
#[derive(Debug)]
struct NoSecrets;
impl SecretStore for NoSecrets {
    fn resolve(&self, _: &InstallationId, _: &SecretHandle) -> Option<String> {
        None
    }
}

/// The egress gateway still belongs to the TS daemon; the typed socket starts nothing that needs it.
#[derive(Debug)]
struct NoSandbox;
impl SandboxNetwork for NoSandbox {
    fn apps_sandbox(&self) -> Option<SandboxDns> {
        None
    }
}

fn listen(path: &Path, mode: u32, group: Option<u32>) -> Result<UnixListener, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{}: {e}", path.display())),
    }
    let l = UnixListener::bind(path).map_err(|e| format!("{}: {e}", path.display()))?;
    // The kernel peer check (SO_PEERCRED against the uid list) is what admits a caller; the
    // typed socket is connectable by anyone so core's own uid can reach it without a group.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if let Some(gid) = group {
        rustix::fs::chown(
            path,
            Some(rustix::fs::Uid::ROOT),
            Some(rustix::fs::Gid::from_raw(gid)),
        )
        .map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(l)
}

fn run() -> Result<(), String> {
    let cmd = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "serve".to_owned());
    if cmd == "--version" {
        let _ = writeln!(
            std::io::stdout(),
            "flagship-broker {}",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }
    if cmd == "check-v1" {
        return check_v1();
    }
    if cmd != "serve" {
        return Err(format!("unknown command {cmd}"));
    }
    let v1_path = env_path(
        "FLAGSHIP_BROKER_V1_SOCKET",
        "/run/flagship-broker/privd.sock",
    );
    let typed_path = env_path("FLAGSHIP_BROKER_SOCKET", "/run/flagship-broker/broker.sock");
    let state_dir = env_path("FLAGSHIP_BROKER_STATE", "/var/lib/flagship-broker");
    let files_root = env_path("FLAGSHIP_BROKER_FILES_ROOT", "/var/lib/flagship-files");
    let engine_file = env_path("FLAGSHIP_BROKER_ENGINE_FILE", ENGINE_ACTIVE_FILE);
    let engine_fallback = if std::env::var("FLAGSHIP_BROKER_ENGINE").as_deref() == Ok("podman") {
        EngineKind::Podman
    } else {
        EngineKind::Docker
    };
    let podman = read_active_engine(&engine_file, engine_fallback) == EngineKind::Podman;
    let v1_uids = id_list("FLAGSHIP_BROKER_V1_UIDS", &[0])?;
    // The daemon's group may open the v1 socket; the kernel's uid check still admits each caller.
    let v1_group = match std::env::var("FLAGSHIP_BROKER_V1_GROUP") {
        Ok(name) if !name.is_empty() => {
            Some(group_id(&name, Path::new("/etc/group")).ok_or(format!("no group {name}"))?)
        }
        _ => None,
    };
    let trust = embedded_trust()?;
    let typed_uids = id_list("FLAGSHIP_BROKER_TYPED_UIDS", &[])?;

    std::fs::create_dir_all(&state_dir).map_err(|e| format!("{}: {e}", state_dir.display()))?;
    std::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("{}: {e}", state_dir.display()))?;
    let audit = Arc::new(Audit::new(Some(state_dir.join("audit.log"))));
    let state =
        BrokerState::open(&state_dir.join("broker.db")).map_err(|e| format!("broker.db: {e:?}"))?;
    let engine = if podman {
        Engine::Podman
    } else {
        Engine::Docker
    };
    let broker = Arc::new(TypedBroker::new(
        BrokerConfig::production(files_root, state_dir),
        state,
        Parts {
            verifier: Box::new(authority()?),
            runtime: Box::new(OciCli::new(engine, SystemExecutor)),
            host: Box::new(SystemExecutor),
            secrets: Box::new(NoSecrets),
            network: Box::new(NoSandbox),
            clock: Box::new(SystemClock),
            audit: Arc::clone(&audit),
        },
    ));

    let stop = Arc::new(AtomicBool::new(false));
    let v1 = listen(
        &v1_path,
        if v1_group.is_some() { 0o660 } else { 0o600 },
        v1_group,
    )?;
    let typed = listen(&typed_path, 0o666, None)?;
    let auth: Arc<KernelPeerCredentials> = Arc::new(KernelPeerCredentials);

    let (stop2, audit2, auth2) = (Arc::clone(&stop), Arc::clone(&audit), Arc::clone(&auth));
    let typed_thread = std::thread::Builder::new()
        .name("broker-typed".into())
        .spawn(move || {
            serve(
                typed,
                auth2,
                PeerPolicy::uids(typed_uids),
                Arc::new(TypedFactory {
                    broker,
                    max_per_second: 20,
                }),
                ServerLimits::default(),
                stop2,
                audit2,
            )
        })
        .map_err(|e| e.to_string())?;

    let mut out = std::io::stdout();
    let _ = writeln!(
        out,
        "flagship-broker serving {} (v1) and {} (typed), engine {}",
        v1_path.display(),
        typed_path.display(),
        if podman { "podman" } else { "docker" }
    );
    let _ = out.flush();
    let result = serve(
        v1,
        auth,
        PeerPolicy::uids(v1_uids),
        Arc::new(V1Factory {
            runner: Arc::new(SystemRunner::default()),
            env: Arc::new(BoxEnvironment {
                engine_file,
                engine_fallback,
                trust,
            }),
            audit: Arc::clone(&audit),
            limits: V1Limits::default(),
        }),
        ServerLimits::default(),
        Arc::clone(&stop),
        audit,
    );
    stop.store(true, Ordering::SeqCst);
    let _ = typed_thread.join();
    result.map_err(|e| e.to_string())
}

fn main() {
    if let Err(e) = run() {
        let _ = writeln!(std::io::stderr(), "flagship-broker: {e}");
        std::process::exit(1);
    }
}

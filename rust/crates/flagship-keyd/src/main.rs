//! `flagship-keyd serve`: the Rust backend. Same environment and state directory as the TS
//! `main.ts`. `migrate` stays with the TS backend.

use std::io::Write;
use std::path::PathBuf;

use flagship_keyd::acme::{AcmeAccount, LETS_ENCRYPT_HOSTS};
use flagship_keyd::files::{load_policy, names_for, read_key_file};
use flagship_keyd::hardening::harden_process;
use flagship_keyd::policy::parse_rate_limits;
use flagship_keyd::server::{PeerPolicy, Server, ServerOptions};
use flagship_keyd::service::KeydService;
use flagship_keyd::tls::{TlsKeys, system_clock};
use nix::sys::signal::{SigSet, Signal};

fn env_path(name: &str, default: &str) -> PathBuf {
    std::env::var_os(name).map_or_else(|| PathBuf::from(default), PathBuf::from)
}

fn id_list(name: &str) -> Result<Option<Vec<u32>>, String> {
    let Ok(v) = std::env::var(name) else {
        return Ok(None);
    };
    v.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.parse::<u32>()
                .map_err(|_| format!("{name} must be a comma-separated list of ids"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// Callers allowed by peer credentials. Unset means root and keyd's own uid only; the box sets
/// `FLAGSHIP_KEYD_ALLOW_UIDS` / `FLAGSHIP_KEYD_ALLOW_GIDS` to the daemon's ids.
fn peer_policy() -> Result<PeerPolicy, String> {
    let uids = id_list("FLAGSHIP_KEYD_ALLOW_UIDS")?;
    let gids = id_list("FLAGSHIP_KEYD_ALLOW_GIDS")?;
    let me = nix::unistd::geteuid().as_raw();
    Ok(PeerPolicy {
        uids: uids.unwrap_or_else(|| if me == 0 { vec![0] } else { vec![0, me] }),
        gids: gids.unwrap_or_default(),
    })
}

fn run() -> Result<(), String> {
    harden_process().map_err(|e| format!("could not disable core dumps: {e}"))?;
    let cmd = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "serve".to_owned());
    if cmd == "migrate" {
        return Err(
            "migrate is run by the TS backend (node packages/keyd/dist/main.js migrate)".to_owned(),
        );
    }
    if cmd != "serve" {
        return Err(format!("unknown command {cmd}"));
    }
    let state = env_path("FLAGSHIP_KEYD_STATE", "/var/lib/flagship-keyd");
    let socket = env_path("FLAGSHIP_KEYD_SOCKET", "/run/flagship-keyd/keyd.sock");
    let peers = peer_policy()?;

    // Signals are taken by one thread with sigwait; every thread started later inherits the block.
    let mut signals = SigSet::empty();
    signals.add(Signal::SIGTERM);
    signals.add(Signal::SIGINT);
    signals.thread_block().map_err(|e| e.to_string())?;

    let identity = read_key_file(&state.join("identity.key"))
        .map_err(|e| e.to_string())?
        .ok_or("no identity key: run `flagship-keyd migrate` or provision one first")?;
    let swk = read_key_file(&state.join("swk.key")).map_err(|e| e.to_string())?;
    let cgk = read_key_file(&state.join("cgk.key")).map_err(|e| e.to_string())?;
    let fqdn = load_policy(&state).map_err(|e| format!("policy.json: {e}"))?;
    let tls = fqdn.map(|f| TlsKeys::new(names_for(&f), Some(state.join("tls")), system_clock()));
    let acme = match &tls {
        Some(_) => Some(AcmeAccount::new(
            LETS_ENCRYPT_HOSTS.iter().map(|h| (*h).to_owned()).collect(),
            Some(state.join("acme-account.key")),
        )?),
        None => None,
    };
    let service = KeydService::new(&identity, swk, cgk, Some(state.clone()), tls, acme);
    drop(identity);

    let mut opts = ServerOptions::new(socket.clone(), peers);
    opts.audit_path = Some(state.join("audit.log"));
    if let Ok(json) = std::env::var("FLAGSHIP_KEYD_RATE_LIMITS") {
        opts.rate_limits = parse_rate_limits(&json)
            .map_err(|e| format!("FLAGSHIP_KEYD_RATE_LIMITS: {}", e.message))?;
    }
    let pub16: String = service.public_key_hex().chars().take(16).collect();
    let server = Server::bind(opts, service).map_err(|e| e.to_string())?;
    let handle = server.handle();
    std::thread::Builder::new()
        .name("keyd-signals".into())
        .spawn(move || {
            if signals.wait().is_ok() {
                handle.shutdown();
                std::process::exit(0);
            }
        })
        .map_err(|e| e.to_string())?;
    let mut out = std::io::stdout();
    let _ = writeln!(
        out,
        "flagship-keyd serving {} for key {pub16}…",
        socket.display()
    );
    let _ = out.flush();
    server.serve().map_err(|e| e.to_string())
}

fn main() {
    if let Err(e) = run() {
        let _ = writeln!(std::io::stderr(), "flagship-keyd: {e}");
        std::process::exit(1);
    }
}

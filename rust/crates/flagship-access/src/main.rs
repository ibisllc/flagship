//! `flagship-access serve`: the access decision socket (release plan R4).
//!
//! Environment: `FLAGSHIP_ACCESS_SOCKET` (`/run/flagship-access/access.sock`), `FLAGSHIP_ACCESS_STATE`
//! (`/var/flagship/data/flagship-access/service-access.json`), `FLAGSHIP_ACCESS_SESSIONS`
//! (`/var/flagship/service-sessions.json`), `FLAGSHIP_ACCESS_ALLOW_UIDS` (`0`: the uids admitted).

use flagship_access::server::{Context, peer_uid, serve_connection};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

fn run() -> Result<(), String> {
    match std::env::args().nth(1).as_deref() {
        Some("--version") => {
            let _ = writeln!(
                std::io::stdout(),
                "flagship-access {}",
                env!("CARGO_PKG_VERSION")
            );
            return Ok(());
        }
        Some("serve") | None => {}
        Some(other) => return Err(format!("unknown command {other} (serve)")),
    }
    let socket = PathBuf::from(env_or(
        "FLAGSHIP_ACCESS_SOCKET",
        "/run/flagship-access/access.sock",
    ));
    let ctx = Context {
        state_path: env_or(
            "FLAGSHIP_ACCESS_STATE",
            "/var/flagship/data/flagship-access/service-access.json",
        )
        .into(),
        sessions_path: env_or(
            "FLAGSHIP_ACCESS_SESSIONS",
            "/var/flagship/service-sessions.json",
        )
        .into(),
    };
    let allowed: Vec<u32> = env_or("FLAGSHIP_ACCESS_ALLOW_UIDS", "0")
        .split(',')
        .filter_map(|u| u.trim().parse().ok())
        .collect();
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).map_err(|e| format!("{}: {e}", socket.display()))?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o660))
        .map_err(|e| e.to_string())?;
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        match peer_uid(&stream) {
            Ok(uid) if allowed.contains(&uid) => {}
            _ => continue,
        }
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let _ = serve_connection(&ctx, stream);
        });
    }
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        let _ = writeln!(std::io::stderr(), "flagship-access: {e}");
        std::process::exit(1);
    }
}

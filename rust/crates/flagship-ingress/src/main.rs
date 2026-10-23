//! flagship-ingress: the box's TLS frontend, holding no private key (README.md).

use std::io::Write;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use flagship_ingress::args;
use flagship_ingress::keyd::KeydClient;
use flagship_ingress::server::{self, IngressConfig};
use flagship_ingress::source::{CertSource, Reload};
use tokio::signal::unix::{SignalKind, signal};

fn log(msg: &str) {
    let _ = writeln!(std::io::stderr(), "flagship-ingress: {msg}");
}

fn main() -> ExitCode {
    let a = match args::parse(std::env::args().skip(1)) {
        Ok(a) => a,
        Err(e) => {
            log(&e.0);
            return ExitCode::from(2);
        }
    };
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log(&format!("runtime: {e}"));
            return ExitCode::FAILURE;
        }
    };
    rt.block_on(run(a))
}

async fn run(a: args::Args) -> ExitCode {
    let keyd = Arc::new(KeydClient::new(&a.keyd, "flagship-ingress", a.keyd_timeout));
    let source = Arc::new(CertSource::new(keyd, a.limits.handshake_timeout));
    // Not fatal: until keyd has a certificate in service, handshakes are refused and retried.
    let first = Arc::clone(&source);
    match tokio::task::spawn_blocking(move || first.reload()).await {
        Ok(Ok(Reload::Loaded)) => log("loaded the certificate in service"),
        Ok(Ok(_)) => {}
        Ok(Err(e)) => log(&format!("no certificate yet: {e}")),
        Err(_) => log("initial reload failed"),
    }
    let tls = match server::tls_configs(&source, a.kx) {
        Ok(t) => t,
        Err(e) => {
            log(&format!("tls: {e}"));
            return ExitCode::FAILURE;
        }
    };
    let listener = match tokio::net::TcpListener::bind(&a.listen).await {
        Ok(l) => l,
        Err(e) => {
            log(&format!("listen {}: {e}", a.listen));
            return ExitCode::FAILURE;
        }
    };
    // Tell the caller where we actually are (useful with port 0), as flagship-tlsd does.
    if let Ok(addr) = listener.local_addr() {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "listening {addr}");
        let _ = out.flush();
    }
    let (Ok(mut term), Ok(mut int), Ok(mut hup)) = (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
        signal(SignalKind::hangup()),
    ) else {
        log("signals unavailable");
        return ExitCode::FAILURE;
    };
    tokio::spawn(Arc::clone(&source).run_reloader(a.refresh, Duration::from_millis(250), log));
    let nudger = Arc::clone(&source);
    tokio::spawn(async move {
        while hup.recv().await.is_some() {
            nudger.request_reload();
        }
    });
    let cfg = Arc::new(IngressConfig {
        upstream: a.upstream,
        limits: a.limits,
        kx: a.kx,
    });
    let shutdown = async move {
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
    };
    server::serve(listener, cfg, tls, shutdown).await;
    ExitCode::SUCCESS
}

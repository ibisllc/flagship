//! One WASI app's worker process on the box (`flagship-wasi@<app>.service`).
//!
//! ```text
//! flagship-wasi-worker check --config <file>   admit + compile, then exit
//! flagship-wasi-worker serve --config <file>   http-proxy world: serve the app on its loopback port
//! flagship-wasi-worker run   --config <file>   command world: run _start once, exit with its code
//! ```
//!
//! Errors are printed without host paths; the box passes them through the
//! model redactor before any AI reads them.

use std::collections::BTreeMap;
use std::io::Write;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use flagship_wasi::{
    AppServer, CapabilityBroker, ConfigError, Exit, RunInput, UnixSocketBroker, WasiWorld,
    WorkerFileConfig,
};

fn usage() -> ExitCode {
    eprintln!("usage: flagship-wasi-worker <check|serve|run> --config <file>");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(cmd), Some(flag), Some(path), None) =
        (args.first(), args.get(1), args.get(2), args.get(3))
    else {
        return usage();
    };
    if flag != "--config" {
        return usage();
    }
    match run(cmd, PathBuf::from(path)) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("flagship-wasi-worker: {e}");
            ExitCode::from(1)
        }
    }
}

fn run(cmd: &str, path: PathBuf) -> Result<ExitCode, ConfigError> {
    let config = WorkerFileConfig::load(&path)?;
    let broker = config.cap_socket.clone().map(UnixSocketBroker::new);
    let secret_env = match (&broker, cmd) {
        (Some(b), "serve" | "run") => b.hello().map_err(|e| {
            ConfigError::Invalid(format!(
                "could not get the app's settings from the box: {e}"
            ))
        })?,
        _ => BTreeMap::new(),
    };
    let prepared = config.prepare(&secret_env)?;
    let app = prepared.grant.app_id().to_owned();
    match cmd {
        "check" => {
            let line = serde_json::json!({
                "ok": true,
                "appId": app,
                "digest": prepared.compiled.digest(),
                "world": prepared.grant.world(),
            });
            let mut out = std::io::stdout().lock();
            let _ = writeln!(out, "{line}");
            Ok(ExitCode::SUCCESS)
        }
        "serve" => {
            if prepared.grant.world() != WasiWorld::HttpProxy {
                return Err(ConfigError::Invalid(
                    "serve needs the http-proxy world".into(),
                ));
            }
            let addr = prepared
                .listen
                .ok_or_else(|| ConfigError::Invalid("serve needs listen".into()))?;
            let listener = TcpListener::bind(addr)
                .map_err(|_| ConfigError::Invalid("could not listen on the app's port".into()))?;
            let tag = app.clone();
            let server = AppServer::new(
                prepared.worker,
                prepared.compiled,
                prepared.grant,
                prepared.preopens,
                broker.map(|b| Arc::new(b) as Arc<dyn CapabilityBroker>),
                prepared.server_limits,
            )?
            .with_log(Arc::new(move |m: &str| eprintln!("[wasi {tag}] {m}")));
            eprintln!("[wasi {app}] serving on {addr}");
            let stop = AtomicBool::new(false);
            Arc::new(server)
                .serve(&listener, &stop)
                .map_err(|_| ConfigError::Invalid("the listener failed".into()))?;
            Ok(ExitCode::SUCCESS)
        }
        "run" => {
            let input = RunInput {
                stdin: b"",
                extra_env: &[],
                broker: broker.map(|b| Arc::new(b) as Arc<dyn CapabilityBroker>),
            };
            let out = prepared.worker.run_compiled(
                &prepared.compiled,
                &prepared.grant,
                &prepared.preopens,
                input,
            )?;
            let _ = std::io::stdout().lock().write_all(&out.stdout);
            let _ = std::io::stderr().lock().write_all(&out.stderr);
            let Exit::Code(code) = out.exit;
            eprintln!("[wasi {app}] exited with code {code}");
            Ok(ExitCode::from(u8::try_from(code).unwrap_or(1)))
        }
        _ => Ok(usage()),
    }
}

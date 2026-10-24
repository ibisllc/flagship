//! `flagship-core shadow`: the controller on a real box, in shadow mode. It holds the controller
//! lock (so a second core cannot start), reads the TS controller's checkpoint, asks the broker
//! what the engine runs (`ListWorkloads`, read-only, no capability), journals each change of
//! verdict and writes a status file the daemon's update gate reads. It never asks for an effect.
//!
//! Environment: `FLAGSHIP_CORE_DIR` (`/var/lib/flagship-core`), `FLAGSHIP_CORE_BROKER`
//! (`/run/flagship-broker/broker.sock`), `FLAGSHIP_CORE_CHECKPOINT`
//! (`<dir>/ts-checkpoint.json`), `FLAGSHIP_CORE_STATUS` (`/run/flagship-core/status.json`),
//! `FLAGSHIP_CORE_INTERVAL_SECS` (60).

use flagship_core::handover::TsCheckpoint;
use flagship_core::journal::Journal;
use flagship_core::lock::ControllerLock;
use flagship_core::shadow::{Seen, compare, divergent};
use flagship_runtime::InstallationId;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn env_path(name: &str, default: &Path) -> PathBuf {
    std::env::var_os(name).map_or_else(|| default.to_path_buf(), PathBuf::from)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

const MAX_FRAME: usize = 1 << 20;

fn call(socket: &Path, op: &str, n: u64) -> Result<Value, String> {
    let mut s = UnixStream::connect(socket).map_err(|e| format!("{}: {e}", socket.display()))?;
    s.set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    let deadline = now_secs().saturating_add(60).saturating_mul(1000);
    let body = json!({
        "protocolVersion": 2,
        "requestId": format!("core-{n}"),
        "op": op,
        "operationRef": format!("core-shadow-{n}"),
        "target": { "installation": null, "generation": 0 },
        "expectedRevision": 0,
        "deadlineUnixMs": deadline,
        "payload": {},
    })
    .to_string();
    let len = u32::try_from(body.len()).map_err(|_| "request too long".to_owned())?;
    s.write_all(&len.to_be_bytes())
        .and_then(|()| s.write_all(body.as_bytes()))
        .map_err(|e| e.to_string())?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head).map_err(|e| e.to_string())?;
    let size = usize::try_from(u32::from_be_bytes(head)).map_err(|e| e.to_string())?;
    if size == 0 || size > MAX_FRAME {
        return Err("the broker answered with a bad frame".into());
    }
    let mut buf = vec![0u8; size];
    s.read_exact(&mut buf).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&buf).map_err(|e| e.to_string())?;
    if v.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(format!(
            "the broker refused {op}: {}",
            v.get("message")
                .and_then(Value::as_str)
                .unwrap_or("no reason")
        ));
    }
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
}

fn seen_from(result: &Value) -> Vec<Seen> {
    result
        .get("workloads")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|w| {
                    Some(Seen {
                        installation: w.get("installation")?.as_str()?.to_owned(),
                        state: w.get("state")?.as_str()?.to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn write_status(path: &Path, v: &Value) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, format!("{v}\n")).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

fn run() -> Result<(), String> {
    let cmd = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "shadow".to_owned());
    if cmd == "--version" {
        let _ = writeln!(
            std::io::stdout(),
            "flagship-core {}",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }
    if cmd != "shadow" {
        return Err(format!(
            "unknown command {cmd} (only shadow is available: handover needs the capability issuer)"
        ));
    }
    let dir = env_path("FLAGSHIP_CORE_DIR", Path::new("/var/lib/flagship-core"));
    let broker = env_path(
        "FLAGSHIP_CORE_BROKER",
        Path::new("/run/flagship-broker/broker.sock"),
    );
    let checkpoint_path = env_path("FLAGSHIP_CORE_CHECKPOINT", &dir.join("ts-checkpoint.json"));
    let status_path = env_path(
        "FLAGSHIP_CORE_STATUS",
        Path::new("/run/flagship-core/status.json"),
    );
    let interval = std::env::var("FLAGSHIP_CORE_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(60)
        .clamp(5, 3600);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let _lock = ControllerLock::acquire(&dir.join("controller.lock"))
        .map_err(|e| format!("controller lock: {e}"))?;
    let mut journal = Journal::open(&dir.join("journal.db")).map_err(|e| e.to_string())?;
    let mut last: BTreeMap<String, String> = BTreeMap::new();
    let mut n: u64 = 0;
    let _ = writeln!(
        std::io::stdout(),
        "flagship-core shadow: term {}, every {interval}s",
        journal.term()
    );
    loop {
        n = n.saturating_add(1);
        let tick = now_secs();
        let outcome = (|| -> Result<(usize, usize), String> {
            let text = match std::fs::read_to_string(&checkpoint_path) {
                Ok(t) => t,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    r#"{"takenAt":0,"tsControllerPaused":false,"workloads":[]}"#.to_owned()
                }
                Err(e) => return Err(format!("checkpoint: {e}")),
            };
            let cp: TsCheckpoint =
                serde_json::from_str(&text).map_err(|e| format!("checkpoint: {e}"))?;
            let seen = seen_from(&call(&broker, "ListWorkloads", n)?);
            let verdicts = compare(&cp, &seen);
            for (inst, verdict) in &verdicts {
                if last.get(inst) != Some(verdict)
                    && let Ok(id) = InstallationId::parse(inst)
                {
                    journal
                        .record_shadow(&id, verdict, tick)
                        .map_err(|e| e.to_string())?;
                }
            }
            let d = divergent(&verdicts);
            let total = verdicts.len();
            last = verdicts;
            Ok((total, d))
        })();
        let status = match outcome {
            Ok((total, d)) => json!({
                "component": "core", "mode": "shadow", "ok": true, "at": tick,
                "term": journal.term(), "installations": total, "divergent": d,
            }),
            Err(e) => json!({
                "component": "core", "mode": "shadow", "ok": false, "at": tick,
                "term": journal.term(), "error": e,
            }),
        };
        write_status(&status_path, &status);
        std::thread::sleep(Duration::from_secs(interval));
    }
}

fn main() {
    if let Err(e) = run() {
        let _ = writeln!(std::io::stderr(), "flagship-core: {e}");
        std::process::exit(1);
    }
}

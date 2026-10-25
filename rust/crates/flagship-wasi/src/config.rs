//! The file the box writes for one app's worker process
//! (`flagship/wasi-worker/v1`), and the socket broker that answers the app's
//! host calls from the daemon.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::WorkerError;
use crate::hostcalls::{BrokerError, CapabilityBroker, MAX_HOST_RESPONSE};
use crate::limits::Ceilings;
use crate::manifest::{
    FILES_GUEST_PATH, HostCall, Preopen, SCRATCH_GUEST_PATH, WasiCapabilityManifest, WasiGrant,
};
use crate::server::ServerLimits;
use crate::worker::{CompiledModule, ModuleSource, Worker, WorkerConfig};

pub const WORKER_CONFIG_SCHEMA: &str = "flagship/wasi-worker/v1";
const MAX_CONFIG_BYTES: u64 = 256 * 1024;
const MAX_MODULE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerFileConfig {
    pub schema: String,
    pub manifest: WasiCapabilityManifest,
    /// The module digest the owner's install order named.
    pub approved_digest: String,
    pub module_path: PathBuf,
    /// Loopback address the app proxy dials (`http-proxy` world).
    #[serde(default)]
    pub listen: Option<String>,
    #[serde(default)]
    pub files_dir: Option<PathBuf>,
    #[serde(default)]
    pub scratch_dir: Option<PathBuf>,
    /// The daemon's socket for this app's host calls and its start-up env.
    #[serde(default)]
    pub cap_socket: Option<PathBuf>,
    /// Non-secret platform variables (`FLAGSHIP_APP_ID`, ...). Secrets come
    /// over the socket, never through this file.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub max_concurrent_runs: Option<usize>,
    #[serde(default)]
    pub max_connections: Option<usize>,
    #[serde(default)]
    pub max_body_bytes: Option<usize>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("config: {0}")]
    Invalid(String),
    #[error("config: could not read {0}")]
    Read(&'static str),
    #[error(transparent)]
    Worker(#[from] WorkerError),
}

/// Everything a process needs to serve or run the app.
#[derive(Debug)]
pub struct Prepared {
    pub worker: Worker,
    pub compiled: CompiledModule,
    pub grant: WasiGrant,
    pub preopens: Vec<Preopen>,
    pub listen: Option<SocketAddr>,
    pub server_limits: ServerLimits,
}

fn read_bounded(path: &Path, max: u64, what: &'static str) -> Result<Vec<u8>, ConfigError> {
    let f = std::fs::File::open(path).map_err(|_| ConfigError::Read(what))?;
    let mut buf = Vec::new();
    f.take(max.saturating_add(1))
        .read_to_end(&mut buf)
        .map_err(|_| ConfigError::Read(what))?;
    if u64::try_from(buf.len()).unwrap_or(u64::MAX) > max {
        return Err(ConfigError::Invalid(format!("{what} is too large")));
    }
    Ok(buf)
}

impl WorkerFileConfig {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let raw = read_bounded(path, MAX_CONFIG_BYTES, "the config file")?;
        let c: Self =
            serde_json::from_slice(&raw).map_err(|e| ConfigError::Invalid(e.to_string()))?;
        if c.schema != WORKER_CONFIG_SCHEMA {
            return Err(ConfigError::Invalid(format!(
                "schema must be {WORKER_CONFIG_SCHEMA}"
            )));
        }
        if c.manifest.app_id.is_empty() {
            return Err(ConfigError::Invalid("manifest.appId is required".into()));
        }
        Ok(c)
    }

    /// Admit the manifest, read and compile the module (never a cached
    /// native artifact), and open nothing but the granted directories.
    pub fn prepare(&self, secret_env: &BTreeMap<String, String>) -> Result<Prepared, ConfigError> {
        let mut platform = self.env.clone();
        platform.extend(secret_env.iter().map(|(k, v)| (k.clone(), v.clone())));
        let grant = WasiGrant::admit(&self.manifest, &self.approved_digest, &Ceilings::default())
            .map_err(WorkerError::from)?
            .with_platform_env(&platform)
            .map_err(WorkerError::from)?;
        let listen = match &self.listen {
            None => None,
            Some(s) => {
                let a: SocketAddr = s
                    .parse()
                    .map_err(|_| ConfigError::Invalid("listen is not an address".into()))?;
                if !a.ip().is_loopback() {
                    return Err(ConfigError::Invalid(
                        "listen must be a loopback address".into(),
                    ));
                }
                Some(a)
            }
        };
        let mut preopens = Vec::new();
        for (guest, perms) in grant.preopens() {
            let host = match guest.as_str() {
                FILES_GUEST_PATH => self.files_dir.clone(),
                SCRATCH_GUEST_PATH => self.scratch_dir.clone(),
                _ => None,
            }
            .ok_or_else(|| ConfigError::Invalid(format!("no directory for {guest}")))?;
            preopens.push(Preopen {
                guest: guest.clone(),
                host,
                perms: *perms,
            });
        }
        if grant.preopens().is_empty() && (self.files_dir.is_some() || self.scratch_dir.is_some()) {
            return Err(ConfigError::Invalid(
                "a directory was given that the manifest does not ask for".into(),
            ));
        }
        let bytes = read_bounded(&self.module_path, MAX_MODULE_BYTES, "the module")?;
        let defaults = WorkerConfig::default();
        let worker = Worker::for_app(
            WorkerConfig {
                max_concurrent_runs: self
                    .max_concurrent_runs
                    .unwrap_or(defaults.max_concurrent_runs)
                    .clamp(1, 64),
                max_module_bytes: usize::try_from(MAX_MODULE_BYTES).unwrap_or(usize::MAX),
                ..defaults
            },
            grant.app_id(),
        )?;
        let source = if bytes.starts_with(b"\0asm") {
            ModuleSource::Wasm(&bytes)
        } else {
            let text = std::str::from_utf8(&bytes).map_err(|_| WorkerError::NotWasm)?;
            ModuleSource::Wat(text)
        };
        let compiled = worker.compile_for(&grant, source)?;
        let d = ServerLimits::default();
        Ok(Prepared {
            worker,
            compiled,
            grant,
            preopens,
            listen,
            server_limits: ServerLimits {
                max_connections: self
                    .max_connections
                    .unwrap_or(d.max_connections)
                    .clamp(1, 1024),
                max_body_bytes: self
                    .max_body_bytes
                    .unwrap_or(d.max_body_bytes)
                    .clamp(1024, 64 * 1024 * 1024),
                ..d
            },
        })
    }
}

/// The daemon's end of an app's host calls: one JSON line per call over the
/// app's own Unix socket. Which app is calling is the socket, not anything
/// the guest wrote.
#[derive(Clone, Debug)]
pub struct UnixSocketBroker {
    path: PathBuf,
}

#[derive(Deserialize)]
struct Answer {
    ok: bool,
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

impl UnixSocketBroker {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn exchange(
        &self,
        op: &str,
        request: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, BrokerError> {
        use std::os::unix::net::UnixStream;
        let timeout = timeout.max(Duration::from_millis(10));
        let mut s = UnixStream::connect(&self.path)
            .map_err(|_| BrokerError::Failed("the box's broker is not reachable".into()))?;
        let _ = s.set_read_timeout(Some(timeout));
        let _ = s.set_write_timeout(Some(timeout));
        let mut line = serde_json::json!({ "op": op, "request": request })
            .to_string()
            .into_bytes();
        line.push(b'\n');
        s.write_all(&line)
            .map_err(|_| BrokerError::Failed("the box's broker closed".into()))?;
        let mut reply = Vec::new();
        let limit = u64::try_from(MAX_HOST_RESPONSE)
            .unwrap_or(u64::MAX)
            .saturating_mul(2);
        let read = BufReader::new(s).take(limit).read_until(b'\n', &mut reply);
        match read {
            Ok(_) if reply.ends_with(b"\n") => {}
            Ok(_) => return Err(BrokerError::Failed("the box's answer was cut short".into())),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return Err(BrokerError::Timeout);
            }
            Err(_) => return Err(BrokerError::Failed("the box's broker closed".into())),
        }
        let a: Answer = serde_json::from_slice(&reply)
            .map_err(|_| BrokerError::Failed("the box's answer was not JSON".into()))?;
        if a.ok {
            return Ok(a.result.unwrap_or(serde_json::Value::Null));
        }
        let msg = a.error.unwrap_or_else(|| "refused".into());
        Err(match a.code.as_deref() {
            Some("denied") => BrokerError::Denied(msg),
            Some("timeout") => BrokerError::Timeout,
            _ => BrokerError::Failed(msg),
        })
    }

    /// The app's start-up variables (owner env, data credentials). Kept off
    /// disk: the box hands them over this socket once per start.
    pub fn hello(&self) -> Result<BTreeMap<String, String>, BrokerError> {
        let v = self.exchange("hello", serde_json::json!({}), Duration::from_secs(10))?;
        let env = v.get("env").cloned().unwrap_or(serde_json::Value::Null);
        serde_json::from_value(env)
            .map_err(|_| BrokerError::Failed("hello answer has no env map".into()))
    }
}

impl CapabilityBroker for UnixSocketBroker {
    fn call(
        &self,
        call: HostCall,
        request: &[u8],
        timeout: Duration,
    ) -> Result<Vec<u8>, BrokerError> {
        let req: serde_json::Value = serde_json::from_slice(request)
            .map_err(|_| BrokerError::Failed("the request is not JSON".into()))?;
        let v = self.exchange(call.name(), req, timeout)?;
        Ok(v.to_string().into_bytes())
    }
}

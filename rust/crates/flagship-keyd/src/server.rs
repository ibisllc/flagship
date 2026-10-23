//! The AF_UNIX server (`server.ts`): hello first, strict parsing, rate limits, an audit line per
//! request. On top of the TS backend it checks the caller's peer credentials against an
//! allowlist before reading a byte.

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use zeroize::{Zeroize, Zeroizing};

use crate::files::ensure_dir;
use crate::policy::{Limit, RateLimiter};
use crate::service::KeydService;
use crate::tls::now_ms;
use crate::wire::{
    ErrorCode, KeydError, encode_frame, err_response, frame_len, ok_response, parse_frame_body,
    parse_request,
};

/// Who may connect. A caller passes if its uid or its (effective, primary) gid is listed.
#[derive(Debug, Clone, Default)]
pub struct PeerPolicy {
    pub uids: Vec<u32>,
    pub gids: Vec<u32>,
}

impl PeerPolicy {
    pub fn allows(&self, uid: u32, gid: u32) -> bool {
        self.uids.contains(&uid) || self.gids.contains(&gid)
    }
}

#[derive(Debug)]
pub struct ServerOptions {
    pub socket_path: PathBuf,
    pub audit_path: Option<PathBuf>,
    pub audit_max_bytes: u64,
    pub rate_limits: std::collections::HashMap<String, Limit>,
    pub max_connections: usize,
    pub hello_timeout: Duration,
    pub peers: PeerPolicy,
}

impl ServerOptions {
    pub fn new(socket_path: PathBuf, peers: PeerPolicy) -> Self {
        Self {
            socket_path,
            audit_path: None,
            audit_max_bytes: 8 * 1024 * 1024,
            rate_limits: crate::policy::default_rate_limits(),
            max_connections: 32,
            hello_timeout: Duration::from_millis(5000),
            peers,
        }
    }
}

struct Audit {
    path: Option<PathBuf>,
    max: u64,
    key: String,
}

#[derive(Debug, Clone, Copy)]
struct AuditRec<'a> {
    op: &'a str,
    component: &'a str,
    ok: bool,
    code: Option<ErrorCode>,
    purpose: Option<&'a str>,
}

impl Audit {
    /// One JSON line in the TS field order: t, key, op, component, ok, then purpose or code.
    fn write(&self, rec: AuditRec<'_>) {
        let Some(path) = &self.path else { return };
        let q = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_owned());
        let mut line = format!(
            "{{\"t\":{},\"key\":{},\"op\":{},\"component\":{},\"ok\":{}",
            now_ms(),
            q(&self.key),
            q(rec.op),
            q(rec.component),
            rec.ok
        );
        if let Some(c) = rec.code {
            line.push_str(&format!(",\"code\":{}", q(c.as_str())));
        }
        if let Some(p) = rec.purpose {
            line.push_str(&format!(",\"purpose\":{}", q(p)));
        }
        line.push_str("}\n");
        // An audit write failure never blocks a signature the box needs to stay up.
        if fs::metadata(path).is_ok_and(|m| m.len() > self.max) {
            let mut rotated = path.as_os_str().to_owned();
            rotated.push(".1");
            let _ = fs::rename(path, PathBuf::from(rotated));
        }
        if let Ok(mut f) = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o640)
            .open(path)
        {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

struct Shared {
    service: Mutex<KeydService>,
    limiter: Mutex<RateLimiter>,
    audit: Mutex<Audit>,
    active: AtomicUsize,
    max_connections: usize,
    hello_timeout: Duration,
    peers: PeerPolicy,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Debug)]
pub enum StartError {
    AlreadyRunning(PathBuf),
    Io(std::io::Error),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyRunning(p) => write!(f, "keyd is already running on {}", p.display()),
            Self::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for StartError {}

pub struct Server {
    listener: UnixListener,
    socket_path: PathBuf,
    shared: Arc<Shared>,
}

impl std::fmt::Debug for Server {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Server")
            .field("socket_path", &self.socket_path)
            .finish_non_exhaustive()
    }
}

/// Lets another thread zero the keys and remove the socket (the SIGTERM path).
#[derive(Clone)]
pub struct ServerHandle {
    socket_path: PathBuf,
    shared: Arc<Shared>,
}

impl std::fmt::Debug for ServerHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerHandle")
            .field("socket_path", &self.socket_path)
            .finish_non_exhaustive()
    }
}

impl ServerHandle {
    /// Zero the keys and remove the socket. Requests after this fail; the process should exit.
    pub fn shutdown(&self) {
        lock(&self.shared.service).destroy();
        let _ = fs::remove_file(&self.socket_path);
    }
}

impl Server {
    pub fn bind(opts: ServerOptions, service: KeydService) -> Result<Self, StartError> {
        let path = opts.socket_path.clone();
        if let Some(parent) = path.parent() {
            ensure_dir(parent, 0o750).map_err(StartError::Io)?;
        }
        // A stale socket from a crashed run is removed; a live one means another keyd is up.
        if fs::symlink_metadata(&path).is_ok() {
            if UnixStream::connect(&path).is_ok() {
                return Err(StartError::AlreadyRunning(path));
            }
            fs::remove_file(&path).map_err(StartError::Io)?;
        }
        let listener = UnixListener::bind(&path).map_err(StartError::Io)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o660)).map_err(StartError::Io)?;
        let key = service.public_key_hex().chars().take(16).collect();
        let shared = Arc::new(Shared {
            service: Mutex::new(service),
            limiter: Mutex::new(RateLimiter::new(opts.rate_limits)),
            audit: Mutex::new(Audit {
                path: opts.audit_path,
                max: opts.audit_max_bytes,
                key,
            }),
            active: AtomicUsize::new(0),
            max_connections: opts.max_connections,
            hello_timeout: opts.hello_timeout,
            peers: opts.peers,
        });
        Ok(Self {
            listener,
            socket_path: path,
            shared,
        })
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    pub fn handle(&self) -> ServerHandle {
        ServerHandle {
            socket_path: self.socket_path.clone(),
            shared: Arc::clone(&self.shared),
        }
    }

    /// Accept connections until the listener fails. One thread per connection, at most
    /// `max_connections` at once; further connections are closed unanswered.
    pub fn serve(self) -> std::io::Result<()> {
        for conn in self.listener.incoming() {
            let stream = match conn {
                Ok(s) => s,
                Err(e)
                    if matches!(
                        e.kind(),
                        ErrorKind::Interrupted | ErrorKind::ConnectionAborted
                    ) =>
                {
                    continue;
                }
                Err(e) => return Err(e),
            };
            let shared = Arc::clone(&self.shared);
            if shared.active.fetch_add(1, Ordering::SeqCst) >= shared.max_connections {
                shared.active.fetch_sub(1, Ordering::SeqCst);
                drop(stream);
                continue;
            }
            let spawned = std::thread::Builder::new()
                .name("keyd-conn".into())
                .spawn(move || {
                    connection(&shared, stream);
                    shared.active.fetch_sub(1, Ordering::SeqCst);
                });
            if spawned.is_err() {
                self.shared.active.fetch_sub(1, Ordering::SeqCst);
            }
        }
        Ok(())
    }
}

/// The caller's uid and gid from the kernel (SO_PEERCRED on Linux, getpeereid elsewhere).
pub fn peer_credentials(stream: &UnixStream) -> std::io::Result<(u32, u32)> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let c = nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerCredentials)
            .map_err(std::io::Error::from)?;
        Ok((c.uid(), c.gid()))
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        let (u, g) = nix::unistd::getpeereid(stream).map_err(std::io::Error::from)?;
        Ok((u.as_raw(), g.as_raw()))
    }
}

/// Read exactly `buf.len()` bytes before `deadline` (if any). `Ok(false)` is a clean EOF
/// before the first byte.
fn read_full(
    stream: &mut UnixStream,
    buf: &mut [u8],
    deadline: Option<Instant>,
) -> std::io::Result<bool> {
    let mut filled = 0usize;
    while filled < buf.len() {
        if let Some(d) = deadline {
            let left = d.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(ErrorKind::TimedOut.into());
            }
            stream.set_read_timeout(Some(left))?;
        }
        let Some(dst) = buf.get_mut(filled..) else {
            break;
        };
        match stream.read(dst) {
            Ok(0) if filled == 0 => return Ok(false),
            Ok(0) => return Err(ErrorKind::UnexpectedEof.into()),
            Ok(n) => filled = filled.saturating_add(n),
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

fn connection(shared: &Shared, mut stream: UnixStream) {
    match peer_credentials(&stream) {
        Ok((uid, gid)) if shared.peers.allows(uid, gid) => {}
        _ => {
            lock(&shared.audit).write(AuditRec {
                op: "connect",
                component: "-",
                ok: false,
                code: Some(ErrorCode::Forbidden),
                purpose: None,
            });
            return;
        }
    }
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let hello_deadline = Instant::now().checked_add(shared.hello_timeout);
    let mut component: Option<String> = None;
    loop {
        let deadline = if component.is_none() {
            hello_deadline
        } else {
            None
        };
        if deadline.is_none() && stream.set_read_timeout(None).is_err() {
            return;
        }
        let mut header = [0u8; 4];
        match read_full(&mut stream, &mut header, deadline) {
            Ok(true) => {}
            _ => return,
        }
        // A malformed or oversize frame ends the connection; there is no resync.
        let Ok(len) = frame_len(header) else { return };
        let mut body = vec![0u8; len];
        if !matches!(read_full(&mut stream, &mut body, deadline), Ok(true)) {
            return;
        }
        let Ok(raw) = parse_frame_body(&body) else {
            return;
        };
        body.zeroize();
        let (mut response, end) = answer(shared, raw, &mut component);
        let frame = encode_frame(&response).map(Zeroizing::new);
        scrub(&mut response);
        let Ok(frame) = frame else {
            return;
        };
        if stream.write_all(&frame).is_err() || end {
            return;
        }
    }
}

/// Zero every string in a JSON value (request arguments and responses carry key material as hex).
fn scrub(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::String(s) => s.zeroize(),
        serde_json::Value::Array(a) => a.iter_mut().for_each(scrub),
        serde_json::Value::Object(m) => m.values_mut().for_each(scrub),
        _ => {}
    }
}

struct ScrubOnDrop(crate::wire::Args);

impl Drop for ScrubOnDrop {
    fn drop(&mut self) {
        self.0.values_mut().for_each(scrub);
    }
}

/// Handle one parsed frame. Returns the response and whether to end the connection.
fn answer(
    shared: &Shared,
    raw: serde_json::Value,
    component: &mut Option<String>,
) -> (serde_json::Value, bool) {
    let mut id = 0u64;
    let mut op: &str = "?";
    let outcome = (|| {
        let mut req = parse_request(raw)?;
        let args = ScrubOnDrop(std::mem::take(&mut req.args));
        id = req.id;
        op = req.op;
        if component.is_none() && req.op != "hello" {
            return Err(KeydError::new(ErrorCode::NotHello, "say hello first"));
        }
        if !lock(&shared.limiter).take(req.op, now_ms() as f64) {
            return Err(KeydError::new(ErrorCode::RateLimited, "too many requests"));
        }
        let handled = {
            let mut svc = lock(&shared.service);
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| svc.handle(req.op, &args.0)))
                .unwrap_or_else(|_| Err(KeydError::failed("internal error")))?
        };
        if req.op == "hello" {
            *component = Some(match args.0.get("component") {
                Some(serde_json::Value::String(s)) => s.clone(),
                _ => String::new(),
            });
        }
        Ok(handled)
    })();
    let label = component.clone().unwrap_or_else(|| "-".to_owned());
    match outcome {
        Ok(h) => {
            lock(&shared.audit).write(AuditRec {
                op,
                component: &label,
                ok: true,
                code: None,
                purpose: h.purpose.as_deref(),
            });
            (ok_response(id, h.result), false)
        }
        Err(e) => {
            lock(&shared.audit).write(AuditRec {
                op,
                component: &label,
                ok: false,
                code: Some(e.code),
                purpose: None,
            });
            let end = e.code == ErrorCode::UnsupportedVersion;
            (err_response(id, &e), end)
        }
    }
}

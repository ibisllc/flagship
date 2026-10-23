//! A client for the two keyd operations the ingress may use: `tls.active` (which key and
//! chain are in service) and `tls.sign` (one handshake signature). One connection, requests
//! serialized, `hello` first; it redials once when the connection drops, like flagship-tlsd.
//!
//! The client is blocking on purpose: rustls asks for a signature synchronously, and the
//! signer moves the wait off the async workers (`signer::run_blocking`).

use std::fmt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::wire::{self, PROTOCOL_VERSION, WireError};

/// keyd caps handles at 32 characters (`strArg(a, "handle", 32)`).
pub const MAX_HANDLE_LEN: usize = 32;
/// A DER ECDSA P-256 signature is at most 72 bytes.
const MAX_P256_DER_SIG: usize = 72;

#[derive(Debug)]
pub enum KeydError {
    /// The socket, the framing or the response shape failed; the connection is dropped.
    Transport(String),
    /// keyd answered and refused (`ok: false`).
    Refused { code: String, message: String },
    /// keyd answered with something the ingress will not use.
    Invalid(&'static str),
}

impl fmt::Display for KeydError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(m) => write!(f, "keyd unreachable: {m}"),
            Self::Refused { code, message } => write!(f, "keyd refused: {code}: {message}"),
            Self::Invalid(m) => write!(f, "keyd answer rejected: {m}"),
        }
    }
}

impl std::error::Error for KeydError {}

impl From<WireError> for KeydError {
    fn from(e: WireError) -> Self {
        Self::Transport(e.to_string())
    }
}

/// What keyd says is in service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveCert {
    pub handle: String,
    pub chain_pem: String,
    pub not_after_ms: i64,
    pub names: Vec<String>,
}

#[derive(Debug)]
struct Conn {
    stream: UnixStream,
    next_id: u64,
}

#[derive(Debug)]
pub struct KeydClient {
    path: PathBuf,
    component: String,
    timeout: Duration,
    conn: Mutex<Option<Conn>>,
}

impl KeydClient {
    pub fn new(path: impl AsRef<Path>, component: &str, timeout: Duration) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
            component: component.to_owned(),
            timeout,
            conn: Mutex::new(None),
        }
    }

    fn dial(&self) -> Result<Conn, KeydError> {
        let stream =
            UnixStream::connect(&self.path).map_err(|e| KeydError::Transport(e.to_string()))?;
        stream
            .set_read_timeout(Some(self.timeout))
            .map_err(|e| KeydError::Transport(e.to_string()))?;
        stream
            .set_write_timeout(Some(self.timeout))
            .map_err(|e| KeydError::Transport(e.to_string()))?;
        let mut conn = Conn { stream, next_id: 0 };
        let res = round_trip(
            &mut conn,
            "hello",
            json!({"v": PROTOCOL_VERSION, "component": self.component}),
        )?;
        // keyd never falls back to another version; neither do we.
        if res.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
            return Err(KeydError::Transport(
                "keyd does not speak protocol 1".into(),
            ));
        }
        Ok(conn)
    }

    /// One request; on a transport failure the connection is redialed and the request sent once more.
    pub fn call(&self, op: &str, args: Value) -> Result<Map<String, Value>, KeydError> {
        let mut guard = self.conn.lock().unwrap_or_else(PoisonError::into_inner);
        let mut conn = match guard.take() {
            Some(c) => c,
            None => self.dial()?,
        };
        match round_trip(&mut conn, op, args.clone()) {
            Ok(r) => {
                *guard = Some(conn);
                Ok(r)
            }
            Err(e @ KeydError::Refused { .. }) => {
                *guard = Some(conn);
                Err(e)
            }
            Err(_) => {
                drop(conn);
                let mut fresh = self.dial()?;
                let r = round_trip(&mut fresh, op, args);
                if !matches!(r, Err(KeydError::Transport(_))) {
                    *guard = Some(fresh);
                }
                r
            }
        }
    }

    pub fn active(&self) -> Result<Option<ActiveCert>, KeydError> {
        let res = self.call("tls.active", json!({}))?;
        match res.get("active") {
            None => Err(KeydError::Invalid("no active field")),
            Some(Value::Null) => Ok(None),
            Some(Value::Object(a)) => parse_active(a).map(Some),
            Some(_) => Err(KeydError::Invalid("active is not an object")),
        }
    }

    /// The DER ECDSA signature over a SHA-256 or SHA-384 digest, by the key `handle` names.
    pub fn sign(&self, handle: &str, digest: &[u8]) -> Result<Vec<u8>, KeydError> {
        if digest.len() != 32 && digest.len() != 48 {
            return Err(KeydError::Invalid("digest must be 32 or 48 bytes"));
        }
        check_handle(handle)?;
        let res = self.call(
            "tls.sign",
            json!({"handle": handle, "digest": wire::to_hex(digest)}),
        )?;
        let sig = res
            .get("sig")
            .and_then(Value::as_str)
            .and_then(wire::from_hex)
            .ok_or(KeydError::Invalid("sig is not lowercase hex"))?;
        if sig.len() < 8 || sig.len() > MAX_P256_DER_SIG {
            return Err(KeydError::Invalid("sig is not a P-256 DER signature"));
        }
        Ok(sig)
    }
}

pub fn check_handle(handle: &str) -> Result<(), KeydError> {
    if handle.is_empty()
        || handle.len() > MAX_HANDLE_LEN
        || !handle.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(KeydError::Invalid("handle is not a short printable string"));
    }
    Ok(())
}

fn parse_active(a: &Map<String, Value>) -> Result<ActiveCert, KeydError> {
    let handle = a
        .get("handle")
        .and_then(Value::as_str)
        .ok_or(KeydError::Invalid("active.handle"))?;
    check_handle(handle)?;
    let chain_pem = a
        .get("chainPem")
        .and_then(Value::as_str)
        .ok_or(KeydError::Invalid("active.chainPem"))?;
    let not_after_ms = a.get("notAfter").and_then(Value::as_i64).unwrap_or(0);
    let names = match a.get("names") {
        Some(Value::Array(v)) => v
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    };
    Ok(ActiveCert {
        handle: handle.to_owned(),
        chain_pem: chain_pem.to_owned(),
        not_after_ms,
        names,
    })
}

fn round_trip(conn: &mut Conn, op: &str, args: Value) -> Result<Map<String, Value>, KeydError> {
    conn.next_id = conn.next_id.wrapping_add(1);
    let id = conn.next_id;
    wire::write_frame(&mut conn.stream, &json!({"id": id, "op": op, "args": args}))?;
    let resp = wire::read_frame(&mut conn.stream)?;
    let Value::Object(mut resp) = resp else {
        return Err(KeydError::Transport("response is not an object".into()));
    };
    if resp.get("id").and_then(Value::as_u64) != Some(id) {
        return Err(KeydError::Transport(
            "keyd answered a different request".into(),
        ));
    }
    match resp.get("ok") {
        Some(Value::Bool(true)) => match resp.remove("result") {
            Some(Value::Object(r)) => Ok(r),
            _ => Err(KeydError::Transport("response has no result".into())),
        },
        Some(Value::Bool(false)) => Err(KeydError::Refused {
            code: resp
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("?")
                .chars()
                .take(64)
                .collect(),
            message: resp
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(256)
                .collect(),
        }),
        _ => Err(KeydError::Transport("response has no ok".into())),
    }
}

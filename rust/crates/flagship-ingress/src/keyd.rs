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

    /// The DER ECDSA P-256/SHA-256 signature over a TLS server signature input, by the key
    /// `handle` names. keyd takes the input's TLS fields, never a digest, and rebuilds the input
    /// itself, so the key signs TLS handshakes and nothing else.
    pub fn sign_handshake(&self, handle: &str, message: &[u8]) -> Result<Vec<u8>, KeydError> {
        check_handle(handle)?;
        let mut args = tls_sign_args(message)?;
        if let Some(o) = args.as_object_mut() {
            o.insert("handle".into(), Value::from(handle));
        }
        let res = self.call("tls.sign", args)?;
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

const TLS13_SERVER_CONTEXT: &[u8] = b"TLS 1.3, server CertificateVerify\0";

/// keyd's `tls.sign` fields for a TLS 1.3 CertificateVerify or TLS 1.2 ServerKeyExchange input.
pub fn tls_sign_args(message: &[u8]) -> Result<Value, KeydError> {
    if let Some(rest) = message.strip_prefix(&[0x20u8; 64][..])
        && let Some(th) = rest.strip_prefix(TLS13_SERVER_CONTEXT)
    {
        if th.len() != 32 && th.len() != 48 {
            return Err(KeydError::Invalid("not a TLS 1.3 transcript hash"));
        }
        return Ok(json!({"tls": "1.3", "transcriptHash": wire::to_hex(th)}));
    }
    match (message.get(..32), message.get(32..64), message.get(64..)) {
        (Some(cr), Some(sr), Some(params)) if params.len() >= 4 => Ok(json!({
            "tls": "1.2",
            "clientRandom": wire::to_hex(cr),
            "serverRandom": wire::to_hex(sr),
            "params": wire::to_hex(params),
        })),
        _ => Err(KeydError::Invalid("not a TLS server signature input")),
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn splits_tls_inputs_into_keyd_fields() {
        let mut t13 = vec![0x20u8; 64];
        t13.extend_from_slice(TLS13_SERVER_CONTEXT);
        t13.extend_from_slice(&[7u8; 48]);
        let a = tls_sign_args(&t13).unwrap();
        assert_eq!(a["tls"], "1.3");
        assert_eq!(a["transcriptHash"], wire::to_hex(&[7u8; 48]));
        assert!(tls_sign_args(&t13[..t13.len() - 1]).is_err());

        let mut t12 = vec![1u8; 32];
        t12.extend_from_slice(&[2u8; 32]);
        t12.extend_from_slice(&[3, 0x00, 0x1d, 32]);
        t12.extend_from_slice(&[9u8; 32]);
        let a = tls_sign_args(&t12).unwrap();
        assert_eq!(a["tls"], "1.2");
        assert_eq!(a["clientRandom"], wire::to_hex(&[1u8; 32]));
        assert_eq!(a["serverRandom"], wire::to_hex(&[2u8; 32]));
        assert!(a.get("digest").is_none());
        assert!(tls_sign_args(&[0u8; 32]).is_err());
    }
}

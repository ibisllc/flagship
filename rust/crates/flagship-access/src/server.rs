//! The local socket the daemon asks for an access decision (same framing as the broker's privd v1
//! socket: a 4-byte big-endian length, then JSON; `hello` first). The access state and the session
//! records are read here from the box's own files on every question; the caller supplies only what
//! it observed (the routed app, the request, the API-key check) and the account people it verified.
//! Callers are admitted by the kernel's peer credentials, never by what they write.

use crate::decide::{
    ApiKeyCheck, AppFacts, Decision, Principal, Principals, RequestFacts, SessionFact, decide,
};
use crate::state::AccessState;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const MAX_FRAME: usize = 1 << 20;

/// Where the box keeps what the decision reads.
#[derive(Debug, Clone)]
pub struct Context {
    pub state_path: PathBuf,
    pub sessions_path: PathBuf,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn read_optional(p: &PathBuf) -> Result<Option<String>, String> {
    match std::fs::read_to_string(p) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", p.display())),
    }
}

/// The session a cookie token names, from the box's session file (absent or unreadable: none).
fn session_for(ctx: &Context, token: &str) -> Option<SessionFact> {
    let text = read_optional(&ctx.sessions_path).ok()??;
    let v: Value = serde_json::from_str(&text).ok()?;
    let e = v.get(token)?;
    let service_ref = e.get("serviceRef")?.as_str()?.to_owned();
    let aid = e.get("aid")?.as_str()?.to_lowercase();
    let expires = e.get("expiresAt")?.as_f64()?;
    let closed = e.get("closed").and_then(Value::as_bool) == Some(true);
    #[allow(clippy::cast_precision_loss)]
    let live = !closed && expires > now_ms() as f64;
    Some(SessionFact {
        service_ref,
        aid,
        live,
    })
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The account people as the caller's verified device book and share store list them.
#[must_use]
pub fn principals_from(v: &Value) -> Principals {
    let list = v
        .get("principals")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let pub_hex = p.get("pub")?.as_str()?.to_lowercase();
                    match p.get("kind")?.as_str()? {
                        "device" => Some(Principal::Device {
                            pub_hex,
                            admin: p.get("tier").and_then(Value::as_str) == Some("admin"),
                        }),
                        "co-manager" => Some(Principal::CoManager {
                            pub_hex,
                            share_id: p.get("shareId")?.as_str()?.to_owned(),
                        }),
                        _ => None,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Principals {
        list,
        owner_aid: v
            .get("ownerAid")
            .and_then(Value::as_str)
            .map(str::to_lowercase),
    }
}

#[must_use]
pub fn api_key_from(v: Option<&Value>) -> ApiKeyCheck {
    match v {
        Some(Value::String(s)) => match s.as_str() {
            "invalid" => ApiKeyCheck::Invalid,
            "scope" => ApiKeyCheck::Scope,
            "rate-limited" => ApiKeyCheck::RateLimited,
            _ => ApiKeyCheck::None,
        },
        Some(o @ Value::Object(_)) => {
            o.get("keyId")
                .and_then(Value::as_str)
                .map_or(ApiKeyCheck::Invalid, |k| ApiKeyCheck::Ok {
                    key_id: k.to_owned(),
                })
        }
        _ => ApiKeyCheck::None,
    }
}

/// The decision as the daemon and the shared vectors spell it.
#[must_use]
pub fn decision_json(d: &Decision) -> Value {
    match d {
        Decision::Anonymous => {
            json!({ "outcome": "forward", "visitor": "anonymous", "role": null, "identity": null, "external": false })
        }
        Decision::Api { key_id } => {
            json!({ "outcome": "forward", "visitor": "api", "role": "api", "identity": format!("apikey:{key_id}"), "external": false })
        }
        Decision::Member {
            rank,
            identity,
            external,
        } => {
            json!({ "outcome": "forward", "visitor": "member", "role": rank.as_str(), "identity": identity, "external": external })
        }
        other => json!({ "outcome": other.outcome() }),
    }
}

/// Answer one `decide` question.
///
/// # Errors
/// The access state file exists but cannot be read (permissions, I/O): the caller fails closed.
pub fn handle_decide(ctx: &Context, a: &Value) -> Result<Value, String> {
    let state = AccessState::parse(read_optional(&ctx.state_path)?.as_deref());
    let text = |k: &str| {
        a.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let app = AppFacts {
        service_ref: text("serviceRef"),
        routed_host: text("routedHost"),
        public_routes: strings(a.get("publicRoutes")),
        default_role: text("defaultRole"),
    };
    if app.service_ref.is_empty() || app.routed_host.is_empty() {
        return Err("serviceRef and routedHost are required".into());
    }
    let headers: BTreeMap<String, String> = a
        .get("headers")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| Some((k.to_ascii_lowercase(), v.as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    let session = a
        .get("sessionToken")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .and_then(|t| session_for(ctx, t));
    let req = RequestFacts {
        method: text("method"),
        path: text("path"),
        upgrade: a.get("upgrade").and_then(Value::as_bool) == Some(true),
        headers,
        session,
        api_key: api_key_from(a.get("apiKey")),
        external_fresh: a.get("externalFresh").and_then(Value::as_bool) != Some(false),
        catching_up: a.get("catchingUp").and_then(Value::as_bool) == Some(true),
    };
    Ok(decision_json(&decide(
        &state,
        &principals_from(a),
        &app,
        &req,
    )))
}

fn read_frame(s: &mut UnixStream) -> io::Result<Option<Value>> {
    let mut head = [0u8; 4];
    match s.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = usize::try_from(u32::from_be_bytes(head)).unwrap_or(usize::MAX);
    if n == 0 || n > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "bad frame"));
    }
    let mut buf = vec![0u8; n];
    s.read_exact(&mut buf)?;
    serde_json::from_slice(&buf)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

fn write_frame(s: &mut UnixStream, v: &Value) -> io::Result<()> {
    let body = v.to_string();
    let n = u32::try_from(body.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "too long"))?;
    s.write_all(&n.to_be_bytes())?;
    s.write_all(body.as_bytes())
}

/// Serve one admitted connection until it closes.
///
/// # Errors
/// A transport error or a malformed frame (the connection is then dropped).
pub fn serve_connection(ctx: &Context, mut s: UnixStream) -> io::Result<()> {
    s.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut greeted = false;
    while let Some(req) = read_frame(&mut s)? {
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let op = req.get("op").and_then(Value::as_str).unwrap_or_default();
        let args = req.get("args").cloned().unwrap_or(Value::Null);
        let reply = match (op, greeted) {
            ("hello", _) if args.get("version").and_then(Value::as_u64) == Some(1) => {
                greeted = true;
                json!({ "id": id, "ok": true, "result": { "version": 1 } })
            }
            ("hello", _) => {
                json!({ "id": id, "ok": false, "code": "version", "message": "only version 1" })
            }
            (_, false) => {
                json!({ "id": id, "ok": false, "code": "hello-first", "message": "send hello first" })
            }
            ("decide", true) => match handle_decide(ctx, &args) {
                Ok(r) => json!({ "id": id, "ok": true, "result": r }),
                Err(m) => json!({ "id": id, "ok": false, "code": "unavailable", "message": m }),
            },
            _ => json!({ "id": id, "ok": false, "code": "unknown-op", "message": "unknown op" }),
        };
        write_frame(&mut s, &reply)?;
    }
    Ok(())
}

/// The uid of the process on the other end (Linux `SO_PEERCRED`; elsewhere nobody is admitted).
///
/// # Errors
/// No peer credentials on this platform or socket.
pub fn peer_uid(s: &UnixStream) -> io::Result<u32> {
    #[cfg(target_os = "linux")]
    {
        Ok(rustix::net::sockopt::socket_peercred(s)?.uid.as_raw())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = s;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "peer credentials need Linux SO_PEERCRED",
        ))
    }
}

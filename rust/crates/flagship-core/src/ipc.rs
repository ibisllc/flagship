//! Core's socket (`/run/flagship-core/core.sock`): the daemon syncs its desired workloads and what
//! the engine shows, and settles the effects core handed it. Frames are a 4-byte big-endian length
//! and JSON, as on the broker's sockets. Who may connect comes from the kernel (SO_PEERCRED): the
//! daemon's account and root, nobody else.
//!
//! Requests: `{"op":"Sync","sync":SyncRequest}`, `{"op":"Settle","settle":SettleRequest}`,
//! `{"op":"Status"}`. Answers: `{"ok":true,"result":…}` or `{"ok":false,"error":"…"}`.

use crate::apps::{AppController, SettleRequest, SyncRequest};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::io::{self, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

/// A desired list for a full box fits easily; anything larger is refused before it is read.
pub const MAX_FRAME: usize = 4 * 1024 * 1024;

/// One frame, or `None` at a clean end of the connection.
pub fn read_frame<R: Read>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut head = [0u8; 4];
    match r.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = usize::try_from(u32::from_be_bytes(head)).unwrap_or(usize::MAX);
    if n == 0 || n > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame length out of range",
        ));
    }
    let mut body = vec![0u8; n];
    r.read_exact(&mut body)?;
    Ok(Some(body))
}

pub fn write_frame<W: Write>(w: &mut W, body: &[u8]) -> io::Result<()> {
    let n = u32::try_from(body.len())
        .ok()
        .filter(|n| *n > 0 && (*n as usize) <= MAX_FRAME)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "frame length out of range"))?;
    w.write_all(&n.to_be_bytes())?;
    w.write_all(body)?;
    w.flush()
}

/// Answer one request.
pub fn handle(ctrl: &Mutex<AppController>, body: &[u8]) -> Value {
    let err = |m: String| json!({ "ok": false, "error": m });
    let v: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return err(format!("not JSON: {e}")),
    };
    let mut c = ctrl.lock().unwrap_or_else(PoisonError::into_inner);
    match v.get("op").and_then(Value::as_str) {
        Some("Sync") => {
            let req: SyncRequest = match v.get("sync").cloned().map(serde_json::from_value) {
                Some(Ok(r)) => r,
                Some(Err(e)) => return err(format!("sync: {e}")),
                None => return err("sync: missing".into()),
            };
            match c.sync(&req) {
                Ok(r) => json!({ "ok": true, "result": r }),
                Err(e) => err(e.to_string()),
            }
        }
        Some("Settle") => {
            let req: SettleRequest = match v.get("settle").cloned().map(serde_json::from_value) {
                Some(Ok(r)) => r,
                Some(Err(e)) => return err(format!("settle: {e}")),
                None => return err("settle: missing".into()),
            };
            match c.settle(&req) {
                Ok(()) => json!({ "ok": true, "result": {} }),
                Err(e) => err(e.to_string()),
            }
        }
        Some("Status") => match c.summary() {
            Ok(s) => json!({ "ok": true, "result": s }),
            Err(e) => err(e.to_string()),
        },
        _ => err("unknown op".into()),
    }
}

#[cfg(target_os = "linux")]
fn peer_uid(s: &UnixStream) -> io::Result<u32> {
    Ok(rustix::net::sockopt::socket_peercred(s)?.uid.as_raw())
}

#[cfg(not(target_os = "linux"))]
fn peer_uid(_s: &UnixStream) -> io::Result<u32> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "peer credentials need Linux SO_PEERCRED",
    ))
}

/// Serve connections until the listener fails. `allow` = the UIDs that may connect; `None` only
/// in tests (no kernel check).
pub fn serve(
    listener: &UnixListener,
    ctrl: &Arc<Mutex<AppController>>,
    allow: Option<&BTreeSet<u32>>,
) -> io::Result<()> {
    for conn in listener.incoming() {
        let Ok(mut s) = conn else { continue };
        if let Some(allow) = allow {
            match peer_uid(&s) {
                Ok(uid) if allow.contains(&uid) => {}
                _ => continue,
            }
        }
        let ctrl = Arc::clone(ctrl);
        std::thread::spawn(move || {
            let _ = s.set_read_timeout(Some(Duration::from_secs(300)));
            while let Ok(Some(body)) = read_frame(&mut s) {
                let answer = handle(&ctrl, &body);
                if write_frame(&mut s, answer.to_string().as_bytes()).is_err() {
                    break;
                }
            }
        });
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_and_refuse_out_of_range() {
        let mut buf = Vec::new();
        write_frame(&mut buf, b"{\"op\":\"Status\"}").unwrap();
        assert_eq!(
            read_frame(&mut buf.as_slice()).unwrap().unwrap(),
            b"{\"op\":\"Status\"}"
        );
        assert!(read_frame(&mut [0u8; 4].as_slice()).is_err());
        let big = u32::try_from(MAX_FRAME + 1).unwrap().to_be_bytes();
        assert!(read_frame(&mut big.as_slice()).is_err());
        assert!(read_frame(&mut [].as_slice()).unwrap().is_none());
        assert!(write_frame(&mut Vec::new(), b"").is_err());
    }
}

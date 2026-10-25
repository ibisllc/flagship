//! The capability SDK's host side: the `flagship_v1` calls a WASI app may
//! import, each behind the manifest capability that names it.
//!
//! The guest never opens a connection. `http_fetch` and `db_query` hand a
//! JSON request to the [`CapabilityBroker`] (on the box: the daemon, over the
//! app's own socket), which checks the owner's approvals again and does the
//! work as this app and nothing else. The worker checks first what it can
//! check itself (the call is granted, the host is declared), so a refusal
//! never needs the broker.
//!
//! ABI, all `i32`:
//! - `http_fetch(req_ptr, req_len, out_ptr, out_cap, out_len_ptr) -> status`
//! - `db_query(req_ptr, req_len, out_ptr, out_cap, out_len_ptr) -> status`
//! - `last_response(out_ptr, out_cap, out_len_ptr) -> status`
//!
//! The answer's full length is written to `out_len_ptr` as a little-endian
//! `u32`. When it fits in `out_cap` the bytes are written at `out_ptr`;
//! otherwise nothing is written and `last_response` returns them into a
//! larger buffer. The status is one of [`status`].

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use wasmtime::{Caller, Extern, Linker, Memory};

use crate::error::WorkerError;
use crate::manifest::{HostCall, WasiGrant};
use crate::worker::Host;

/// What a host call returns to the guest.
pub mod status {
    /// The broker answered; the answer is the JSON it returned.
    pub const OK: i32 = 0;
    /// Refused: not declared, not approved by the owner, or not this app's.
    pub const DENIED: i32 = 1;
    /// The request was malformed or out of bounds.
    pub const BAD_REQUEST: i32 = 2;
    /// The broker tried and failed (upstream error, SQL error).
    pub const FAILED: i32 = 3;
    /// The run's deadline, or the broker's own, passed.
    pub const TIMEOUT: i32 = 4;
    /// `last_response` with nothing kept.
    pub const NOTHING: i32 = 5;
}

/// Largest request a guest may pass to a host call.
pub const MAX_HOST_REQUEST: usize = 1024 * 1024;
/// Largest answer the worker keeps from the broker.
pub const MAX_HOST_RESPONSE: usize = 8 * 1024 * 1024;
/// Host calls one run may make.
pub const MAX_CALLS_PER_RUN: u32 = 256;

#[derive(Debug, thiserror::Error)]
pub enum BrokerError {
    #[error("denied: {0}")]
    Denied(String),
    #[error("failed: {0}")]
    Failed(String),
    #[error("timed out")]
    Timeout,
}

/// The box side of the host calls. It is told which call and gets the
/// guest's JSON request; it knows which app is asking from the channel it
/// was handed (one per app), never from the request.
pub trait CapabilityBroker: Send + Sync + fmt::Debug {
    fn call(
        &self,
        call: HostCall,
        request: &[u8],
        timeout: Duration,
    ) -> Result<Vec<u8>, BrokerError>;
}

pub(crate) struct HostCallState {
    egress_hosts: Vec<String>,
    broker: Option<Arc<dyn CapabilityBroker>>,
    deadline: Option<Instant>,
    last: Option<Vec<u8>>,
    count: u32,
}

impl HostCallState {
    pub(crate) fn new(
        egress_hosts: Vec<String>,
        broker: Option<Arc<dyn CapabilityBroker>>,
        deadline: Option<Instant>,
    ) -> Self {
        Self {
            egress_hosts,
            broker,
            deadline,
            last: None,
            count: 0,
        }
    }

    pub(crate) fn count(&self) -> u32 {
        self.count
    }
}

/// Define the host calls `grant` allows, and only those.
pub(crate) fn add_to_linker(
    linker: &mut Linker<Host>,
    grant: &WasiGrant,
) -> Result<(), WorkerError> {
    let internal = |e: wasmtime::Error| WorkerError::Internal(e.to_string());
    if grant.grants(HostCall::HttpFetch) {
        linker
            .func_wrap_async(
                HostCall::MODULE,
                HostCall::HttpFetch.name(),
                |caller: Caller<'_, Host>, (rp, rl, op, oc, olp): (i32, i32, i32, i32, i32)| {
                    Box::new(async move {
                        Ok(brokered(
                            caller,
                            HostCall::HttpFetch,
                            rp,
                            rl,
                            Out {
                                ptr: op,
                                cap: oc,
                                len_ptr: olp,
                            },
                        )
                        .await)
                    })
                },
            )
            .map_err(internal)?;
    }
    if grant.grants(HostCall::DbQuery) {
        linker
            .func_wrap_async(
                HostCall::MODULE,
                HostCall::DbQuery.name(),
                |caller: Caller<'_, Host>, (rp, rl, op, oc, olp): (i32, i32, i32, i32, i32)| {
                    Box::new(async move {
                        Ok(brokered(
                            caller,
                            HostCall::DbQuery,
                            rp,
                            rl,
                            Out {
                                ptr: op,
                                cap: oc,
                                len_ptr: olp,
                            },
                        )
                        .await)
                    })
                },
            )
            .map_err(internal)?;
    }
    if grant.grants(HostCall::LastResponse) {
        linker
            .func_wrap(
                HostCall::MODULE,
                HostCall::LastResponse.name(),
                |mut caller: Caller<'_, Host>, op: i32, oc: i32, olp: i32| -> i32 {
                    let Some(mem) = memory(&mut caller) else {
                        return status::BAD_REQUEST;
                    };
                    let Some(last) = caller.data_mut().calls.last.take() else {
                        return status::NOTHING;
                    };
                    let out = Out {
                        ptr: op,
                        cap: oc,
                        len_ptr: olp,
                    };
                    deliver(&mut caller, mem, status::OK, last, out)
                },
            )
            .map_err(internal)?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct Out {
    ptr: i32,
    cap: i32,
    len_ptr: i32,
}

fn memory(caller: &mut Caller<'_, Host>) -> Option<Memory> {
    caller.get_export("memory").and_then(Extern::into_memory)
}

fn error_body(msg: &str) -> Vec<u8> {
    serde_json::json!({ "error": msg }).to_string().into_bytes()
}

async fn brokered(
    mut caller: Caller<'_, Host>,
    call: HostCall,
    req_ptr: i32,
    req_len: i32,
    out: Out,
) -> i32 {
    let Some(mem) = memory(&mut caller) else {
        return status::BAD_REQUEST;
    };
    let state = &mut caller.data_mut().calls;
    state.count = state.count.saturating_add(1);
    if state.count > MAX_CALLS_PER_RUN {
        return deliver(
            &mut caller,
            mem,
            status::DENIED,
            error_body("too many host calls in one run"),
            out,
        );
    }
    let (Ok(start), Ok(len)) = (usize::try_from(req_ptr), usize::try_from(req_len)) else {
        return status::BAD_REQUEST;
    };
    if len > MAX_HOST_REQUEST {
        return deliver(
            &mut caller,
            mem,
            status::BAD_REQUEST,
            error_body("request too large"),
            out,
        );
    }
    let mut req = vec![0u8; len];
    if mem.read(&caller, start, &mut req).is_err() {
        return status::BAD_REQUEST;
    }
    if call == HostCall::HttpFetch {
        match fetch_host(&req) {
            None => {
                return deliver(
                    &mut caller,
                    mem,
                    status::BAD_REQUEST,
                    error_body("url must be http(s)://host/..."),
                    out,
                );
            }
            Some(host) => {
                if !caller.data().calls.egress_hosts.contains(&host) {
                    let msg = format!("{host} is not in this app's network.egress");
                    return deliver(&mut caller, mem, status::DENIED, error_body(&msg), out);
                }
            }
        }
    }
    let Some(broker) = caller.data().calls.broker.clone() else {
        return deliver(
            &mut caller,
            mem,
            status::DENIED,
            error_body("this server gives no host calls to this run"),
            out,
        );
    };
    let remaining = caller
        .data()
        .calls
        .deadline
        .map_or(Duration::from_secs(30), |d| {
            d.saturating_duration_since(Instant::now())
        });
    if remaining.is_zero() {
        return deliver(
            &mut caller,
            mem,
            status::TIMEOUT,
            error_body("deadline passed"),
            out,
        );
    }
    let joined = tokio::task::spawn_blocking(move || broker.call(call, &req, remaining)).await;
    let (code, body) = match joined {
        Ok(Ok(body)) if body.len() <= MAX_HOST_RESPONSE => (status::OK, body),
        Ok(Ok(_)) => (status::FAILED, error_body("answer too large")),
        Ok(Err(BrokerError::Denied(m))) => (status::DENIED, error_body(&m)),
        Ok(Err(BrokerError::Failed(m))) => (status::FAILED, error_body(&m)),
        Ok(Err(BrokerError::Timeout)) => (status::TIMEOUT, error_body("timed out")),
        Err(_) => (status::FAILED, error_body("host call failed")),
    };
    deliver(&mut caller, mem, code, body, out)
}

fn deliver(caller: &mut Caller<'_, Host>, mem: Memory, code: i32, body: Vec<u8>, out: Out) -> i32 {
    let (Ok(ptr), Ok(cap), Ok(len_ptr)) = (
        usize::try_from(out.ptr),
        usize::try_from(out.cap),
        usize::try_from(out.len_ptr),
    ) else {
        return status::BAD_REQUEST;
    };
    let Ok(full) = u32::try_from(body.len()) else {
        return status::FAILED;
    };
    if mem
        .write(&mut *caller, len_ptr, &full.to_le_bytes())
        .is_err()
    {
        return status::BAD_REQUEST;
    }
    if body.len() <= cap {
        if mem.write(&mut *caller, ptr, &body).is_err() {
            return status::BAD_REQUEST;
        }
        caller.data_mut().calls.last = None;
    } else {
        caller.data_mut().calls.last = Some(body);
    }
    code
}

#[derive(Deserialize)]
struct FetchUrl {
    url: String,
}

/// The lowercase host of the request's `url`, if it is a plain http(s) URL
/// with no user info.
pub fn fetch_host(request: &[u8]) -> Option<String> {
    let r: FetchUrl = serde_json::from_slice(request).ok()?;
    let rest = r
        .url
        .strip_prefix("https://")
        .or_else(|| r.url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.contains('@') || authority.is_empty() {
        return None;
    }
    let host = match authority.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => h,
        Some(_) => return None,
        None => authority,
    };
    if host.is_empty() {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::fetch_host;

    #[test]
    fn fetch_host_reads_only_plain_urls() {
        let h = |u: &str| fetch_host(format!(r#"{{"url":"{u}"}}"#).as_bytes());
        assert_eq!(
            h("https://API.example.com/x?y"),
            Some("api.example.com".into())
        );
        assert_eq!(h("http://example.com:8080/"), Some("example.com".into()));
        assert_eq!(h("https://user@example.com/"), None);
        assert_eq!(h("ftp://example.com/"), None);
        assert_eq!(h("https://example.com:x/"), None);
        assert_eq!(h("https:///x"), None);
        assert_eq!(fetch_host(b"not json"), None);
    }
}

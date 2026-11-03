//! HTTP/1.1 framing for the app proxy (G4/R3): the request head as the daemon's TS proxy reads it
//! (`parseHead` in `packages/server-daemon/src/appConnection.ts`), the header rules of
//! docs/app-apis.md §5, chunked bodies both ways, and the upstream response head.
//!
//! The parser is deliberately a twin of the TS one, not a general HTTP parser: what it accepts
//! the TS proxy accepts with the same meaning (`test-vectors/app-proxy.json`). Anything it does
//! not accept goes to the daemon unchanged, so a disagreement can only ever cost the fast path,
//! never change a decision.

use std::fmt;

/// `HTTP/1.0` or `HTTP/1.1`; nothing else reaches an app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Version {
    Http10,
    Http11,
}

impl Version {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Http10 => "1.0",
            Self::Http11 => "1.1",
        }
    }
}

/// A request head: lowercase names, repeated headers combined as the TS proxy does (`, `, and
/// `; ` for `cookie`), in first-seen order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestHead {
    pub method: String,
    pub target: String,
    pub version: Version,
    pub headers: Vec<(String, String)>,
}

impl RequestHead {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    /// A WebSocket upgrade exactly as the TS proxy recognises one.
    pub fn is_websocket_upgrade(&self) -> bool {
        let upgrade = self.get("upgrade").unwrap_or("").to_ascii_lowercase();
        let connection = self.get("connection").unwrap_or("").to_ascii_lowercase();
        upgrade == "websocket" && connection.split(',').any(|t| t.trim() == "upgrade")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadError {
    /// Not a head the TS proxy parses the same way; the daemon handles the connection.
    Unparsed,
}

impl fmt::Display for HeadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("request head not parsed by the proxy")
    }
}

impl std::error::Error for HeadError {}

fn is_tchar(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&b)
}

/// JavaScript's `\s` over a latin1-decoded byte (what `\S*` in the request-line regex excludes).
fn js_space(b: u8) -> bool {
    matches!(b, 0x09..=0x0d | 0x20 | 0xa0)
}

/// `String.prototype.trim` over latin1: the same set as `\s`.
fn js_trim(s: &[u8]) -> &[u8] {
    let start = s.iter().position(|b| !js_space(*b)).unwrap_or(s.len());
    let end = s
        .iter()
        .rposition(|b| !js_space(*b))
        .map_or(start, |e| e.saturating_add(1));
    s.get(start..end).unwrap_or(&[])
}

/// Latin1 bytes to a Rust string, one char per byte (`Buffer.toString("latin1")`).
fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| char::from(c)).collect()
}

/// Header names a plain JS object resolves on its prototype; the TS proxy's map treats them
/// specially, so the proxy leaves such a request to it.
const PROTOTYPE_NAMES: &[&str] = &["__proto__", "constructor"];

fn split_crlf(block: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut rest = block;
    loop {
        match rest.windows(2).position(|w| w == b"\r\n") {
            Some(i) => {
                out.push(rest.get(..i).unwrap_or(&[]));
                rest = rest.get(i.saturating_add(2)..).unwrap_or(&[]);
            }
            None => {
                out.push(rest);
                return out;
            }
        }
    }
}

/// Parse the head `block` (the bytes before the first `\r\n\r\n`).
pub fn parse_request_head(block: &[u8]) -> Result<RequestHead, HeadError> {
    let lines = split_crlf(block);
    let mut it = lines.into_iter();
    let first = it.next().ok_or(HeadError::Unparsed)?;
    // ^([token]+) (\/\S*) HTTP\/1\.([01])$
    let sp1 = first
        .iter()
        .position(|&b| b == b' ')
        .ok_or(HeadError::Unparsed)?;
    let method = first.get(..sp1).ok_or(HeadError::Unparsed)?;
    if method.is_empty() || !method.iter().all(|&b| is_tchar(b)) {
        return Err(HeadError::Unparsed);
    }
    let after = first
        .get(sp1.saturating_add(1)..)
        .ok_or(HeadError::Unparsed)?;
    let version = if after.ends_with(b" HTTP/1.1") {
        Version::Http11
    } else if after.ends_with(b" HTTP/1.0") {
        Version::Http10
    } else {
        return Err(HeadError::Unparsed);
    };
    let target = after
        .get(..after.len().saturating_sub(9))
        .ok_or(HeadError::Unparsed)?;
    if target.first() != Some(&b'/') || target.iter().any(|&b| js_space(b)) {
        return Err(HeadError::Unparsed);
    }
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in it {
        let idx = line
            .iter()
            .position(|&b| b == b':')
            .ok_or(HeadError::Unparsed)?;
        if idx == 0 {
            return Err(HeadError::Unparsed);
        }
        let name = line.get(..idx).ok_or(HeadError::Unparsed)?;
        if !name.iter().all(|&b| is_tchar(b)) {
            return Err(HeadError::Unparsed);
        }
        let key = latin1(name).to_ascii_lowercase();
        if PROTOTYPE_NAMES.contains(&key.as_str()) {
            return Err(HeadError::Unparsed);
        }
        let value = js_trim(line.get(idx.saturating_add(1)..).unwrap_or(&[]));
        if value
            .iter()
            .any(|&b| !(b == b'\t' || (0x20..=0x7e).contains(&b) || b >= 0x80))
        {
            return Err(HeadError::Unparsed);
        }
        let value = latin1(value);
        match headers.iter_mut().find(|(k, _)| *k == key) {
            Some((_, prev)) => {
                prev.push_str(if key == "cookie" { "; " } else { ", " });
                prev.push_str(&value);
            }
            None => headers.push((key, value)),
        }
    }
    Ok(RequestHead {
        method: latin1(method),
        target: latin1(target),
        version,
        headers,
    })
}

/// Where the head ends: the index of the first `\r\n\r\n`.
pub fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// How the request body arrives (the TS proxy's `BodyPlan` without its buffering).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestBody {
    None,
    Length(u64),
    Chunked,
}

/// A request the proxy answers itself before any decision (the TS proxy's `fail` cases).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub text: &'static str,
}

/// The TS proxy's body checks, in its order.
pub fn request_body(head: &RequestHead) -> Result<RequestBody, Refusal> {
    let te = head.get("transfer-encoding");
    let cl = head.get("content-length");
    if te.is_some() && cl.is_some() {
        return Err(Refusal {
            status: 400,
            text: "both Transfer-Encoding and Content-Length",
        });
    }
    let mut plan = RequestBody::None;
    if let Some(te) = te {
        if !te.eq_ignore_ascii_case("chunked") {
            return Err(Refusal {
                status: 501,
                text: "unsupported transfer-encoding",
            });
        }
        plan = RequestBody::Chunked;
    } else if let Some(cl) = cl {
        if cl.is_empty() || cl.len() > 15 || !cl.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Refusal {
                status: 400,
                text: "bad content-length",
            });
        }
        let n: u64 = cl.parse().map_err(|_| Refusal {
            status: 400,
            text: "bad content-length",
        })?;
        if n > 0 {
            plan = RequestBody::Length(n);
        }
    }
    if head.is_websocket_upgrade() && plan != RequestBody::None {
        return Err(Refusal {
            status: 400,
            text: "an upgrade request has no body",
        });
    }
    Ok(plan)
}

/// Request headers that describe this hop only; never forwarded.
const HOP_REQUEST: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "expect",
    "http2-settings",
];

/// Response headers the box rewrites.
const HOP_RESPONSE: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
];

/// Any spelling of an identity header: `x-flagship-…`, also with underscores (a CGI/WSGI server
/// folds `_` into `-`, so `x_flagship_role` would reach a Python app as the real header).
pub fn is_identity_header(name: &str) -> bool {
    let folded: String = name
        .chars()
        .map(|c| {
            if c == '_' {
                '-'
            } else {
                c.to_ascii_lowercase()
            }
        })
        .collect();
    folded.starts_with("x-flagship-")
}

/// The daemon's answer for one request: what to add and what to drop.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Injection {
    /// Identity headers to set (every name must be an `x-flagship-` header).
    pub set: Vec<(String, String)>,
    /// Client headers to drop besides the identity ones (an API key the box checked).
    pub remove: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectionError {
    NotIdentityHeader,
    BadValue,
    BadRemoval,
}

/// A header value safe to write on one line (no CR, LF or NUL, no other control except tab).
pub fn safe_value(v: &str) -> bool {
    v.bytes()
        .all(|b| b == b'\t' || (0x20..=0x7e).contains(&b) || b >= 0x80)
        && !v.contains('\u{7f}')
}

impl Injection {
    pub fn validate(&self) -> Result<(), InjectionError> {
        for (k, v) in &self.set {
            if !k.starts_with("x-flagship-")
                || !k.bytes().all(is_tchar)
                || k.bytes().any(|b| b.is_ascii_uppercase())
            {
                return Err(InjectionError::NotIdentityHeader);
            }
            if !safe_value(v) || v.chars().any(|c| u32::from(c) > 0xff) {
                return Err(InjectionError::BadValue);
            }
        }
        for r in &self.remove {
            if r.is_empty() || !r.bytes().all(is_tchar) || r.bytes().any(|b| b.is_ascii_uppercase())
            {
                return Err(InjectionError::BadRemoval);
            }
        }
        Ok(())
    }
}

/// The headers the app receives, as the TS proxy builds them (`stripIdentityHeaders`, the
/// prepared identity headers, then `forwardRequestHeaders` and the body's framing header): every
/// client identity header gone, whatever the daemon said; then its identity headers; hop-by-hop
/// headers and the ones the client's `Connection` named dropped; `Connection: close`, or the
/// `Upgrade: websocket` handshake.
pub fn forward_request_headers(
    client: &[(String, String)],
    inj: &Injection,
    upgrade: bool,
    body: RequestBody,
) -> Vec<(String, String)> {
    let mut prepared: Vec<(String, String)> = client
        .iter()
        .filter(|(k, _)| !is_identity_header(k) && !inj.remove.iter().any(|r| r == k))
        .cloned()
        .collect();
    for (k, v) in &inj.set {
        match prepared.iter_mut().find(|(pk, _)| pk == k) {
            Some((_, pv)) => pv.clone_from(v),
            None => prepared.push((k.clone(), v.clone())),
        }
    }
    let named: Vec<String> = prepared
        .iter()
        .find(|(k, _)| k == "connection")
        .map(|(_, v)| {
            v.to_ascii_lowercase()
                .split(',')
                .map(|t| t.trim().to_owned())
                .filter(|t| !t.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let mut out: Vec<(String, String)> = prepared
        .into_iter()
        .filter(|(k, _)| {
            !HOP_REQUEST.contains(&k.as_str())
                && !(named.contains(k)
                    && !k.starts_with("x-flagship-")
                    && !k.starts_with("sec-websocket-"))
        })
        .collect();
    if upgrade {
        out.push(("connection".into(), "Upgrade".into()));
        out.push(("upgrade".into(), "websocket".into()));
    } else {
        out.push(("connection".into(), "close".into()));
    }
    match body {
        RequestBody::None => {}
        RequestBody::Length(n) => out.push(("content-length".into(), n.to_string())),
        RequestBody::Chunked => out.push(("transfer-encoding".into(), "chunked".into())),
    }
    out
}

/// The app sees the name it was routed by (as the TS proxy's `routedHost`): a client-written Host or
/// X-Forwarded-Host never names another app to it (H5). The box is the only hop, so it states the
/// scheme and host itself.
pub fn with_routed_host(
    headers: Vec<(String, String)>,
    routed_host: &str,
) -> Vec<(String, String)> {
    if routed_host.is_empty() {
        return headers;
    }
    let mut out: Vec<(String, String)> = headers
        .into_iter()
        .filter(|(k, _)| k != "host" && k != "x-forwarded-host" && k != "x-forwarded-proto")
        .collect();
    out.insert(0, ("host".into(), routed_host.to_owned()));
    out.push(("x-forwarded-host".into(), routed_host.to_owned()));
    out.push(("x-forwarded-proto".into(), "https".into()));
    out
}

/// Serialise a request head for the app. Node's `http.request` adds `Host: <ip>:<port>` when
/// the client sent none (HTTP/1.0); so does this.
pub fn encode_request_head(
    method: &str,
    target: &str,
    headers: &[(String, String)],
    host_fallback: &str,
) -> Vec<u8> {
    let mut s = format!("{method} {target} HTTP/1.1\r\n");
    if !headers.iter().any(|(k, _)| k == "host") {
        s.push_str("host: ");
        s.push_str(host_fallback);
        s.push_str("\r\n");
    }
    for (k, v) in headers {
        s.push_str(k);
        s.push_str(": ");
        s.push_str(v);
        s.push_str("\r\n");
    }
    s.push_str("\r\n");
    s.chars()
        .map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?'))
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Responses

/// The app's response head, raw names kept (as Node's `rawHeaders`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseHead {
    pub status: u16,
    pub reason: String,
    pub headers: Vec<(String, String)>,
}

/// How the app's response body is delimited.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseBody {
    None,
    Length(u64),
    Chunked,
    UntilClose,
}

impl ResponseHead {
    fn values<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.headers
            .iter()
            .filter(move |(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The body's framing, refusing what Node's parser refuses (both framings, a bad or
    /// conflicting length, a transfer coding that is not chunked last).
    pub fn body(&self, request_method: &str) -> Option<ResponseBody> {
        let bodyless = request_method.eq_ignore_ascii_case("HEAD")
            || self.status == 204
            || self.status == 304
            || (100..200).contains(&self.status);
        let te: Vec<&str> = self.values("transfer-encoding").collect();
        let cl: Vec<&str> = self.values("content-length").collect();
        if !te.is_empty() && !cl.is_empty() {
            return None;
        }
        let length = match cl.as_slice() {
            [] => None,
            vals => {
                let mut n: Option<u64> = None;
                for v in vals {
                    for part in v.split(',') {
                        let p = part.trim();
                        if p.is_empty() || p.len() > 15 || !p.bytes().all(|b| b.is_ascii_digit()) {
                            return None;
                        }
                        let x: u64 = p.parse().ok()?;
                        if n.is_some_and(|m| m != x) {
                            return None;
                        }
                        n = Some(x);
                    }
                }
                n
            }
        };
        let chunked = if te.is_empty() {
            false
        } else {
            let joined = te.join(",").to_ascii_lowercase();
            let last = joined.rsplit(',').next().map(str::trim).unwrap_or("");
            if last != "chunked" {
                return None;
            }
            true
        };
        if bodyless {
            return Some(ResponseBody::None);
        }
        Some(if chunked {
            ResponseBody::Chunked
        } else if let Some(n) = length {
            ResponseBody::Length(n)
        } else {
            ResponseBody::UntilClose
        })
    }
}

/// Parse the app's response head (bytes before the first `\r\n\r\n`).
pub fn parse_response_head(block: &[u8]) -> Option<ResponseHead> {
    let lines = split_crlf(block);
    let mut it = lines.into_iter();
    let first = it.next()?;
    let rest = first
        .strip_prefix(b"HTTP/1.1 ")
        .or_else(|| first.strip_prefix(b"HTTP/1.0 "))?;
    let code = rest.get(..3)?;
    if !code.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let status: u16 = std::str::from_utf8(code).ok()?.parse().ok()?;
    if !(100..=599).contains(&status) {
        return None;
    }
    let reason = match rest.get(3..) {
        None | Some([]) => String::new(),
        Some([b' ', r @ ..]) => latin1(r),
        Some(_) => return None,
    };
    if !safe_value(&reason) {
        return None;
    }
    let mut headers = Vec::new();
    for line in it {
        let idx = line.iter().position(|&b| b == b':')?;
        let name = line.get(..idx)?;
        if name.is_empty() || !name.iter().all(|&b| is_tchar(b)) {
            return None;
        }
        let value = js_trim(line.get(idx.saturating_add(1)..).unwrap_or(&[]));
        if value
            .iter()
            .any(|&b| !(b == b'\t' || (0x20..=0x7e).contains(&b) || b >= 0x80))
        {
            return None;
        }
        headers.push((latin1(name), latin1(value)));
    }
    Some(ResponseHead {
        status,
        reason,
        headers,
    })
}

/// The reason phrase Node writes when the app sent none (`STATUS_CODES`).
pub fn default_reason(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        101 => "Switching Protocols",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        206 => "Partial Content",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Unknown",
    }
}

/// The head the client gets (the TS proxy's `relayResponse`): hop-by-hop headers and those the
/// app's `Connection` named dropped, re-chunked when the length is unknown and the client speaks
/// 1.1, always `Connection: close`. Returns the bytes and whether the body is re-chunked.
pub fn client_response_head(
    resp: &ResponseHead,
    framing: ResponseBody,
    client: Version,
) -> (Vec<u8>, bool) {
    let named: Vec<String> = resp
        .values("connection")
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    let reason = if resp.reason.is_empty() {
        default_reason(resp.status).to_owned()
    } else {
        resp.reason.clone()
    };
    let mut lines = vec![format!("HTTP/1.1 {} {reason}", resp.status)];
    let mut has_length = false;
    for (k, v) in &resp.headers {
        let kl = k.to_ascii_lowercase();
        if HOP_RESPONSE.contains(&kl.as_str()) || named.contains(&kl) {
            continue;
        }
        if kl == "content-length" {
            has_length = true;
        }
        lines.push(format!("{k}: {v}"));
    }
    let chunked = framing != ResponseBody::None && !has_length && client == Version::Http11;
    if chunked {
        lines.push("Transfer-Encoding: chunked".into());
    }
    lines.push("Connection: close".into());
    let mut s = lines.join("\r\n");
    s.push_str("\r\n\r\n");
    (
        s.chars()
            .map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?'))
            .collect(),
        chunked,
    )
}

/// A switching-protocols answer goes to the client with every header the app sent (as the TS
/// proxy writes `rawHeaders` for a 101).
pub fn upgrade_response_head(resp: &ResponseHead) -> Vec<u8> {
    let reason = if resp.reason.is_empty() {
        "Switching Protocols".to_owned()
    } else {
        resp.reason.clone()
    };
    let mut s = format!("HTTP/1.1 {} {reason}\r\n", resp.status);
    for (k, v) in &resp.headers {
        s.push_str(k);
        s.push_str(": ");
        s.push_str(v);
        s.push_str("\r\n");
    }
    s.push_str("\r\n");
    s.chars()
        .map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?'))
        .collect()
}

/// A short plain answer written by the proxy itself (`writeBuffered` in the TS proxy).
pub fn plain_response(status: u16, text: &str, method: &str, extra: &[(&str, &str)]) -> Vec<u8> {
    let mut s = format!(
        "HTTP/1.1 {status} {}\r\nContent-Length: {}\r\nConnection: close\r\ncontent-type: text/plain; charset=utf-8\r\n",
        default_reason(status),
        text.len()
    );
    for (k, v) in extra {
        s.push_str(k);
        s.push_str(": ");
        s.push_str(v);
        s.push_str("\r\n");
    }
    s.push_str("\r\n");
    if !method.eq_ignore_ascii_case("HEAD") {
        s.push_str(text);
    }
    s.into_bytes()
}

// ---------------------------------------------------------------------------------------------
// Chunked bodies

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkError {
    LineTooLong,
    BadSize,
    MissingCrlf,
}

impl fmt::Display for ChunkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::LineTooLong => "chunk line too long",
            Self::BadSize => "bad chunk size",
            Self::MissingCrlf => "missing CRLF after chunk",
        })
    }
}

impl std::error::Error for ChunkError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChunkState {
    Size,
    Data,
    DataCrlf,
    Trailers,
    Done,
}

/// The TS proxy's `ChunkedDecoder`: a size line of 1 to 12 hex digits (extensions ignored),
/// data, CRLF; trailers are read and dropped; lines are capped at 4096 bytes.
#[derive(Debug, Clone)]
pub struct ChunkedDecoder {
    state: ChunkState,
    line: Vec<u8>,
    left: u64,
}

impl Default for ChunkedDecoder {
    fn default() -> Self {
        Self::new()
    }
}

pub const CHUNK_LINE_MAX: usize = 4096;

impl ChunkedDecoder {
    pub fn new() -> Self {
        Self {
            state: ChunkState::Size,
            line: Vec::new(),
            left: 0,
        }
    }

    pub fn done(&self) -> bool {
        self.state == ChunkState::Done
    }

    /// Feed bytes; calls `out` with each run of decoded data. Returns how many input bytes were
    /// used (all of them unless the body ended inside `input`).
    pub fn push(&mut self, input: &[u8], out: &mut dyn FnMut(&[u8])) -> Result<usize, ChunkError> {
        let mut i: usize = 0;
        while i < input.len() && self.state != ChunkState::Done {
            if self.state == ChunkState::Data {
                let avail = input.len().saturating_sub(i);
                let n = usize::try_from(self.left).map_or(avail, |l| l.min(avail));
                let end = i.saturating_add(n);
                out(input.get(i..end).unwrap_or(&[]));
                i = end;
                self.left = self.left.saturating_sub(n as u64);
                if self.left == 0 {
                    self.state = ChunkState::DataCrlf;
                }
                continue;
            }
            let c = input.get(i).copied().unwrap_or(0);
            i = i.saturating_add(1);
            self.line.push(c);
            if self.line.len() > CHUNK_LINE_MAX {
                return Err(ChunkError::LineTooLong);
            }
            if !self.line.ends_with(b"\r\n") {
                continue;
            }
            let text_len = self.line.len().saturating_sub(2);
            let text = self.line.get(..text_len).unwrap_or(&[]).to_vec();
            self.line.clear();
            match self.state {
                ChunkState::Size => {
                    let digits_end = text.iter().position(|&b| b == b';').unwrap_or(text.len());
                    let digits = text.get(..digits_end).unwrap_or(&[]);
                    if digits.is_empty()
                        || digits.len() > 12
                        || !digits.iter().all(u8::is_ascii_hexdigit)
                    {
                        return Err(ChunkError::BadSize);
                    }
                    let s = std::str::from_utf8(digits).map_err(|_| ChunkError::BadSize)?;
                    self.left = u64::from_str_radix(s, 16).map_err(|_| ChunkError::BadSize)?;
                    self.state = if self.left == 0 {
                        ChunkState::Trailers
                    } else {
                        ChunkState::Data
                    };
                }
                ChunkState::DataCrlf => {
                    if !text.is_empty() {
                        return Err(ChunkError::MissingCrlf);
                    }
                    self.state = ChunkState::Size;
                }
                ChunkState::Trailers => {
                    if text.is_empty() {
                        self.state = ChunkState::Done;
                    }
                }
                ChunkState::Data | ChunkState::Done => {}
            }
        }
        Ok(i)
    }
}

/// One chunk of a chunked body (an empty `data` is never sent: it would end the body).
pub fn encode_chunk(data: &[u8]) -> Vec<u8> {
    let mut out = format!("{:x}\r\n", data.len()).into_bytes();
    out.extend_from_slice(data);
    out.extend_from_slice(b"\r\n");
    out
}

pub const LAST_CHUNK: &[u8] = b"0\r\n\r\n";

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
mod tests {
    use super::*;

    fn h(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn the_app_is_told_the_routed_host_not_the_clients() {
        let out = with_routed_host(
            h(&[
                ("host", "b.box.example"),
                ("x-forwarded-host", "b.box.example"),
                ("x-forwarded-proto", "http"),
                ("accept", "*/*"),
            ]),
            "a.box.example",
        );
        assert_eq!(
            out,
            h(&[
                ("host", "a.box.example"),
                ("accept", "*/*"),
                ("x-forwarded-host", "a.box.example"),
                ("x-forwarded-proto", "https")
            ])
        );
    }

    #[test]
    fn parses_like_the_ts_proxy() {
        let p = parse_request_head(
            b"GET /a?b=1 HTTP/1.1\r\nHost: x\r\nCookie: a=1\r\ncookie: b=2\r\nX-A:  v \r\nx-a: w",
        )
        .unwrap();
        assert_eq!(p.method, "GET");
        assert_eq!(p.target, "/a?b=1");
        assert_eq!(p.version, Version::Http11);
        assert_eq!(
            p.headers,
            h(&[("host", "x"), ("cookie", "a=1; b=2"), ("x-a", "v, w")])
        );
        for bad in [
            &b"GET  / HTTP/1.1"[..],
            b"GET / HTTP/2.0",
            b"GET * HTTP/1.1",
            b"GET http://a/ HTTP/1.1",
            b"G\xc3T / HTTP/1.1",
            b"GET /a\xa0b HTTP/1.1",
            b"GET / HTTP/1.1\r\n folded: x",
            b"GET / HTTP/1.1\r\n: x",
            b"GET / HTTP/1.1\r\nnocolon",
            b"GET / HTTP/1.1\r\nA: b\x01c",
            b"GET / HTTP/1.1\r\nA: b\rc",
            b"GET / HTTP/1.1\r\nconstructor: x",
            b"GET / HTTP/1.1\r\n__proto__: x",
            b"\r\nGET / HTTP/1.1",
        ] {
            assert!(parse_request_head(bad).is_err(), "{:?}", latin1(bad));
        }
        // A target with a non-breaking space is not `\S*`; 0x85 is (JS `\s` lacks it).
        assert!(parse_request_head(b"GET /a\x85b HTTP/1.1").is_ok());
    }

    #[test]
    fn strips_every_spelling_of_identity_headers() {
        let client = h(&[
            ("host", "a"),
            ("x-flagship-user", "forged"),
            ("x_flagship_role", "master"),
            ("x-flagship_visitor", "member"),
            ("authorization", "Bearer fsk_x"),
            ("connection", "keep-alive, x-secret"),
            ("x-secret", "1"),
            ("te", "trailers"),
        ]);
        let inj = Injection {
            set: h(&[
                ("x-flagship-visitor", "anonymous"),
                ("x-flagship-app-id", "a--b"),
            ]),
            remove: vec!["authorization".into()],
        };
        inj.validate().unwrap();
        let out = forward_request_headers(&client, &inj, false, RequestBody::Length(3));
        assert_eq!(
            out,
            h(&[
                ("host", "a"),
                ("x-flagship-visitor", "anonymous"),
                ("x-flagship-app-id", "a--b"),
                ("connection", "close"),
                ("content-length", "3"),
            ])
        );
        let up = forward_request_headers(
            &h(&[
                ("connection", "Upgrade, sec-websocket-key"),
                ("sec-websocket-key", "k"),
                ("upgrade", "websocket"),
            ]),
            &Injection::default(),
            true,
            RequestBody::None,
        );
        assert_eq!(
            up,
            h(&[
                ("sec-websocket-key", "k"),
                ("connection", "Upgrade"),
                ("upgrade", "websocket")
            ])
        );
    }

    #[test]
    fn refuses_injections_that_are_not_identity_headers() {
        let bad = |set: &[(&str, &str)], remove: &[&str]| {
            Injection {
                set: h(set),
                remove: remove.iter().map(|s| (*s).to_owned()).collect(),
            }
            .validate()
            .is_err()
        };
        assert!(bad(&[("host", "evil")], &[]));
        assert!(bad(&[("X-Flagship-User", "a")], &[]));
        assert!(bad(&[("x-flagship-user", "a\r\nx: y")], &[]));
        assert!(bad(&[("x-flagship-user", "\u{100}")], &[]));
        assert!(bad(&[], &["Authorization"]));
        assert!(!bad(&[("x-flagship-user", "u")], &["authorization"]));
    }

    #[test]
    fn body_plans_and_refusals() {
        let req = |extra: &[(&str, &str)]| RequestHead {
            method: "POST".into(),
            target: "/".into(),
            version: Version::Http11,
            headers: h(extra),
        };
        assert_eq!(request_body(&req(&[])), Ok(RequestBody::None));
        assert_eq!(
            request_body(&req(&[("content-length", "0")])),
            Ok(RequestBody::None)
        );
        assert_eq!(
            request_body(&req(&[("content-length", "12")])),
            Ok(RequestBody::Length(12))
        );
        assert_eq!(
            request_body(&req(&[("transfer-encoding", "Chunked")])),
            Ok(RequestBody::Chunked)
        );
        assert_eq!(
            request_body(&req(&[("transfer-encoding", "gzip, chunked")]))
                .unwrap_err()
                .status,
            501
        );
        assert_eq!(
            request_body(&req(&[("content-length", "1, 1")]))
                .unwrap_err()
                .status,
            400
        );
        assert_eq!(
            request_body(&req(&[("content-length", "1234567890123456")]))
                .unwrap_err()
                .status,
            400
        );
        assert_eq!(
            request_body(&req(&[
                ("content-length", "1"),
                ("transfer-encoding", "chunked")
            ]))
            .unwrap_err()
            .status,
            400
        );
        assert_eq!(
            request_body(&req(&[
                ("upgrade", "websocket"),
                ("connection", "upgrade"),
                ("content-length", "2")
            ]))
            .unwrap_err()
            .status,
            400
        );
    }

    #[test]
    fn response_framing() {
        let r = parse_response_head(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: x-drop\r\nX-Drop: 1").unwrap();
        assert_eq!(r.body("GET"), Some(ResponseBody::UntilClose));
        let (head, chunked) = client_response_head(&r, ResponseBody::UntilClose, Version::Http11);
        assert!(chunked);
        assert_eq!(
            String::from_utf8(head).unwrap(),
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        );
        let (_, chunked10) = client_response_head(&r, ResponseBody::UntilClose, Version::Http10);
        assert!(!chunked10);
        let l = parse_response_head(b"HTTP/1.1 201 \r\ncontent-length: 5\r\nContent-Length: 5")
            .unwrap();
        assert_eq!(l.body("GET"), Some(ResponseBody::Length(5)));
        assert_eq!(l.body("HEAD"), Some(ResponseBody::None));
        assert!(
            parse_response_head(b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\ncontent-length: 6")
                .unwrap()
                .body("GET")
                .is_none()
        );
        assert!(
            parse_response_head(
                b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\ntransfer-encoding: chunked"
            )
            .unwrap()
            .body("GET")
            .is_none()
        );
        assert!(
            parse_response_head(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked, gzip")
                .unwrap()
                .body("GET")
                .is_none()
        );
        assert!(parse_response_head(b"HTTP/2 200 OK").is_none());
        assert!(parse_response_head(b"HTTP/1.1 20 OK").is_none());
        assert!(parse_response_head(b"HTTP/1.1 200 OK\r\nBad Name: x").is_none());
        let n = parse_response_head(b"HTTP/1.1 204").unwrap();
        assert_eq!(n.reason, "");
        assert_eq!(n.body("GET"), Some(ResponseBody::None));
    }

    /// A tiny deterministic generator, so the property tests need no extra crate.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n.max(1)
        }
        fn bytes(&mut self, n: usize) -> Vec<u8> {
            (0..n).map(|_| self.next() as u8).collect()
        }
    }

    #[test]
    fn property_chunked_roundtrip_under_any_split() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for _ in 0..400 {
            let pieces: Vec<Vec<u8>> = (0..rng.below(8))
                .map(|_| {
                    let n = 1 + rng.below(300) as usize;
                    rng.bytes(n)
                })
                .collect();
            let mut wire = Vec::new();
            for p in &pieces {
                wire.extend(encode_chunk(p));
            }
            wire.extend_from_slice(b"0\r\nX-T: 1\r\n\r\nNEXT");
            let want: Vec<u8> = pieces.concat();
            let mut dec = ChunkedDecoder::new();
            let mut got = Vec::new();
            let mut used_total = 0;
            let mut at = 0;
            while at < wire.len() && !dec.done() {
                let step = 1 + rng.below(40) as usize;
                let end = (at + step).min(wire.len());
                let used = dec
                    .push(&wire[at..end], &mut |d| got.extend_from_slice(d))
                    .unwrap();
                used_total += used;
                at = end;
            }
            assert!(dec.done());
            assert_eq!(got, want);
            assert_eq!(&wire[used_total..], b"NEXT");
        }
    }

    #[test]
    fn property_chunked_decoder_never_panics_and_bounds_lines() {
        let mut rng = Rng(42);
        for _ in 0..3000 {
            let n = rng.below(200) as usize;
            let mut junk = rng.bytes(n);
            if rng.below(2) == 0 {
                junk.splice(0..0, b"5\r\nhello\r\n".iter().copied());
            }
            let mut dec = ChunkedDecoder::new();
            let mut total = 0usize;
            let r = dec.push(&junk, &mut |d| total += d.len());
            assert!(total <= junk.len());
            if let Ok(used) = r {
                assert!(used <= junk.len());
            }
        }
        let mut dec = ChunkedDecoder::new();
        let long = vec![b'1'; CHUNK_LINE_MAX + 1];
        assert_eq!(dec.push(&long, &mut |_| {}), Err(ChunkError::LineTooLong));
        let mut dec = ChunkedDecoder::new();
        assert_eq!(
            dec.push(b"1234567890abc\r\n", &mut |_| {}),
            Err(ChunkError::BadSize)
        );
        let mut dec = ChunkedDecoder::new();
        assert_eq!(
            dec.push(b"1\r\naX\r\n", &mut |_| {}),
            Err(ChunkError::MissingCrlf)
        );
    }

    #[test]
    fn property_request_head_parser_never_panics_and_is_stable() {
        let mut rng = Rng(7);
        let alphabet = b"GETPOST /?=&:;, \t\r\nabcXYZ-_0123456789\x00\x7f\x80\xa0\xff";
        for _ in 0..20_000 {
            let n = rng.below(120) as usize;
            let mut b: Vec<u8> = (0..n)
                .map(|_| alphabet[rng.below(alphabet.len() as u64) as usize])
                .collect();
            if rng.below(3) == 0 {
                b.splice(0..0, b"GET / HTTP/1.1\r\n".iter().copied());
            }
            if let Ok(p) = parse_request_head(&b) {
                // Whatever parses never yields a value that would break a header line.
                for (k, v) in &p.headers {
                    assert!(k.bytes().all(is_tchar));
                    assert!(!v.contains('\r') && !v.contains('\n') && !v.contains('\0'));
                }
                assert!(p.target.starts_with('/'));
                // Forwarding keeps no identity header the daemon did not set.
                let out = forward_request_headers(
                    &p.headers,
                    &Injection::default(),
                    false,
                    RequestBody::None,
                );
                assert!(out.iter().all(|(k, _)| !is_identity_header(k)));
                // The forwarded head parses back to the same headers on the app's side.
                let wire = encode_request_head(&p.method, &p.target, &out, "10.0.0.2:8080");
                let end = find_head_end(&wire).unwrap();
                let back = parse_request_head(&wire[..end]).unwrap();
                assert_eq!(back.target, p.target);
                for (k, v) in &out {
                    assert_eq!(back.get(k), Some(v.as_str()), "{k}");
                }
            }
        }
    }

    #[test]
    fn property_identity_spellings() {
        let mut rng = Rng(99);
        for _ in 0..2000 {
            let name: String = "x-flagship-user"
                .chars()
                .map(|c| match c {
                    '-' if rng.below(2) == 0 => '_',
                    c if rng.below(2) == 0 => c.to_ascii_uppercase(),
                    c => c,
                })
                .collect();
            let client = vec![(name.to_ascii_lowercase(), "forged".to_owned())];
            let out =
                forward_request_headers(&client, &Injection::default(), false, RequestBody::None);
            assert_eq!(
                out,
                vec![("connection".to_owned(), "close".to_owned())],
                "{name}"
            );
        }
    }
}

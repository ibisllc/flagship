//! The worker's HTTP/1.1 front for `http-proxy` apps. It listens on the
//! box's loopback, where the app proxy dials an app's port exactly as it
//! dials a container's, so routing, identity headers, membership and the
//! knock page are the same for both kinds of app.
//!
//! The parser is deliberately strict and small: origin-form targets only,
//! no obsolete line folding, one Content-Length or chunked framing (never
//! both), bounded head and body, and `Connection: close` on every answer.

use std::fmt;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use crate::cgi::{HttpRequest, HttpResponse, cgi_env, clean_value, is_token, parse_cgi_output};
use crate::error::WorkerError;
use crate::hostcalls::CapabilityBroker;
use crate::manifest::{Preopen, WasiGrant, WasiWorld};
use crate::worker::{CompiledModule, Exit, RunInput, Worker};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ServerLimits {
    /// Request line plus headers.
    pub max_head_bytes: usize,
    pub max_body_bytes: usize,
    /// Per read and write on a connection.
    pub io_timeout: Duration,
    /// Connections served at once; past it the answer is 503.
    pub max_connections: usize,
}

impl Default for ServerLimits {
    fn default() -> Self {
        Self {
            max_head_bytes: 16 * 1024,
            max_body_bytes: 8 * 1024 * 1024,
            io_timeout: Duration::from_secs(30),
            max_connections: 64,
        }
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum HttpError {
    #[error("bad request: {0}")]
    Bad(&'static str),
    #[error("request head too large")]
    HeadTooLarge,
    #[error("request body too large")]
    BodyTooLarge,
    #[error("connection closed")]
    Closed,
    #[error("i/o: {0}")]
    Io(String),
}

impl HttpError {
    fn status(&self) -> u16 {
        match self {
            Self::Bad(_) => 400,
            Self::HeadTooLarge => 431,
            Self::BodyTooLarge => 413,
            Self::Closed | Self::Io(_) => 400,
        }
    }
}

impl From<io::Error> for HttpError {
    fn from(e: io::Error) -> Self {
        match e.kind() {
            io::ErrorKind::UnexpectedEof => Self::Closed,
            _ => Self::Io(e.kind().to_string()),
        }
    }
}

/// The parsed head and how the body is framed.
struct Head {
    req: HttpRequest,
    framing: Framing,
    expect_continue: bool,
}

enum Framing {
    Length(usize),
    Chunked,
}

fn read_line<R: BufRead>(r: &mut R, budget: &mut usize) -> Result<String, HttpError> {
    let mut buf = Vec::new();
    let limit = u64::try_from(*budget).unwrap_or(u64::MAX).saturating_add(1);
    let n = r.by_ref().take(limit).read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Err(HttpError::Closed);
    }
    if n > *budget || !buf.ends_with(b"\n") {
        return Err(HttpError::HeadTooLarge);
    }
    *budget = budget.saturating_sub(n);
    buf.pop();
    if buf.ends_with(b"\r") {
        buf.pop();
    }
    String::from_utf8(buf).map_err(|_| HttpError::Bad("head is not UTF-8"))
}

fn read_head<R: BufRead>(r: &mut R, limits: &ServerLimits) -> Result<Head, HttpError> {
    let mut budget = limits.max_head_bytes;
    let line = read_line(r, &mut budget)?;
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(HttpError::Bad("request line"));
    };
    if !is_token(method) || !method.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(HttpError::Bad("method"));
    }
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err(HttpError::Bad("version"));
    }
    if !target.starts_with('/')
        || target.starts_with("//")
        || target.len() > 8192
        || !target.bytes().all(|b| b > 0x20 && b != 0x7f)
    {
        return Err(HttpError::Bad("target"));
    }
    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let line = read_line(r, &mut budget)?;
        if line.is_empty() {
            break;
        }
        if line.starts_with([' ', '\t']) {
            return Err(HttpError::Bad("obsolete line folding"));
        }
        let (name, value) = line.split_once(':').ok_or(HttpError::Bad("header line"))?;
        let value = value.trim_matches([' ', '\t']);
        if !is_token(name) || !clean_value(value) {
            return Err(HttpError::Bad("header"));
        }
        if headers.len() >= 100 {
            return Err(HttpError::HeadTooLarge);
        }
        headers.push((name.to_owned(), value.to_owned()));
    }
    let lengths: Vec<&str> = headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .map(|(_, v)| v.as_str())
        .collect();
    let te: Vec<&str> = headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("transfer-encoding"))
        .map(|(_, v)| v.as_str())
        .collect();
    let framing = match (lengths.as_slice(), te.as_slice()) {
        ([], []) => Framing::Length(0),
        ([], [t]) if t.eq_ignore_ascii_case("chunked") => Framing::Chunked,
        (_, [_, ..]) => return Err(HttpError::Bad("transfer-encoding")),
        ([l], []) => {
            if l.is_empty() || l.len() > 19 || !l.bytes().all(|b| b.is_ascii_digit()) {
                return Err(HttpError::Bad("content-length"));
            }
            let n: usize = l.parse().map_err(|_| HttpError::Bad("content-length"))?;
            Framing::Length(n)
        }
        _ => return Err(HttpError::Bad("several content-length headers")),
    };
    let expect_continue = headers
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("expect") && v.eq_ignore_ascii_case("100-continue"));
    Ok(Head {
        req: HttpRequest {
            method: method.to_owned(),
            target: target.to_owned(),
            headers,
            body: Vec::new(),
        },
        framing,
        expect_continue,
    })
}

fn read_body<R: BufRead>(
    r: &mut R,
    framing: &Framing,
    limits: &ServerLimits,
) -> Result<Vec<u8>, HttpError> {
    match framing {
        Framing::Length(n) => {
            if *n > limits.max_body_bytes {
                return Err(HttpError::BodyTooLarge);
            }
            let mut body = vec![0u8; *n];
            r.read_exact(&mut body)?;
            Ok(body)
        }
        Framing::Chunked => {
            let mut body = Vec::new();
            loop {
                let mut budget = 1024usize;
                let line = read_line(r, &mut budget)?;
                let size_hex = line.split(';').next().unwrap_or("").trim();
                if size_hex.is_empty() || size_hex.len() > 8 {
                    return Err(HttpError::Bad("chunk size"));
                }
                let size = usize::from_str_radix(size_hex, 16)
                    .map_err(|_| HttpError::Bad("chunk size"))?;
                if size == 0 {
                    let mut trailer_budget = limits.max_head_bytes;
                    loop {
                        if read_line(r, &mut trailer_budget)?.is_empty() {
                            return Ok(body);
                        }
                    }
                }
                if body.len().saturating_add(size) > limits.max_body_bytes {
                    return Err(HttpError::BodyTooLarge);
                }
                let start = body.len();
                body.resize(start.saturating_add(size), 0);
                r.read_exact(body.get_mut(start..).ok_or(HttpError::Bad("chunk"))?)?;
                let mut crlf = [0u8; 2];
                r.read_exact(&mut crlf)?;
                if &crlf != b"\r\n" {
                    return Err(HttpError::Bad("chunk terminator"));
                }
            }
        }
    }
}

/// Read one whole request (head and body).
pub fn read_request<R: BufRead>(
    r: &mut R,
    limits: &ServerLimits,
) -> Result<HttpRequest, HttpError> {
    let head = read_head(r, limits)?;
    let body = read_body(r, &head.framing, limits)?;
    Ok(HttpRequest { body, ..head.req })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Content Too Large",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

/// Write `resp` with its own Content-Length and `Connection: close`.
pub fn write_response<W: Write>(w: &mut W, resp: &HttpResponse, head_only: bool) -> io::Result<()> {
    let mut out = format!("HTTP/1.1 {} {}\r\n", resp.status, reason(resp.status)).into_bytes();
    for (k, v) in &resp.headers {
        out.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
    }
    let no_body = resp.status == 204 || resp.status == 304;
    if !no_body {
        out.extend_from_slice(format!("Content-Length: {}\r\n", resp.body.len()).as_bytes());
    }
    out.extend_from_slice(b"Connection: close\r\n\r\n");
    if !head_only && !no_body {
        out.extend_from_slice(&resp.body);
    }
    w.write_all(&out)?;
    w.flush()
}

type LogFn = dyn Fn(&str) + Send + Sync;

/// One app's HTTP front: a worker bound to the app, the module compiled once
/// for it, and the grant every request runs under.
pub struct AppServer {
    worker: Worker,
    compiled: CompiledModule,
    grant: WasiGrant,
    preopens: Vec<Preopen>,
    broker: Option<Arc<dyn CapabilityBroker>>,
    limits: ServerLimits,
    active: AtomicUsize,
    log: Arc<LogFn>,
}

impl fmt::Debug for AppServer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AppServer")
            .field("app", &self.compiled.app_id())
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

struct ConnPermit<'a>(&'a AtomicUsize);

impl Drop for ConnPermit<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl AppServer {
    pub fn new(
        worker: Worker,
        compiled: CompiledModule,
        grant: WasiGrant,
        preopens: Vec<Preopen>,
        broker: Option<Arc<dyn CapabilityBroker>>,
        limits: ServerLimits,
    ) -> Result<Self, WorkerError> {
        if grant.world() != WasiWorld::HttpProxy {
            return Err(WorkerError::Internal(
                "an HTTP front needs the http-proxy world".into(),
            ));
        }
        Ok(Self {
            worker,
            compiled,
            grant,
            preopens,
            broker,
            limits,
            active: AtomicUsize::new(0),
            log: Arc::new(|_| {}),
        })
    }

    /// Where the server reports each request and every failure. Lines carry
    /// no request bodies, queries or header values.
    pub fn with_log(mut self, log: Arc<LogFn>) -> Self {
        self.log = log;
        self
    }

    pub fn limits(&self) -> &ServerLimits {
        &self.limits
    }

    /// Run the app for one request.
    pub fn handle(&self, req: &HttpRequest) -> HttpResponse {
        let env = cgi_env(req);
        let input = RunInput {
            stdin: &req.body,
            extra_env: &env,
            broker: self.broker.clone(),
        };
        match self
            .worker
            .run_compiled(&self.compiled, &self.grant, &self.preopens, input)
        {
            Ok(out) => {
                if !out.stderr.is_empty() {
                    let tail = String::from_utf8_lossy(&out.stderr);
                    let tail: String = tail
                        .chars()
                        .rev()
                        .take(400)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    (self.log)(&format!("app stderr: {}", tail.trim_end()));
                }
                match out.exit {
                    Exit::Code(0) => parse_cgi_output(&out.stdout).unwrap_or_else(|e| {
                        (self.log)(&format!("bad answer: {e}"));
                        HttpResponse::text(502, "The app's answer was not a valid response.\n")
                    }),
                    Exit::Code(code) => {
                        (self.log)(&format!("app exited with code {code}"));
                        HttpResponse::text(500, "The app failed on this request.\n")
                    }
                }
            }
            Err(WorkerError::Busy(_)) => {
                let mut r = HttpResponse::text(503, "The app is busy. Try again.\n");
                r.headers.push(("Retry-After".into(), "1".into()));
                r
            }
            Err(WorkerError::LimitExceeded(kind)) => {
                (self.log)(&format!("stopped: {kind} limit"));
                HttpResponse::text(
                    503,
                    &format!("The app ran out of {kind} on this request.\n"),
                )
            }
            Err(e) => {
                (self.log)(&format!("run failed: {e}"));
                HttpResponse::text(500, "The app failed on this request.\n")
            }
        }
    }

    /// Serve one connection: one request, one answer, close.
    pub fn handle_connection(&self, stream: TcpStream) {
        let started = Instant::now();
        let _ = stream.set_read_timeout(Some(self.limits.io_timeout));
        let _ = stream.set_write_timeout(Some(self.limits.io_timeout));
        let Ok(write_half) = stream.try_clone() else {
            return;
        };
        let mut w = write_half;
        let mut r = BufReader::new(stream);
        let head = match read_head(&mut r, &self.limits) {
            Ok(h) => h,
            Err(HttpError::Closed) => return,
            Err(e) => {
                let _ = write_response(
                    &mut w,
                    &HttpResponse::text(e.status(), &format!("{e}\n")),
                    false,
                );
                return;
            }
        };
        if head.expect_continue {
            if let Framing::Length(n) = head.framing
                && n > self.limits.max_body_bytes
            {
                let _ = write_response(
                    &mut w,
                    &HttpResponse::text(413, "request body too large\n"),
                    false,
                );
                return;
            }
            if w.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").is_err() {
                return;
            }
        }
        let body = match read_body(&mut r, &head.framing, &self.limits) {
            Ok(b) => b,
            Err(e) => {
                let _ = write_response(
                    &mut w,
                    &HttpResponse::text(e.status(), &format!("{e}\n")),
                    false,
                );
                return;
            }
        };
        let req = HttpRequest { body, ..head.req };
        let resp = self.handle(&req);
        let head_only = req.method == "HEAD";
        let path = req.target.split('?').next().unwrap_or("");
        (self.log)(&format!(
            "{} {} {} {}ms",
            req.method,
            path,
            resp.status,
            started.elapsed().as_millis()
        ));
        let _ = write_response(&mut w, &resp, head_only);
    }

    /// Accept until `stop` is set. Each connection gets its own thread, up to
    /// `max_connections`; past it the answer is 503 at once.
    pub fn serve(self: &Arc<Self>, listener: &TcpListener, stop: &AtomicBool) -> io::Result<()> {
        for conn in listener.incoming() {
            if stop.load(Ordering::Acquire) {
                return Ok(());
            }
            let Ok(mut stream) = conn else {
                continue;
            };
            let max = self.limits.max_connections;
            if self
                .active
                .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                    (n < max).then(|| n.saturating_add(1))
                })
                .is_err()
            {
                let mut busy = HttpResponse::text(503, "The app is busy. Try again.\n");
                busy.headers.push(("Retry-After".into(), "1".into()));
                let _ = write_response(&mut stream, &busy, false);
                continue;
            }
            let me = Arc::clone(self);
            let spawned = std::thread::Builder::new()
                .name("flagship-wasi-conn".into())
                .spawn(move || {
                    let _permit = ConnPermit(&me.active);
                    me.handle_connection(stream);
                });
            if spawned.is_err() {
                self.active.fetch_sub(1, Ordering::AcqRel);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &[u8]) -> Result<HttpRequest, HttpError> {
        read_request(&mut BufReader::new(raw), &ServerLimits::default())
    }

    #[test]
    fn reads_a_plain_and_a_chunked_request() {
        let r = parse(b"POST /a?b HTTP/1.1\r\nHost: x\r\nContent-Length: 3\r\n\r\nabc")
            .unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!(r.body, b"abc");
        assert_eq!(r.target, "/a?b");
        let r = parse(b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2;x=y\r\nde\r\n0\r\nT: 1\r\n\r\n")
            .unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!(r.body, b"abcde");
    }

    #[test]
    fn refuses_smuggling_shapes() {
        assert_eq!(
            parse(b"POST / HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n")
                .err(),
            Some(HttpError::Bad("transfer-encoding"))
        );
        assert_eq!(
            parse(b"POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n").err(),
            Some(HttpError::Bad("several content-length headers"))
        );
        assert_eq!(
            parse(b"GET / HTTP/1.1\r\nX: a\r\n b\r\n\r\n").err(),
            Some(HttpError::Bad("obsolete line folding"))
        );
        assert_eq!(
            parse(b"GET http://x/ HTTP/1.1\r\n\r\n").err(),
            Some(HttpError::Bad("target"))
        );
        assert_eq!(
            parse(b"GET //x HTTP/1.1\r\n\r\n").err(),
            Some(HttpError::Bad("target"))
        );
        assert_eq!(
            parse(b"GET / HTTP/2\r\n\r\n").err(),
            Some(HttpError::Bad("version"))
        );
        assert_eq!(
            parse(b"POST / HTTP/1.1\r\nContent-Length: -1\r\n\r\n").err(),
            Some(HttpError::Bad("content-length"))
        );
        assert_eq!(
            parse(b"POST / HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n").err(),
            Some(HttpError::Bad("transfer-encoding"))
        );
    }

    #[test]
    fn bounds_head_and_body() {
        let limits = ServerLimits {
            max_head_bytes: 64,
            max_body_bytes: 4,
            ..ServerLimits::default()
        };
        let long = format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(100));
        assert_eq!(
            read_request(&mut BufReader::new(long.as_bytes()), &limits).err(),
            Some(HttpError::HeadTooLarge)
        );
        assert_eq!(
            read_request(
                &mut BufReader::new(&b"POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\nabcde"[..]),
                &limits
            )
            .err(),
            Some(HttpError::BodyTooLarge)
        );
        assert_eq!(
            read_request(
                &mut BufReader::new(&b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nabcde\r\n0\r\n\r\n"[..]),
                &limits
            )
            .err(),
            Some(HttpError::BodyTooLarge)
        );
    }

    #[test]
    fn writes_framed_responses() {
        let mut out = Vec::new();
        write_response(&mut out, &HttpResponse::text(200, "hi"), false)
            .unwrap_or_else(|e| unreachable!("{e}"));
        let s = String::from_utf8(out).unwrap_or_default();
        assert!(s.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(s.contains("Content-Length: 2\r\n"));
        assert!(s.ends_with("Connection: close\r\n\r\nhi"));
    }
}

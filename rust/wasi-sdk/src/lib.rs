//! Flagship WASI SDK, guest side (`docs/wasi-apps.md`).
//!
//! An `http-proxy` app is a WASI preview 1 command that the box runs once
//! per request: [`Request::from_env`] reads the request the box handed over
//! (CGI/1.1 variables and the body on stdin), and [`Response::send`] writes
//! the answer to stdout. Data lives in `/data` (`FLAGSHIP_FILES_DIR`) when the
//! manifest asks for `data.stores.files`.
//!
//! The app has no sockets. [`host`] wraps the `flagship_v1` calls the box
//! makes for it, each available only when the manifest declares the
//! capability: `http_fetch` needs `network.egress` (and the owner's
//! approval of the host), `db_query` needs `data.stores.postgres`. A module
//! that imports a call its manifest does not declare is refused at install.

use std::io::{Read, Write};

/// Who is asking, as the box's app proxy said (never what the client sent).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Visitor {
    /// `member`, `api` or `anonymous`.
    pub kind: String,
    /// A per-app stable id; absent for anonymous visitors.
    pub user: Option<String>,
    /// `member`, `manager` or `master`; absent for anonymous visitors.
    pub role: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: String,
    /// Lowercase names, dashes (from the `HTTP_*` variables).
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

fn var(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

impl Request {
    /// The request the box handed this run.
    pub fn from_env() -> Self {
        let len: usize = var("CONTENT_LENGTH").parse().unwrap_or(0);
        let mut body = Vec::with_capacity(len.min(1 << 20));
        let _ = std::io::stdin().take(len as u64).read_to_end(&mut body);
        let mut headers = Vec::new();
        for (k, v) in std::env::vars() {
            if let Some(h) = k.strip_prefix("HTTP_") {
                headers.push((h.to_ascii_lowercase().replace('_', "-"), v));
            }
        }
        if let Ok(ct) = std::env::var("CONTENT_TYPE") {
            headers.push(("content-type".into(), ct));
        }
        Self {
            method: var("REQUEST_METHOD"),
            path: var("PATH_INFO"),
            query: var("QUERY_STRING"),
            headers,
            body,
        }
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.as_str())
    }

    /// A query parameter, percent-decoded.
    pub fn query_param(&self, key: &str) -> Option<String> {
        self.query.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(k) == key).then(|| percent_decode(v))
        })
    }

    pub fn visitor(&self) -> Visitor {
        Visitor {
            kind: self
                .header("x-flagship-visitor")
                .unwrap_or("anonymous")
                .to_owned(),
            user: self.header("x-flagship-user").map(str::to_owned),
            role: self.header("x-flagship-role").map(str::to_owned),
        }
    }
}

pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                let hex = std::str::from_utf8(&b[i + 1..i + 3])
                    .ok()
                    .and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(v) => {
                        out.push(v);
                        i += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Clone, Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn new(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    pub fn text(status: u16, body: impl Into<String>) -> Self {
        Self::new(status)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(body.into().into_bytes())
    }

    pub fn json(status: u16, body: impl Into<String>) -> Self {
        Self::new(status)
            .header("Content-Type", "application/json")
            .body(body.into().into_bytes())
    }

    pub fn redirect(location: &str) -> Self {
        Self::new(303).header("Location", location)
    }

    pub fn header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.to_owned(), v.to_owned()));
        self
    }

    pub fn body(mut self, b: Vec<u8>) -> Self {
        self.body = b;
        self
    }

    /// Write the CGI answer to stdout.
    pub fn send(self) {
        let mut out = format!("Status: {}\r\n", self.status).into_bytes();
        for (k, v) in &self.headers {
            out.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
        }
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(&self.body);
        let mut stdout = std::io::stdout().lock();
        let _ = stdout.write_all(&out);
        let _ = stdout.flush();
    }
}

/// A JSON string literal for `s`.
pub fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The `flagship_v1` host calls.
pub mod host {
    /// Status codes the box returns (`flagship_wasi::status` on the host).
    pub mod status {
        pub const OK: i32 = 0;
        pub const DENIED: i32 = 1;
        pub const BAD_REQUEST: i32 = 2;
        pub const FAILED: i32 = 3;
        pub const TIMEOUT: i32 = 4;
    }

    #[link(wasm_import_module = "flagship_v1")]
    unsafe extern "C" {
        #[link_name = "http_fetch"]
        fn raw_http_fetch(
            req: *const u8,
            req_len: usize,
            out: *mut u8,
            out_cap: usize,
            out_len: *mut u32,
        ) -> i32;
        #[link_name = "db_query"]
        fn raw_db_query(
            req: *const u8,
            req_len: usize,
            out: *mut u8,
            out_cap: usize,
            out_len: *mut u32,
        ) -> i32;
        #[link_name = "last_response"]
        fn raw_last_response(out: *mut u8, out_cap: usize, out_len: *mut u32) -> i32;
    }

    /// A refused or failed host call: the box's status and its sentence.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct HostError {
        pub status: i32,
        /// The box's JSON answer (`{"error": "..."}`).
        pub body: String,
    }

    type Raw = unsafe extern "C" fn(*const u8, usize, *mut u8, usize, *mut u32) -> i32;

    fn call(f: Raw, req: &str) -> Result<String, HostError> {
        let mut buf = vec![0u8; 64 * 1024];
        let mut len: u32 = 0;
        // SAFETY: the pointers and lengths describe live buffers owned here;
        // the host writes at most `buf.len()` bytes and one u32.
        let code = unsafe {
            f(
                req.as_ptr(),
                req.len(),
                buf.as_mut_ptr(),
                buf.len(),
                &mut len,
            )
        };
        let full = len as usize;
        if full > buf.len() {
            buf = vec![0u8; full];
            // SAFETY: as above, with a buffer of the announced length.
            let again = unsafe { raw_last_response(buf.as_mut_ptr(), buf.len(), &mut len) };
            if again != status::OK {
                return Err(HostError {
                    status: again,
                    body: String::new(),
                });
            }
        }
        buf.truncate(full);
        let body = String::from_utf8_lossy(&buf).into_owned();
        if code == status::OK {
            Ok(body)
        } else {
            Err(HostError { status: code, body })
        }
    }

    /// An HTTP request the box makes for the app. `url`'s host must be in
    /// the manifest's `network.egress` and approved by the owner. Answers
    /// `{"status":200,"headers":{...},"body":"..."}`.
    pub fn http_fetch(method: &str, url: &str, body: Option<&str>) -> Result<String, HostError> {
        let req = format!(
            r#"{{"method":{},"url":{}{}}}"#,
            crate::json_string(method),
            crate::json_string(url),
            body.map(|b| format!(r#","body":{}"#, crate::json_string(b)))
                .unwrap_or_default()
        );
        call(raw_http_fetch, &req)
    }

    /// One SQL statement on the app's own database, run by the box as the
    /// app's role, with `$1..$n` bound to `params`. Answers
    /// `{"rows":[{...}],"rowCount":n}`.
    pub fn db_query(sql: &str, params: &[&str]) -> Result<String, HostError> {
        let ps: Vec<String> = params.iter().map(|p| crate::json_string(p)).collect();
        let req = format!(
            r#"{{"sql":{},"params":[{}]}}"#,
            crate::json_string(sql),
            ps.join(",")
        );
        call(raw_db_query, &req)
    }
}

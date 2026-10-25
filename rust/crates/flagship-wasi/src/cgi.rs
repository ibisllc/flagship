//! The `http-proxy` world for WASI preview 1 core modules: the Flagship CGI
//! profile (`flagship/wasi-http/v1`, `docs/wasi-apps.md`).
//!
//! Preview 1 has no sockets and no HTTP interface, so one request is one run:
//! the request line and headers arrive as CGI/1.1 variables (RFC 3875), the
//! body on stdin, and the guest writes a CGI response (header lines, a blank
//! line, the body) to stdout. Identity headers the box's app proxy set
//! (`X-Flagship-Visitor`, `X-Flagship-User`, ...) arrive as
//! `HTTP_X_FLAGSHIP_*` like any other header; the proxy has already removed
//! any a client sent.

/// One parsed HTTP/1.1 request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    /// The request target as sent: an origin-form path with its query.
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpRequest {
    /// The first header named `name` (case-insensitive).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// A short plain-text answer from the worker itself.
    pub fn text(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![(
                "Content-Type".to_owned(),
                "text/plain; charset=utf-8".to_owned(),
            )],
            body: body.as_bytes().to_vec(),
        }
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum CgiError {
    #[error("the app's answer has no header section")]
    NoHeaders,
    #[error("the app's answer has a bad header line: {0}")]
    BadHeader(String),
    #[error("the app's answer has a bad Status line")]
    BadStatus,
    #[error("the app's answer has too many or too long headers")]
    TooLarge,
}

const MAX_RESPONSE_HEADER_BYTES: usize = 16 * 1024;
const MAX_RESPONSE_HEADERS: usize = 64;
const MAX_ENV_HEADERS: usize = 100;

/// Hop-by-hop and framing headers: never passed to the app as variables, and
/// never taken from its answer (the worker frames the response itself).
fn hop_by_hop(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(
        n.as_str(),
        "connection"
            | "keep-alive"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "content-length"
            | "proxy-connection"
            | "proxy-authenticate"
            | "proxy-authorization"
    )
}

pub(crate) fn is_token(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

pub(crate) fn clean_value(v: &str) -> bool {
    v.bytes().all(|b| b == b'\t' || (b >= 0x20 && b != 0x7f))
}

/// The CGI/1.1 variables for `req`. `Proxy` is dropped (httpoxy), so is any
/// header whose name is not alphanumerics and dashes.
pub fn cgi_env(req: &HttpRequest) -> Vec<(String, String)> {
    let (path, query) = req
        .target
        .split_once('?')
        .unwrap_or((req.target.as_str(), ""));
    let mut env = vec![
        ("GATEWAY_INTERFACE".to_owned(), "CGI/1.1".to_owned()),
        ("SERVER_PROTOCOL".to_owned(), "HTTP/1.1".to_owned()),
        ("SERVER_SOFTWARE".to_owned(), "flagship-wasi".to_owned()),
        ("REQUEST_METHOD".to_owned(), req.method.clone()),
        ("REQUEST_URI".to_owned(), req.target.clone()),
        ("SCRIPT_NAME".to_owned(), String::new()),
        ("PATH_INFO".to_owned(), path.to_owned()),
        ("QUERY_STRING".to_owned(), query.to_owned()),
        ("CONTENT_LENGTH".to_owned(), req.body.len().to_string()),
    ];
    if let Some(ct) = req.header("content-type") {
        env.push(("CONTENT_TYPE".to_owned(), ct.to_owned()));
    }
    let mut seen: Vec<(String, String)> = Vec::new();
    for (k, v) in &req.headers {
        if hop_by_hop(k)
            || k.eq_ignore_ascii_case("content-type")
            || k.eq_ignore_ascii_case("proxy")
            || !k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || !clean_value(v)
        {
            continue;
        }
        let var = format!("HTTP_{}", k.to_ascii_uppercase().replace('-', "_"));
        if let Some((_, existing)) = seen.iter_mut().find(|(name, _)| *name == var) {
            existing.push_str(if var == "HTTP_COOKIE" { "; " } else { ", " });
            existing.push_str(v);
        } else if seen.len() < MAX_ENV_HEADERS {
            seen.push((var, v.clone()));
        }
    }
    env.extend(seen);
    env
}

/// Turn the guest's stdout into a response.
pub fn parse_cgi_output(stdout: &[u8]) -> Result<HttpResponse, CgiError> {
    let (head, body) = split_head(stdout).ok_or(CgiError::NoHeaders)?;
    if head.len() > MAX_RESPONSE_HEADER_BYTES {
        return Err(CgiError::TooLarge);
    }
    let head = std::str::from_utf8(head).map_err(|_| CgiError::BadHeader("not UTF-8".into()))?;
    let mut status: Option<u16> = None;
    let mut location = false;
    let mut headers = Vec::new();
    for line in head.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| CgiError::BadHeader(short(line)))?;
        let value = value.trim_matches([' ', '\t']);
        if !is_token(name) || !clean_value(value) {
            return Err(CgiError::BadHeader(short(line)));
        }
        if name.eq_ignore_ascii_case("status") {
            let code = value.split(' ').next().unwrap_or("");
            let code: u16 = code.parse().map_err(|_| CgiError::BadStatus)?;
            if !(200..=599).contains(&code) || status.is_some() {
                return Err(CgiError::BadStatus);
            }
            status = Some(code);
            continue;
        }
        if hop_by_hop(name) {
            continue;
        }
        if name.eq_ignore_ascii_case("location") {
            location = true;
        }
        if headers.len() >= MAX_RESPONSE_HEADERS {
            return Err(CgiError::TooLarge);
        }
        headers.push((name.to_owned(), value.to_owned()));
    }
    let status = status.unwrap_or(if location { 302 } else { 200 });
    Ok(HttpResponse {
        status,
        headers,
        body: body.to_vec(),
    })
}

fn split_head(out: &[u8]) -> Option<(&[u8], &[u8])> {
    let crlf = find(out, b"\r\n\r\n").map(|i| (i, 4usize));
    let lf = find(out, b"\n\n").map(|i| (i, 2usize));
    let (at, sep) = match (crlf, lf) {
        (Some(a), Some(b)) => {
            if a.0 <= b.0 {
                a
            } else {
                b
            }
        }
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => return None,
    };
    let head = out.get(..at)?;
    let body = out.get(at.checked_add(sep)?..)?;
    Some((head, body))
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn short(s: &str) -> String {
    s.chars().take(60).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(target: &str, headers: &[(&str, &str)]) -> HttpRequest {
        HttpRequest {
            method: "GET".into(),
            target: target.into(),
            headers: headers
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
            body: vec![],
        }
    }

    fn get<'a>(env: &'a [(String, String)], k: &str) -> Option<&'a str> {
        env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }

    #[test]
    fn request_becomes_cgi_variables() {
        let env = cgi_env(&req(
            "/notes/1?x=2",
            &[
                ("Host", "notes.example"),
                ("X-Flagship-Visitor", "member"),
                ("Cookie", "a=1"),
                ("cookie", "b=2"),
                ("Proxy", "http://evil"),
                ("Connection", "close"),
                ("Bad_Name", "x"),
                ("X-Ctl", "a\u{1}b"),
            ],
        ));
        assert_eq!(get(&env, "PATH_INFO"), Some("/notes/1"));
        assert_eq!(get(&env, "QUERY_STRING"), Some("x=2"));
        assert_eq!(get(&env, "HTTP_X_FLAGSHIP_VISITOR"), Some("member"));
        assert_eq!(get(&env, "HTTP_COOKIE"), Some("a=1; b=2"));
        assert_eq!(get(&env, "HTTP_PROXY"), None);
        assert_eq!(get(&env, "HTTP_CONNECTION"), None);
        assert_eq!(get(&env, "HTTP_BAD_NAME"), None);
        assert_eq!(get(&env, "HTTP_X_CTL"), None);
    }

    #[test]
    fn cgi_answer_becomes_a_response() {
        let r = parse_cgi_output(
            b"Status: 201 Created\r\nContent-Type: text/plain\r\nContent-Length: 99\r\n\r\nhi",
        )
        .unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!(r.status, 201);
        assert_eq!(r.body, b"hi");
        assert_eq!(
            r.headers,
            vec![("Content-Type".to_owned(), "text/plain".to_owned())]
        );
        let r = parse_cgi_output(b"Location: /x\n\n").unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!(r.status, 302);
        assert_eq!(parse_cgi_output(b"no blank line"), Err(CgiError::NoHeaders));
        assert_eq!(
            parse_cgi_output(b"Status: 99\n\n"),
            Err(CgiError::BadStatus)
        );
        assert!(matches!(
            parse_cgi_output(b"X: a\rb\n\n"),
            Err(CgiError::BadHeader(_))
        ));
        assert!(matches!(
            parse_cgi_output(b"Bad Name: a\n\n"),
            Err(CgiError::BadHeader(_))
        ));
        let many: String = (0..70).map(|i| format!("X-{i}: v\n")).collect::<String>() + "\n";
        assert_eq!(parse_cgi_output(many.as_bytes()), Err(CgiError::TooLarge));
    }
}

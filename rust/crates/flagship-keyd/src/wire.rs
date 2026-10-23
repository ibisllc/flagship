//! Wire protocol v1, byte-compatible with `packages/keyd/src/wire.ts`.
//!
//! A frame is a 4-byte big-endian length then that many bytes of UTF-8 JSON. Argument checks
//! mirror the TS helpers exactly, including JavaScript's UTF-16 string lengths and whitespace
//! class, because the error a caller sees must not depend on which backend answered.

use serde_json::{Map, Value};

pub const KEYD_PROTOCOL_VERSION: u64 = 1;
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

pub const OPS: &[&str] = &[
    "hello",
    "status",
    "sign",
    "unseal",
    "swk.hkdf",
    "swk.seal",
    "swk.open",
    "swk.encryptChunk",
    "swk.decryptChunk",
    "swk.deriveServiceSecret",
    "swk.deriveTlsKey",
    "swk.deriveBackupManifestKey",
    "cgk.seal",
    "cgk.open",
    "cgk.deriveAppCopyEnvKey",
    "tls.createKey",
    "tls.csr",
    "tls.install",
    "tls.activate",
    "tls.active",
    "tls.sign",
    "tls.list",
    "tls.remove",
    "acme.create",
    "acme.importGranted",
    "acme.jwk",
    "acme.sign",
    "provision.swk",
    "provision.cgk",
];

pub type Args = Map<String, Value>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    BadFrame,
    BadRequest,
    UnknownOp,
    UnsupportedVersion,
    NotHello,
    Forbidden,
    RateLimited,
    NotProvisioned,
    Failed,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BadFrame => "bad-frame",
            Self::BadRequest => "bad-request",
            Self::UnknownOp => "unknown-op",
            Self::UnsupportedVersion => "unsupported-version",
            Self::NotHello => "not-hello",
            Self::Forbidden => "forbidden",
            Self::RateLimited => "rate-limited",
            Self::NotProvisioned => "not-provisioned",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeydError {
    pub code: ErrorCode,
    pub message: String,
}

impl KeydError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::BadRequest, message)
    }
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Forbidden, message)
    }
    pub fn failed(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Failed, message)
    }
    pub fn not_provisioned(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotProvisioned, message)
    }
}

impl std::fmt::Display for KeydError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for KeydError {}

pub type KeydResult<T> = Result<T, KeydError>;

/// Encode one frame. Refuses a body over the cap, like `encodeFrame`.
pub fn encode_frame(value: &Value) -> KeydResult<Vec<u8>> {
    let body = serde_json::to_vec(value)
        .map_err(|_| KeydError::new(ErrorCode::BadFrame, "frame is not JSON"))?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(KeydError::new(ErrorCode::BadFrame, "frame too large"));
    }
    let len = u32::try_from(body.len())
        .map_err(|_| KeydError::new(ErrorCode::BadFrame, "frame too large"))?;
    let mut out = Vec::with_capacity(body.len().saturating_add(4));
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// The length a frame header announces, refused before any body byte is buffered.
pub fn frame_len(header: [u8; 4]) -> KeydResult<usize> {
    let len = usize::try_from(u32::from_be_bytes(header))
        .map_err(|_| KeydError::new(ErrorCode::BadFrame, "frame length out of range"))?;
    if len == 0 || len > MAX_FRAME_BYTES {
        return Err(KeydError::new(
            ErrorCode::BadFrame,
            "frame length out of range",
        ));
    }
    Ok(len)
}

/// Parse a frame body. Invalid UTF-8 is replaced, as Node's `Buffer.toString("utf8")` does.
pub fn parse_frame_body(body: &[u8]) -> KeydResult<Value> {
    let text = String::from_utf8_lossy(body);
    serde_json::from_str(&text)
        .map_err(|_| KeydError::new(ErrorCode::BadFrame, "frame is not JSON"))
}

/// String length as JavaScript counts it (UTF-16 code units).
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JavaScript's `\s` class.
pub fn js_is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// The order `Object.keys` returns: array-index keys ascending, then the rest as inserted.
pub fn js_key_order(map: &Args) -> Vec<&str> {
    let mut indices: Vec<(u32, &str)> = Vec::new();
    let mut rest: Vec<&str> = Vec::new();
    for k in map.keys() {
        match array_index(k) {
            Some(i) => indices.push((i, k.as_str())),
            None => rest.push(k.as_str()),
        }
    }
    indices.sort_by_key(|(i, _)| *i);
    indices.into_iter().map(|(_, k)| k).chain(rest).collect()
}

fn array_index(k: &str) -> Option<u32> {
    if k.is_empty() || (k.len() > 1 && k.starts_with('0')) || !k.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let v: u32 = k.parse().ok()?;
    if v == u32::MAX { None } else { Some(v) }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct HexBounds {
    pub min: Option<usize>,
    pub max: Option<usize>,
    pub exact: Option<usize>,
}

impl HexBounds {
    pub const fn any() -> Self {
        Self {
            min: None,
            max: None,
            exact: None,
        }
    }
    pub const fn min(min: usize) -> Self {
        Self {
            min: Some(min),
            max: None,
            exact: None,
        }
    }
    pub const fn max(max: usize) -> Self {
        Self {
            min: None,
            max: Some(max),
            exact: None,
        }
    }
    pub const fn range(min: usize, max: usize) -> Self {
        Self {
            min: Some(min),
            max: Some(max),
            exact: None,
        }
    }
    pub const fn exact(n: usize) -> Self {
        Self {
            min: None,
            max: None,
            exact: Some(n),
        }
    }
}

pub fn hex_arg(args: &Args, name: &str, bounds: HexBounds) -> KeydResult<Vec<u8>> {
    let bad = || KeydError::bad_request(format!("{name} must be lowercase hex"));
    let Some(Value::String(v)) = args.get(name) else {
        return Err(bad());
    };
    let bytes = v.as_bytes();
    if !bytes.len().is_multiple_of(2)
        || !bytes.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(bad());
    }
    let n = bytes.len() / 2;
    if let Some(exact) = bounds.exact
        && n != exact
    {
        return Err(KeydError::bad_request(format!(
            "{name} must be {exact} bytes"
        )));
    }
    if let Some(min) = bounds.min
        && n < min
    {
        return Err(KeydError::bad_request(format!("{name} is too short")));
    }
    if let Some(max) = bounds.max
        && n > max
    {
        return Err(KeydError::bad_request(format!("{name} is too long")));
    }
    decode_hex(v).ok_or_else(bad)
}

pub fn decode_hex(s: &str) -> Option<Vec<u8>> {
    let (pairs, rest) = s.as_bytes().as_chunks::<2>();
    if !rest.is_empty() {
        return None;
    }
    pairs
        .iter()
        .map(|[h, l]| Some(nibble(*h)?.wrapping_shl(4) | nibble(*l)?))
        .collect()
}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c.wrapping_sub(b'0')),
        b'a'..=b'f' => Some(c.wrapping_sub(b'a').wrapping_add(10)),
        _ => None,
    }
}

pub fn to_hex(b: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len().saturating_mul(2));
    for byte in b {
        for n in [byte >> 4, byte & 0x0f] {
            if let Some(d) = DIGITS.get(usize::from(n)) {
                s.push(char::from(*d));
            }
        }
    }
    s
}

pub fn str_arg<'a>(args: &'a Args, name: &str, max: usize) -> KeydResult<&'a str> {
    match args.get(name) {
        Some(Value::String(v))
            if !v.is_empty() && js_len(v) <= max && !v.chars().any(|c| c <= '\u{1f}') =>
        {
            Ok(v)
        }
        _ => Err(KeydError::bad_request(format!(
            "{name} must be a short string"
        ))),
    }
}

pub fn pem_arg<'a>(args: &'a Args, name: &str, max: usize) -> KeydResult<&'a str> {
    match args.get(name) {
        Some(Value::String(v))
            if !v.is_empty()
                && js_len(v) <= max
                && v.chars().all(|c| {
                    c.is_ascii_alphanumeric()
                        || matches!(c, '+' | '/' | '=' | '-')
                        || js_is_space(c)
                }) =>
        {
            Ok(v)
        }
        _ => Err(KeydError::bad_request(format!("{name} must be PEM text"))),
    }
}

pub const PEM_MAX: usize = 64 * 1024;

pub fn no_extra_args(args: &Args, allowed: &[&str]) -> KeydResult<()> {
    for k in js_key_order(args) {
        if !allowed.contains(&k) {
            return Err(KeydError::bad_request(format!("unknown field {k}")));
        }
    }
    Ok(())
}

/// A list of strings (`Array.isArray(x) && x.every(n => typeof n === "string")`).
pub fn string_list(v: Option<&Value>) -> KeydResult<Vec<String>> {
    match v {
        Some(Value::Array(items)) => items
            .iter()
            .map(|n| match n {
                Value::String(s) => Ok(s.clone()),
                _ => Err(KeydError::bad_request("names must be a list of strings")),
            })
            .collect(),
        _ => Err(KeydError::bad_request("names must be a list of strings")),
    }
}

#[derive(Debug, Clone)]
pub struct Request {
    pub id: u64,
    pub op: &'static str,
    pub args: Args,
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn safe_id(v: Option<&Value>) -> Option<u64> {
    let Some(Value::Number(n)) = v else {
        return None;
    };
    if let Some(u) = n.as_u64() {
        return if u <= 9_007_199_254_740_991 {
            Some(u)
        } else {
            None
        };
    }
    if n.is_i64() {
        return None;
    }
    let f = n.as_f64()?;
    // `Number.isSafeInteger(id) && id >= 0`; -0 passes and is sent back as 0.
    if !f.is_finite() || f.fract() != 0.0 || f.abs() > MAX_SAFE_INTEGER || f < 0.0 {
        return None;
    }
    Some(f.abs() as u64)
}

/// `parseRequest`: on failure the response carries id 0.
pub fn parse_request(v: Value) -> KeydResult<Request> {
    let Value::Object(mut r) = v else {
        return Err(KeydError::bad_request("request must be an object"));
    };
    for k in js_key_order(&r) {
        if k != "id" && k != "op" && k != "args" {
            return Err(KeydError::bad_request(format!("unknown field {k}")));
        }
    }
    let id = safe_id(r.get("id")).ok_or_else(|| KeydError::bad_request("bad id"))?;
    let op = match r.get("op") {
        Some(Value::String(s)) => s.clone(),
        _ => return Err(KeydError::bad_request("bad op")),
    };
    let op = OPS
        .iter()
        .copied()
        .find(|o| *o == op)
        .ok_or_else(|| KeydError::new(ErrorCode::UnknownOp, "unknown operation"))?;
    let args = match r.remove("args") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(m)) => m,
        Some(_) => return Err(KeydError::bad_request("args must be an object")),
    };
    Ok(Request { id, op, args })
}

pub fn ok_response(id: u64, result: Args) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), Value::from(id));
    m.insert("ok".into(), Value::Bool(true));
    m.insert("result".into(), Value::Object(result));
    Value::Object(m)
}

pub fn err_response(id: u64, e: &KeydError) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), Value::from(id));
    m.insert("ok".into(), Value::Bool(false));
    m.insert("code".into(), Value::from(e.code.as_str()));
    m.insert("message".into(), Value::from(e.message.as_str()));
    Value::Object(m)
}

/// Build an ordered JSON object (key order matches the TS result literals).
#[macro_export]
macro_rules! obj {
    ($($k:expr => $v:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut m = ::serde_json::Map::new();
        $( m.insert(::std::string::String::from($k), ::serde_json::Value::from($v)); )*
        m
    }};
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use serde_json::json;

    #[test]
    fn frames_round_trip_and_bad_lengths_are_refused() {
        let f = encode_frame(&json!({"a": 1})).unwrap();
        let len = frame_len([f[0], f[1], f[2], f[3]]).unwrap();
        assert_eq!(parse_frame_body(&f[4..4 + len]).unwrap(), json!({"a": 1}));
        assert!(frame_len([0, 0, 0, 0]).is_err());
        let big = u32::try_from(MAX_FRAME_BYTES + 1).unwrap().to_be_bytes();
        assert!(frame_len(big).is_err());
        assert!(frame_len(u32::try_from(MAX_FRAME_BYTES).unwrap().to_be_bytes()).is_ok());
        assert!(parse_frame_body(b"{{{").is_err());
    }

    #[test]
    fn requests_are_parsed_strictly() {
        let r = parse_request(json!({"id": 3, "op": "status"})).unwrap();
        assert_eq!((r.id, r.op, r.args.len()), (3, "status", 0));
        assert_eq!(
            parse_request(json!({"id": 1.0, "op": "status", "args": null}))
                .unwrap()
                .id,
            1
        );
        let code = |v: Value| parse_request(v).unwrap_err();
        assert_eq!(code(json!([])).message, "request must be an object");
        assert_eq!(
            code(json!({"id": 1, "op": "status", "x": 1})).message,
            "unknown field x"
        );
        assert_eq!(code(json!({"id": -1, "op": "status"})).message, "bad id");
        assert_eq!(code(json!({"id": 1.5, "op": "status"})).message, "bad id");
        assert_eq!(
            code(json!({"id": 9_007_199_254_740_992_u64, "op": "status"})).message,
            "bad id"
        );
        assert_eq!(code(json!({"id": "1", "op": "status"})).message, "bad id");
        assert_eq!(code(json!({"id": 1, "op": 7})).message, "bad op");
        assert_eq!(
            code(json!({"id": 1, "op": "exportKey"})).code,
            ErrorCode::UnknownOp
        );
        assert_eq!(
            code(json!({"id": 1, "op": "status", "args": []})).message,
            "args must be an object"
        );
    }

    #[test]
    fn key_order_follows_object_keys() {
        let Value::Object(m) = json!({"zz": 1, "10": 1, "b": 1, "2": 1, "01": 1}) else {
            unreachable!()
        };
        assert_eq!(js_key_order(&m), vec!["2", "10", "zz", "b", "01"]);
    }

    #[test]
    fn argument_helpers_match_the_ts_rules() {
        let Value::Object(a) = json!({"h": "00ff", "H": "00FF", "o": "0", "s": "x", "e": "", "c": "a\u{1}", "u": "\u{1F600}\u{1F600}", "p": "AB+/= \n-\u{3000}", "q": "a*b"})
        else {
            unreachable!()
        };
        assert_eq!(hex_arg(&a, "h", HexBounds::exact(2)).unwrap(), vec![0, 255]);
        assert_eq!(
            hex_arg(&a, "H", HexBounds::any()).unwrap_err().message,
            "H must be lowercase hex"
        );
        assert!(hex_arg(&a, "o", HexBounds::any()).is_err());
        assert_eq!(
            hex_arg(&a, "h", HexBounds::exact(3)).unwrap_err().message,
            "h must be 3 bytes"
        );
        assert_eq!(
            hex_arg(&a, "h", HexBounds::min(3)).unwrap_err().message,
            "h is too short"
        );
        assert_eq!(
            hex_arg(&a, "h", HexBounds::max(1)).unwrap_err().message,
            "h is too long"
        );
        assert_eq!(
            hex_arg(&a, "e", HexBounds::any()).unwrap(),
            Vec::<u8>::new()
        );
        assert!(str_arg(&a, "s", 1).is_ok());
        assert!(str_arg(&a, "e", 1).is_err());
        assert!(str_arg(&a, "c", 9).is_err());
        assert!(
            str_arg(&a, "u", 3).is_err(),
            "two astral chars are four UTF-16 units"
        );
        assert!(str_arg(&a, "u", 4).is_ok());
        assert!(pem_arg(&a, "p", 100).is_ok());
        assert!(pem_arg(&a, "q", 100).is_err());
        assert_eq!(
            no_extra_args(&a, &["h"]).unwrap_err().message,
            "unknown field H"
        );
    }
}

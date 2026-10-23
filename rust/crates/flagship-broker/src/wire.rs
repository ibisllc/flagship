//! flagship-privd wire protocol, version 1, byte-compatible with packages/privd/src/wire.ts:
//! a 4-byte big-endian length (1..=1 MiB) then that many bytes of UTF-8 JSON.

use serde::Serialize;
use serde_json::{Map, Number, Value};
use std::fmt;

pub const PRIVD_PROTOCOL_VERSION: u64 = 1;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const OPS: &[&str] = &["hello", "power", "systemd.restart", "docker", "nft.apply"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ErrorCode {
    #[serde(rename = "bad-frame")]
    BadFrame,
    #[serde(rename = "bad-request")]
    BadRequest,
    #[serde(rename = "unknown-op")]
    UnknownOp,
    #[serde(rename = "not-hello")]
    NotHello,
    #[serde(rename = "unsupported-version")]
    UnsupportedVersion,
    #[serde(rename = "forbidden")]
    Forbidden,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "timed-out")]
    TimedOut,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BadFrame => "bad-frame",
            Self::BadRequest => "bad-request",
            Self::UnknownOp => "unknown-op",
            Self::NotHello => "not-hello",
            Self::UnsupportedVersion => "unsupported-version",
            Self::Forbidden => "forbidden",
            Self::Failed => "failed",
            Self::TimedOut => "timed-out",
        }
    }
}

/// `PrivdError`: a code and the exact message the TS broker sends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivdError {
    pub code: ErrorCode,
    pub message: String,
}

impl PrivdError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for PrivdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for PrivdError {}

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub id: u64,
    pub op: &'static str,
    pub args: Map<String, Value>,
}

/// A success body, in the key order `JSON.stringify` writes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum ResultBody {
    Exec { stdout: String, stderr: String },
    Hello { version: u64 },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Response {
    Ok {
        id: Number,
        ok: bool,
        result: ResultBody,
    },
    Err {
        id: Number,
        ok: bool,
        code: ErrorCode,
        message: String,
    },
}

impl Response {
    pub fn ok(id: u64, result: ResultBody) -> Self {
        Self::Ok {
            id: Number::from(id),
            ok: true,
            result,
        }
    }
    pub fn err(id: Number, e: PrivdError) -> Self {
        Self::Err {
            id,
            ok: false,
            code: e.code,
            message: e.message,
        }
    }
}

/// `encodeFrame`.
pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, PrivdError> {
    let body = serde_json::to_vec(value)
        .map_err(|_| PrivdError::new(ErrorCode::BadFrame, "frame is not JSON"))?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(PrivdError::new(ErrorCode::BadFrame, "frame too large"));
    }
    let len = u32::try_from(body.len())
        .map_err(|_| PrivdError::new(ErrorCode::BadFrame, "frame too large"))?;
    let mut out = Vec::with_capacity(body.len().saturating_add(4));
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// `FrameReader`: buffers bytes and yields complete JSON frames.
#[derive(Debug, Default)]
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, PrivdError> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(head) = self.buf.get(..4) {
            let mut len_bytes = [0u8; 4];
            len_bytes.copy_from_slice(head);
            let len = usize::try_from(u32::from_be_bytes(len_bytes)).unwrap_or(usize::MAX);
            if len == 0 || len > MAX_FRAME_BYTES {
                return Err(PrivdError::new(
                    ErrorCode::BadFrame,
                    "frame length out of range",
                ));
            }
            let end = len.saturating_add(4);
            let Some(body) = self.buf.get(4..end) else {
                break;
            };
            let parsed = std::str::from_utf8(body)
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(t).ok());
            self.buf.drain(..end);
            match parsed {
                Some(v) => out.push(v),
                None => return Err(PrivdError::new(ErrorCode::BadFrame, "frame is not JSON")),
            }
        }
        Ok(out)
    }

    pub fn buffered(&self) -> usize {
        self.buf.len()
    }
}

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// `Number.isSafeInteger(id) && id >= 0`, as a JSON number.
fn safe_id(v: &Value) -> Option<u64> {
    let n = v.as_number()?;
    if let Some(u) = n.as_u64() {
        return (u <= MAX_SAFE_INTEGER).then_some(u);
    }
    // 3.0 is an integer to JavaScript.
    let f = n.as_f64()?;
    let whole = f.is_finite() && f.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER as f64).contains(&f);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    whole.then_some(f as u64)
}

/// `typeof raw.id === "number" ? raw.id : 0`, echoed in a refusal.
pub fn echo_id(raw: &Value) -> Number {
    raw.get("id")
        .and_then(Value::as_number)
        .cloned()
        .unwrap_or_else(|| Number::from(0u8))
}

/// `parseRequest`.
pub fn parse_request(v: &Value) -> Result<Request, PrivdError> {
    let Value::Object(r) = v else {
        return Err(PrivdError::new(
            ErrorCode::BadRequest,
            "request must be an object",
        ));
    };
    for k in r.keys() {
        if k != "id" && k != "op" && k != "args" {
            return Err(PrivdError::new(
                ErrorCode::BadRequest,
                format!("unknown field {k}"),
            ));
        }
    }
    let id = r
        .get("id")
        .and_then(safe_id)
        .ok_or_else(|| PrivdError::new(ErrorCode::BadRequest, "bad id"))?;
    let op = r
        .get("op")
        .and_then(Value::as_str)
        .and_then(|s| OPS.iter().find(|o| **o == s).copied())
        .ok_or_else(|| PrivdError::new(ErrorCode::UnknownOp, "unknown operation"))?;
    let args = match r.get("args") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(m)) => m.clone(),
        Some(_) => {
            return Err(PrivdError::new(
                ErrorCode::BadRequest,
                "args must be an object",
            ));
        }
    };
    Ok(Request { id, op, args })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frames_are_byte_compatible() {
        let f = encode_frame(&Response::ok(
            1,
            ResultBody::Exec {
                stdout: "done".into(),
                stderr: String::new(),
            },
        ))
        .unwrap_or_default();
        let body = br#"{"id":1,"ok":true,"result":{"stdout":"done","stderr":""}}"#;
        assert_eq!(
            f.get(..4),
            Some(&u32::try_from(body.len()).unwrap_or(0).to_be_bytes()[..])
        );
        assert_eq!(f.get(4..), Some(&body[..]));
        let e = encode_frame(&Response::err(
            Number::from(2u8),
            PrivdError::new(ErrorCode::NotHello, "say hello first"),
        ))
        .unwrap_or_default();
        assert_eq!(
            e.get(4..),
            Some(&br#"{"id":2,"ok":false,"code":"not-hello","message":"say hello first"}"#[..])
        );
    }

    #[test]
    fn reader_splits_and_refuses() {
        let mut r = FrameReader::default();
        let a = encode_frame(&json!({"id":1})).unwrap_or_default();
        let b = encode_frame(&json!({"id":2})).unwrap_or_default();
        let mut all = a.clone();
        all.extend_from_slice(&b);
        let (x, y) = all.split_at(5);
        assert_eq!(r.push(x).map(|v| v.len()), Ok(0));
        assert_eq!(r.push(y).map(|v| v.len()), Ok(2));
        assert!(FrameReader::default().push(&[0, 0, 0, 0]).is_err());
        assert!(FrameReader::default().push(&[0, 0x10, 0, 1]).is_err());
        assert!(FrameReader::default().push(&[0, 0, 0, 1, b'{']).is_err());
    }

    #[test]
    fn requests_parse_like_privd() {
        let ok = parse_request(&json!({"id": 3, "op": "power", "args": {"action": "reboot"}}));
        assert!(matches!(
            ok,
            Ok(Request {
                id: 3,
                op: "power",
                ..
            })
        ));
        assert!(parse_request(&json!({"id": 3.0, "op": "hello"})).is_ok());
        assert!(parse_request(&json!({"id": 3, "op": "hello", "args": null})).is_ok());
        let code = |v: serde_json::Value| parse_request(&v).err().map(|e| (e.code, e.message));
        assert_eq!(
            code(json!([])),
            Some((ErrorCode::BadRequest, "request must be an object".into()))
        );
        assert_eq!(
            code(json!({"id": 1, "op": "hello", "x": 1})),
            Some((ErrorCode::BadRequest, "unknown field x".into()))
        );
        assert_eq!(
            code(json!({"id": -1, "op": "hello"})),
            Some((ErrorCode::BadRequest, "bad id".into()))
        );
        assert_eq!(
            code(json!({"id": 1.5, "op": "hello"})),
            Some((ErrorCode::BadRequest, "bad id".into()))
        );
        assert_eq!(
            code(json!({"id": 9007199254740992u64, "op": "hello"})),
            Some((ErrorCode::BadRequest, "bad id".into()))
        );
        assert_eq!(
            code(json!({"id": 1, "op": "shell"})),
            Some((ErrorCode::UnknownOp, "unknown operation".into()))
        );
        assert_eq!(
            code(json!({"id": 1, "op": "power", "args": []})),
            Some((ErrorCode::BadRequest, "args must be an object".into()))
        );
        assert_eq!(echo_id(&json!({"id": 1.5})).to_string(), "1.5");
        assert_eq!(echo_id(&json!({"id": "x"})).to_string(), "0");
    }
}

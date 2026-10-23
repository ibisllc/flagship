//! flagship-keyd wire protocol, version 1 (`packages/keyd/src/wire.ts`): each request and
//! each response is one frame, a 4-byte big-endian length then that many bytes of UTF-8
//! JSON. A length of zero or above [`MAX_FRAME_BYTES`] ends the connection before anything
//! is buffered; there is no resynchronisation.

use std::fmt;
use std::io::{self, Read, Write};

pub const PROTOCOL_VERSION: u64 = 1;
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug)]
pub enum WireError {
    Io(io::Error),
    /// The peer announced a frame of zero bytes or above the cap.
    FrameOutOfRange(u64),
    NotJson,
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "keyd socket: {e}"),
            Self::FrameOutOfRange(n) => write!(f, "keyd frame length {n} out of range"),
            Self::NotJson => f.write_str("keyd frame is not JSON"),
        }
    }
}

impl std::error::Error for WireError {}

impl From<io::Error> for WireError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// Length-prefix `body`, refusing a body keyd would refuse.
pub fn encode_frame(body: &[u8]) -> Result<Vec<u8>, WireError> {
    let len =
        u32::try_from(body.len()).map_err(|_| WireError::FrameOutOfRange(body.len() as u64))?;
    if body.is_empty() || body.len() > MAX_FRAME_BYTES {
        return Err(WireError::FrameOutOfRange(u64::from(len)));
    }
    let mut out = Vec::with_capacity(body.len().saturating_add(4));
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(body);
    Ok(out)
}

pub fn write_frame<W: Write>(w: &mut W, value: &serde_json::Value) -> Result<(), WireError> {
    let body = serde_json::to_vec(value).map_err(|_| WireError::NotJson)?;
    w.write_all(&encode_frame(&body)?)?;
    w.flush()?;
    Ok(())
}

/// Read one frame; the length is checked before the body is allocated.
pub fn read_frame<R: Read>(r: &mut R) -> Result<serde_json::Value, WireError> {
    let mut hdr = [0u8; 4];
    r.read_exact(&mut hdr)?;
    let len = u32::from_be_bytes(hdr);
    let n = usize::try_from(len).map_err(|_| WireError::FrameOutOfRange(u64::from(len)))?;
    if n == 0 || n > MAX_FRAME_BYTES {
        return Err(WireError::FrameOutOfRange(u64::from(len)));
    }
    let mut body = vec![0u8; n];
    r.read_exact(&mut body)?;
    serde_json::from_slice(&body).map_err(|_| WireError::NotJson)
}

pub fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len().saturating_mul(2));
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Lowercase hex only, as keyd sends it.
pub fn from_hex(s: &str) -> Option<Vec<u8>> {
    fn nibble(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => c.checked_sub(b'0'),
            b'a'..=b'f' => c.checked_sub(b'a').and_then(|v| v.checked_add(10)),
            _ => None,
        }
    }
    let raw = s.as_bytes();
    if !raw.len().is_multiple_of(2) {
        return None;
    }
    raw.as_chunks::<2>()
        .0
        .iter()
        .map(|[hi, lo]| Some((nibble(*hi)? << 4) | nibble(*lo)?))
        .collect()
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let v = serde_json::json!({"id": 1, "op": "hello", "args": {"v": 1}});
        let mut buf = Vec::new();
        write_frame(&mut buf, &v).unwrap();
        let got = read_frame(&mut buf.as_slice()).unwrap();
        assert_eq!(got, v);
    }

    #[test]
    fn refuses_oversize_and_empty_frames_before_buffering() {
        let mut big = Vec::new();
        big.extend_from_slice(&u32::try_from(MAX_FRAME_BYTES + 1).unwrap().to_be_bytes());
        assert!(matches!(
            read_frame(&mut big.as_slice()),
            Err(WireError::FrameOutOfRange(_))
        ));
        let zero = [0u8; 4];
        assert!(matches!(
            read_frame(&mut zero.as_slice()),
            Err(WireError::FrameOutOfRange(0))
        ));
        let huge = vec![b' '; MAX_FRAME_BYTES + 1];
        assert!(matches!(
            encode_frame(&huge),
            Err(WireError::FrameOutOfRange(_))
        ));
        assert!(matches!(
            encode_frame(b""),
            Err(WireError::FrameOutOfRange(0))
        ));
    }

    #[test]
    fn hex_is_lowercase_only() {
        assert_eq!(to_hex(&[0x00, 0xab, 0xff]), "00abff");
        assert_eq!(from_hex("00abff"), Some(vec![0x00, 0xab, 0xff]));
        assert_eq!(from_hex("00ABFF"), None);
        assert_eq!(from_hex("abc"), None);
    }
}

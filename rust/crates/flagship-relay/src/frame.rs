//! Tunnel frame protocol v1, byte-compatible with `packages/tunnel-protocol/src/frames.ts`.
//!
//! ```text
//! u32 BE streamId | u8 type | u32 BE payloadLen | payload
//! ```

use std::fmt;

pub const FRAME_OPEN: u8 = 0x01;
pub const FRAME_DATA: u8 = 0x02;
pub const FRAME_CLOSE: u8 = 0x03;
pub const FRAME_CLOSE_REMOTE: u8 = 0x04;
/// Defined in `frames.ts` but absent from its decoder's type set: every v1 peer rejects it as
/// an unknown type and closes the tunnel. Only sent to a peer that negotiated `drain-v1`.
pub const FRAME_DRAIN_NOTICE: u8 = 0x05;
/// Per-stream credit for hub-opened streams (`stream-credit-v1`); not a v1 frame.
pub const FRAME_STREAM_CREDIT: u8 = 0x06;
pub const FRAME_HELLO: u8 = 0x10;
pub const FRAME_HELLO_ACK: u8 = 0x11;
pub const FRAME_DOMAIN_GRANTED: u8 = 0x12;
pub const FRAME_REQUEST_TRANSFER: u8 = 0x13;
pub const FRAME_PB_PUT: u8 = 0x20;
pub const FRAME_PB_PUT_ACK: u8 = 0x21;
pub const FRAME_PB_GET: u8 = 0x22;
pub const FRAME_PB_GET_DATA: u8 = 0x23;
pub const FRAME_PB_GET_END: u8 = 0x24;
pub const FRAME_PB_CHALLENGE: u8 = 0x30;
pub const FRAME_PB_RESPONSE: u8 = 0x31;
pub const FRAME_OUTBOUND_OPEN: u8 = 0x40;
pub const FRAME_OUTBOUND_RESULT: u8 = 0x41;
pub const FRAME_OUTBOUND_CREDIT: u8 = 0x42;
pub const FRAME_PB_MAIL_REQ: u8 = 0x50;
pub const FRAME_PB_MAIL_RESP: u8 = 0x51;
pub const FRAME_PB_MAILBOX_ANNOUNCE: u8 = 0x52;

pub const FRAME_HEADER_BYTES: usize = 9;
pub const MAX_FRAME_PAYLOAD: usize = 1 << 20;

/// The types a v1 decoder (`isFrameType` in `frames.ts`) accepts. 0x05 is deliberately absent.
const V1_TYPES: [u8; 21] = [
    FRAME_HELLO,
    FRAME_HELLO_ACK,
    FRAME_DOMAIN_GRANTED,
    FRAME_REQUEST_TRANSFER,
    FRAME_OPEN,
    FRAME_DATA,
    FRAME_CLOSE,
    FRAME_CLOSE_REMOTE,
    FRAME_PB_PUT,
    FRAME_PB_PUT_ACK,
    FRAME_PB_GET,
    FRAME_PB_GET_DATA,
    FRAME_PB_GET_END,
    FRAME_PB_CHALLENGE,
    FRAME_PB_RESPONSE,
    FRAME_OUTBOUND_OPEN,
    FRAME_OUTBOUND_RESULT,
    FRAME_OUTBOUND_CREDIT,
    FRAME_PB_MAIL_REQ,
    FRAME_PB_MAIL_RESP,
    FRAME_PB_MAILBOX_ANNOUNCE,
];

/// Frame types beyond v1 that a peer may use only after negotiating the named capability.
pub fn is_v1_frame_type(t: u8) -> bool {
    V1_TYPES.contains(&t)
}

/// Which type set a decoder accepts: exactly v1, or v1 plus negotiated extensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TypeSet {
    pub drain_notice: bool,
    pub stream_credit: bool,
}

impl TypeSet {
    pub const V1: Self = Self {
        drain_notice: false,
        stream_credit: false,
    };

    pub fn accepts(self, t: u8) -> bool {
        is_v1_frame_type(t)
            || (self.drain_notice && t == FRAME_DRAIN_NOTICE)
            || (self.stream_credit && t == FRAME_STREAM_CREDIT)
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct Frame {
    pub stream_id: u32,
    pub frame_type: u8,
    pub payload: Vec<u8>,
}

impl fmt::Debug for Frame {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Frame")
            .field("stream_id", &self.stream_id)
            .field("frame_type", &format_args!("0x{:02x}", self.frame_type))
            .field("payload_len", &self.payload.len())
            .finish()
    }
}

impl Frame {
    pub fn new(stream_id: u32, frame_type: u8, payload: Vec<u8>) -> Self {
        Self {
            stream_id,
            frame_type,
            payload,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodeError {
    PayloadTooLarge(usize),
}

impl fmt::Display for EncodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PayloadTooLarge(_) => {
                write!(f, "frame payload exceeds {MAX_FRAME_PAYLOAD} bytes")
            }
        }
    }
}

impl std::error::Error for EncodeError {}

pub fn encode_frame(frame: &Frame) -> Result<Vec<u8>, EncodeError> {
    let mut out = Vec::new();
    encode_frame_into(frame.stream_id, frame.frame_type, &frame.payload, &mut out)?;
    Ok(out)
}

pub fn encode_frame_into(
    stream_id: u32,
    frame_type: u8,
    payload: &[u8],
    out: &mut Vec<u8>,
) -> Result<(), EncodeError> {
    let len = payload.len();
    if len > MAX_FRAME_PAYLOAD {
        return Err(EncodeError::PayloadTooLarge(len));
    }
    let len32 = u32::try_from(len).map_err(|_| EncodeError::PayloadTooLarge(len))?;
    out.reserve(FRAME_HEADER_BYTES.saturating_add(len));
    out.extend_from_slice(&stream_id.to_be_bytes());
    out.push(frame_type);
    out.extend_from_slice(&len32.to_be_bytes());
    out.extend_from_slice(payload);
    Ok(())
}

/// Same three outcomes as `decodeFrame` in TS; reasons are byte-identical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decoded<'a> {
    Ok {
        stream_id: u32,
        frame_type: u8,
        payload: &'a [u8],
        consumed: usize,
    },
    Incomplete {
        need_at_least: usize,
    },
    Error {
        reason: String,
    },
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    let s = b.get(at..at.checked_add(4)?)?;
    let a: [u8; 4] = s.try_into().ok()?;
    Some(u32::from_be_bytes(a))
}

/// Decode one frame from the front of `buf` with the v1 type set.
pub fn decode_frame(buf: &[u8]) -> Decoded<'_> {
    decode_frame_with(buf, TypeSet::V1)
}

pub fn decode_frame_with(buf: &[u8], types: TypeSet) -> Decoded<'_> {
    let (Some(stream_id), Some(&frame_type), Some(len)) = (be32(buf, 0), buf.get(4), be32(buf, 5))
    else {
        return Decoded::Incomplete {
            need_at_least: FRAME_HEADER_BYTES,
        };
    };
    if !types.accepts(frame_type) {
        return Decoded::Error {
            reason: format!("unknown frame type 0x{frame_type:x}"),
        };
    }
    let len = len as usize;
    if len > MAX_FRAME_PAYLOAD {
        return Decoded::Error {
            reason: format!("payload length {len} exceeds max {MAX_FRAME_PAYLOAD}"),
        };
    }
    let total = FRAME_HEADER_BYTES.saturating_add(len);
    match buf.get(FRAME_HEADER_BYTES..total) {
        Some(payload) => Decoded::Ok {
            stream_id,
            frame_type,
            payload,
            consumed: total,
        },
        None => Decoded::Incomplete {
            need_at_least: total,
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameError(pub String);

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FrameError {}

/// Streaming decoder over a byte carrier (WebSocket messages need not align with frames).
///
/// Memory is bounded by one maximal frame plus one carrier chunk: the buffer grows only with
/// bytes that actually arrived, never by a peer-declared length, and a declared length above
/// [`MAX_FRAME_PAYLOAD`] fails before anything is reserved for it.
#[derive(Debug)]
pub struct FrameDecoder {
    buf: Vec<u8>,
    start: usize,
    types: TypeSet,
    max_chunk: usize,
}

impl FrameDecoder {
    pub fn new(types: TypeSet, max_chunk: usize) -> Self {
        Self {
            buf: Vec::new(),
            start: 0,
            types,
            max_chunk,
        }
    }

    pub fn set_types(&mut self, types: TypeSet) {
        self.types = types;
    }

    pub fn buffered(&self) -> usize {
        self.buf.len().saturating_sub(self.start)
    }

    /// Append carrier bytes. Refuses a chunk that would push the buffer past one frame plus
    /// `max_chunk`; a caller that drains with [`Self::next_frame`] after every push never hits it.
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), FrameError> {
        if chunk.len() > self.max_chunk {
            return Err(FrameError("carrier chunk too large".into()));
        }
        let limit = FRAME_HEADER_BYTES
            .saturating_add(MAX_FRAME_PAYLOAD)
            .saturating_add(self.max_chunk);
        if self.buffered().saturating_add(chunk.len()) > limit {
            return Err(FrameError("decoder buffer limit exceeded".into()));
        }
        if self.start > 0 && self.start >= self.buf.len() / 2 {
            self.buf.drain(..self.start);
            self.start = 0;
        }
        self.buf.extend_from_slice(chunk);
        Ok(())
    }

    /// The next complete frame, `Ok(None)` when more bytes are needed.
    pub fn next_frame(&mut self) -> Result<Option<Frame>, FrameError> {
        let rest = self.buf.get(self.start..).unwrap_or_default();
        match decode_frame_with(rest, self.types) {
            Decoded::Ok {
                stream_id,
                frame_type,
                payload,
                consumed,
            } => {
                let frame = Frame::new(stream_id, frame_type, payload.to_vec());
                self.start = self.start.saturating_add(consumed);
                if self.start == self.buf.len() {
                    self.buf.clear();
                    self.start = 0;
                }
                Ok(Some(frame))
            }
            Decoded::Incomplete { .. } => Ok(None),
            Decoded::Error { reason } => Err(FrameError(reason)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_never_reserves_declared_length() {
        let mut d = FrameDecoder::new(TypeSet::V1, 64 * 1024);
        let mut hdr = vec![0, 0, 0, 1, FRAME_DATA];
        hdr.extend_from_slice(&(MAX_FRAME_PAYLOAD as u32).to_be_bytes());
        assert!(d.push(&hdr).is_ok());
        assert_eq!(d.next_frame(), Ok(None));
        assert!(d.buf.capacity() < 1024);
    }

    #[test]
    fn drain_notice_needs_negotiation() {
        let bytes = [0, 0, 0, 0, FRAME_DRAIN_NOTICE, 0, 0, 0, 0];
        assert!(matches!(decode_frame(&bytes), Decoded::Error { .. }));
        let t = TypeSet {
            drain_notice: true,
            stream_credit: false,
        };
        assert!(matches!(decode_frame_with(&bytes, t), Decoded::Ok { .. }));
    }
}

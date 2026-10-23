//! Peer-backup mailbox frames (`mailFrames.ts`): a request or reply split over frames.
//!
//! Byte 0 is flags (1 = first, 2 = last). The first REQ frame then carries `u8 len` + the
//! mailbox id, the first RESP frame a `u16 BE` status; the rest is the envelope.

use crate::frame::{FRAME_PB_MAIL_REQ, FRAME_PB_MAIL_RESP, Frame, MAX_FRAME_PAYLOAD};

pub const MAIL_FIRST: u8 = 1;
pub const MAIL_LAST: u8 = 2;
pub const MAIL_MAX_ENVELOPE: usize = 16 * 1024 * 1024 + 256 * 1024;
const CHUNK: usize = MAX_FRAME_PAYLOAD - 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailError(pub &'static str);

impl std::fmt::Display for MailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for MailError {}

fn split(frame_type: u8, stream_id: u32, head: &[u8], body: &[u8]) -> Vec<Frame> {
    let mut frames = Vec::new();
    let mut off = 0usize;
    let mut first = true;
    loop {
        let room = CHUNK.saturating_sub(if first { head.len() } else { 0 });
        let end = body.len().min(off.saturating_add(room));
        let part = body.get(off..end).unwrap_or_default();
        off = end;
        let last = off >= body.len();
        let mut payload =
            Vec::with_capacity(1usize.saturating_add(head.len()).saturating_add(part.len()));
        payload.push((if first { MAIL_FIRST } else { 0 }) | (if last { MAIL_LAST } else { 0 }));
        if first {
            payload.extend_from_slice(head);
        }
        payload.extend_from_slice(part);
        frames.push(Frame::new(stream_id, frame_type, payload));
        first = false;
        if off >= body.len() {
            break;
        }
    }
    frames
}

pub fn mail_request_frames(
    stream_id: u32,
    mailbox_id: &str,
    envelope: &[u8],
) -> Result<Vec<Frame>, MailError> {
    let id = mailbox_id.as_bytes();
    let n = u8::try_from(id.len())
        .ok()
        .filter(|n| *n <= 64)
        .ok_or(MailError("mailbox id too long"))?;
    let mut head = Vec::with_capacity(id.len().saturating_add(1));
    head.push(n);
    head.extend_from_slice(id);
    Ok(split(FRAME_PB_MAIL_REQ, stream_id, &head, envelope))
}

pub fn mail_response_frames(stream_id: u32, status: u16, envelope: &[u8]) -> Vec<Frame> {
    split(
        FRAME_PB_MAIL_RESP,
        stream_id,
        &status.to_be_bytes(),
        envelope,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailKind {
    Req,
    Resp,
}

/// `MailAssembler`, with the same error strings and the same size cap.
#[derive(Debug)]
pub struct MailAssembler {
    kind: MailKind,
    parts: Vec<u8>,
    head_done: bool,
    pub mailbox_id: String,
    pub status: u16,
}

impl MailAssembler {
    pub fn new(kind: MailKind) -> Self {
        Self {
            kind,
            parts: Vec::new(),
            head_done: false,
            mailbox_id: String::new(),
            status: 0,
        }
    }

    /// `Ok(Some(body))` on the last frame, `Ok(None)` while more are expected.
    pub fn push(&mut self, payload: &[u8]) -> Result<Option<Vec<u8>>, MailError> {
        let (&flags, mut rest) = payload.split_first().ok_or(MailError("empty mail frame"))?;
        if flags & MAIL_FIRST != 0 {
            if self.head_done {
                return Err(MailError("mail stream restarted"));
            }
            match self.kind {
                MailKind::Req => {
                    let n = usize::from(rest.first().copied().unwrap_or(0));
                    let end = rest.len().min(n.saturating_add(1));
                    let id = rest.get(1.min(end)..end).unwrap_or_default();
                    let text = String::from_utf8_lossy(id);
                    self.mailbox_id = text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned();
                    rest = rest.get(end..).unwrap_or_default();
                }
                MailKind::Resp => {
                    let hi = u16::from(rest.first().copied().unwrap_or(0));
                    let lo = u16::from(rest.get(1).copied().unwrap_or(0));
                    self.status = (hi << 8) | lo;
                    rest = rest.get(2.min(rest.len())..).unwrap_or_default();
                }
            }
            self.head_done = true;
        } else if !self.head_done {
            return Err(MailError("mail stream without its first frame"));
        }
        if self.parts.len().saturating_add(rest.len()) > MAIL_MAX_ENVELOPE {
            return Err(MailError("mail too large"));
        }
        self.parts.extend_from_slice(rest);
        if flags & MAIL_LAST == 0 {
            return Ok(None);
        }
        Ok(Some(std::mem::take(&mut self.parts)))
    }
}

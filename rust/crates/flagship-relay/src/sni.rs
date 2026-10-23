//! ClientHello SNI extraction for raw-TCP passthrough.
//!
//! On a ClientHello that fits one TLS record this returns what `sni.ts` returns (same
//! hostname, same refusal reasons, same `need_at_least`). Unlike `sni.ts` it also reassembles
//! a ClientHello fragmented across several handshake records (RFC 8446 §5.1 allows it, and a
//! large post-quantum hello under a small record limit does it), incrementally so a sender
//! that dribbles bytes or one-byte records costs linear work, inside a hard byte budget.
//!
//! The parser never decrypts or validates anything beyond framing. Under ECH the name it
//! returns is the outer (public) name; routing on it is the caller's decision.

use std::time::Duration;

const TLS_RECORD_HANDSHAKE: u8 = 0x16;
const TLS_HANDSHAKE_CLIENT_HELLO: u8 = 0x01;
const EXT_SERVER_NAME: u16 = 0x0000;
const NAME_TYPE_HOST: u8 = 0x00;
const TLS_RECORD_HEADER: usize = 5;
const HANDSHAKE_HEADER: usize = 4;
/// RFC 8446: 2^14 + 256.
pub const MAX_RECORD_LEN: usize = 16_640;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SniLimits {
    /// Raw bytes (record headers included) buffered before the hello must be complete.
    pub max_raw_bytes: usize,
    /// Largest ClientHello body accepted (the handshake message's own length field).
    pub max_hello_len: usize,
    /// Most TLS records a fragmented hello may span.
    pub max_records: usize,
    /// Wall-clock budget for the whole hello to arrive.
    pub deadline: Duration,
}

impl Default for SniLimits {
    fn default() -> Self {
        Self {
            max_raw_bytes: 32 * 1024,
            max_hello_len: 24 * 1024,
            max_records: 512,
            deadline: Duration::from_secs(10),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientHelloInfo {
    /// Lower-cased host_name, `None` when the client sent no SNI extension.
    pub sni: Option<String>,
    /// Records the hello spanned (1 for every hello `sni.ts` can parse).
    pub records: usize,
    /// Raw bytes up to the end of the last record carrying the hello.
    pub consumed: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SniStatus {
    /// Buffer at least this many raw bytes (absolute, from the first byte) and retry.
    NeedMore(usize),
    Reject(&'static str),
    Done(ClientHelloInfo),
}

/// Incremental reader: feed bytes as they arrive; work is linear in the bytes fed.
#[derive(Debug)]
pub struct ClientHelloReader {
    limits: SniLimits,
    raw: Vec<u8>,
    /// Raw offset of the next record header.
    pos: usize,
    handshake: Vec<u8>,
    records: usize,
    status: SniStatus,
}

fn u16_at(b: &[u8], at: usize) -> Option<usize> {
    let hi = *b.get(at)?;
    let lo = *b.get(at.checked_add(1)?)?;
    Some(usize::from(hi) << 8 | usize::from(lo))
}

fn u24_at(b: &[u8], at: usize) -> Option<usize> {
    let a = *b.get(at)?;
    let rest = u16_at(b, at.checked_add(1)?)?;
    Some(usize::from(a) << 16 | rest)
}

impl ClientHelloReader {
    pub fn new(limits: SniLimits) -> Self {
        Self {
            limits,
            raw: Vec::new(),
            pos: 0,
            handshake: Vec::new(),
            records: 0,
            status: SniStatus::NeedMore(TLS_RECORD_HEADER),
        }
    }

    pub fn limits(&self) -> &SniLimits {
        &self.limits
    }

    /// Every byte fed so far, to replay to the backend once routed.
    pub fn raw(&self) -> &[u8] {
        &self.raw
    }

    pub fn into_raw(self) -> Vec<u8> {
        self.raw
    }

    pub fn status(&self) -> &SniStatus {
        &self.status
    }

    pub fn push(&mut self, data: &[u8]) -> &SniStatus {
        self.raw.extend_from_slice(data);
        if let SniStatus::NeedMore(n) = self.status
            && self.raw.len() >= n
        {
            self.status = self.advance();
        }
        let over = match &self.status {
            SniStatus::NeedMore(n) => *n > self.limits.max_raw_bytes,
            SniStatus::Done(i) => i.consumed > self.limits.max_raw_bytes,
            SniStatus::Reject(_) => false,
        };
        if over {
            self.status = SniStatus::Reject("ClientHello exceeds the peek limit");
        }
        &self.status
    }

    fn advance(&mut self) -> SniStatus {
        loop {
            let hdr_end = self.pos.saturating_add(TLS_RECORD_HEADER);
            let (Some(&ty), Some(rec_len)) = (
                self.raw.get(self.pos),
                u16_at(&self.raw, self.pos.saturating_add(3)),
            ) else {
                return SniStatus::NeedMore(hdr_end);
            };
            if ty != TLS_RECORD_HANDSHAKE {
                return SniStatus::Reject("not a TLS handshake record");
            }
            // sni.ts refuses a first record under 4 bytes; RFC 8446 forbids only empty ones, so
            // a hello that starts in a 1..3 byte record continues in the next record here.
            if rec_len == 0 {
                return SniStatus::Reject(if self.records == 0 {
                    "record too small for handshake header"
                } else {
                    "empty handshake record"
                });
            }
            if rec_len > MAX_RECORD_LEN {
                return SniStatus::Reject("record length exceeds TLS maximum");
            }
            let rec_end = hdr_end.saturating_add(rec_len);
            let Some(fragment) = self.raw.get(hdr_end..rec_end) else {
                return SniStatus::NeedMore(rec_end);
            };
            if self.records >= self.limits.max_records {
                return SniStatus::Reject("ClientHello spans too many records");
            }
            self.records = self.records.saturating_add(1);
            self.handshake.extend_from_slice(fragment);
            self.pos = rec_end;

            if let Some(&msg) = self.handshake.first()
                && msg != TLS_HANDSHAKE_CLIENT_HELLO
            {
                return SniStatus::Reject("handshake is not ClientHello");
            }
            let Some(hs_len) = u24_at(&self.handshake, 1) else {
                continue;
            };
            if hs_len > self.limits.max_hello_len {
                return SniStatus::Reject("ClientHello exceeds the size limit");
            }
            let hs_end = HANDSHAKE_HEADER.saturating_add(hs_len);
            let Some(body) = self.handshake.get(HANDSHAKE_HEADER..hs_end) else {
                continue;
            };
            return match parse_body(body) {
                Ok(sni) => SniStatus::Done(ClientHelloInfo {
                    sni,
                    records: self.records,
                    consumed: self.pos,
                }),
                Err(r) => SniStatus::Reject(r),
            };
        }
    }
}

/// One-shot parse of a buffer prefix, for callers that re-buffer themselves.
pub fn parse_client_hello(buf: &[u8], limits: SniLimits) -> SniStatus {
    let mut r = ClientHelloReader::new(limits);
    r.push(buf).clone()
}

/// Exactly `parseClientHelloSni` from `sni.ts` (single record only), for differential tests.
pub fn parse_client_hello_ts_compat(buf: &[u8]) -> SniStatus {
    let Some(rec_len) = u16_at(buf, 3) else {
        return SniStatus::NeedMore(TLS_RECORD_HEADER);
    };
    if buf.first() != Some(&TLS_RECORD_HANDSHAKE) {
        return SniStatus::Reject("not a TLS handshake record");
    }
    if rec_len < HANDSHAKE_HEADER {
        return SniStatus::Reject("record too small for handshake header");
    }
    if rec_len > MAX_RECORD_LEN {
        return SniStatus::Reject("record length exceeds TLS maximum");
    }
    let rec_end = TLS_RECORD_HEADER.saturating_add(rec_len);
    let Some(record) = buf.get(TLS_RECORD_HEADER..rec_end) else {
        return SniStatus::NeedMore(rec_end);
    };
    if record.first() != Some(&TLS_HANDSHAKE_CLIENT_HELLO) {
        return SniStatus::Reject("handshake is not ClientHello");
    }
    let Some(hs_len) = u24_at(record, 1) else {
        return SniStatus::Reject("handshake length exceeds record");
    };
    let Some(body) = record.get(HANDSHAKE_HEADER..HANDSHAKE_HEADER.saturating_add(hs_len)) else {
        return SniStatus::Reject("handshake length exceeds record");
    };
    match parse_body(body) {
        Ok(sni) => SniStatus::Done(ClientHelloInfo {
            sni,
            records: 1,
            consumed: rec_end,
        }),
        Err(r) => SniStatus::Reject(r),
    }
}

/// The ClientHello body walk, step for step with `sni.ts` (same order, same reasons).
fn parse_body(b: &[u8]) -> Result<Option<String>, &'static str> {
    let end = b.len();
    if end < 34 {
        return Err("ClientHello too short");
    }
    let mut p = 34usize;
    let session_len = usize::from(*b.get(p).ok_or("truncated at session_id")?);
    p = p.saturating_add(1).saturating_add(session_len);
    if p > end {
        return Err("session_id overruns handshake");
    }
    if p.saturating_add(2) > end {
        return Err("truncated at cipher_suites");
    }
    let cipher_len = u16_at(b, p).ok_or("truncated at cipher_suites")?;
    p = p.saturating_add(2).saturating_add(cipher_len);
    if p > end {
        return Err("cipher_suites overruns handshake");
    }
    let comp_len = usize::from(*b.get(p).ok_or("truncated at compression_methods")?);
    p = p.saturating_add(1).saturating_add(comp_len);
    if p > end {
        return Err("compression_methods overruns handshake");
    }
    if p == end {
        return Ok(None);
    }
    if p.saturating_add(2) > end {
        return Err("truncated at extensions length");
    }
    let exts_len = u16_at(b, p).ok_or("truncated at extensions length")?;
    p = p.saturating_add(2);
    let exts_end = p.saturating_add(exts_len);
    if exts_end > end {
        return Err("extensions overrun handshake");
    }
    while p.saturating_add(4) <= exts_end {
        let ext_type = u16_at(b, p).ok_or("extension length overruns extensions block")?;
        let ext_len =
            u16_at(b, p.saturating_add(2)).ok_or("extension length overruns extensions block")?;
        p = p.saturating_add(4);
        if p.saturating_add(ext_len) > exts_end {
            return Err("extension length overruns extensions block");
        }
        if ext_type == EXT_SERVER_NAME as usize {
            let ext = b
                .get(p..p.saturating_add(ext_len))
                .ok_or("SNI extension too short for list length")?;
            return parse_server_name(ext).map(Some);
        }
        p = p.saturating_add(ext_len);
    }
    Ok(None)
}

fn parse_server_name(e: &[u8]) -> Result<String, &'static str> {
    let list_len = u16_at(e, 0).ok_or("SNI extension too short for list length")?;
    let list = e
        .get(2..2usize.saturating_add(list_len))
        .ok_or("SNI list length exceeds extension")?;
    let mut p = 0usize;
    while p.saturating_add(3) <= list.len() {
        let name_type = *list.get(p).ok_or("SNI name length exceeds list")?;
        let name_len = u16_at(list, p.saturating_add(1)).ok_or("SNI name length exceeds list")?;
        p = p.saturating_add(3);
        let name = list
            .get(p..p.saturating_add(name_len))
            .ok_or("SNI name length exceeds list")?;
        if name_type == NAME_TYPE_HOST {
            if name.iter().any(|c| !(0x20..=0x7e).contains(c)) {
                return Err("SNI hostname contains non-printable bytes");
            }
            if name.is_empty() {
                return Err("SNI hostname is empty");
            }
            let s: String = name
                .iter()
                .map(|&c| char::from(c.to_ascii_lowercase()))
                .collect();
            return Ok(s);
        }
        p = p.saturating_add(name_len);
    }
    Err("SNI extension had no host_name entry")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_garbage() {
        let l = SniLimits::default();
        assert_eq!(parse_client_hello(&[], l), SniStatus::NeedMore(5));
        assert_eq!(parse_client_hello(&[0], l), SniStatus::NeedMore(5));
        assert_eq!(
            parse_client_hello(&[0x17, 3, 3, 0, 5], l),
            SniStatus::Reject("not a TLS handshake record")
        );
        assert_eq!(parse_client_hello_ts_compat(&[0]), SniStatus::NeedMore(5));
    }

    #[test]
    fn declared_record_beyond_peek_limit_is_rejected_early() {
        let l = SniLimits {
            max_raw_bytes: 1024,
            ..SniLimits::default()
        };
        assert_eq!(
            parse_client_hello(&[0x16, 3, 1, 0x10, 0x00], l),
            SniStatus::Reject("ClientHello exceeds the peek limit")
        );
    }
}

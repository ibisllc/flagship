//! Typed payloads for the v1 frame types: `frames.ts`, `outboundFrames.ts`, `mailFrames.ts`
//! (announce) and `peerBackupFrames.ts`. Encoders emit the bytes the TS helpers emit; parsers
//! accept and refuse what the TS parsers accept and refuse.

use serde_json::Value;

use crate::frame::{
    FRAME_DOMAIN_GRANTED, FRAME_HELLO_ACK, FRAME_OPEN, FRAME_OUTBOUND_CREDIT, FRAME_OUTBOUND_OPEN,
    FRAME_OUTBOUND_RESULT, FRAME_PB_CHALLENGE, FRAME_PB_GET, FRAME_PB_GET_DATA, FRAME_PB_GET_END,
    FRAME_PB_MAILBOX_ANNOUNCE, FRAME_PB_PUT, FRAME_PB_PUT_ACK, FRAME_PB_RESPONSE,
    FRAME_REQUEST_TRANSFER, FRAME_STREAM_CREDIT, Frame,
};
use crate::json::{self, as_object, is_integer, is_lower_hex, js_len, number, str_lit};

pub const CAPABILITY_OUTBOUND_V1: &str = "outbound-v1";
pub const CAPABILITY_PB_MAIL_V1: &str = "pb-mail-v1";
/// Rust-relay extension: per-stream credit on hub-opened streams (docs/architecture-v2/relay-transport.md).
pub const CAPABILITY_STREAM_CREDIT_V1: &str = "stream-credit-v1";
/// Rust-relay extension: the hub may send FRAME_DRAIN_NOTICE before it goes away.
pub const CAPABILITY_DRAIN_V1: &str = "drain-v1";

pub const OUTBOUND_STREAM_ID_BASE: u32 = 0x8000_0000;
pub const OUTBOUND_INITIAL_WINDOW: u32 = 256 * 1024;
pub const OUTBOUND_MAX_CHUNK: usize = 64 * 1024;
/// `Number.MAX_SAFE_INTEGER`: the largest integer a TS peer reads back exactly.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

pub fn is_outbound_stream_id(id: u32) -> bool {
    id >= OUTBOUND_STREAM_ID_BASE
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayloadError(pub &'static str);

impl std::fmt::Display for PayloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for PayloadError {}

fn safe_int(n: u64) -> Result<u64, PayloadError> {
    if n > MAX_SAFE_INTEGER {
        Err(PayloadError("integer above Number.MAX_SAFE_INTEGER"))
    } else {
        Ok(n)
    }
}

fn control(frame_type: u8, json: String) -> Frame {
    Frame::new(0, frame_type, json.into_bytes())
}

// ---------------------------------------------------------------- HELLO_ACK

/// Optional trust attachment; `service_blessing_json` is the envelope already serialized the
/// way `JSON.stringify` writes it (the relay passes it through verbatim).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HelloAckTrust {
    pub service_blessing_json: Option<String>,
    pub hub_sig: Option<String>,
}

pub fn hello_ack_frame(
    ok: bool,
    reason: Option<&str>,
    trust: Option<&HelloAckTrust>,
    capabilities: &[&str],
) -> Frame {
    let mut s = String::from("{\"ok\":");
    s.push_str(if ok { "true" } else { "false" });
    if let Some(r) = reason {
        s.push_str(",\"reason\":");
        json::write_str(&mut s, r);
    }
    if let Some(t) = trust {
        if let Some(b) = &t.service_blessing_json {
            s.push_str(",\"serviceBlessing\":");
            s.push_str(b);
        }
        if let Some(h) = &t.hub_sig {
            s.push_str(",\"hubSig\":");
            json::write_str(&mut s, h);
        }
    }
    if !capabilities.is_empty() {
        s.push_str(",\"capabilities\":[");
        for (i, c) in capabilities.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            json::write_str(&mut s, c);
        }
        s.push(']');
    }
    s.push('}');
    control(FRAME_HELLO_ACK, s)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedHelloAck {
    pub ok: bool,
    pub reason: Option<String>,
    pub service_blessing: Option<Value>,
    pub hub_sig: Option<String>,
    pub capabilities: Option<Vec<String>>,
}

/// `parseHelloAck`: `None` when the payload is not JSON or not an object (arrays count as
/// objects in JS, and parse to `ok: false`).
pub fn parse_hello_ack(payload: &[u8]) -> Option<ParsedHelloAck> {
    let v = json::parse(payload)?;
    let mut out = ParsedHelloAck {
        ok: false,
        reason: None,
        service_blessing: None,
        hub_sig: None,
        capabilities: None,
    };
    if v.is_array() {
        return Some(out);
    }
    let o = as_object(&v)?;
    out.ok = o.get("ok") == Some(&Value::Bool(true));
    out.reason = o.get("reason").and_then(Value::as_str).map(str::to_owned);
    out.service_blessing = o.get("serviceBlessing").filter(|b| !b.is_null()).cloned();
    out.hub_sig = o.get("hubSig").and_then(Value::as_str).map(str::to_owned);
    out.capabilities = o.get("capabilities").and_then(Value::as_array).map(|a| {
        a.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    });
    Some(out)
}

// ---------------------------------------------------------------- control frames

pub fn domain_granted_frame(fqdn: &str, owner_server_id: &str) -> Frame {
    control(
        FRAME_DOMAIN_GRANTED,
        format!(
            "{{\"fqdn\":{},\"ownerServerId\":{}}}",
            str_lit(fqdn),
            str_lit(owner_server_id)
        ),
    )
}

/// The daemon's reading of DOMAIN_GRANTED: both fields strings, else dropped.
pub fn parse_domain_granted(payload: &[u8]) -> Option<(String, String)> {
    let v = json::parse(payload)?;
    let fqdn = v.get("fqdn")?.as_str()?;
    let owner = v.get("ownerServerId")?.as_str()?;
    Some((fqdn.to_owned(), owner.to_owned()))
}

pub fn request_transfer_frame(fqdn: &str) -> Frame {
    control(
        FRAME_REQUEST_TRANSFER,
        format!("{{\"fqdn\":{}}}", str_lit(fqdn)),
    )
}

/// The hub's reading of REQUEST_TRANSFER: `fqdn` must be a string, else the frame is ignored.
pub fn parse_request_transfer(payload: &[u8]) -> Option<String> {
    let v = json::parse(payload)?;
    v.get("fqdn")?.as_str().map(str::to_owned)
}

pub fn open_frame(stream_id: u32, sni: &str) -> Frame {
    Frame::new(stream_id, FRAME_OPEN, sni.as_bytes().to_vec())
}

pub fn parse_open(payload: &[u8]) -> String {
    let s = String::from_utf8_lossy(payload);
    s.strip_prefix('\u{feff}').unwrap_or(&s).to_owned()
}

// ---------------------------------------------------------------- outbound

pub const OUTBOUND_REFUSALS: [&str; 10] = [
    "bad-request",
    "forbidden-port",
    "forbidden-host",
    "forbidden-address",
    "dns-failed",
    "connect-failed",
    "too-many-streams",
    "rate-limited",
    "duplicate-stream",
    "disabled",
];

pub fn outbound_open_frame(stream_id: u32, host: &str, port: u16) -> Result<Frame, PayloadError> {
    if !is_outbound_stream_id(stream_id) {
        return Err(PayloadError("outbound stream id outside the box space"));
    }
    Ok(Frame::new(
        stream_id,
        FRAME_OUTBOUND_OPEN,
        format!("{{\"host\":{},\"port\":{port}}}", str_lit(host)).into_bytes(),
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundOpen {
    pub host: String,
    pub port: u16,
}

pub fn parse_outbound_open(payload: &[u8]) -> Option<OutboundOpen> {
    let v = json::parse(payload)?;
    let o = as_object(&v)?;
    let host = o.get("host")?.as_str()?;
    let n = js_len(host);
    if n == 0 || n > 253 {
        return None;
    }
    let port = number(o.get("port")?)?;
    if !is_integer(port) || !(1.0..=65535.0).contains(&port) {
        return None;
    }
    let port = u16::try_from(port as i64).ok()?;
    Some(OutboundOpen {
        host: host.to_owned(),
        port,
    })
}

pub fn outbound_result_frame(stream_id: u32, ok: bool, reason: Option<&str>) -> Frame {
    let body = match (ok, reason) {
        (false, Some(r)) => format!("{{\"ok\":false,\"reason\":{}}}", str_lit(r)),
        (false, None) => "{\"ok\":false}".to_owned(),
        (true, _) => "{\"ok\":true}".to_owned(),
    };
    Frame::new(stream_id, FRAME_OUTBOUND_RESULT, body.into_bytes())
}

/// `(ok, reason)`; an unknown or missing refusal reads as `connect-failed`.
pub fn parse_outbound_result(payload: &[u8]) -> Option<(bool, Option<&'static str>)> {
    let v = json::parse(payload)?;
    let o = as_object(&v)?;
    let ok = o.get("ok")?.as_bool()?;
    if ok {
        return Some((true, None));
    }
    let reason = o
        .get("reason")
        .and_then(Value::as_str)
        .and_then(|r| OUTBOUND_REFUSALS.iter().find(|k| **k == r).copied())
        .unwrap_or("connect-failed");
    Some((false, Some(reason)))
}

fn credit_payload(bytes: u32) -> Result<Vec<u8>, PayloadError> {
    if bytes == 0 {
        return Err(PayloadError("credit must be a positive u32"));
    }
    Ok(bytes.to_be_bytes().to_vec())
}

pub fn outbound_credit_frame(stream_id: u32, bytes: u32) -> Result<Frame, PayloadError> {
    Ok(Frame::new(
        stream_id,
        FRAME_OUTBOUND_CREDIT,
        credit_payload(bytes)?,
    ))
}

/// Same wire form as OUTBOUND_CREDIT, on a hub-opened stream, only after `stream-credit-v1`.
pub fn stream_credit_frame(stream_id: u32, bytes: u32) -> Result<Frame, PayloadError> {
    Ok(Frame::new(
        stream_id,
        FRAME_STREAM_CREDIT,
        credit_payload(bytes)?,
    ))
}

pub fn parse_credit(payload: &[u8]) -> Option<u32> {
    let a: [u8; 4] = payload.try_into().ok()?;
    let n = u32::from_be_bytes(a);
    (n > 0).then_some(n)
}

// ---------------------------------------------------------------- mailbox announce

#[derive(Debug, Clone, PartialEq)]
pub struct MailboxAnnouncement {
    pub pik_pub_hex: String,
    /// A JS number: any non-negative integral double, as `Number.isInteger` allows.
    pub epoch: f64,
    pub sig_hex: String,
}

pub fn mailbox_announce_frame(list: &[MailboxAnnouncement]) -> Result<Frame, PayloadError> {
    let mut s = String::from("{\"announcements\":[");
    for (i, a) in list.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        if !is_integer(a.epoch) || a.epoch < 0.0 || a.epoch > MAX_SAFE_INTEGER as f64 {
            return Err(PayloadError("epoch must be a safe non-negative integer"));
        }
        s.push_str("{\"pikPubHex\":");
        json::write_str(&mut s, &a.pik_pub_hex);
        s.push_str(&format!(",\"epoch\":{}", a.epoch as u64));
        s.push_str(",\"sigHex\":");
        json::write_str(&mut s, &a.sig_hex);
        s.push('}');
    }
    s.push_str("]}");
    Ok(control(FRAME_PB_MAILBOX_ANNOUNCE, s))
}

pub fn decode_mailbox_announce(payload: &[u8]) -> Option<Vec<MailboxAnnouncement>> {
    let v = json::parse(payload)?;
    let list = v.get("announcements")?.as_array()?;
    if list.len() > 8 {
        return None;
    }
    let mut out = Vec::with_capacity(list.len());
    for a in list {
        let pik = a.get("pikPubHex")?.as_str()?;
        let sig = a.get("sigHex")?.as_str()?;
        let epoch = number(a.get("epoch")?)?;
        if !is_lower_hex(pik, 64) || !is_lower_hex(sig, 128) || !is_integer(epoch) || epoch < 0.0 {
            return None;
        }
        out.push(MailboxAnnouncement {
            pik_pub_hex: pik.to_owned(),
            epoch,
            sig_hex: sig.to_owned(),
        });
    }
    Some(out)
}

// ---------------------------------------------------------------- peer backup

const PB_MALFORMED: PayloadError = PayloadError("payload malformed");

fn obj(payload: &[u8]) -> Result<serde_json::Map<String, Value>, PayloadError> {
    match json::parse(payload) {
        Some(Value::Object(m)) => Ok(m),
        Some(Value::Array(_)) => Ok(serde_json::Map::new()),
        _ => Err(PB_MALFORMED),
    }
}

fn hex_field(
    o: &serde_json::Map<String, Value>,
    k: &str,
    len: usize,
) -> Result<String, PayloadError> {
    match o.get(k).and_then(Value::as_str) {
        Some(s) if is_lower_hex(s, len) => Ok(s.to_owned()),
        _ => Err(PB_MALFORMED),
    }
}

/// `nonNeg`: a finite number `>= 0` (fractions allowed, as in TS).
fn non_neg(o: &serde_json::Map<String, Value>, k: &str) -> Result<f64, PayloadError> {
    match o.get(k).and_then(number) {
        Some(n) if n.is_finite() && n >= 0.0 => Ok(n),
        _ => Err(PB_MALFORMED),
    }
}

fn pb_json(frame_type: u8, stream_id: u32, body: String) -> Frame {
    Frame::new(stream_id, frame_type, body.into_bytes())
}

#[derive(Debug, Clone, PartialEq)]
pub struct PbPut {
    pub enc_chunk_id: String,
    pub shard_index: f64,
    pub size_bytes: f64,
    pub signature: String,
}

pub fn pb_put_frame(
    stream_id: u32,
    enc_chunk_id: &str,
    shard_index: u64,
    size_bytes: u64,
    signature: &str,
) -> Result<Frame, PayloadError> {
    Ok(pb_json(
        FRAME_PB_PUT,
        stream_id,
        format!(
            "{{\"encChunkId\":{},\"shardIndex\":{},\"sizeBytes\":{},\"signature\":{}}}",
            str_lit(enc_chunk_id),
            safe_int(shard_index)?,
            safe_int(size_bytes)?,
            str_lit(signature)
        ),
    ))
}

pub fn decode_pb_put(payload: &[u8]) -> Result<PbPut, PayloadError> {
    let o = obj(payload)?;
    Ok(PbPut {
        enc_chunk_id: hex_field(&o, "encChunkId", 64)?,
        shard_index: non_neg(&o, "shardIndex")?,
        size_bytes: non_neg(&o, "sizeBytes")?,
        signature: hex_field(&o, "signature", 128)?,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct PbPutAck {
    pub enc_chunk_id: String,
    pub shard_index: f64,
    pub ok: bool,
    pub reason: Option<String>,
}

pub fn pb_put_ack_frame(
    stream_id: u32,
    enc_chunk_id: &str,
    shard_index: u64,
    ok: bool,
    reason: Option<&str>,
) -> Result<Frame, PayloadError> {
    let mut s = format!(
        "{{\"encChunkId\":{},\"shardIndex\":{},\"ok\":{ok}",
        str_lit(enc_chunk_id),
        safe_int(shard_index)?
    );
    if let Some(r) = reason {
        s.push_str(",\"reason\":");
        json::write_str(&mut s, r);
    }
    s.push('}');
    Ok(pb_json(FRAME_PB_PUT_ACK, stream_id, s))
}

pub fn decode_pb_put_ack(payload: &[u8]) -> Result<PbPutAck, PayloadError> {
    let o = obj(payload)?;
    Ok(PbPutAck {
        enc_chunk_id: hex_field(&o, "encChunkId", 64)?,
        shard_index: non_neg(&o, "shardIndex")?,
        ok: o.get("ok").and_then(Value::as_bool).ok_or(PB_MALFORMED)?,
        reason: o.get("reason").and_then(Value::as_str).map(str::to_owned),
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct PbGet {
    pub enc_chunk_id: String,
    pub shard_index: f64,
}

pub fn pb_get_frame(
    stream_id: u32,
    enc_chunk_id: &str,
    shard_index: u64,
) -> Result<Frame, PayloadError> {
    Ok(pb_json(
        FRAME_PB_GET,
        stream_id,
        format!(
            "{{\"encChunkId\":{},\"shardIndex\":{}}}",
            str_lit(enc_chunk_id),
            safe_int(shard_index)?
        ),
    ))
}

pub fn decode_pb_get(payload: &[u8]) -> Result<PbGet, PayloadError> {
    let o = obj(payload)?;
    Ok(PbGet {
        enc_chunk_id: hex_field(&o, "encChunkId", 64)?,
        shard_index: non_neg(&o, "shardIndex")?,
    })
}

pub fn pb_get_data_frame(stream_id: u32, data: &[u8]) -> Frame {
    Frame::new(stream_id, FRAME_PB_GET_DATA, data.to_vec())
}

#[derive(Debug, Clone, PartialEq)]
pub struct PbGetEnd {
    pub enc_chunk_id: String,
    pub shard_index: f64,
    pub sha256: String,
}

pub fn pb_get_end_frame(
    stream_id: u32,
    enc_chunk_id: &str,
    shard_index: u64,
    sha256: &str,
) -> Result<Frame, PayloadError> {
    Ok(pb_json(
        FRAME_PB_GET_END,
        stream_id,
        format!(
            "{{\"encChunkId\":{},\"shardIndex\":{},\"sha256\":{}}}",
            str_lit(enc_chunk_id),
            safe_int(shard_index)?,
            str_lit(sha256)
        ),
    ))
}

pub fn decode_pb_get_end(payload: &[u8]) -> Result<PbGetEnd, PayloadError> {
    let o = obj(payload)?;
    Ok(PbGetEnd {
        enc_chunk_id: hex_field(&o, "encChunkId", 64)?,
        shard_index: non_neg(&o, "shardIndex")?,
        sha256: hex_field(&o, "sha256", 64)?,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct PbChallenge {
    pub enc_chunk_id: String,
    pub shard_index: f64,
    pub nonce: String,
    pub offset: f64,
    pub length: f64,
}

pub fn pb_challenge_frame(
    stream_id: u32,
    enc_chunk_id: &str,
    shard_index: u64,
    nonce: &str,
    offset: u64,
    length: u64,
) -> Result<Frame, PayloadError> {
    Ok(pb_json(
        FRAME_PB_CHALLENGE,
        stream_id,
        format!(
            "{{\"encChunkId\":{},\"shardIndex\":{},\"nonce\":{},\"offset\":{},\"length\":{}}}",
            str_lit(enc_chunk_id),
            safe_int(shard_index)?,
            str_lit(nonce),
            safe_int(offset)?,
            safe_int(length)?
        ),
    ))
}

pub fn decode_pb_challenge(payload: &[u8]) -> Result<PbChallenge, PayloadError> {
    let o = obj(payload)?;
    let c = PbChallenge {
        enc_chunk_id: hex_field(&o, "encChunkId", 64)?,
        shard_index: non_neg(&o, "shardIndex")?,
        nonce: hex_field(&o, "nonce", 64)?,
        offset: non_neg(&o, "offset")?,
        length: non_neg(&o, "length")?,
    };
    if c.length == 0.0 {
        return Err(PB_MALFORMED);
    }
    Ok(c)
}

#[derive(Debug, Clone, PartialEq)]
pub struct PbResponse {
    pub enc_chunk_id: String,
    pub shard_index: f64,
    pub hash: String,
    pub signature: String,
}

pub fn pb_response_frame(
    stream_id: u32,
    enc_chunk_id: &str,
    shard_index: u64,
    hash: &str,
    signature: &str,
) -> Result<Frame, PayloadError> {
    Ok(pb_json(
        FRAME_PB_RESPONSE,
        stream_id,
        format!(
            "{{\"encChunkId\":{},\"shardIndex\":{},\"hash\":{},\"signature\":{}}}",
            str_lit(enc_chunk_id),
            safe_int(shard_index)?,
            str_lit(hash),
            str_lit(signature)
        ),
    ))
}

pub fn decode_pb_response(payload: &[u8]) -> Result<PbResponse, PayloadError> {
    let o = obj(payload)?;
    Ok(PbResponse {
        enc_chunk_id: hex_field(&o, "encChunkId", 64)?,
        shard_index: non_neg(&o, "shardIndex")?,
        hash: hex_field(&o, "hash", 64)?,
        signature: hex_field(&o, "signature", 128)?,
    })
}

/// `canonicalPbPut`; integers only (a fractional shard index has no canonical form shared
/// with the TS `${n}` template across every value).
pub fn canonical_pb_put(
    enc_chunk_id: &str,
    shard_index: u64,
    size_bytes: u64,
    peer_server_id: &str,
) -> Vec<u8> {
    format!("pb-put|{enc_chunk_id}|{shard_index}|{size_bytes}|{peer_server_id}").into_bytes()
}

pub fn canonical_pb_response(
    enc_chunk_id: &str,
    shard_index: u64,
    nonce: &str,
    hash: &str,
) -> Vec<u8> {
    format!("pb-resp|{enc_chunk_id}|{shard_index}|{nonce}|{hash}").into_bytes()
}

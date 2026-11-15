//! The phone's TURN responder for one voi.ci call (docs/voici-calls.md §4), sans-IO.
//!
//! The caller's browser has exactly one ICE server: `turns:<user>.<servicesApex>:443?transport=tcp`. TLS ends on the
//! phone; the phone endpoint hands the decrypted byte stream of that connection to [`TurnLite`] (a STUN or ChannelData
//! first byte, while a call is answered), and the datagrams of the loopback UDP socket paired with the phone's own
//! WebRTC peer connection come back through [`TurnLite::on_peer_datagram`].
//!
//! RFC 8656 subset: Allocate (UDP, one allocation, the call's one-time long-term credential), Refresh,
//! CreatePermission, ChannelBind, Send / Data indications and ChannelData; plus a Binding answer. Peers are only the
//! configured loopback address. Each direction is capped (64 kbit/s by default: a CBR Opus call is about 40 kbit/s
//! with its sealing and headers). Everything else is refused, and a byte stream that is not STUN or ChannelData ends
//! the connection.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};

use hmac::{Hmac, Mac};
use md5::{Digest, Md5};
use sha1::Sha1;

const MAGIC: u32 = 0x2112_A442;
const HEADER: usize = 20;
/// Largest frame accepted from the client (a STUN message or a ChannelData frame).
pub const MAX_FRAME: usize = 4096;
/// Largest buffered unparsed input.
pub const MAX_BUFFER: usize = 16 * 1024;
const PERMISSION_MS: u64 = 300_000;
const MAX_LIFETIME_S: u32 = 3600;
const DEFAULT_LIFETIME_S: u32 = 600;

const BINDING: u16 = 0x001;
const ALLOCATE: u16 = 0x003;
const REFRESH: u16 = 0x004;
const SEND: u16 = 0x006;
const DATA: u16 = 0x007;
const CREATE_PERMISSION: u16 = 0x008;
const CHANNEL_BIND: u16 = 0x009;

const CLASS_REQUEST: u16 = 0;
const CLASS_INDICATION: u16 = 1;
const CLASS_SUCCESS: u16 = 2;
const CLASS_ERROR: u16 = 3;

const A_USERNAME: u16 = 0x0006;
const A_MESSAGE_INTEGRITY: u16 = 0x0008;
const A_ERROR_CODE: u16 = 0x0009;
const A_CHANNEL_NUMBER: u16 = 0x000C;
const A_LIFETIME: u16 = 0x000D;
const A_XOR_PEER_ADDRESS: u16 = 0x0012;
const A_DATA: u16 = 0x0013;
const A_REALM: u16 = 0x0014;
const A_NONCE: u16 = 0x0015;
const A_XOR_RELAYED_ADDRESS: u16 = 0x0016;
const A_REQUESTED_TRANSPORT: u16 = 0x0019;
const A_XOR_MAPPED_ADDRESS: u16 = 0x0020;
const A_FINGERPRINT: u16 = 0x8028;

/// The call's TURN setting, from the phone's signed answer (`turnUser`, `turnSecret`).
#[derive(Debug, Clone)]
pub struct Config {
    pub realm: String,
    pub username: String,
    pub password: String,
    pub nonce: String,
    /// What XOR-MAPPED-ADDRESS reports (the phone cannot see the caller's address behind the relay).
    pub client_addr: SocketAddr,
    /// The loopback UDP socket the relayed traffic leaves from.
    pub relay_addr: SocketAddr,
    /// The only peer: the phone's own peer connection's loopback address.
    pub peer_ip: IpAddr,
    /// Per direction, bytes per second of payload.
    pub rate_bytes_per_s: u32,
}

/// What the caller of [`TurnLite`] must do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// Bytes for the client's TLS stream.
    ToClient(Vec<u8>),
    /// A datagram from the relay socket to `peer`.
    ToPeer { peer: SocketAddr, data: Vec<u8> },
}

/// The connection must close.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Neither STUN nor ChannelData.
    NotTurn,
    /// A frame over [`MAX_FRAME`] or a buffer over [`MAX_BUFFER`].
    TooLarge,
}

#[derive(Debug)]
struct Bucket {
    rate: u64,
    tokens: u64,
    at: u64,
}

impl Bucket {
    fn new(rate: u32) -> Self {
        Self {
            rate: u64::from(rate),
            tokens: u64::from(rate),
            at: 0,
        }
    }
    fn take(&mut self, n: usize, now_ms: u64) -> bool {
        let elapsed = now_ms.saturating_sub(self.at);
        self.at = self.at.max(now_ms);
        self.tokens = self.rate.min(
            self.tokens
                .saturating_add(elapsed.saturating_mul(self.rate) / 1000),
        );
        let n = n as u64;
        if self.tokens < n {
            return false;
        }
        self.tokens = self.tokens.saturating_sub(n);
        true
    }
}

/// One TURN connection, one allocation, for the call in progress only.
#[derive(Debug)]
pub struct TurnLite {
    cfg: Config,
    key: [u8; 16],
    buf: Vec<u8>,
    allocated_until: Option<u64>,
    permissions: HashMap<IpAddr, u64>,
    channels: HashMap<u16, SocketAddr>,
    peer_channel: HashMap<SocketAddr, u16>,
    up: Bucket,
    down: Bucket,
}

struct Msg<'a> {
    method: u16,
    class: u16,
    tid: [u8; 12],
    raw: &'a [u8],
    attrs: Vec<(u16, usize, &'a [u8])>,
}

impl Msg<'_> {
    fn attr(&self, t: u16) -> Option<&[u8]> {
        self.attrs.iter().find(|a| a.0 == t).map(|a| a.2)
    }
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([
        *b.get(at)?,
        *b.get(at.checked_add(1)?)?,
    ]))
}

fn pad4(n: usize) -> usize {
    n.saturating_add(3) & !3
}

fn message_type(method: u16, class: u16) -> u16 {
    (method & 0x000F)
        | ((method & 0x0070) << 1)
        | ((method & 0x0F80) << 2)
        | ((class & 1) << 4)
        | ((class & 2) << 7)
}

fn parse(raw: &[u8]) -> Option<Msg<'_>> {
    let t = be16(raw, 0)?;
    let len = usize::from(be16(raw, 2)?);
    if raw.len() != HEADER.checked_add(len)?
        || u32::from_be_bytes(raw.get(4..8)?.try_into().ok()?) != MAGIC
    {
        return None;
    }
    let method = (t & 0x000F) | ((t & 0x00E0) >> 1) | ((t & 0x3E00) >> 2);
    let class = ((t >> 4) & 1) | ((t >> 7) & 2);
    let tid: [u8; 12] = raw.get(8..20)?.try_into().ok()?;
    let mut attrs = Vec::new();
    let mut at = HEADER;
    while at < raw.len() {
        let ty = be16(raw, at)?;
        let l = usize::from(be16(raw, at.checked_add(2)?)?);
        let start = at.checked_add(4)?;
        let value = raw.get(start..start.checked_add(l)?)?;
        attrs.push((ty, at, value));
        at = start.checked_add(pad4(l))?;
    }
    Some(Msg {
        method,
        class,
        tid,
        raw,
        attrs,
    })
}

fn xor_addr(addr: SocketAddr, tid: &[u8; 12]) -> Vec<u8> {
    let port = addr.port() ^ ((MAGIC >> 16) as u16);
    let mut out = vec![0u8];
    match addr.ip() {
        IpAddr::V4(ip) => {
            out.push(1);
            out.extend_from_slice(&port.to_be_bytes());
            let v = u32::from(ip) ^ MAGIC;
            out.extend_from_slice(&v.to_be_bytes());
        }
        IpAddr::V6(ip) => {
            out.push(2);
            out.extend_from_slice(&port.to_be_bytes());
            let mut mask = MAGIC.to_be_bytes().to_vec();
            mask.extend_from_slice(tid);
            out.extend(ip.octets().iter().zip(mask.iter()).map(|(a, b)| a ^ b));
        }
    }
    out
}

fn parse_xor_addr(v: &[u8], tid: &[u8; 12]) -> Option<SocketAddr> {
    let port = be16(v, 2)? ^ ((MAGIC >> 16) as u16);
    match *v.get(1)? {
        1 if v.len() == 8 => {
            let ip = u32::from_be_bytes(v.get(4..8)?.try_into().ok()?) ^ MAGIC;
            Some(SocketAddr::new(IpAddr::from(ip.to_be_bytes()), port))
        }
        2 if v.len() == 20 => {
            let mut mask = MAGIC.to_be_bytes().to_vec();
            mask.extend_from_slice(tid);
            let o: Vec<u8> = v
                .get(4..20)?
                .iter()
                .zip(mask.iter())
                .map(|(a, b)| a ^ b)
                .collect();
            let o: [u8; 16] = o.try_into().ok()?;
            Some(SocketAddr::new(IpAddr::from(o), port))
        }
        _ => None,
    }
}

/// The phone endpoint's demux after TLS: a connection whose first byte is a STUN first byte goes to TURN (a TURN
/// client always opens with Allocate). Only the first byte of a connection decides: ChannelData's range (0x40-0x4F)
/// overlaps HTTP methods ("G", "H", ...), so it is never used to choose.
pub fn is_turn_first_byte(b: u8) -> bool {
    b & 0xC0 == 0
}

/// HMAC-SHA1 key of the long-term credential: MD5(username ":" realm ":" password).
pub fn long_term_key(username: &str, realm: &str, password: &str) -> [u8; 16] {
    let mut h = Md5::new();
    h.update(format!("{username}:{realm}:{password}").as_bytes());
    h.finalize().into()
}

/// A STUN message with optional MESSAGE-INTEGRITY (under `key`) and FINGERPRINT.
pub fn encode(
    method: u16,
    class: u16,
    tid: &[u8; 12],
    attrs: &[(u16, Vec<u8>)],
    key: Option<&[u8]>,
    fingerprint: bool,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(128);
    out.extend_from_slice(&message_type(method, class).to_be_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&MAGIC.to_be_bytes());
    out.extend_from_slice(tid);
    for (t, v) in attrs {
        out.extend_from_slice(&t.to_be_bytes());
        out.extend_from_slice(&(v.len() as u16).to_be_bytes());
        out.extend_from_slice(v);
        out.resize(pad4(out.len()), 0);
    }
    let set_len = |out: &mut Vec<u8>, extra: usize| {
        let l = (out.len().saturating_sub(HEADER).saturating_add(extra)) as u16;
        if let Some(s) = out.get_mut(2..4) {
            s.copy_from_slice(&l.to_be_bytes());
        }
    };
    if let Some(k) = key {
        set_len(&mut out, 24);
        if let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(k) {
            mac.update(&out);
            out.extend_from_slice(&A_MESSAGE_INTEGRITY.to_be_bytes());
            out.extend_from_slice(&20u16.to_be_bytes());
            out.extend_from_slice(&mac.finalize().into_bytes());
        }
    }
    if fingerprint {
        set_len(&mut out, 8);
        let crc = crc32fast::hash(&out) ^ 0x5354_554E;
        out.extend_from_slice(&A_FINGERPRINT.to_be_bytes());
        out.extend_from_slice(&4u16.to_be_bytes());
        out.extend_from_slice(&crc.to_be_bytes());
    }
    set_len(&mut out, 0);
    out
}

fn integrity_ok(m: &Msg<'_>, key: &[u8]) -> bool {
    let Some(&(_, at, value)) = m.attrs.iter().find(|a| a.0 == A_MESSAGE_INTEGRITY) else {
        return false;
    };
    let (Some(head), Some(body)) = (m.raw.get(..2), m.raw.get(4..at)) else {
        return false;
    };
    let len = (at.saturating_sub(HEADER).saturating_add(24)) as u16;
    let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(key) else {
        return false;
    };
    mac.update(head);
    mac.update(&len.to_be_bytes());
    mac.update(body);
    mac.verify_slice(value).is_ok()
}

/// A ChannelData frame (padded to 4 bytes, as over TCP).
pub fn channel_data(channel: u16, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(pad4(data.len().saturating_add(4)));
    out.extend_from_slice(&channel.to_be_bytes());
    out.extend_from_slice(&(data.len() as u16).to_be_bytes());
    out.extend_from_slice(data);
    out.resize(pad4(out.len()), 0);
    out
}

impl TurnLite {
    pub fn new(cfg: Config) -> Self {
        let key = long_term_key(&cfg.username, &cfg.realm, &cfg.password);
        let rate = cfg.rate_bytes_per_s;
        Self {
            cfg,
            key,
            buf: Vec::new(),
            allocated_until: None,
            permissions: HashMap::new(),
            channels: HashMap::new(),
            peer_channel: HashMap::new(),
            up: Bucket::new(rate),
            down: Bucket::new(rate),
        }
    }

    pub fn is_allocated(&self, now_ms: u64) -> bool {
        self.allocated_until.is_some_and(|u| now_ms < u)
    }

    /// Bytes from the client's TLS stream, in any split. Returns what to send, or an error that ends the connection.
    pub fn on_client_bytes(&mut self, data: &[u8], now_ms: u64) -> Result<Vec<Event>, Error> {
        if self.buf.len().saturating_add(data.len()) > MAX_BUFFER {
            return Err(Error::TooLarge);
        }
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        while let Some(&first) = self.buf.first() {
            let need = if first & 0xC0 == 0 {
                let Some(len) = be16(&self.buf, 2) else { break };
                HEADER.saturating_add(usize::from(len))
            } else if (0x40..=0x4F).contains(&first) {
                let Some(len) = be16(&self.buf, 2) else { break };
                pad4(usize::from(len).saturating_add(4))
            } else {
                return Err(Error::NotTurn);
            };
            if need > MAX_FRAME {
                return Err(Error::TooLarge);
            }
            if self.buf.len() < need {
                break;
            }
            let frame: Vec<u8> = self.buf.drain(..need).collect();
            if first & 0xC0 == 0 {
                let Some(m) = parse(&frame) else {
                    return Err(Error::NotTurn);
                };
                self.on_message(&m, now_ms, &mut out);
            } else {
                self.on_channel_data(&frame, now_ms, &mut out);
            }
        }
        Ok(out)
    }

    /// A datagram that reached the relay socket from `peer`: framed for the client, or dropped (None).
    pub fn on_peer_datagram(
        &mut self,
        peer: SocketAddr,
        data: &[u8],
        now_ms: u64,
    ) -> Option<Vec<u8>> {
        if !self.is_allocated(now_ms)
            || !self.permitted(peer.ip(), now_ms)
            || data.len() > MAX_FRAME.saturating_sub(64)
            || !self.down.take(data.len(), now_ms)
        {
            return None;
        }
        if let Some(&ch) = self.peer_channel.get(&peer) {
            return Some(channel_data(ch, data));
        }
        let tid = indication_tid(now_ms);
        Some(encode(
            DATA,
            CLASS_INDICATION,
            &tid,
            &[
                (A_XOR_PEER_ADDRESS, xor_addr(peer, &tid)),
                (A_DATA, data.to_vec()),
            ],
            None,
            false,
        ))
    }

    fn permitted(&self, ip: IpAddr, now_ms: u64) -> bool {
        self.permissions.get(&ip).is_some_and(|&u| now_ms < u)
    }

    fn on_channel_data(&mut self, frame: &[u8], now_ms: u64, out: &mut Vec<Event>) {
        let (Some(ch), Some(len)) = (be16(frame, 0), be16(frame, 2)) else {
            return;
        };
        let Some(data) = frame.get(4..4usize.saturating_add(usize::from(len))) else {
            return;
        };
        let Some(&peer) = self.channels.get(&ch) else {
            return;
        };
        if self.is_allocated(now_ms)
            && self.permitted(peer.ip(), now_ms)
            && self.up.take(data.len(), now_ms)
        {
            out.push(Event::ToPeer {
                peer,
                data: data.to_vec(),
            });
        }
    }

    fn reply(&self, m: &Msg<'_>, class: u16, attrs: &[(u16, Vec<u8>)], signed: bool) -> Event {
        Event::ToClient(encode(
            m.method,
            class,
            &m.tid,
            attrs,
            signed.then_some(&self.key[..]),
            true,
        ))
    }

    fn error(&self, m: &Msg<'_>, code: u16, reason: &str, signed: bool) -> Event {
        let mut v = vec![0, 0, (code / 100) as u8, (code % 100) as u8];
        v.extend_from_slice(reason.as_bytes());
        let mut attrs = vec![(A_ERROR_CODE, v)];
        if code == 401 || code == 438 {
            attrs.push((A_REALM, self.cfg.realm.as_bytes().to_vec()));
            attrs.push((A_NONCE, self.cfg.nonce.as_bytes().to_vec()));
        }
        self.reply(m, CLASS_ERROR, &attrs, signed)
    }

    fn authenticated(&self, m: &Msg<'_>, out: &mut Vec<Event>) -> bool {
        let (Some(user), Some(realm), Some(nonce)) =
            (m.attr(A_USERNAME), m.attr(A_REALM), m.attr(A_NONCE))
        else {
            out.push(self.error(m, 401, "Unauthorized", false));
            return false;
        };
        if m.attr(A_MESSAGE_INTEGRITY).is_none()
            || user != self.cfg.username.as_bytes()
            || realm != self.cfg.realm.as_bytes()
        {
            out.push(self.error(m, 401, "Unauthorized", false));
            return false;
        }
        if nonce != self.cfg.nonce.as_bytes() {
            out.push(self.error(m, 438, "Stale Nonce", false));
            return false;
        }
        if !integrity_ok(m, &self.key) {
            out.push(self.error(m, 401, "Unauthorized", false));
            return false;
        }
        true
    }

    fn lifetime(&self, m: &Msg<'_>) -> u32 {
        m.attr(A_LIFETIME)
            .and_then(|v| v.try_into().ok())
            .map(u32::from_be_bytes)
            .unwrap_or(DEFAULT_LIFETIME_S)
            .min(MAX_LIFETIME_S)
    }

    fn on_message(&mut self, m: &Msg<'_>, now_ms: u64, out: &mut Vec<Event>) {
        if m.class == CLASS_INDICATION {
            if m.method == SEND && self.is_allocated(now_ms) {
                let peer = m
                    .attr(A_XOR_PEER_ADDRESS)
                    .and_then(|v| parse_xor_addr(v, &m.tid));
                if let (Some(peer), Some(data)) = (peer, m.attr(A_DATA))
                    && self.permitted(peer.ip(), now_ms)
                    && self.up.take(data.len(), now_ms)
                {
                    out.push(Event::ToPeer {
                        peer,
                        data: data.to_vec(),
                    });
                }
            }
            return;
        }
        if m.class != CLASS_REQUEST {
            return;
        }
        if m.method == BINDING {
            out.push(self.reply(
                m,
                CLASS_SUCCESS,
                &[(A_XOR_MAPPED_ADDRESS, xor_addr(self.cfg.client_addr, &m.tid))],
                false,
            ));
            return;
        }
        if !matches!(
            m.method,
            ALLOCATE | REFRESH | CREATE_PERMISSION | CHANNEL_BIND
        ) {
            out.push(self.error(m, 400, "Bad Request", false));
            return;
        }
        if !self.authenticated(m, out) {
            return;
        }
        let ms = |s: u32| now_ms.saturating_add(u64::from(s).saturating_mul(1000));
        match m.method {
            ALLOCATE => {
                if self.allocated_until.is_some() {
                    out.push(self.error(m, 437, "Allocation Mismatch", true));
                    return;
                }
                if m.attr(A_REQUESTED_TRANSPORT)
                    .and_then(|v| v.first().copied())
                    != Some(17)
                {
                    out.push(self.error(m, 442, "Unsupported Transport Protocol", true));
                    return;
                }
                let life = self.lifetime(m);
                self.allocated_until = Some(ms(life));
                out.push(self.reply(
                    m,
                    CLASS_SUCCESS,
                    &[
                        (A_XOR_RELAYED_ADDRESS, xor_addr(self.cfg.relay_addr, &m.tid)),
                        (A_XOR_MAPPED_ADDRESS, xor_addr(self.cfg.client_addr, &m.tid)),
                        (A_LIFETIME, life.to_be_bytes().to_vec()),
                    ],
                    true,
                ));
            }
            REFRESH => {
                if !self.is_allocated(now_ms) {
                    out.push(self.error(m, 437, "Allocation Mismatch", true));
                    return;
                }
                let life = self.lifetime(m);
                if life == 0 {
                    self.allocated_until = Some(0);
                    self.permissions.clear();
                    self.channels.clear();
                    self.peer_channel.clear();
                } else {
                    self.allocated_until = Some(ms(life));
                }
                out.push(self.reply(
                    m,
                    CLASS_SUCCESS,
                    &[(A_LIFETIME, life.to_be_bytes().to_vec())],
                    true,
                ));
            }
            CREATE_PERMISSION => {
                if !self.is_allocated(now_ms) {
                    out.push(self.error(m, 437, "Allocation Mismatch", true));
                    return;
                }
                let peers: Vec<Option<SocketAddr>> = m
                    .attrs
                    .iter()
                    .filter(|a| a.0 == A_XOR_PEER_ADDRESS)
                    .map(|a| parse_xor_addr(a.2, &m.tid))
                    .collect();
                if peers.is_empty()
                    || peers
                        .iter()
                        .any(|p| p.map(|p| p.ip()) != Some(self.cfg.peer_ip))
                {
                    out.push(self.error(m, 403, "Forbidden", true));
                    return;
                }
                self.permissions
                    .insert(self.cfg.peer_ip, now_ms.saturating_add(PERMISSION_MS));
                out.push(self.reply(m, CLASS_SUCCESS, &[], true));
            }
            _ => {
                if !self.is_allocated(now_ms) {
                    out.push(self.error(m, 437, "Allocation Mismatch", true));
                    return;
                }
                let ch = m.attr(A_CHANNEL_NUMBER).and_then(|v| be16(v, 0));
                let peer = m
                    .attr(A_XOR_PEER_ADDRESS)
                    .and_then(|v| parse_xor_addr(v, &m.tid));
                let (Some(ch), Some(peer)) = (ch, peer) else {
                    out.push(self.error(m, 400, "Bad Request", true));
                    return;
                };
                if peer.ip() != self.cfg.peer_ip {
                    out.push(self.error(m, 403, "Forbidden", true));
                    return;
                }
                let clash = self.channels.get(&ch).is_some_and(|p| *p != peer)
                    || self.peer_channel.get(&peer).is_some_and(|c| *c != ch);
                if !(0x4000..=0x4FFF).contains(&ch) || clash {
                    out.push(self.error(m, 400, "Bad Request", true));
                    return;
                }
                self.channels.insert(ch, peer);
                self.peer_channel.insert(peer, ch);
                self.permissions
                    .insert(peer.ip(), now_ms.saturating_add(PERMISSION_MS));
                out.push(self.reply(m, CLASS_SUCCESS, &[], true));
            }
        }
    }
}

fn indication_tid(now_ms: u64) -> [u8; 12] {
    let mut t = [0u8; 12];
    if let Some(s) = t.get_mut(4..12) {
        s.copy_from_slice(&now_ms.to_be_bytes());
    }
    t
}

#[cfg(test)]
mod tests;

//! The safe half: config parsing and the result encoding shared by the C and JNI exports.

#![forbid(unsafe_code)]

use std::net::{IpAddr, SocketAddr};

use flagship_turn_lite::{Config, Error, Event, TurnLite};

/// One TURN connection of one call, plus the one peer IP its datagrams may go to.
#[derive(Debug)]
pub struct Session {
    turn: TurnLite,
    peer_ip: IpAddr,
}

pub const OK: u8 = 0;
pub const NOT_TURN: u8 = 1;
pub const TOO_LARGE: u8 = 2;

impl Session {
    /// Seven UTF-8 lines: realm, username, password, nonce, relay address, peer IP, payload bytes per second.
    pub fn from_config(config: &[u8]) -> Option<Self> {
        let text = std::str::from_utf8(config).ok()?;
        let f: Vec<&str> = text.lines().collect();
        let [realm, username, password, nonce, relay, peer, rate] = f.as_slice() else {
            return None;
        };
        let relay_addr: SocketAddr = relay.parse().ok()?;
        let peer_ip: IpAddr = peer.parse().ok()?;
        if !relay_addr.ip().is_loopback()
            || !peer_ip.is_loopback()
            || username.is_empty()
            || password.is_empty()
        {
            return None;
        }
        let turn = TurnLite::new(Config {
            realm: (*realm).to_owned(),
            username: (*username).to_owned(),
            password: (*password).to_owned(),
            nonce: (*nonce).to_owned(),
            client_addr: SocketAddr::from(([0, 0, 0, 0], 0)),
            relay_addr,
            peer_ip,
            rate_bytes_per_s: rate.parse().ok()?,
        });
        Some(Self { turn, peer_ip })
    }

    pub fn client_bytes(&mut self, data: &[u8], now_ms: u64) -> Vec<u8> {
        match self.turn.on_client_bytes(data, now_ms) {
            Ok(events) => {
                let mut client = Vec::new();
                let mut peers = Vec::new();
                for e in events {
                    match e {
                        Event::ToClient(b) => client.extend_from_slice(&b),
                        Event::ToPeer { peer, data } if peer.ip() == self.peer_ip => {
                            peers.push((peer.port(), data))
                        }
                        Event::ToPeer { .. } => {}
                    }
                }
                encode(OK, &client, &peers)
            }
            Err(Error::NotTurn) => encode(NOT_TURN, &[], &[]),
            Err(Error::TooLarge) => encode(TOO_LARGE, &[], &[]),
        }
    }

    pub fn peer_datagram(&mut self, port: u16, data: &[u8], now_ms: u64) -> Vec<u8> {
        let framed = self
            .turn
            .on_peer_datagram(SocketAddr::new(self.peer_ip, port), data, now_ms);
        encode(OK, framed.as_deref().unwrap_or_default(), &[])
    }

    pub fn is_allocated(&self, now_ms: u64) -> bool {
        self.turn.is_allocated(now_ms)
    }
}

/// See include/flagship_turn.h. A datagram over 65535 bytes cannot come out of TurnLite (its frames are capped far
/// below), so it is skipped rather than truncated.
pub fn encode(status: u8, client: &[u8], peers: &[(u16, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(client.len().saturating_add(16));
    out.push(status);
    out.extend_from_slice(&u32::try_from(client.len()).unwrap_or(0).to_be_bytes());
    if u32::try_from(client.len()).is_ok() {
        out.extend_from_slice(client);
    }
    let peers: Vec<&(u16, Vec<u8>)> = peers
        .iter()
        .filter(|(_, d)| u16::try_from(d.len()).is_ok())
        .collect();
    out.extend_from_slice(&u16::try_from(peers.len()).unwrap_or(u16::MAX).to_be_bytes());
    for (port, d) in peers.into_iter().take(usize::from(u16::MAX)) {
        out.extend_from_slice(&port.to_be_bytes());
        out.extend_from_slice(&u16::try_from(d.len()).unwrap_or(0).to_be_bytes());
        out.extend_from_slice(d);
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    const CONFIG: &str =
        "alice.flagship.services\nuser\nsecret\nn0nce\n127.0.0.1:50000\n127.0.0.1\n8000";

    // A Binding request: 20-byte header, magic cookie, no attributes.
    fn binding() -> Vec<u8> {
        let mut m = vec![0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xA4, 0x42];
        m.extend_from_slice(&[7u8; 12]);
        m
    }

    #[test]
    fn parses_the_seven_lines_and_refuses_anything_else() {
        assert!(Session::from_config(CONFIG.as_bytes()).is_some());
        assert!(Session::from_config(b"a\nb\nc").is_none());
        let public_relay = CONFIG.replace("127.0.0.1:50000", "192.0.2.1:50000");
        assert!(Session::from_config(public_relay.as_bytes()).is_none());
        let public_peer = CONFIG.replace("\n127.0.0.1\n", "\n192.0.2.1\n");
        assert!(Session::from_config(public_peer.as_bytes()).is_none());
        assert!(Session::from_config(&[0xff, 0xfe]).is_none());
    }

    #[test]
    fn answers_a_binding_and_closes_on_garbage() {
        let mut s = Session::from_config(CONFIG.as_bytes()).unwrap();
        let out = s.client_bytes(&binding(), 1);
        assert_eq!(out[0], OK);
        let n = u32::from_be_bytes(out[1..5].try_into().unwrap()) as usize;
        assert!(n >= 20);
        assert_eq!(&out[5..7], &[0x01, 0x01]);
        assert_eq!(&out[5 + n..], &[0, 0]);
        assert_eq!(s.client_bytes(b"PUT / HTTP/1.1\r\n", 2)[0], NOT_TURN);
    }

    #[test]
    fn drops_a_peer_datagram_without_an_allocation() {
        let mut s = Session::from_config(CONFIG.as_bytes()).unwrap();
        assert_eq!(
            s.peer_datagram(40000, b"rtp", 1),
            vec![OK, 0, 0, 0, 0, 0, 0]
        );
        assert!(!s.is_allocated(1));
    }

    #[test]
    fn encodes_peer_datagrams() {
        let out = encode(OK, b"ab", &[(5, vec![9, 9, 9])]);
        assert_eq!(
            out,
            vec![0, 0, 0, 0, 2, b'a', b'b', 0, 1, 0, 5, 0, 3, 9, 9, 9]
        );
    }
}

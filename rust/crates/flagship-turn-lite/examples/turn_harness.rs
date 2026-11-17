//! A TURN-over-TCP server around `TurnLite`, for driving it from a real browser (tools/voici-calls-ice/).
//!
//! `turn_harness <listen> <relay-ip> <peer-ip> <user> <password> <rate-bytes-per-s>`: every TCP connection gets its own
//! `TurnLite` and its own UDP relay socket on `<relay-ip>`, exactly like the phone's responder (one allocation, one
//! peer IP). Each STUN message and ChannelData frame in both directions is printed to stderr (type, size), so a run
//! shows what the browser and the peer exchanged.
//!
//! With a 7th argument `loopback`, the browser sees what it sees on a real phone: the relayed address and the peer
//! are 127.0.0.1 (the harness swaps `<relay-ip>` and 127.0.0.1 on the way in and out, since a browser's own peer
//! connection never gathers a loopback candidate).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stderr)]

use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use flagship_turn_lite::{Config, Event, TurnLite};

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn describe(b: &[u8]) -> String {
    match b.first() {
        Some(f) if f & 0xC0 == 0 && b.len() >= 20 && b[4..8] == [0x21, 0x12, 0xA4, 0x42] => {
            let t = u16::from_be_bytes([b[0], b[1]]);
            let method = (t & 0x000F) | ((t & 0x00E0) >> 1) | ((t & 0x3E00) >> 2);
            let class = ((t >> 4) & 1) | ((t >> 7) & 2);
            format!("stun m={method:#05x} c={class} len={}", b.len())
        }
        Some(f) if (0x40..=0x4F).contains(f) && b.len() >= 4 => {
            format!("chan {:#06x} len={}", u16::from_be_bytes([b[0], b[1]]), u16::from_be_bytes([b[2], b[3]]))
        }
        Some(f) if (20..=63).contains(f) => format!("dtls len={}", b.len()),
        Some(f) if (128..=191).contains(f) && b.len() >= 2 && (200..=206).contains(&b[1]) => format!("rtcp len={}", b.len()),
        Some(f) if (128..=191).contains(f) => format!("rtp len={}", b.len()),
        _ => format!("other len={}", b.len()),
    }
}

fn serve(tcp: TcpStream, relay_ip: IpAddr, peer_ip: IpAddr, user: String, pass: String, rate: u32, n: usize, lo: bool) {
    let client = tcp.peer_addr().unwrap();
    let udp = UdpSocket::bind(SocketAddr::new(relay_ip, 0)).unwrap();
    let local = IpAddr::from([127, 0, 0, 1]);
    let (relay, peer_ip) = if lo { (SocketAddr::new(local, udp.local_addr().unwrap().port()), local) } else { (udp.local_addr().unwrap(), peer_ip) };
    let real = relay_ip;
    eprintln!("[{n}] conn from {client}, relay {relay}");
    let turn = Arc::new(Mutex::new(TurnLite::new(Config {
        realm: "flagship".into(),
        username: user,
        password: pass,
        nonce: format!("{:032x}", now_ms()),
        client_addr: client,
        relay_addr: relay,
        peer_ip,
        rate_bytes_per_s: rate,
    })));
    let writer = Arc::new(Mutex::new(tcp.try_clone().unwrap()));
    {
        let (turn, writer, udp) = (turn.clone(), writer.clone(), udp.try_clone().unwrap());
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut dropped = 0u32;
            loop {
                let Ok((len, from)) = udp.recv_from(&mut buf) else { return };
                let from = if lo { SocketAddr::new(local, from.port()) } else { from };
                let out = turn.lock().unwrap().on_peer_datagram(from, &buf[..len], now_ms());
                match out {
                    Some(b) => {
                        eprintln!("[{n}] peer {from} {} -> client {}", describe(&buf[..len]), describe(&b));
                        if writer.lock().unwrap().write_all(&b).is_err() {
                            return;
                        }
                    }
                    None => {
                        dropped += 1;
                        eprintln!("[{n}] peer {from} {} DROPPED (#{dropped})", describe(&buf[..len]));
                    }
                }
            }
        });
    }
    let mut tcp = tcp;
    let mut buf = [0u8; 16 * 1024];
    loop {
        let len = match tcp.read(&mut buf) {
            Ok(0) | Err(_) => {
                eprintln!("[{n}] client closed");
                return;
            }
            Ok(l) => l,
        };
        let r = turn.lock().unwrap().on_client_bytes(&buf[..len], now_ms());
        match r {
            Err(e) => {
                eprintln!("[{n}] error {e:?}, closing");
                return;
            }
            Ok(events) => {
                if events.is_empty() {
                    eprintln!("[{n}] client {} bytes -> nothing", len);
                }
                for e in events {
                    match e {
                        Event::ToClient(b) => {
                            eprintln!("[{n}] reply {}", describe(&b));
                            if writer.lock().unwrap().write_all(&b).is_err() {
                                return;
                            }
                        }
                        Event::ToPeer { peer, data } => {
                            eprintln!("[{n}] client -> peer {peer} {}", describe(&data));
                            let to = if lo { SocketAddr::new(real, peer.port()) } else { peer };
                            let _ = udp.send_to(&data, to);
                        }
                    }
                }
            }
        }
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let listen = &a[1];
    let relay_ip: IpAddr = a[2].parse().unwrap();
    let peer_ip: IpAddr = a[3].parse().unwrap();
    let (user, pass) = (a[4].clone(), a[5].clone());
    let rate: u32 = a[6].parse().unwrap();
    let lo = a.get(7).is_some_and(|x| x == "loopback");
    let l = TcpListener::bind(listen.as_str()).unwrap();
    eprintln!("listening {}", l.local_addr().unwrap());
    for (n, s) in l.incoming().enumerate() {
        let Ok(s) = s else { continue };
        let (user, pass) = (user.clone(), pass.clone());
        std::thread::spawn(move || serve(s, relay_ip, peer_ip, user, pass, rate, n, lo));
    }
}

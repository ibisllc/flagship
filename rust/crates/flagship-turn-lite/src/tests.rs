#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::expect_used
)]

use super::*;
use std::net::{Ipv4Addr, SocketAddrV4};

const USER: &str = "7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e";
const PASS: &str = "5ec75ec75ec75ec75ec75ec75ec75ec75ec75ec75ec75ec75ec75ec75ec75ec7";
const REALM: &str = "alice.flagship.services";
const NONCE: &str = "n0nce";

fn loopback(port: u16) -> SocketAddr {
    SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
}

fn server() -> TurnLite {
    TurnLite::new(Config {
        realm: REALM.into(),
        username: USER.into(),
        password: PASS.into(),
        nonce: NONCE.into(),
        client_addr: SocketAddr::from(([0, 0, 0, 0], 0)),
        relay_addr: loopback(50000),
        peer_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
        rate_bytes_per_s: 8000,
    })
}

fn tid(n: u8) -> [u8; 12] {
    [n; 12]
}

fn req(method: u16, t: u8, extra: Vec<(u16, Vec<u8>)>, pass: &str) -> Vec<u8> {
    let mut attrs = extra;
    attrs.push((A_USERNAME, USER.as_bytes().to_vec()));
    attrs.push((A_REALM, REALM.as_bytes().to_vec()));
    attrs.push((A_NONCE, NONCE.as_bytes().to_vec()));
    encode(
        method,
        CLASS_REQUEST,
        &tid(t),
        &attrs,
        Some(&long_term_key(USER, REALM, pass)),
        true,
    )
}

fn one(events: Vec<Event>) -> Vec<u8> {
    assert_eq!(events.len(), 1, "{events:?}");
    match events.into_iter().next().unwrap() {
        Event::ToClient(b) => b,
        e => unreachable!("{e:?}"),
    }
}

fn class_and_code(b: &[u8]) -> (u16, Option<u16>) {
    let m = parse(b).unwrap();
    let code = m
        .attr(A_ERROR_CODE)
        .map(|v| u16::from(v[2]) * 100 + u16::from(v[3]));
    (m.class, code)
}

fn allocate(s: &mut TurnLite) {
    let r = one(s
        .on_client_bytes(
            &req(
                ALLOCATE,
                2,
                vec![(A_REQUESTED_TRANSPORT, vec![17, 0, 0, 0])],
                PASS,
            ),
            0,
        )
        .unwrap());
    let m = parse(&r).unwrap();
    assert_eq!(m.class, CLASS_SUCCESS);
    assert!(integrity_ok(&m, &long_term_key(USER, REALM, PASS)));
    assert_eq!(
        parse_xor_addr(m.attr(A_XOR_RELAYED_ADDRESS).unwrap(), &m.tid),
        Some(loopback(50000))
    );
}

#[test]
fn allocate_asks_for_credentials_then_accepts_the_call_credential() {
    let mut s = server();
    let bare = encode(
        ALLOCATE,
        CLASS_REQUEST,
        &tid(1),
        &[(A_REQUESTED_TRANSPORT, vec![17, 0, 0, 0])],
        None,
        false,
    );
    let r = one(s.on_client_bytes(&bare, 0).unwrap());
    assert_eq!(class_and_code(&r), (CLASS_ERROR, Some(401)));
    let m = parse(&r).unwrap();
    assert_eq!(m.attr(A_REALM), Some(REALM.as_bytes()));
    assert_eq!(m.attr(A_NONCE), Some(NONCE.as_bytes()));
    allocate(&mut s);
    assert!(s.is_allocated(1));
    let again = one(s
        .on_client_bytes(
            &req(
                ALLOCATE,
                3,
                vec![(A_REQUESTED_TRANSPORT, vec![17, 0, 0, 0])],
                PASS,
            ),
            1,
        )
        .unwrap());
    assert_eq!(class_and_code(&again), (CLASS_ERROR, Some(437)));
}

#[test]
fn refuses_a_wrong_password_a_stale_nonce_and_tcp_relaying() {
    let mut s = server();
    let r = one(s
        .on_client_bytes(
            &req(
                ALLOCATE,
                2,
                vec![(A_REQUESTED_TRANSPORT, vec![17, 0, 0, 0])],
                "wrong",
            ),
            0,
        )
        .unwrap());
    assert_eq!(class_and_code(&r), (CLASS_ERROR, Some(401)));
    let stale = encode(
        ALLOCATE,
        CLASS_REQUEST,
        &tid(4),
        &[
            (A_REQUESTED_TRANSPORT, vec![17, 0, 0, 0]),
            (A_USERNAME, USER.into()),
            (A_REALM, REALM.into()),
            (A_NONCE, b"old".to_vec()),
        ],
        Some(&long_term_key(USER, REALM, PASS)),
        false,
    );
    assert_eq!(
        class_and_code(&one(s.on_client_bytes(&stale, 0).unwrap())),
        (CLASS_ERROR, Some(438))
    );
    let tcp = one(s
        .on_client_bytes(
            &req(
                ALLOCATE,
                5,
                vec![(A_REQUESTED_TRANSPORT, vec![6, 0, 0, 0])],
                PASS,
            ),
            0,
        )
        .unwrap());
    assert_eq!(class_and_code(&tcp), (CLASS_ERROR, Some(442)));
    assert!(!s.is_allocated(0));
}

#[test]
fn only_the_phones_loopback_peer_and_relayed_data_both_ways() {
    let mut s = server();
    allocate(&mut s);
    let other = SocketAddr::from(([192, 168, 1, 7], 9));
    let r = one(s
        .on_client_bytes(
            &req(
                CREATE_PERMISSION,
                6,
                vec![(A_XOR_PEER_ADDRESS, xor_addr(other, &tid(6)))],
                PASS,
            ),
            10,
        )
        .unwrap());
    assert_eq!(class_and_code(&r), (CLASS_ERROR, Some(403)));
    let peer = loopback(40000);
    let r = one(s
        .on_client_bytes(
            &req(
                CHANNEL_BIND,
                7,
                vec![
                    (A_CHANNEL_NUMBER, vec![0x40, 0x01, 0, 0]),
                    (A_XOR_PEER_ADDRESS, xor_addr(peer, &tid(7))),
                ],
                PASS,
            ),
            10,
        )
        .unwrap());
    assert_eq!(class_and_code(&r).0, CLASS_SUCCESS);
    let ev = s
        .on_client_bytes(&channel_data(0x4001, &[9; 88]), 20)
        .unwrap();
    assert_eq!(
        ev,
        vec![Event::ToPeer {
            peer,
            data: vec![9; 88]
        }]
    );
    assert_eq!(
        s.on_peer_datagram(peer, &[7; 88], 30),
        Some(channel_data(0x4001, &[7; 88]))
    );
    assert_eq!(s.on_peer_datagram(other, &[7; 88], 30), None);
    let send = encode(
        SEND,
        CLASS_INDICATION,
        &tid(8),
        &[
            (A_XOR_PEER_ADDRESS, xor_addr(peer, &tid(8))),
            (A_DATA, vec![1, 2, 3]),
        ],
        None,
        false,
    );
    assert_eq!(
        s.on_client_bytes(&send, 40).unwrap(),
        vec![Event::ToPeer {
            peer,
            data: vec![1, 2, 3]
        }]
    );
    let clash = one(s
        .on_client_bytes(
            &req(
                CHANNEL_BIND,
                9,
                vec![
                    (A_CHANNEL_NUMBER, vec![0x40, 0x02, 0, 0]),
                    (A_XOR_PEER_ADDRESS, xor_addr(peer, &tid(9))),
                ],
                PASS,
            ),
            50,
        )
        .unwrap());
    assert_eq!(class_and_code(&clash), (CLASS_ERROR, Some(400)));
}

#[test]
fn data_indication_without_a_channel_and_any_split_of_the_stream() {
    let mut s = server();
    allocate(&mut s);
    let peer = loopback(40000);
    let perm = req(
        CREATE_PERMISSION,
        6,
        vec![(A_XOR_PEER_ADDRESS, xor_addr(peer, &tid(6)))],
        PASS,
    );
    let mut events = Vec::new();
    for b in perm.chunks(3) {
        events.extend(s.on_client_bytes(b, 10).unwrap());
    }
    assert_eq!(class_and_code(&one(events)).0, CLASS_SUCCESS);
    let d = s.on_peer_datagram(peer, &[5; 10], 20).unwrap();
    let m = parse(&d).unwrap();
    assert_eq!((m.method, m.class), (DATA, CLASS_INDICATION));
    assert_eq!(m.attr(A_DATA), Some(&[5u8; 10][..]));
    assert_eq!(
        parse_xor_addr(m.attr(A_XOR_PEER_ADDRESS).unwrap(), &m.tid),
        Some(peer)
    );
}

#[test]
fn the_rate_cap_drops_over_budget_and_refills() {
    let mut s = server();
    allocate(&mut s);
    let peer = loopback(40000);
    one(s
        .on_client_bytes(
            &req(
                CHANNEL_BIND,
                7,
                vec![
                    (A_CHANNEL_NUMBER, vec![0x40, 0x01, 0, 0]),
                    (A_XOR_PEER_ADDRESS, xor_addr(peer, &tid(7))),
                ],
                PASS,
            ),
            0,
        )
        .unwrap());
    let mut sent = 0;
    for _ in 0..200 {
        sent += s
            .on_client_bytes(&channel_data(0x4001, &[0; 100]), 0)
            .unwrap()
            .len();
    }
    assert_eq!(sent, 80);
    assert_eq!(
        s.on_client_bytes(&channel_data(0x4001, &[0; 100]), 1000)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn refresh_zero_ends_the_allocation_and_garbage_ends_the_connection() {
    let mut s = server();
    allocate(&mut s);
    let r = one(s
        .on_client_bytes(
            &req(
                REFRESH,
                9,
                vec![(A_LIFETIME, 0u32.to_be_bytes().to_vec())],
                PASS,
            ),
            5,
        )
        .unwrap());
    assert_eq!(class_and_code(&r).0, CLASS_SUCCESS);
    assert!(!s.is_allocated(6));
    assert_eq!(s.on_peer_datagram(loopback(40000), &[1], 7), None);
    assert!(!is_turn_first_byte(b'G') && !is_turn_first_byte(b'P') && is_turn_first_byte(0x00));
    assert_eq!(
        server().on_client_bytes(&[0x80, 1, 2, 3], 0),
        Err(Error::NotTurn)
    );
    let mut big = vec![0x40, 0x01, 0xFF, 0xFF];
    big.resize(8, 0);
    assert_eq!(server().on_client_bytes(&big, 0), Err(Error::TooLarge));
}

#[test]
fn an_allocation_expires_with_its_lifetime() {
    let mut s = server();
    let r = one(s
        .on_client_bytes(
            &req(
                ALLOCATE,
                2,
                vec![
                    (A_REQUESTED_TRANSPORT, vec![17, 0, 0, 0]),
                    (A_LIFETIME, 30u32.to_be_bytes().to_vec()),
                ],
                PASS,
            ),
            0,
        )
        .unwrap());
    assert_eq!(
        parse(&r).unwrap().attr(A_LIFETIME),
        Some(&30u32.to_be_bytes()[..])
    );
    assert!(s.is_allocated(29_999));
    assert!(!s.is_allocated(30_000));
}

#[test]
fn fingerprint_is_the_rfc_crc() {
    let b = encode(BINDING, CLASS_SUCCESS, &tid(1), &[], None, true);
    let n = b.len();
    let crc = crc32fast::hash(&b[..n - 8]) ^ 0x5354_554E;
    assert_eq!(&b[n - 4..], &crc.to_be_bytes());
    assert_eq!(u16::from_be_bytes([b[2], b[3]]) as usize, n - 20);
}

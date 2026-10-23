//! Hostile callers against an in-process server on a real Unix socket.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use flagship_keyd::server::{PeerPolicy, Server, ServerOptions};
use flagship_keyd::service::KeydService;
use flagship_keyd::wire::{MAX_FRAME_BYTES, encode_frame, to_hex};
use serde_json::{Value, json};

static N: AtomicUsize = AtomicUsize::new(0);

struct Keyd {
    dir: PathBuf,
    sock: PathBuf,
}

impl Drop for Keyd {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn me() -> (u32, u32) {
    (
        nix::unistd::geteuid().as_raw(),
        nix::unistd::getegid().as_raw(),
    )
}

fn start_with(f: impl FnOnce(&mut ServerOptions)) -> Keyd {
    let dir = std::env::temp_dir().join(format!(
        "kh-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let sock = dir.join("k.sock");
    let mut opts = ServerOptions::new(
        sock.clone(),
        PeerPolicy {
            uids: vec![me().0],
            gids: vec![],
        },
    );
    opts.audit_path = Some(dir.join("audit.log"));
    f(&mut opts);
    let svc = KeydService::new(
        &[0x42; 32],
        Some(zeroize::Zeroizing::new([0x11; 32])),
        None,
        None,
        None,
        None,
    );
    let server = Server::bind(opts, svc).unwrap();
    std::thread::spawn(move || server.serve());
    Keyd { dir, sock }
}

fn start() -> Keyd {
    start_with(|_| {})
}

fn conn(k: &Keyd) -> UnixStream {
    let s = UnixStream::connect(&k.sock).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    s
}

fn send(s: &mut UnixStream, v: &Value) {
    s.write_all(&encode_frame(v).unwrap()).unwrap();
}

/// The next response, or `None` once the server has closed the connection.
fn recv(s: &mut UnixStream) -> Option<Value> {
    let mut h = [0u8; 4];
    s.read_exact(&mut h).ok()?;
    let mut body = vec![0u8; u32::from_be_bytes(h) as usize];
    s.read_exact(&mut body).ok()?;
    Some(serde_json::from_slice(&body).unwrap())
}

fn closed(s: &mut UnixStream) -> bool {
    let mut b = [0u8; 1];
    matches!(s.read(&mut b), Ok(0) | Err(_))
}

fn hello(s: &mut UnixStream) {
    send(
        s,
        &json!({"id": 1, "op": "hello", "args": {"v": 1, "component": "hostile"}}),
    );
    assert_eq!(recv(s).unwrap()["ok"], true);
}

fn sign(s: &mut UnixStream, msg: &[u8]) -> Value {
    send(
        s,
        &json!({"id": 9, "op": "sign", "args": {"msg": to_hex(msg)}}),
    );
    recv(s).unwrap()
}

#[test]
fn a_request_before_hello_is_refused() {
    let k = start();
    let mut s = conn(&k);
    send(
        &mut s,
        &json!({"id": 4, "op": "sign", "args": {"msg": to_hex(b"flagship/inject/v1|x")}}),
    );
    let r = recv(&mut s).unwrap();
    assert_eq!(
        (r["id"].as_u64(), r["code"].as_str()),
        (Some(4), Some("not-hello"))
    );
    // The connection stays usable and hello still works.
    hello(&mut s);
}

#[test]
fn a_caller_with_the_wrong_uid_gets_nothing() {
    let (uid, gid) = me();
    let k = start_with(|o| {
        o.peers = PeerPolicy {
            uids: vec![uid.wrapping_add(4242)],
            gids: vec![gid.wrapping_add(4242)],
        }
    });
    let mut s = conn(&k);
    let _ = s.write_all(
        &encode_frame(&json!({"id": 1, "op": "hello", "args": {"v": 1, "component": "x"}}))
            .unwrap(),
    );
    assert!(recv(&mut s).is_none());
    let log = std::fs::read_to_string(k.dir.join("audit.log")).unwrap();
    assert!(
        log.contains("\"op\":\"connect\",\"component\":\"-\",\"ok\":false,\"code\":\"forbidden\""),
        "{log}"
    );
}

#[test]
fn a_caller_in_an_allowed_group_is_served() {
    let k = start_with(|o| {
        o.peers = PeerPolicy {
            uids: vec![],
            gids: vec![me().1],
        }
    });
    let mut s = conn(&k);
    hello(&mut s);
}

#[test]
fn unknown_and_authority_purposes_and_untagged_bytes_are_refused() {
    let k = start();
    let mut s = conn(&k);
    hello(&mut s);
    for m in [
        &b"flagship/totally-new/v1|x"[..],
        b"flagship/server-update/v1|x",
        b"flagship/root-entitlement/v1|x",
        b"flagship/admin-root-rotation/v1|x",
        b"flagship/app-rank/v1|x",
        b"flagship/owner-unlock/v1|x",
        b"untagged bytes",
        b"|x",
        &[0xff, 0xfe, b'|', 1],
    ] {
        let r = sign(&mut s, m);
        assert_eq!(r["code"], "forbidden", "{:?}", String::from_utf8_lossy(m));
    }
    let r = sign(&mut s, b"flagship/secret-request/v1|x");
    assert_eq!(r["ok"], true);
    assert_eq!(r["result"]["sig"].as_str().unwrap().len(), 128);
    // No generic signer hides behind another op name.
    for op in ["signBytes", "exportKey", "getPrivateKey", "exec"] {
        send(&mut s, &json!({"id": 2, "op": op, "args": {}}));
        assert_eq!(recv(&mut s).unwrap()["code"], "unknown-op");
    }
}

#[test]
fn an_oversize_frame_closes_the_connection_unanswered() {
    let k = start();
    let mut s = conn(&k);
    hello(&mut s);
    let len = u32::try_from(MAX_FRAME_BYTES + 1).unwrap();
    s.write_all(&len.to_be_bytes()).unwrap();
    assert!(closed(&mut s));
    let mut s = conn(&k);
    s.write_all(&[0, 0, 0, 0]).unwrap();
    assert!(closed(&mut s));
    // The server is still up for the next caller.
    hello(&mut conn(&k));
}

#[test]
fn a_truncated_frame_gets_no_answer() {
    let k = start();
    let mut s = conn(&k);
    s.write_all(&100u32.to_be_bytes()).unwrap();
    s.write_all(b"{\"id\":1").unwrap();
    s.shutdown(std::net::Shutdown::Write).unwrap();
    assert!(recv(&mut s).is_none());
    let mut s = conn(&k);
    s.write_all(&[0, 0]).unwrap();
    s.shutdown(std::net::Shutdown::Write).unwrap();
    assert!(recv(&mut s).is_none());
    hello(&mut conn(&k));
}

#[test]
fn a_frame_that_is_not_json_closes_the_connection() {
    let k = start();
    let mut s = conn(&k);
    s.write_all(&[0, 0, 0, 3]).unwrap();
    s.write_all(b"{{{").unwrap();
    assert!(closed(&mut s));
}

#[test]
fn another_protocol_version_is_refused_and_the_connection_ends() {
    let k = start();
    let mut s = conn(&k);
    send(
        &mut s,
        &json!({"id": 1, "op": "hello", "args": {"v": 2, "component": "x"}}),
    );
    assert_eq!(recv(&mut s).unwrap()["code"], "unsupported-version");
    assert!(closed(&mut s));
}

#[test]
fn unknown_fields_are_refused() {
    let k = start();
    let mut s = conn(&k);
    send(
        &mut s,
        &json!({"id": 1, "op": "hello", "args": {"v": 1, "component": "x", "admin": true}}),
    );
    assert_eq!(recv(&mut s).unwrap()["message"], "unknown field admin");
    send(
        &mut s,
        &json!({"id": 1, "op": "hello", "args": {"v": 1, "component": "x"}, "uid": 0}),
    );
    let r = recv(&mut s).unwrap();
    assert_eq!(
        (r["id"].as_u64(), r["message"].as_str()),
        (Some(0), Some("unknown field uid"))
    );
}

#[test]
fn a_silent_caller_is_dropped_at_the_hello_deadline() {
    let k = start_with(|o| o.hello_timeout = Duration::from_millis(200));
    let mut s = conn(&k);
    let t = Instant::now();
    assert!(closed(&mut s));
    assert!(t.elapsed() < Duration::from_secs(2));
}

#[test]
fn connections_over_the_cap_are_closed() {
    let k = start_with(|o| o.max_connections = 1);
    let mut first = conn(&k);
    hello(&mut first);
    let mut second = conn(&k);
    assert!(closed(&mut second));
    hello(&mut first);
}

/// Run as root on Linux: a caller with another uid is refused by SO_PEERCRED.
#[cfg(target_os = "linux")]
#[test]
#[ignore = "needs root to start a caller under another uid"]
fn linux_peercred_refuses_another_uid() {
    use std::os::unix::process::CommandExt;
    if let Ok(sock) = std::env::var("KEYD_HOSTILE_SOCKET") {
        // The child half: we run as nobody.
        let mut s = UnixStream::connect(sock).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let _ = s.write_all(
            &encode_frame(&json!({"id": 1, "op": "hello", "args": {"v": 1, "component": "x"}}))
                .unwrap(),
        );
        assert!(recv(&mut s).is_none());
        return;
    }
    assert_eq!(me().0, 0, "run as root");
    let k = start_with(|o| {
        o.peers = PeerPolicy {
            uids: vec![0],
            gids: vec![],
        }
    });
    std::fs::set_permissions(&k.dir, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    std::fs::set_permissions(&k.sock, std::os::unix::fs::PermissionsExt::from_mode(0o666)).unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "linux_peercred_refuses_another_uid",
            "--ignored",
            "--nocapture",
        ])
        .env("KEYD_HOSTILE_SOCKET", &k.sock)
        .uid(65534)
        .gid(65534)
        .status()
        .unwrap();
    assert!(status.success());
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "changes the test process's dumpable flag"]
fn linux_hardening_makes_the_process_undumpable() {
    flagship_keyd::hardening::harden_process().unwrap();
    assert!(!flagship_keyd::hardening::is_dumpable().unwrap());
}

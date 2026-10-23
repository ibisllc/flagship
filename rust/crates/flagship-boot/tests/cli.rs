//! `flagship-boot unlock` end to end: the real binary, the real HTTP client
//! (over loopback HTTP, the only plain-HTTP case the policy allows), the
//! `/boot` files the shell reads, and a stand-in cryptsetup that records what
//! it was given.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

mod common;

use base64ct::{Base64, Encoding};
use common::*;
use flagship_boot::gohex;
use flagship_boot::seal;
use flagship_boot::unlock::transport::Method;
use std::cell::Cell;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::rc::Rc;
use std::sync::mpsc;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

/// Serve the in-process worker over loopback HTTP; `redirect_lease` answers
/// lease GETs with a 302 instead. Returns the port and a log of requests.
fn serve(
    setup: fn(&mut Worker),
    redirect_lease: Option<String>,
) -> (u16, mpsc::Receiver<(Method, String)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut w = Worker::new(Rc::new(Cell::new(now_ms())));
        setup(&mut w);
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            w.now.set(now_ms());
            if handle(stream, &mut w, redirect_lease.as_deref(), &tx).is_err() {
                return;
            }
        }
    });
    (port, rx)
}

fn handle(
    mut s: TcpStream,
    w: &mut Worker,
    redirect: Option<&str>,
    tx: &mpsc::Sender<(Method, String)>,
) -> std::io::Result<()> {
    let mut r = BufReader::new(s.try_clone()?);
    let mut line = String::new();
    r.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = if parts.next() == Some("POST") {
        Method::Post
    } else {
        Method::Get
    };
    let path = parts.next().unwrap_or("/").to_owned();
    let (mut auth, mut len) = (String::new(), 0usize);
    loop {
        let mut h = String::new();
        r.read_line(&mut h)?;
        if h == "\r\n" || h.is_empty() {
            break;
        }
        let (k, v) = h.split_once(':').unwrap();
        match k.to_ascii_lowercase().as_str() {
            "authorization" => auth = v.trim().to_owned(),
            "content-length" => len = v.trim().parse().unwrap(),
            _ => {}
        }
    }
    let mut body = vec![0; len];
    r.read_exact(&mut body)?;
    let _ = tx.send((method, path.clone()));
    let (status, extra, body) = if let (Some(loc), true) = (
        redirect,
        path.starts_with("/api/boot/lease") || path == "/api/boot/request",
    ) {
        (302, format!("Location: {loc}\r\n"), Vec::new())
    } else {
        let body_s = String::from_utf8(body).unwrap();
        let resp = w.handle(
            method,
            &format!("http://x{path}"),
            &auth,
            (method == Method::Post).then_some(body_s.as_str()),
        );
        match resp {
            Ok(r) => (r.status, String::new(), r.body),
            Err(_) => return Ok(()),
        }
    };
    write!(
        s,
        "HTTP/1.1 {status} X\r\n{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    s.write_all(&body)
}

fn boot_dir(name: &str, port: u16, mode: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("cli-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut der = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    der.extend_from_slice(&SEED_A);
    std::fs::write(
        dir.join("identity.pem"),
        format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            Base64::encode_string(&der)
        ),
    )
    .unwrap();
    std::fs::write(dir.join("server-domain"), format!("{DOMAIN}\n")).unwrap();
    std::fs::write(
        dir.join("flagship-boot-host"),
        format!("http://127.0.0.1:{port}/\n"),
    )
    .unwrap();
    std::fs::write(dir.join("flagship-boot-unlock-mode"), format!("{mode}\n")).unwrap();
    dir
}

/// A cryptsetup stand-in: records argv and the bytes on stdin, exits `code`.
fn fake_cryptsetup(dir: &Path, code: i32) -> PathBuf {
    let p = dir.join("cryptsetup");
    std::fs::write(&p, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"{0}/argv\"\nenv > \"{0}/env\"\ncat > \"{0}/key\"\nexit {code}\n", dir.display())).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

fn unlock(dir: &Path, extra: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_flagship-boot"))
        .arg("unlock")
        .arg("--boot-dir")
        .arg(dir)
        .arg("--allow-loopback-http")
        .args(extra)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn with_lease(w: &mut Worker) {
    w.lease = Some(seal::seal_for_recipient_with(
        &luks_key(),
        &xpub(&SEED_A),
        [1; 32],
        [2; 12],
    ));
}

fn with_reply(w: &mut Worker) {
    w.reply = Reply::After {
        after: 0,
        build: Rc::new(|n: &str| {
            seal::build_sealed_secret_response_with(
                &luks_key(),
                &xpub(&SEED_A),
                n,
                "unlock-key",
                [9; 32],
                [8; 12],
            )
        }),
    };
}

#[test]
fn auto_hands_the_lease_key_to_cryptsetup_through_a_pipe() {
    let (port, seen) = serve(with_lease, None);
    let dir = boot_dir("lease", port, "auto");
    let cs = fake_cryptsetup(&dir, 0);
    let out = unlock(
        &dir,
        &[
            "--handoff",
            "cryptsetup",
            "--cryptsetup",
            cs.to_str().unwrap(),
            "--device",
            "/dev/vda3",
            "--name",
            "vda3_crypt",
        ],
    );
    let log = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(0), "{log}");
    assert_eq!(std::fs::read(dir.join("key")).unwrap(), luks_key());
    assert_eq!(
        std::fs::read_to_string(dir.join("argv")).unwrap(),
        "luksOpen\n--key-file\n-\n/dev/vda3\nvda3_crypt\n"
    );
    let key_hex = gohex::encode(&luks_key());
    let seed_hex = gohex::encode(&SEED_A);
    for secret in [&key_hex, &seed_hex] {
        assert!(
            !std::fs::read_to_string(dir.join("env"))
                .unwrap()
                .contains(secret.as_str())
        );
        assert!(!log.contains(secret.as_str()));
    }
    assert!(out.stdout.is_empty());
    assert_eq!(
        seen.try_iter().collect::<Vec<_>>(),
        vec![(Method::Get, format!("/api/boot/lease/{DOMAIN}"))]
    );
}

#[test]
fn approve_relays_and_writes_the_key_to_a_pipe() {
    let (port, seen) = serve(
        |w| {
            with_lease(w);
            with_reply(w);
        },
        None,
    );
    let dir = boot_dir("relay", port, "approve");
    let out = unlock(&dir, &["--handoff", "stdout"]);
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(out.stdout, luks_key());
    let calls: Vec<_> = seen.try_iter().collect();
    assert_eq!(calls[0], (Method::Post, "/api/boot/request".to_owned()));
    assert!(calls.iter().all(|(_, p)| !p.starts_with("/api/boot/lease")));
}

#[test]
fn a_lock_once_marker_forces_the_relay() {
    let (port, seen) = serve(
        |w| {
            with_lease(w);
            with_reply(w);
        },
        None,
    );
    let dir = boot_dir("lock-once", port, "auto");
    std::fs::write(dir.join("flagship-lock-once"), "").unwrap();
    let out = unlock(&dir, &["--handoff", "stdout"]);
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stderr).contains("lock-once=yes"));
    assert!(
        seen.try_iter()
            .all(|(_, p)| !p.starts_with("/api/boot/lease"))
    );
    assert!(
        dir.join("flagship-lock-once").exists(),
        "the caller consumes the marker after mounting"
    );
}

#[test]
fn redirects_are_never_followed() {
    let elsewhere = TcpListener::bind("127.0.0.1:0").unwrap();
    elsewhere.set_nonblocking(true).unwrap();
    let loc = format!(
        "http://127.0.0.1:{}/api/boot/lease/{DOMAIN}",
        elsewhere.local_addr().unwrap().port()
    );
    let (port, _seen) = serve(with_lease, Some(loc));
    let dir = boot_dir("redirect", port, "auto");
    let out = unlock(&dir, &["--handoff", "stdout"]);
    let log = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(1), "{log}");
    assert!(log.contains("box-lease HTTP 302"), "{log}");
    assert!(log.contains("relay boot-request HTTP 302"), "{log}");
    assert!(
        elsewhere.accept().is_err(),
        "the redirect target was contacted"
    );
    assert!(out.stdout.is_empty());
}

#[test]
fn cryptsetup_refusal_is_reported_with_its_code() {
    let (port, _) = serve(with_lease, None);
    let dir = boot_dir("cs-fail", port, "auto");
    let cs = fake_cryptsetup(&dir, 2);
    let out = unlock(
        &dir,
        &[
            "--handoff",
            "cryptsetup",
            "--cryptsetup",
            cs.to_str().unwrap(),
            "--device",
            "/dev/x",
            "--name",
            "x",
        ],
    );
    assert_eq!(out.status.code(), Some(2));
}

#[test]
fn strict_policy_refuses_an_unapproved_worker_before_any_request() {
    let dir = boot_dir("strict", 9, "auto");
    let out = unlock(
        &dir,
        &[
            "--handoff",
            "stdout",
            "--boot-host",
            "https://boot.example.org",
            "--policy",
            "strict",
        ],
    );
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("not an approved endpoint"));
    let out = unlock(
        &dir,
        &[
            "--handoff",
            "stdout",
            "--boot-host",
            "http://boot.flagshipserver.com",
        ],
    );
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("must use https"));
}

#[test]
fn usage_errors_exit_64() {
    let dir = boot_dir("usage", 9, "auto");
    assert_eq!(unlock(&dir, &[]).status.code(), Some(64));
    assert_eq!(
        unlock(&dir, &["--handoff", "cryptsetup"]).status.code(),
        Some(64)
    );
    assert_eq!(
        unlock(&dir, &["--handoff", "stdout", "--bogus", "1"])
            .status
            .code(),
        Some(64)
    );
    assert_eq!(
        unlock(
            &dir,
            &["--handoff", "stdout", "--relay-window-secs", "soon"]
        )
        .status
        .code(),
        Some(64)
    );
}

#[test]
fn a_missing_identity_fails_without_network() {
    let dir = boot_dir("no-identity", 9, "auto");
    std::fs::remove_file(dir.join("identity.pem")).unwrap();
    let out = unlock(&dir, &["--handoff", "stdout"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("identity.pem"));
}

//! The `flagship-relay` process end to end: it starts from the environment, answers on the hub port and drains on SIGTERM.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};

fn get(port: u16, path: &str, header: Option<(&str, &str)>) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let extra = header
        .map(|(k, v)| format!("{k}: {v}\r\n"))
        .unwrap_or_default();
    write!(
        s,
        "GET {path} HTTP/1.1\r\nhost: t\r\nconnection: close\r\n{extra}\r\n"
    )
    .unwrap();
    let mut raw = String::new();
    s.read_to_string(&mut raw).unwrap();
    let status = raw.split_whitespace().nth(1).unwrap().parse().unwrap();
    (
        status,
        raw.split("\r\n\r\n").nth(1).unwrap_or("").to_owned(),
    )
}

#[test]
fn it_serves_health_and_stats_and_drains_on_sigterm() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_flagship-relay"))
        .env_clear()
        .env("HOST", "127.0.0.1")
        .env("PORT", "0")
        .env("TUNNEL_TCP_PORT", "0")
        .env("USAGE_REPORT_SECRET", "sec")
        .env("FLAGSHIP_COM_BASE_URL", "http://127.0.0.1:9")
        .env("FLAGSHIP_DRAIN_GRACE_MS", "200")
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut port = 0u16;
    let mut seen = Vec::new();
    for _ in 0..40 {
        let mut line = String::new();
        if out.read_line(&mut line).unwrap() == 0 {
            break;
        }
        if let Some(rest) = line.strip_prefix("tunnel hub: ws://127.0.0.1:") {
            port = rest.split('/').next().unwrap().parse().unwrap();
            seen.push(line);
            break;
        }
        seen.push(line);
    }
    assert_ne!(port, 0, "no hub line in {seen:?}");

    let (st, body) = get(port, "/api/health", None);
    assert_eq!(st, 200);
    assert!(
        body.contains("\"runtime\":\"rust\"") && body.contains("\"ok\":true"),
        "{body}"
    );
    assert_eq!(get(port, "/api/stats", None).0, 403);
    assert_eq!(
        get(port, "/api/stats", Some(("x-usage-secret", "sec"))).0,
        200
    );

    let killed = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(killed.success());
    let mut rest = String::new();
    out.read_to_string(&mut rest).unwrap();
    let status = child.wait().unwrap();
    assert!(status.success(), "exit {status:?}; output {rest}");
    assert!(rest.contains("drained, 0 stream(s) cut"), "{rest}");
}

#[test]
fn it_refuses_to_start_without_the_router_port() {
    let out = Command::new(env!("CARGO_BIN_EXE_flagship-relay"))
        .env_clear()
        .stdout(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stdout).contains("TUNNEL_TCP_PORT is required"));
}

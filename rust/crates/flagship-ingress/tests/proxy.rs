//! The app proxy end to end over plain TCP (TLS is the ingress's other half and has its own
//! tests): a fake daemon decision socket, a fake app, and the proxy between a client and the app.
//! Streaming (SSE), WebSocket echo, large uploads (length and chunked), backpressure, the header
//! rules, deadlines and cancellation by the daemon.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use flagship_ingress::guard;
use flagship_ingress::proxy::{self, Cidr, ProxyConfig, Route};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream, UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot};

static SEQ: AtomicUsize = AtomicUsize::new(0);

fn sock_path(tag: &str) -> PathBuf {
    let base = std::env::temp_dir();
    let base = if base.as_os_str().len() > 60 {
        PathBuf::from("/tmp")
    } else {
        base
    };
    base.join(format!(
        "fp-{tag}-{}-{}.sock",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    ))
}

/// The daemon's decision socket. `answer` builds the reply from the request; every request seen
/// is kept; `hold` keeps the connection (the lease) until the sender fires.
struct Decider {
    path: PathBuf,
    seen: Arc<Mutex<Vec<Value>>>,
    cancel: Arc<Mutex<Vec<oneshot::Sender<()>>>>,
}

fn decider(answer: impl Fn(&Value) -> Value + Send + Sync + 'static) -> Decider {
    let path = sock_path("decide");
    let _ = std::fs::remove_file(&path);
    let l = UnixListener::bind(&path).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let cancel: Arc<Mutex<Vec<oneshot::Sender<()>>>> = Arc::new(Mutex::new(Vec::new()));
    let (s2, c2) = (Arc::clone(&seen), Arc::clone(&cancel));
    let answer = Arc::new(answer);
    tokio::spawn(async move {
        loop {
            let Ok((conn, _)) = l.accept().await else {
                return;
            };
            let (s3, c3, answer) = (Arc::clone(&s2), Arc::clone(&c2), Arc::clone(&answer));
            tokio::spawn(async move {
                let (r, mut w) = conn.into_split();
                let mut line = String::new();
                BufReader::new(r).read_line(&mut line).await.unwrap();
                let req: Value = serde_json::from_str(&line).unwrap();
                let reply = answer(&req);
                s3.lock().unwrap().push(req);
                w.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
                let (tx, rx) = oneshot::channel();
                c3.lock().unwrap().push(tx);
                let _ = rx.await;
                drop(w);
            });
        }
    });
    Decider { path, seen, cancel }
}

fn cfg(d: &Decider) -> ProxyConfig {
    ProxyConfig {
        decide: d.path.clone(),
        allow: vec![Cidr::parse("127.0.0.0/8").unwrap()],
        decide_timeout: Duration::from_secs(2),
        connect_timeout: Duration::from_secs(2),
        idle_timeout: Duration::from_secs(10),
        max_response_head: 64 * 1024,
    }
}

fn proxy_to(port: u16) -> impl Fn(&Value) -> Value + Send + Sync + 'static {
    move |_| {
        json!({"action":"proxy","host":"127.0.0.1","port":port,
            "set":[["x-flagship-visitor","member"],["x-flagship-user","u1"],["x-flagship-app-id","alice--app"]],
            "remove":["authorization"]})
    }
}

/// The ingress's side: accept one client, read its head with the guard, route, then proxy or
/// say "DAEMON" (standing in for the daemon's upstream socket).
async fn front(cfg: ProxyConfig) -> (u16, oneshot::Receiver<&'static str>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let (tx, rx) = oneshot::channel();
    tokio::spawn(async move {
        let (mut s, _) = l.accept().await.unwrap();
        let first = guard::read_first_head(&mut s, 16 * 1024, 32 * 1024)
            .await
            .unwrap();
        match proxy::route(&first, "app.home.alice.flagship.services", &cfg).await {
            Route::Proxy(session) => {
                let _ = tx.send("proxy");
                proxy::run(s, *session, &cfg).await;
            }
            Route::Daemon => {
                let _ = tx.send("daemon");
                let _ = s.write_all(b"DAEMON").await;
            }
        }
    });
    (port, rx)
}

/// An app: hands each accepted connection to `serve`.
async fn app<F, Fut>(serve: F) -> u16
where
    F: Fn(TcpStream) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let serve = Arc::new(serve);
    tokio::spawn(async move {
        loop {
            let Ok((s, _)) = l.accept().await else { return };
            let serve = Arc::clone(&serve);
            tokio::spawn(async move { serve(s).await });
        }
    });
    port
}

async fn read_head(s: &mut (impl AsyncReadExt + Unpin)) -> (String, Vec<u8>) {
    let mut buf = Vec::new();
    let mut b = [0u8; 4096];
    loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf[i + 4..].to_vec();
            return (String::from_utf8_lossy(&buf[..i]).into_owned(), rest);
        }
        let n = s.read(&mut b).await.unwrap();
        assert!(
            n > 0,
            "closed inside a head: {}",
            String::from_utf8_lossy(&buf)
        );
        buf.extend_from_slice(&b[..n]);
    }
}

async fn read_all(s: &mut TcpStream) -> Vec<u8> {
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), s.read_to_end(&mut out)).await;
    out
}

#[tokio::test]
async fn forwards_with_identity_and_strips_forgeries() {
    let (seen_tx, mut seen_rx) = mpsc::unbounded_channel::<String>();
    let port = app(move |mut s| {
        let seen_tx = seen_tx.clone();
        async move {
            let (head, _) = read_head(&mut s).await;
            seen_tx.send(head).unwrap();
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: keep-alive, X-Hop\r\nX-Hop: 1\r\nX-App: yes\r\n\r\nhello").await.unwrap();
        }
    })
    .await;
    let d = decider(proxy_to(port));
    let (fport, routed) = front(cfg(&d)).await;
    let mut c = TcpStream::connect(("127.0.0.1", fport)).await.unwrap();
    c.write_all(b"GET /x?y=1 HTTP/1.1\r\nHost: app.home.alice.flagship.services\r\nX-Flagship-User: forged\r\nX_Flagship_Role: master\r\nAuthorization: Bearer fsk_a_b\r\nCookie: a=1\r\n\r\n").await.unwrap();
    let out = String::from_utf8(read_all(&mut c).await).unwrap();
    assert_eq!(routed.await.unwrap(), "proxy");
    assert!(out.starts_with("HTTP/1.1 200 OK\r\n"), "{out}");
    assert!(
        out.contains("X-App: yes\r\n")
            && !out.contains("X-Hop")
            && out.contains("Connection: close\r\n")
    );
    assert!(out.ends_with("\r\n\r\nhello"));
    let head = seen_rx.recv().await.unwrap().to_ascii_lowercase();
    assert!(head.starts_with("get /x?y=1 http/1.1\r\n"), "{head}");
    assert!(
        !head.contains("forged") && !head.contains("master") && !head.contains("fsk_"),
        "{head}"
    );
    assert!(head.contains("x-flagship-user: u1") && head.contains("x-flagship-visitor: member"));
    assert!(head.contains("connection: close") && head.contains("cookie: a=1"));
    let asked = d.seen.lock().unwrap()[0].clone();
    assert_eq!(asked["sni"], "app.home.alice.flagship.services");
    assert_eq!(asked["target"], "/x?y=1");
    assert_eq!(asked["body"], "none");
}

#[tokio::test]
async fn routes_to_the_daemon_on_any_doubt() {
    // The daemon says so.
    let d = decider(|_| json!({"action":"daemon"}));
    let (fport, routed) = front(cfg(&d)).await;
    let mut c = TcpStream::connect(("127.0.0.1", fport)).await.unwrap();
    c.write_all(b"GET / HTTP/1.1\r\nHost: a\r\n\r\n")
        .await
        .unwrap();
    assert_eq!(read_all(&mut c).await, b"DAEMON");
    assert_eq!(routed.await.unwrap(), "daemon");
    // A target outside the app networks.
    let d = decider(|_| json!({"action":"proxy","host":"10.1.2.3","port":80}));
    let (fport, routed) = front(cfg(&d)).await;
    let mut c = TcpStream::connect(("127.0.0.1", fport)).await.unwrap();
    c.write_all(b"GET / HTTP/1.1\r\nHost: a\r\n\r\n")
        .await
        .unwrap();
    assert_eq!(read_all(&mut c).await, b"DAEMON");
    assert_eq!(routed.await.unwrap(), "daemon");
    // A head the TS proxy reads differently (bare LF) never reaches the decider.
    let d = decider(proxy_to(1));
    let (fport, routed) = front(cfg(&d)).await;
    let mut c = TcpStream::connect(("127.0.0.1", fport)).await.unwrap();
    c.write_all(b"GET / HTTP/1.1\nHost: a\n\n").await.unwrap();
    assert_eq!(read_all(&mut c).await, b"DAEMON");
    assert_eq!(routed.await.unwrap(), "daemon");
    assert!(d.seen.lock().unwrap().is_empty());
    // No decision socket at all.
    let mut c2 = cfg(&d);
    c2.decide = sock_path("missing");
    let (fport, routed) = front(c2).await;
    let mut c = TcpStream::connect(("127.0.0.1", fport)).await.unwrap();
    c.write_all(b"GET / HTTP/1.1\r\nHost: a\r\n\r\n")
        .await
        .unwrap();
    assert_eq!(read_all(&mut c).await, b"DAEMON");
    assert_eq!(routed.await.unwrap(), "daemon");
}

#[tokio::test]
async fn server_sent_events_stream_event_by_event() {
    let (go_tx, go_rx) = mpsc::unbounded_channel::<()>();
    let go_rx = Arc::new(tokio::sync::Mutex::new(go_rx));
    let port = app(move |mut s| {
        let go_rx = Arc::clone(&go_rx);
        async move {
            let _ = read_head(&mut s).await;
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: one\n\n")
                .await
                .unwrap();
            go_rx.lock().await.recv().await;
            s.write_all(b"data: two\n\n").await.unwrap();
        }
    })
    .await;
    let d = decider(proxy_to(port));
    let (fport, _) = front(cfg(&d)).await;
    let mut c = TcpStream::connect(("127.0.0.1", fport)).await.unwrap();
    c.write_all(b"GET /events HTTP/1.1\r\nHost: a\r\nAccept: text/event-stream\r\n\r\n")
        .await
        .unwrap();
    let (head, mut got) = read_head(&mut c).await;
    assert!(head.contains("Transfer-Encoding: chunked"), "{head}");
    // The first event arrives while the app still holds the second.
    let mut b = [0u8; 256];
    while !String::from_utf8_lossy(&got).contains("data: one") {
        let n = tokio::time::timeout(Duration::from_secs(5), c.read(&mut b))
            .await
            .unwrap()
            .unwrap();
        assert!(n > 0);
        got.extend_from_slice(&b[..n]);
    }
    assert!(!String::from_utf8_lossy(&got).contains("two"));
    go_tx.send(()).unwrap();
    let rest = read_all(&mut c).await;
    got.extend(rest);
    let text = String::from_utf8_lossy(&got);
    assert!(
        text.contains("data: two") && text.ends_with("0\r\n\r\n"),
        "{text}"
    );
}

#[tokio::test]
async fn websocket_upgrade_echoes_both_ways() {
    let port = app(|mut s| async move {
        let (head, early) = read_head(&mut s).await;
        assert!(head.to_ascii_lowercase().contains("connection: upgrade"));
        assert!(head.to_ascii_lowercase().contains("upgrade: websocket"));
        assert!(head.contains("x-flagship-visitor: member"));
        s.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: abc\r\n\r\n").await.unwrap();
        if !early.is_empty() {
            s.write_all(&early).await.unwrap();
        }
        let mut b = [0u8; 1024];
        loop {
            let n = s.read(&mut b).await.unwrap();
            if n == 0 {
                return;
            }
            s.write_all(&b[..n]).await.unwrap();
        }
    })
    .await;
    let d = decider(proxy_to(port));
    let (fport, _) = front(cfg(&d)).await;
    let mut c = TcpStream::connect(("127.0.0.1", fport)).await.unwrap();
    c.write_all(b"GET /ws HTTP/1.1\r\nHost: a\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: k\r\nSec-WebSocket-Version: 13\r\n\r\nearly").await.unwrap();
    let (head, mut got) = read_head(&mut c).await;
    assert!(head.starts_with("HTTP/1.1 101 Switching Protocols"));
    assert!(head.contains("Sec-WebSocket-Accept: abc"));
    let mut b = [0u8; 64];
    while got.len() < 5 {
        let n = c.read(&mut b).await.unwrap();
        got.extend_from_slice(&b[..n]);
    }
    assert_eq!(&got[..5], b"early");
    for msg in [&b"ping-1"[..], b"a longer frame of bytes", b"\x81\x05hello"] {
        c.write_all(msg).await.unwrap();
        let mut back = vec![0u8; msg.len()];
        tokio::time::timeout(Duration::from_secs(5), c.read_exact(&mut back))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(back, msg);
    }
}

/// The app counts what it receives and answers the count and a checksum.
async fn counting_app() -> u16 {
    app(|mut s| async move {
        let (head, rest) = read_head(&mut s).await;
        let lower = head.to_ascii_lowercase();
        let mut total: u64 = 0;
        let mut sum: u64 = 0;
        let add = |d: &[u8], total: &mut u64, sum: &mut u64| {
            *total += d.len() as u64;
            for &x in d {
                *sum = sum.wrapping_mul(31).wrapping_add(u64::from(x));
            }
        };
        if let Some(cl) = lower
            .lines()
            .find_map(|l| l.strip_prefix("content-length: "))
        {
            let want: u64 = cl.trim().parse().unwrap();
            add(&rest, &mut total, &mut sum);
            let mut b = vec![0u8; 65536];
            while total < want {
                let n = s.read(&mut b).await.unwrap();
                assert!(n > 0);
                add(&b[..n], &mut total, &mut sum);
            }
        } else {
            assert!(lower.contains("transfer-encoding: chunked"));
            let mut dec = flagship_ingress::http::ChunkedDecoder::new();
            let mut feed = rest;
            let mut b = vec![0u8; 65536];
            loop {
                dec.push(&feed, &mut |d| add(d, &mut total, &mut sum))
                    .unwrap();
                if dec.done() {
                    break;
                }
                let n = s.read(&mut b).await.unwrap();
                assert!(n > 0);
                feed = b[..n].to_vec();
            }
        }
        let body = format!("{total} {sum}");
        s.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    })
    .await
}

fn pattern(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i * 7 + i / 251) as u8).collect()
}

fn checksum(d: &[u8]) -> u64 {
    d.iter()
        .fold(0u64, |s, &x| s.wrapping_mul(31).wrapping_add(u64::from(x)))
}

#[tokio::test]
async fn large_uploads_stream_with_length_and_chunked() {
    let port = counting_app().await;
    let data = pattern(24 * 1024 * 1024 + 13);
    // Content-Length.
    let d = decider(proxy_to(port));
    let (fport, _) = front(cfg(&d)).await;
    let c = TcpStream::connect(("127.0.0.1", fport)).await.unwrap();
    let (mut r, mut w) = c.into_split();
    let body = data.clone();
    let writer = tokio::spawn(async move {
        w.write_all(format!("POST /up HTTP/1.1\r\nHost: a\r\nContent-Length: {}\r\nExpect: 100-continue\r\n\r\n", body.len()).as_bytes()).await.unwrap();
        w.write_all(&body).await.unwrap();
        w
    });
    let mut out = Vec::new();
    tokio::time::timeout(Duration::from_secs(60), r.read_to_end(&mut out))
        .await
        .unwrap()
        .unwrap();
    let _w = writer.await.unwrap();
    let text = String::from_utf8_lossy(&out);
    assert!(
        text.starts_with("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK"),
        "{text}"
    );
    assert!(
        text.ends_with(&format!("{} {}", data.len(), checksum(&data))),
        "{text}"
    );
    assert_eq!(d.seen.lock().unwrap()[0]["body"], "length");
    // Chunked, in odd-sized chunks.
    let d = decider(proxy_to(port));
    let (fport, _) = front(cfg(&d)).await;
    let c = TcpStream::connect(("127.0.0.1", fport)).await.unwrap();
    let (mut r, mut w) = c.into_split();
    let body = data.clone();
    let writer = tokio::spawn(async move {
        w.write_all(b"POST /up HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .unwrap();
        for piece in body.chunks(100_003) {
            w.write_all(&flagship_ingress::http::encode_chunk(piece))
                .await
                .unwrap();
        }
        w.write_all(b"0\r\n\r\n").await.unwrap();
        w
    });
    let mut out = Vec::new();
    tokio::time::timeout(Duration::from_secs(60), r.read_to_end(&mut out))
        .await
        .unwrap()
        .unwrap();
    let _w = writer.await.unwrap();
    let text = String::from_utf8_lossy(&out);
    assert!(
        text.ends_with(&format!("{} {}", data.len(), checksum(&data))),
        "{text}"
    );
    assert_eq!(d.seen.lock().unwrap()[0]["body"], "chunked");
}

#[tokio::test]
async fn an_app_that_does_not_read_holds_the_client_back() {
    let (hold_tx, hold_rx) = oneshot::channel::<()>();
    let hold = Arc::new(Mutex::new(Some(hold_rx)));
    let port = app(move |mut s| {
        let hold = Arc::clone(&hold);
        async move {
            let _ = read_head(&mut s).await;
            let rx = hold.lock().unwrap().take();
            if let Some(rx) = rx {
                let _ = rx.await;
            }
        }
    })
    .await;
    let d = decider(proxy_to(port));
    let (fport, _) = front(cfg(&d)).await;
    let mut c = TcpStream::connect(("127.0.0.1", fport)).await.unwrap();
    let total = 512 * 1024 * 1024usize;
    c.write_all(
        format!("POST /up HTTP/1.1\r\nHost: a\r\nContent-Length: {total}\r\n\r\n").as_bytes(),
    )
    .await
    .unwrap();
    let chunk = vec![7u8; 1024 * 1024];
    let mut sent = 0usize;
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        while sent < total {
            c.write_all(&chunk).await.unwrap();
            sent += chunk.len();
        }
    })
    .await;
    // Kernel socket buffers on both hops plus the proxy's one 64 KiB buffer: far below the body.
    assert!(
        sent < 64 * 1024 * 1024,
        "the proxy buffered {sent} bytes for an app that reads nothing"
    );
    let _ = hold_tx.send(());
}

#[tokio::test]
async fn malformed_chunked_upload_is_400() {
    let port = app(|mut s| async move {
        let _ = read_head(&mut s).await;
        let mut b = [0u8; 1024];
        while s.read(&mut b).await.unwrap_or(0) > 0 {}
    })
    .await;
    let d = decider(proxy_to(port));
    let (fport, _) = front(cfg(&d)).await;
    let mut c = TcpStream::connect(("127.0.0.1", fport)).await.unwrap();
    c.write_all(b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n")
        .await
        .unwrap();
    let out = String::from_utf8(read_all(&mut c).await).unwrap();
    assert!(out.starts_with("HTTP/1.1 400 "), "{out}");
}

#[tokio::test]
async fn idle_connections_are_closed() {
    let port = app(|mut s| async move {
        let _ = read_head(&mut s).await;
        s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(30)).await;
    })
    .await;
    let d = decider(proxy_to(port));
    let mut c2 = cfg(&d);
    c2.idle_timeout = Duration::from_millis(400);
    let (fport, _) = front(c2).await;
    let mut c = TcpStream::connect(("127.0.0.1", fport)).await.unwrap();
    c.write_all(b"GET / HTTP/1.1\r\nHost: a\r\n\r\n")
        .await
        .unwrap();
    let start = std::time::Instant::now();
    let _ = read_all(&mut c).await;
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "closed after {:?}",
        start.elapsed()
    );
}

#[tokio::test]
async fn the_daemon_closing_its_lease_ends_the_connection() {
    let port = app(|mut s| async move {
        let _ = read_head(&mut s).await;
        s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: x\n\n")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(30)).await;
    })
    .await;
    let d = decider(proxy_to(port));
    let (fport, _) = front(cfg(&d)).await;
    let mut c = TcpStream::connect(("127.0.0.1", fport)).await.unwrap();
    c.write_all(b"GET / HTTP/1.1\r\nHost: a\r\n\r\n")
        .await
        .unwrap();
    let (_, _) = read_head(&mut c).await;
    // The endpoint is invalidated: the daemon drops the lease.
    let tx = loop {
        if let Some(tx) = d.cancel.lock().unwrap().pop() {
            break tx;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let start = std::time::Instant::now();
    let _ = tx.send(());
    let _ = read_all(&mut c).await;
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn an_unreachable_app_is_502() {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead = l.local_addr().unwrap().port();
    drop(l);
    let d = decider(proxy_to(dead));
    let (fport, _) = front(cfg(&d)).await;
    let mut c = TcpStream::connect(("127.0.0.1", fport)).await.unwrap();
    c.write_all(b"GET / HTTP/1.1\r\nHost: a\r\n\r\n")
        .await
        .unwrap();
    let out = String::from_utf8(read_all(&mut c).await).unwrap();
    assert!(out.starts_with("HTTP/1.1 502 "), "{out}");
}

#[tokio::test]
async fn a_decider_that_never_answers_falls_back_to_the_daemon() {
    let path = sock_path("silent");
    let _ = std::fs::remove_file(&path);
    let l = UnixListener::bind(&path).unwrap();
    tokio::spawn(async move {
        let mut keep: Vec<UnixStream> = Vec::new();
        while let Ok((s, _)) = l.accept().await {
            keep.push(s);
        }
    });
    let c0 = ProxyConfig {
        decide: path,
        allow: vec![Cidr::parse("127.0.0.0/8").unwrap()],
        decide_timeout: Duration::from_millis(300),
        ..ProxyConfig::default()
    };
    let (fport, routed) = front(c0).await;
    let mut c = TcpStream::connect(("127.0.0.1", fport)).await.unwrap();
    c.write_all(b"GET / HTTP/1.1\r\nHost: a\r\n\r\n")
        .await
        .unwrap();
    assert_eq!(read_all(&mut c).await, b"DAEMON");
    assert_eq!(routed.await.unwrap(), "daemon");
}

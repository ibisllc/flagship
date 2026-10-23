//! The tokio relay end to end over real sockets: boxes dial the hub WebSocket, visitors dial
//! the SNI port, bytes are spliced through the v1 frame protocol.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use flagship_relay::frame::{
    self, FRAME_CLOSE, FRAME_DATA, FRAME_DOMAIN_GRANTED, FRAME_DRAIN_NOTICE, FRAME_HELLO,
    FRAME_HELLO_ACK, FRAME_OPEN, FRAME_STREAM_CREDIT, Frame, FrameDecoder, TypeSet,
};
use flagship_relay::hello::UnverifiedDevAuthority;
use flagship_relay::payload;
use flagship_relay::relay::{
    self, Collaborators, Listeners, RelayConfig, RunningRelay, StartError,
};
use flagship_relay::throttle::{LocalMeter, Meter};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

const T: Duration = Duration::from_secs(10);

fn cfg() -> RelayConfig {
    let mut c = RelayConfig {
        require_verified_authority: false,
        ..RelayConfig::default()
    };
    c.router.hold_timeout = Duration::from_millis(400);
    c.router.hold_poll_interval = Duration::from_millis(20);
    c.router.sni.deadline = Duration::from_millis(500);
    c.hub.slow_receiver_grace = Duration::from_millis(300);
    c
}

async fn start_with(c: RelayConfig, meter: Option<Arc<dyn Meter>>) -> RunningRelay {
    let l = Listeners {
        sni: TcpListener::bind("127.0.0.1:0").await.unwrap(),
        hub: TcpListener::bind("127.0.0.1:0").await.unwrap(),
        echo: Some(TcpListener::bind("127.0.0.1:0").await.unwrap()),
    };
    relay::start(
        c,
        l,
        Collaborators {
            authority: Arc::new(UnverifiedDevAuthority),
            blessing: None,
            meter,
        },
    )
    .unwrap()
}

async fn start() -> RunningRelay {
    start_with(cfg(), None).await
}

/// TLS 1.2-shaped ClientHello with one SNI entry, as `sni.test.ts` builds it.
fn client_hello(sni: &str) -> Vec<u8> {
    let host = sni.as_bytes();
    let mut entry = vec![0u8];
    entry.extend_from_slice(&(host.len() as u16).to_be_bytes());
    entry.extend_from_slice(host);
    let mut list = (entry.len() as u16).to_be_bytes().to_vec();
    list.extend(entry);
    let mut ext = vec![0, 0];
    ext.extend_from_slice(&(list.len() as u16).to_be_bytes());
    ext.extend(list);
    let mut body = vec![3, 3];
    body.extend([7u8; 32]);
    body.extend([0, 0, 2, 0, 0x9c, 1, 0]);
    body.extend_from_slice(&(ext.len() as u16).to_be_bytes());
    body.extend(ext);
    let mut hs = vec![1u8];
    hs.extend_from_slice(&(body.len() as u32).to_be_bytes()[1..]);
    hs.extend(body);
    let mut rec = vec![0x16, 3, 1];
    rec.extend_from_slice(&(hs.len() as u16).to_be_bytes());
    rec.extend(hs);
    rec
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn hello_json(
    server: &str,
    user: &str,
    canonicals: &[&str],
    caps: &[&str],
    issued_at: u64,
) -> Vec<u8> {
    let pc = format!("{server}.{user}.flagship.services");
    let h64 = "ab".repeat(32);
    let h128 = "cd".repeat(64);
    let service = if canonicals.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::json!({"username": user, "podPubKey": h64, "canonicals": canonicals, "issuedAt": 1, "expiresAt": now_ms() + 3_600_000})
    };
    serde_json::to_vec(&serde_json::json!({
        "version": 2,
        "serverId": pc,
        "rootEntitlement": {"username": user, "podPubKey": h64, "podCanonical": pc, "issuedAt": 1},
        "rootEntitlementSig": h128,
        "rootEntitlementCertId": h64,
        "serviceEntitlement": service,
        "serviceEntitlementSig": if canonicals.is_empty() { serde_json::Value::Null } else { h128.clone().into() },
        "serviceEntitlementCertId": if canonicals.is_empty() { "".into() } else { serde_json::Value::from(h64.clone()) },
        "nonce": h64,
        "issuedAt": issued_at,
        "signature": h128,
        "capabilities": caps,
    }))
    .unwrap()
}

/// A box: frames in on a channel (decoded with the strict v1 type set unless it negotiated
/// more), frames out through `send`.
struct TestBox {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    rx: mpsc::UnboundedReceiver<Frame>,
    close_code: Arc<std::sync::Mutex<Option<u16>>>,
    paused: tokio::sync::watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}

impl TestBox {
    async fn connect(r: &RunningRelay, accept: TypeSet) -> Self {
        let url = format!("ws://{}/tunnel", r.hub_addr);
        let (ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let (mut sink, mut stream) = ws.split();
        let (tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (in_tx, rx) = mpsc::unbounded_channel();
        let close_code = Arc::new(std::sync::Mutex::new(None));
        let cc = close_code.clone();
        let (paused, mut paused_rx) = tokio::sync::watch::channel(false);
        let reader = tokio::spawn(async move {
            let mut d = FrameDecoder::new(accept, 8 << 20);
            loop {
                let _ = paused_rx.wait_for(|p| !*p).await;
                let Some(Ok(m)) = stream.next().await else {
                    break;
                };
                match m {
                    Message::Binary(b) => {
                        d.push(&b).unwrap();
                        loop {
                            match d.next_frame() {
                                Ok(Some(f)) => {
                                    let _ = in_tx.send(f);
                                }
                                Ok(None) => break,
                                Err(e) => panic!("box received a frame a v1 peer rejects: {e}"),
                            }
                        }
                    }
                    Message::Close(c) => {
                        *cc.lock().unwrap() = c.map(|c| u16::from(c.code));
                        break;
                    }
                    _ => {}
                }
            }
        });
        let writer = tokio::spawn(async move {
            while let Some(b) = out_rx.recv().await {
                if b.is_empty() {
                    let _ = sink.close().await;
                    return;
                }
                if sink.send(Message::Binary(b.into())).await.is_err() {
                    return;
                }
            }
        });
        Self {
            tx,
            rx,
            close_code,
            paused,
            tasks: vec![reader, writer],
        }
    }

    fn send(&self, f: &Frame) {
        self.tx.send(frame::encode_frame(f).unwrap()).unwrap();
    }

    fn hello(&self, server: &str, user: &str, canonicals: &[&str], caps: &[&str], issued_at: u64) {
        self.send(&Frame::new(
            0,
            FRAME_HELLO,
            hello_json(server, user, canonicals, caps, issued_at),
        ));
    }

    async fn next(&mut self) -> Option<Frame> {
        tokio::time::timeout(T, self.rx.recv()).await.ok().flatten()
    }

    async fn next_of(&mut self, ty: u8) -> Frame {
        loop {
            let f = self
                .next()
                .await
                .unwrap_or_else(|| panic!("no frame of type 0x{ty:02x}"));
            if f.frame_type == ty {
                return f;
            }
        }
    }

    async fn ack(&mut self) -> payload::ParsedHelloAck {
        let f = self.next_of(FRAME_HELLO_ACK).await;
        payload::parse_hello_ack(&f.payload).unwrap()
    }

    async fn registered(
        r: &RunningRelay,
        server: &str,
        user: &str,
        canonicals: &[&str],
        caps: &[&str],
    ) -> Self {
        let mut accept = TypeSet::V1;
        accept.stream_credit = caps.contains(&payload::CAPABILITY_STREAM_CREDIT_V1);
        accept.drain_notice = caps.contains(&payload::CAPABILITY_DRAIN_V1);
        let mut b = Self::connect(r, accept).await;
        b.hello(server, user, canonicals, caps, now_ms());
        let a = b.ack().await;
        assert!(a.ok, "{a:?}");
        b
    }

    fn disconnect(&self) {
        let _ = self.tx.send(Vec::new());
    }
}

impl Drop for TestBox {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

async fn visitor(r: &RunningRelay, sni: &str) -> (TcpStream, Vec<u8>) {
    let mut s = TcpStream::connect(r.sni_addr).await.unwrap();
    let h = client_hello(sni);
    s.write_all(&h).await.unwrap();
    (s, h)
}

async fn read_exact_within(s: &mut TcpStream, n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    tokio::time::timeout(T, s.read_exact(&mut buf))
        .await
        .unwrap()
        .unwrap();
    buf
}

async fn read_to_eof(s: &mut TcpStream) -> Vec<u8> {
    let mut out = Vec::new();
    tokio::time::timeout(T, s.read_to_end(&mut out))
        .await
        .unwrap()
        .unwrap_or(0);
    out
}

/// Collect DATA payloads for `id` until `n` bytes arrived.
async fn collect(b: &mut TestBox, id: u32, n: usize) -> Vec<u8> {
    let mut got = Vec::new();
    while got.len() < n {
        let f = b.next().await.expect("data");
        if f.frame_type == FRAME_DATA && f.stream_id == id {
            got.extend(f.payload);
        }
    }
    got
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn registers_routes_by_sni_and_splices_both_ways() {
    let r = start().await;
    let mut alice = TestBox::registered(
        &r,
        "home",
        "alice",
        &["chess.home.alice.flagship.services"],
        &[],
    )
    .await;
    let mut bob = TestBox::registered(&r, "home", "bob", &[], &[]).await;
    let g = alice.next_of(FRAME_DOMAIN_GRANTED).await;
    assert!(payload::parse_domain_granted(&g.payload).is_some());

    for (name, expect_alice) in [
        ("home.alice.flagship.services", true),
        ("chess.alice.flagship.services", true),
        ("www.home.bob.flagship.services", false),
    ] {
        let (mut v, hello) = visitor(&r, name).await;
        let target = if expect_alice { &mut alice } else { &mut bob };
        let open = target.next_of(FRAME_OPEN).await;
        assert_eq!(payload::parse_open(&open.payload), name);
        assert_eq!(
            collect(target, open.stream_id, hello.len()).await,
            hello,
            "{name}: ClientHello replayed verbatim"
        );
        v.write_all(b"ping").await.unwrap();
        assert_eq!(collect(target, open.stream_id, 4).await, b"ping");
        target.send(&Frame::new(open.stream_id, FRAME_DATA, b"pong".to_vec()));
        target.send(&Frame::new(
            open.stream_id,
            frame::FRAME_CLOSE_REMOTE,
            Vec::new(),
        ));
        assert_eq!(
            read_to_eof(&mut v).await,
            b"pong",
            "{name}: box data flushed before FIN"
        );
    }
    assert_eq!(r.tunnel_count(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hello_refusals_match_ts_reasons_and_close() {
    let r = start().await;
    let mut b = TestBox::connect(&r, TypeSet::V1).await;
    b.send(&Frame::new(1, FRAME_DATA, vec![1]));
    let a = b.ack().await;
    assert_eq!(
        (a.ok, a.reason.as_deref()),
        (false, Some("expected HELLO as first frame"))
    );

    let mut b = TestBox::connect(&r, TypeSet::V1).await;
    b.send(&Frame::new(0, FRAME_HELLO, b"{\"version\":1}".to_vec()));
    assert_eq!(
        b.ack().await.reason.as_deref(),
        Some("HELLO version must be 2")
    );

    let mut b = TestBox::connect(&r, TypeSet::V1).await;
    b.hello("home", "alice", &[], &[], now_ms() - 10 * 60_000);
    assert_eq!(
        b.ack().await.reason.as_deref(),
        Some("HELLO issuedAt is stale or in the future")
    );

    let mut b = TestBox::connect(&r, TypeSet::V1).await;
    b.hello(
        "home",
        "alice",
        &["chess.bob.flagship.services"],
        &[],
        now_ms(),
    );
    let reason = b.ack().await.reason.unwrap();
    assert!(reason.contains("foreign-zone canonical"), "{reason}");

    let mut b = TestBox::registered(&r, "home", "carol", &[], &[]).await;
    b.tx.send(vec![0, 0, 0, 1, 0x99, 0, 0, 0, 0]).unwrap();
    let a = b.ack().await;
    assert_eq!(
        (a.ok, a.reason.as_deref()),
        (false, Some("unknown frame type 0x99"))
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(*b.close_code.lock().unwrap(), Some(1002));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn production_mode_refuses_an_authority_without_signatures() {
    let l = Listeners {
        sni: TcpListener::bind("127.0.0.1:0").await.unwrap(),
        hub: TcpListener::bind("127.0.0.1:0").await.unwrap(),
        echo: None,
    };
    let e = relay::start(
        RelayConfig::default(),
        l,
        Collaborators {
            authority: Arc::new(UnverifiedDevAuthority),
            blessing: None,
            meter: None,
        },
    )
    .err();
    assert_eq!(e, Some(StartError::UnverifiedAuthority));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn extensions_are_negotiated_never_assumed() {
    let r = start().await;
    let mut old = TestBox::connect(&r, TypeSet::V1).await;
    old.hello("home", "alice", &[], &[], now_ms());
    let a = old.ack().await;
    assert!(
        a.ok && a.capabilities.is_none(),
        "an old box sees no capabilities key: {a:?}"
    );
    let mut new = TestBox::connect(
        &r,
        TypeSet {
            stream_credit: true,
            drain_notice: true,
        },
    )
    .await;
    new.hello(
        "cabin",
        "alice",
        &[],
        &["stream-credit-v1", "drain-v1", "future-x"],
        now_ms(),
    );
    let a = new.ack().await;
    assert_eq!(
        a.capabilities,
        Some(vec!["stream-credit-v1".to_owned(), "drain-v1".to_owned()])
    );

    // Traffic, a credit-worthy download and a drain: the v1 box's strict decoder must never
    // see 0x05 or 0x06 (it would panic in its reader).
    let (mut v, h) = visitor(&r, "home.alice.flagship.services").await;
    let open = old.next_of(FRAME_OPEN).await;
    collect(&mut old, open.stream_id, h.len()).await;
    old.send(&Frame::new(open.stream_id, FRAME_DATA, vec![9; 300 * 1024]));
    assert_eq!(
        read_exact_within(&mut v, 300 * 1024).await.len(),
        300 * 1024
    );
    let cut = tokio::spawn(async move {
        let _ = r.drain(Duration::from_millis(300)).await;
        r
    });
    let n = new.next_of(FRAME_DRAIN_NOTICE).await;
    assert_eq!(String::from_utf8(n.payload).unwrap(), "{\"graceMs\":300}");
    let r = cut.await.unwrap();
    while let Some(f) = old.next().await {
        assert!(f.frame_type != FRAME_DRAIN_NOTICE && f.frame_type != FRAME_STREAM_CREDIT);
    }
    drop(r);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stream_credit_bounds_both_directions() {
    let r = start().await;
    let caps = ["stream-credit-v1"];
    let mut b = TestBox::registered(&r, "home", "alice", &[], &caps).await;
    let (mut v, h) = visitor(&r, "home.alice.flagship.services").await;
    let open = b.next_of(FRAME_OPEN).await;
    let id = open.stream_id;

    // Upload: the hub never sends more than the window before the box grants.
    let up = tokio::spawn(async move {
        v.write_all(&vec![1u8; 1024 * 1024]).await.unwrap();
        v
    });
    let window = flagship_relay::flow::STREAM_INITIAL_WINDOW as usize;
    let first = collect(&mut b, id, window).await;
    assert_eq!(
        first.len(),
        window,
        "initial window includes the ClientHello"
    );
    let more = tokio::time::timeout(Duration::from_millis(300), b.rx.recv()).await;
    assert!(
        more.is_err() || more.unwrap().unwrap().frame_type != FRAME_DATA,
        "no DATA past the window"
    );
    b.send(&payload::stream_credit_frame(id, (1024 * 1024 + h.len()) as u32).unwrap());
    let rest = collect(&mut b, id, 1024 * 1024 + h.len() - window).await;
    assert_eq!(rest.len(), 1024 * 1024 + h.len() - window);
    let mut v = up.await.unwrap();

    // Download: the hub returns credit as the visitor reads; a box that overruns its window
    // loses the stream.
    b.send(&Frame::new(id, FRAME_DATA, vec![2; 200 * 1024]));
    read_exact_within(&mut v, 200 * 1024).await;
    let c = b.next_of(FRAME_STREAM_CREDIT).await;
    assert_eq!(c.stream_id, id);
    assert!(payload::parse_credit(&c.payload).unwrap() as usize >= window / 4);
    // Credit returns as bytes reach the visitor's socket, so only a frame larger than the
    // whole window is an overrun no matter how fast the visitor drains.
    b.send(&Frame::new(id, FRAME_DATA, vec![3; window + 1]));
    let closed = b.next_of(FRAME_CLOSE).await;
    assert_eq!(closed.stream_id, id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn slow_visitor_is_cut_without_stalling_other_streams() {
    let r = start().await;
    let mut b = TestBox::registered(&r, "home", "alice", &[], &[]).await;
    let (_slow, _) = visitor(&r, "home.alice.flagship.services").await;
    let slow_id = b.next_of(FRAME_OPEN).await.stream_id;
    let (mut fast, _) = visitor(&r, "home.alice.flagship.services").await;
    let fast_id = b.next_of(FRAME_OPEN).await.stream_id;
    // The slow visitor never reads; v1 has no credit, so the hub buffers up to its bound,
    // waits the grace period and then drops that stream.
    for _ in 0..64 {
        b.send(&Frame::new(slow_id, FRAME_DATA, vec![0; 512 * 1024]));
    }
    b.send(&Frame::new(fast_id, FRAME_DATA, b"still here".to_vec()));
    let started = Instant::now();
    loop {
        let f = b.next_of(FRAME_CLOSE).await;
        if f.stream_id == slow_id {
            break;
        }
    }
    assert!(started.elapsed() < Duration::from_secs(8));
    assert_eq!(read_exact_within(&mut fast, 10).await, b"still here");
    assert!(r.router.active_streams() >= 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fair_scheduling_interleaves_bulk_and_small_uploads() {
    let r = start().await;
    let mut b = TestBox::registered(&r, "home", "alice", &[], &[]).await;
    let (bulk, _) = visitor(&r, "home.alice.flagship.services").await;
    let bulk_id = b.next_of(FRAME_OPEN).await.stream_id;
    let (mut small, _) = visitor(&r, "home.alice.flagship.services").await;
    let small_id = b.next_of(FRAME_OPEN).await.stream_id;
    // Stop reading the tunnel so the hub's queue toward the box is full when the small
    // request arrives: only then does scheduling order matter.
    b.paused.send(true).unwrap();
    let total = 64 * 1024 * 1024;
    let writer = tokio::spawn(async move {
        let mut bulk = bulk;
        let _ = bulk.write_all(&vec![7u8; total]).await;
        bulk
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    small.write_all(b"GET").await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let queued = r.router.active_streams();
    b.paused.send(false).unwrap();
    let mut bulk_bytes_before_small = 0usize;
    loop {
        let f = b.next().await.unwrap();
        if f.frame_type != FRAME_DATA {
            continue;
        }
        if f.stream_id == small_id && f.payload.ends_with(b"GET") {
            break;
        }
        if f.stream_id == bulk_id {
            bulk_bytes_before_small += f.payload.len();
        }
    }
    // What was already in kernel and WebSocket buffers precedes it; the hub's own queue
    // (one lane, 256 KiB) must not.
    eprintln!("bulk bytes ahead of the small request: {bulk_bytes_before_small}");
    assert!(queued == 2);
    assert!(
        bulk_bytes_before_small < 4 * 1024 * 1024,
        "small stream waited behind {bulk_bytes_before_small} bulk bytes"
    );
    writer.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancellation_propagates_both_ways() {
    let r = start().await;
    let mut b = TestBox::registered(&r, "home", "alice", &[], &[]).await;
    let (v, _) = visitor(&r, "home.alice.flagship.services").await;
    let id = b.next_of(FRAME_OPEN).await.stream_id;
    drop(v);
    assert_eq!(
        b.next_of(FRAME_CLOSE).await.stream_id,
        id,
        "visitor hang-up reaches the box"
    );

    let (mut v, _) = visitor(&r, "home.alice.flagship.services").await;
    b.next_of(FRAME_OPEN).await;
    b.disconnect();
    assert!(
        read_to_eof(&mut v).await.is_empty(),
        "tunnel loss closes the visitor"
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(r.registry.lock().unwrap().size(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconnect_is_not_evicted_by_the_old_tunnels_close() {
    let r = start().await;
    let old = TestBox::registered(&r, "home", "alice", &[], &[]).await;
    let mut new = TestBox::registered(&r, "home", "alice", &[], &[]).await;
    old.disconnect();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (_v, _) = visitor(&r, "home.alice.flagship.services").await;
    assert_eq!(new.next_of(FRAME_OPEN).await.frame_type, FRAME_OPEN);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn park_nudges_and_releases_when_a_box_claims() {
    let r = start().await;
    let mut b = TestBox::registered(&r, "home", "alice", &[], &[]).await;
    let (mut v, hello) = visitor(&r, "notes.alice.flagship.services").await;
    let nudge = b.next_of(FRAME_OPEN).await;
    let req = collect(&mut b, nudge.stream_id, 30).await;
    let text = String::from_utf8_lossy(&req).into_owned();
    assert!(
        text.starts_with(
            "POST /internal/route-nudge HTTP/1.1\r\nHost: home.alice.flagship.services\r\n"
        ),
        "{text}"
    );
    v.write_all(b"early").await.unwrap();
    b.hello(
        "home",
        "alice",
        &["notes.alice.flagship.services"],
        &[],
        now_ms() + 1,
    );
    let open = loop {
        let f = b.next_of(FRAME_OPEN).await;
        if payload::parse_open(&f.payload) == "notes.alice.flagship.services" {
            break f;
        }
    };
    let mut want = hello.clone();
    want.extend_from_slice(b"early");
    assert_eq!(
        collect(&mut b, open.stream_id, want.len()).await,
        want,
        "parked bytes replay in order"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn misses_drop_after_the_hold_or_at_once() {
    let r = start().await;
    let _b = TestBox::registered(&r, "home", "alice", &[], &[]).await;
    let t0 = Instant::now();
    let (mut v, _) = visitor(&r, "home.bob.flagship.services").await;
    assert!(read_to_eof(&mut v).await.is_empty());
    assert!(
        t0.elapsed() >= Duration::from_millis(350),
        "first-party miss waits the hold: {:?}",
        t0.elapsed()
    );
    let t0 = Instant::now();
    let (mut v, _) = visitor(&r, "www.example.com").await;
    assert!(read_to_eof(&mut v).await.is_empty());
    assert!(t0.elapsed() < Duration::from_millis(300));
    // A stalled ClientHello is cut at the peek deadline.
    let mut s = TcpStream::connect(r.sni_addr).await.unwrap();
    s.write_all(&client_hello("home.alice.flagship.services")[..20])
        .await
        .unwrap();
    let t0 = Instant::now();
    assert!(read_to_eof(&mut s).await.is_empty());
    assert!(t0.elapsed() < Duration::from_secs(2));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn request_transfer_null_payload_is_ignored_not_fatal() {
    let r = start().await;
    let mut a = TestBox::registered(
        &r,
        "home",
        "alice",
        &["chess.home.alice.flagship.services"],
        &[],
    )
    .await;
    let mut c = TestBox::registered(
        &r,
        "cabin",
        "alice",
        &["chess.cabin.alice.flagship.services"],
        &[],
    )
    .await;
    c.send(&Frame::new(
        0,
        frame::FRAME_REQUEST_TRANSFER,
        b"null".to_vec(),
    ));
    c.send(&payload::request_transfer_frame(
        "chess.alice.flagship.services",
    ));
    loop {
        let g = c.next_of(FRAME_DOMAIN_GRANTED).await;
        let (fqdn, owner) = payload::parse_domain_granted(&g.payload).unwrap();
        if fqdn == "chess.alice.flagship.services" && owner == "cabin.alice.flagship.services" {
            break;
        }
    }
    let (_v, _) = visitor(&r, "chess.alice.flagship.services").await;
    assert_eq!(
        payload::parse_open(&c.next_of(FRAME_OPEN).await.payload),
        "chess.alice.flagship.services"
    );
    drop(a.next().await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn over_quota_account_is_slowed_not_refused() {
    let meter = Arc::new(LocalMeter::new(200_000.0).unwrap());
    meter.set_over_quota("alice", true);
    let r = start_with(cfg(), Some(meter.clone())).await;
    let mut b = TestBox::registered(&r, "home", "alice", &[], &[]).await;
    let (mut v, _) = visitor(&r, "home.alice.flagship.services").await;
    let id = b.next_of(FRAME_OPEN).await.stream_id;
    let t0 = Instant::now();
    for _ in 0..6 {
        b.send(&Frame::new(id, FRAME_DATA, vec![0; 100_000]));
    }
    read_exact_within(&mut v, 600_000).await;
    let took = t0.elapsed();
    assert!(
        took >= Duration::from_millis(1500),
        "600 kB at 200 kB/s with a 200 kB burst took {took:?}"
    );
    assert!(meter.total("alice") >= 600_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn proxy_echo_names_the_arrival_address() {
    let r = start().await;
    let mut s = TcpStream::connect(r.echo_addr.unwrap()).await.unwrap();
    s.write_all(b"PROXY TCP6 2001:db8::1 2a09:8280:1::110:d2b6:0 51000 8444\r\nGET / HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
    let resp = String::from_utf8(read_to_eof(&mut s).await).unwrap();
    assert!(resp.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(resp.ends_with("{\"relay\":\"flagship.services\",\"reachedAt\":\"2a09:8280:1::110:d2b6:0\",\"reachedPort\":8444}"), "{resp}");
    let mut s = TcpStream::connect(r.echo_addr.unwrap()).await.unwrap();
    s.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
    assert!(
        read_to_eof(&mut s).await.is_empty(),
        "no PROXY header: closed without a reply"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn drain_stops_accepting_and_closes_tunnels() {
    let r = start().await;
    let mut b = TestBox::registered(&r, "home", "alice", &[], &["drain-v1"]).await;
    let (mut v, _) = visitor(&r, "home.alice.flagship.services").await;
    let id = b.next_of(FRAME_OPEN).await.stream_id;
    let sni = r.sni_addr;
    let d = tokio::spawn(async move {
        let cut = r.drain(Duration::from_millis(200)).await;
        (cut, r)
    });
    b.next_of(FRAME_DRAIN_NOTICE).await;
    let (cut, r) = d.await.unwrap();
    assert_eq!(cut, 1, "the open stream outlived the grace");
    assert!(read_to_eof(&mut v).await.is_empty());
    let _ = id;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(TcpStream::connect(sni).await.is_err() || r.tunnel_count() == 0);
}

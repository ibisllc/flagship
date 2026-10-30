#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use std::io;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use flagship_relay::authority::BoxFut;
use flagship_relay::frame::{
    FRAME_CLOSE, FRAME_CLOSE_REMOTE, FRAME_DATA, FRAME_OUTBOUND_CREDIT, FRAME_OUTBOUND_RESULT,
    Frame,
};
use flagship_relay::outbound::budget::Limits;
use flagship_relay::outbound::{
    Connect, HostPolicy, HostRow, KnownHostsPolicy, Options, OutboundRelay, OutboundSession,
    Resolve, Sink,
};
use flagship_relay::payload::{self, OUTBOUND_INITIAL_WINDOW, OUTBOUND_STREAM_ID_BASE};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Default)]
struct Collect(Mutex<Vec<Frame>>);

impl Sink for Collect {
    fn send(&self, f: Frame) {
        self.0.lock().unwrap().push(f);
    }
}

impl Collect {
    fn frames(&self) -> Vec<Frame> {
        self.0.lock().unwrap().clone()
    }
    fn result_of(&self, id: u32) -> Option<(bool, Option<&'static str>)> {
        self.frames()
            .iter()
            .find(|f| f.frame_type == FRAME_OUTBOUND_RESULT && f.stream_id == id)
            .and_then(|f| payload::parse_outbound_result(&f.payload))
    }
    fn data_bytes(&self, id: u32) -> usize {
        self.frames()
            .iter()
            .filter(|f| f.frame_type == FRAME_DATA && f.stream_id == id)
            .map(|f| f.payload.len())
            .sum()
    }
}

struct Fixed(Vec<IpAddr>);
impl Resolve for Fixed {
    fn resolve<'a>(&'a self, _h: &'a str) -> BoxFut<'a, Result<Vec<IpAddr>, ()>> {
        Box::pin(async {
            if self.0.is_empty() {
                Err(())
            } else {
                Ok(self.0.clone())
            }
        })
    }
}

/// Connects every "public" address to a local test server.
struct ToLocal(std::net::SocketAddr);
impl Connect for ToLocal {
    fn connect<'a>(&'a self, _a: IpAddr, _p: u16) -> BoxFut<'a, io::Result<TcpStream>> {
        Box::pin(TcpStream::connect(self.0))
    }
}

struct Refuses;
impl Connect for Refuses {
    fn connect<'a>(&'a self, _a: IpAddr, _p: u16) -> BoxFut<'a, io::Result<TcpStream>> {
        Box::pin(async { Err(io::Error::new(io::ErrorKind::ConnectionRefused, "no")) })
    }
}

struct Policy {
    allow: bool,
    reported: Mutex<Vec<HostRow>>,
}
impl HostPolicy for Policy {
    fn allowed<'a>(&'a self, _h: &'a str) -> BoxFut<'a, bool> {
        Box::pin(async move { self.allow })
    }
    fn report(&self, rows: Vec<HostRow>) {
        self.reported.lock().unwrap().extend(rows);
    }
}

const PUBLIC: IpAddr = IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34));
const ID: u32 = OUTBOUND_STREAM_ID_BASE + 1;

fn open(id: u32, host: &str, port: u16) -> Frame {
    payload::outbound_open_frame(id, host, port).unwrap()
}

fn setup(
    addrs: Vec<IpAddr>,
    connect: Arc<dyn Connect>,
    policy: Arc<dyn HostPolicy>,
    o: Options,
) -> (Arc<OutboundRelay>, Arc<Collect>, OutboundSession) {
    let relay = OutboundRelay::new(o, Arc::new(Fixed(addrs)), connect, policy);
    let sink = Arc::new(Collect::default());
    let session = relay.session("home.john.flagship.services", sink.clone());
    (relay, sink, session)
}

async fn until(what: &str, f: impl Fn() -> bool) {
    for _ in 0..400 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("not within 4 s: {what}");
}

async fn server() -> (TcpListener, std::net::SocketAddr) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a = l.local_addr().unwrap();
    (l, a)
}

fn allow() -> Arc<Policy> {
    Arc::new(Policy {
        allow: true,
        reported: Mutex::new(vec![]),
    })
}

#[tokio::test]
async fn a_box_reaches_an_allowed_host_and_bytes_flow_both_ways_under_credit() {
    let (l, addr) = server().await;
    let (_relay, sink, session) = setup(
        vec![PUBLIC],
        Arc::new(ToLocal(addr)),
        allow(),
        Options::default(),
    );
    assert!(session.handle_frame(open(ID, "API.example.com", 443)));
    let (mut up, _) = l.accept().await.unwrap();
    until("the open result", || sink.result_of(ID).is_some()).await;
    assert_eq!(sink.result_of(ID), Some((true, None)));

    // box -> upstream, and the credit comes back once the bytes are on the wire
    session.handle_frame(Frame::new(ID, FRAME_DATA, b"hello upstream".to_vec()));
    let mut got = vec![0u8; 14];
    up.read_exact(&mut got).await.unwrap();
    assert_eq!(&got, b"hello upstream");
    until("the credit", || {
        sink.frames().iter().any(|f| {
            f.frame_type == FRAME_OUTBOUND_CREDIT && payload::parse_credit(&f.payload) == Some(14)
        })
    })
    .await;

    // upstream -> box
    up.write_all(b"hello box").await.unwrap();
    until("the reply", || sink.data_bytes(ID) == 9).await;

    // the box closes: the upstream sees the end
    session.handle_frame(Frame::new(ID, FRAME_CLOSE, vec![]));
    let mut rest = Vec::new();
    up.read_to_end(&mut rest).await.unwrap();
    until("the stream is gone", || session.active_streams() == 0).await;
}

#[tokio::test]
async fn an_upstream_that_ends_tells_the_box_with_close_remote() {
    let (l, addr) = server().await;
    let (_relay, sink, session) = setup(
        vec![PUBLIC],
        Arc::new(ToLocal(addr)),
        allow(),
        Options::default(),
    );
    session.handle_frame(open(ID, "api.example.com", 443));
    let (up, _) = l.accept().await.unwrap();
    until("open", || sink.result_of(ID).is_some()).await;
    drop(up);
    until("close remote", || {
        sink.frames()
            .iter()
            .any(|f| f.frame_type == FRAME_CLOSE_REMOTE && f.stream_id == ID)
    })
    .await;
    until("the stream is gone", || session.active_streams() == 0).await;
}

#[tokio::test]
async fn nothing_reaches_the_box_past_its_credit_window() {
    let (l, addr) = server().await;
    let (_relay, sink, session) = setup(
        vec![PUBLIC],
        Arc::new(ToLocal(addr)),
        allow(),
        Options::default(),
    );
    session.handle_frame(open(ID, "api.example.com", 443));
    let (mut up, _) = l.accept().await.unwrap();
    until("open", || sink.result_of(ID).is_some()).await;
    let big = vec![7u8; OUTBOUND_INITIAL_WINDOW as usize + 100_000];
    up.write_all(&big).await.unwrap();
    until("a full window", || {
        sink.data_bytes(ID) == OUTBOUND_INITIAL_WINDOW as usize
    })
    .await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        sink.data_bytes(ID),
        OUTBOUND_INITIAL_WINDOW as usize,
        "no more flows until the box grants credit"
    );
    session.handle_frame(payload::outbound_credit_frame(ID, 100_000).unwrap());
    until("the rest", || sink.data_bytes(ID) == big.len()).await;
}

#[tokio::test]
async fn a_box_that_sends_past_the_window_loses_the_stream() {
    let (l, addr) = server().await;
    let (_relay, sink, session) = setup(
        vec![PUBLIC],
        Arc::new(ToLocal(addr)),
        allow(),
        Options::default(),
    );
    session.handle_frame(open(ID, "api.example.com", 443));
    let (_up, _) = l.accept().await.unwrap();
    until("open", || sink.result_of(ID).is_some()).await;
    session.handle_frame(Frame::new(
        ID,
        FRAME_DATA,
        vec![1u8; OUTBOUND_INITIAL_WINDOW as usize + 1],
    ));
    until("close remote", || {
        sink.frames()
            .iter()
            .any(|f| f.frame_type == FRAME_CLOSE_REMOTE && f.stream_id == ID)
    })
    .await;
}

#[tokio::test]
async fn bad_requests_forbidden_names_and_ports_are_refused_with_the_documented_reasons() {
    let (_relay, sink, session) =
        setup(vec![PUBLIC], Arc::new(Refuses), allow(), Options::default());
    let cases: Vec<(Frame, &str)> = vec![
        (
            Frame::new(
                ID,
                flagship_relay::frame::FRAME_OUTBOUND_OPEN,
                b"not json".to_vec(),
            ),
            "bad-request",
        ),
        (open(ID + 1, "api.example.com", 80), "forbidden-port"),
        (open(ID + 2, "127.0.0.1", 443), "forbidden-host"),
        (open(ID + 3, "localhost", 443), "forbidden-host"),
        (open(ID + 4, "metadata.internal", 443), "forbidden-host"),
    ];
    for (f, want) in cases {
        let id = f.stream_id;
        session.handle_frame(f);
        assert_eq!(sink.result_of(id), Some((false, Some(want))), "{want}");
    }
    // a stream id outside the box's space is a bad request, not an open
    session.handle_frame(Frame::new(
        5,
        flagship_relay::frame::FRAME_OUTBOUND_OPEN,
        b"{\"host\":\"a.example\",\"port\":443}".to_vec(),
    ));
    assert_eq!(sink.result_of(5), Some((false, Some("bad-request"))));
    assert_eq!(session.active_streams(), 0);
}

#[tokio::test]
async fn a_name_with_any_private_record_is_refused_and_so_is_a_name_that_does_not_resolve() {
    let private = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5));
    let (_r, sink, session) = setup(
        vec![PUBLIC, private],
        Arc::new(Refuses),
        allow(),
        Options::default(),
    );
    session.handle_frame(open(ID, "steered.example.com", 443));
    until("result", || sink.result_of(ID).is_some()).await;
    assert_eq!(sink.result_of(ID), Some((false, Some("forbidden-address"))));
    let (_r, sink, session) = setup(vec![], Arc::new(Refuses), allow(), Options::default());
    session.handle_frame(open(ID, "nowhere.example.com", 443));
    until("result", || sink.result_of(ID).is_some()).await;
    assert_eq!(sink.result_of(ID), Some((false, Some("dns-failed"))));
    let (_r, sink, session) = setup(vec![PUBLIC], Arc::new(Refuses), allow(), Options::default());
    session.handle_frame(open(ID, "down.example.com", 443));
    until("result", || sink.result_of(ID).is_some()).await;
    assert_eq!(sink.result_of(ID), Some((false, Some("connect-failed"))));
    until("the slot is released", || session.active_streams() == 0).await;
}

#[tokio::test]
async fn the_host_policy_decides_and_unknown_hosts_are_rationed() {
    let deny = Arc::new(Policy {
        allow: false,
        reported: Mutex::new(vec![]),
    });
    let (_r, sink, session) = setup(vec![PUBLIC], Arc::new(Refuses), deny, Options::default());
    session.handle_frame(open(ID, "blocked.example.com", 443));
    until("result", || sink.result_of(ID).is_some()).await;
    assert_eq!(sink.result_of(ID), Some((false, Some("forbidden-host"))));

    // the default policy: only the known AI providers
    let (_r, sink, session) = setup(
        vec![PUBLIC],
        Arc::new(Refuses),
        Arc::new(KnownHostsPolicy),
        Options::default(),
    );
    session.handle_frame(open(ID, "random.example.com", 443));
    until("result", || sink.result_of(ID).is_some()).await;
    assert_eq!(sink.result_of(ID), Some((false, Some("forbidden-host"))));

    // at most N new hosts an hour, a repeat is free (rationing happens before the policy is asked)
    let o = Options {
        limits: Limits {
            new_hosts_per_hour: 2,
            ..Limits::default()
        },
        ..Options::default()
    };
    let (_r, sink, session) = setup(vec![PUBLIC], Arc::new(Refuses), allow(), o);
    for (i, h) in ["a.example.com", "b.example.com", "c.example.com"]
        .iter()
        .enumerate()
    {
        session.handle_frame(open(ID + i as u32, h, 443));
    }
    until("three answers", || {
        (0..3).all(|i| sink.result_of(ID + i).is_some())
    })
    .await;
    let refused: Vec<_> = (0..3)
        .filter(|i| sink.result_of(ID + i) == Some((false, Some("forbidden-host"))))
        .collect();
    assert_eq!(
        refused,
        vec![2],
        "the third new host in the hour is refused"
    );
}

#[tokio::test]
async fn a_box_has_a_stream_cap_and_an_open_rate() {
    let (l, addr) = server().await;
    let o = Options {
        max_streams_per_box: 2,
        ..Options::default()
    };
    let (_r, sink, session) = setup(vec![PUBLIC], Arc::new(ToLocal(addr)), allow(), o);
    session.handle_frame(open(ID, "api.example.com", 443));
    session.handle_frame(open(ID + 1, "api.example.com", 443));
    let _a = l.accept().await.unwrap();
    let _b = l.accept().await.unwrap();
    until("two open", || {
        sink.result_of(ID).is_some() && sink.result_of(ID + 1).is_some()
    })
    .await;
    session.handle_frame(open(ID + 2, "api.example.com", 443));
    assert_eq!(
        sink.result_of(ID + 2),
        Some((false, Some("too-many-streams")))
    );
    session.handle_frame(open(ID, "api.example.com", 443));
    assert_eq!(
        sink.result_of(ID).map(|r| r.0),
        Some(true),
        "the first answer stands; a duplicate id is answered separately"
    );
    assert!(
        sink.frames()
            .iter()
            .filter(|f| f.frame_type == FRAME_OUTBOUND_RESULT && f.stream_id == ID)
            .count()
            >= 2
    );

    let o = Options {
        limits: Limits {
            opens_per_minute: 2.0,
            ..Limits::default()
        },
        ..Options::default()
    };
    let (_r, sink, session) = setup(vec![PUBLIC], Arc::new(Refuses), allow(), o);
    for i in 0..3 {
        session.handle_frame(open(ID + i, "api.example.com", 443));
    }
    assert_eq!(sink.result_of(ID + 2), Some((false, Some("rate-limited"))));
}

#[tokio::test]
async fn closing_the_session_drops_every_upstream_without_telling_the_box() {
    let (l, addr) = server().await;
    let (_r, sink, session) = setup(
        vec![PUBLIC],
        Arc::new(ToLocal(addr)),
        allow(),
        Options::default(),
    );
    session.handle_frame(open(ID, "api.example.com", 443));
    let (mut up, _) = l.accept().await.unwrap();
    until("open", || sink.result_of(ID).is_some()).await;
    let before = sink.frames().len();
    session.close();
    let mut rest = Vec::new();
    up.read_to_end(&mut rest).await.unwrap();
    assert!(rest.is_empty());
    assert_eq!(
        sink.frames().len(),
        before,
        "nothing more is sent to a tunnel that is gone"
    );
}

#[tokio::test]
async fn only_totals_are_kept_and_per_host_rows_go_to_the_policy() {
    let (l, addr) = server().await;
    let pol = allow();
    let (relay, sink, session) = setup(
        vec![PUBLIC],
        Arc::new(ToLocal(addr)),
        pol.clone(),
        Options::default(),
    );
    session.handle_frame(open(ID, "api.anthropic.com", 443));
    let (mut up, _) = l.accept().await.unwrap();
    until("open", || sink.result_of(ID).is_some()).await;
    session.handle_frame(Frame::new(ID, FRAME_DATA, vec![1; 10]));
    let mut b = [0u8; 10];
    up.read_exact(&mut b).await.unwrap();
    up.write_all(&[2; 30]).await.unwrap();
    until("the reply", || sink.data_bytes(ID) == 30).await;
    session.handle_frame(Frame::new(ID, FRAME_CLOSE, vec![]));
    until("the stream is gone", || session.active_streams() == 0).await;
    session.handle_frame(open(ID + 1, "127.0.0.1", 443));
    let line = relay.flush_stats().unwrap();
    assert_eq!(
        line,
        "[outbound-relay] streams=1 to=api.anthropic.com:1 up=10 down=30 refused=forbidden-host:1"
    );
    assert!(!line.contains("home.john"), "nothing names a box");
    let rows = pol.reported.lock().unwrap().clone();
    assert_eq!(
        rows,
        vec![HostRow {
            host: "api.anthropic.com".into(),
            streams: 1,
            up: 10,
            down: 30,
            refused: 0
        }]
    );
    assert_eq!(relay.flush_stats(), None, "an idle relay logs nothing");
}

#[tokio::test]
async fn an_upstream_that_goes_quiet_is_closed_after_the_idle_timeout() {
    let (l, addr) = server().await;
    let o = Options {
        idle_timeout: Duration::from_millis(300),
        ..Options::default()
    };
    let (_r, sink, session) = setup(vec![PUBLIC], Arc::new(ToLocal(addr)), allow(), o);
    session.handle_frame(open(ID, "api.example.com", 443));
    let (_up, _) = l.accept().await.unwrap();
    until("open", || sink.result_of(ID).is_some()).await;
    until("the idle close", || {
        sink.frames()
            .iter()
            .any(|f| f.frame_type == FRAME_CLOSE_REMOTE && f.stream_id == ID)
    })
    .await;
}

#[tokio::test]
async fn a_box_over_its_byte_budget_waits_for_the_bucket_to_refill() {
    let (l, addr) = server().await;
    let o = Options {
        limits: Limits {
            bytes_per_second: 2000.0,
            burst_bytes: 1000.0,
            ..Limits::default()
        },
        ..Options::default()
    };
    let (_r, sink, session) = setup(vec![PUBLIC], Arc::new(ToLocal(addr)), allow(), o);
    session.handle_frame(open(ID, "api.example.com", 443));
    let (mut up, _) = l.accept().await.unwrap();
    until("open", || sink.result_of(ID).is_some()).await;
    // The chunk that overdraws the bucket is sent at once (the debt is paid before the NEXT chunk, as in the TypeScript hub).
    up.write_all(&vec![9u8; 4000]).await.unwrap();
    until("the first chunk", || sink.data_bytes(ID) == 4000).await;
    let started = std::time::Instant::now();
    up.write_all(&[1u8; 100]).await.unwrap();
    until("the second chunk", || sink.data_bytes(ID) == 4100).await;
    assert!(
        started.elapsed() >= Duration::from_millis(1200),
        "3000 bytes of debt at 2000 B/s hold the next chunk back about 1.5 s ({:?})",
        started.elapsed()
    );
}

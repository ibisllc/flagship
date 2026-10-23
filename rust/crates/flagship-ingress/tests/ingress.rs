//! End-to-end: a fake keyd (hello / tls.active / tls.sign with a P-256 key, framed by hand so
//! it does not share the ingress's codec), a fake daemon socket, the real ingress, and real
//! rustls clients. These mirror installer/tls-frontend/main_test.go and add the bounds and
//! hybrid key-exchange cases.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::io::{Read, Write};
use std::net::SocketAddr;
use std::os::unix::net::{UnixListener as StdUnixListener, UnixStream as StdUnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use flagship_ingress::keyd::{KeydClient, KeydError};
use flagship_ingress::server::{self, IngressConfig, KxPolicy, Limits};
use flagship_ingress::source::CertSource;
use p256::ecdsa::signature::hazmat::PrehashSigner;
use p256::pkcs8::DecodePrivateKey;
use rustls::crypto::{CryptoProvider, SupportedKxGroup, aws_lc_rs};
use rustls::pki_types::{CertificateDer, ServerName};
use rustls::{ClientConfig, NamedGroup, RootCertStore};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpStream, UnixListener};
use tokio::sync::mpsc;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

const HOME: &str = "home.alice.flagship.services";
const CHESS: &str = "chess.home.alice.flagship.services";

static SEQ: AtomicUsize = AtomicUsize::new(0);

fn short_dir(tag: &str) -> PathBuf {
    // Unix socket paths are short on macOS.
    let base = std::env::temp_dir();
    let base = if base.as_os_str().len() > 60 {
        PathBuf::from("/tmp")
    } else {
        base
    };
    let d = base.join(format!(
        "fi-{tag}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[derive(Clone)]
struct FakeCert {
    handle: String,
    chain_pem: String,
    ca: CertificateDer<'static>,
    key: p256::ecdsa::SigningKey,
}

fn fake_cert(handle: &str, names: &[&str]) -> FakeCert {
    let ca_key = rcgen::KeyPair::generate().unwrap();
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca_params
        .distinguished_name
        .push(rcgen::DnType::CommonName, format!("test ca {handle}"));
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let issuer = rcgen::Issuer::new(ca_params, ca_key);
    let leaf_key = rcgen::KeyPair::generate().unwrap();
    let leaf_params =
        rcgen::CertificateParams::new(names.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>())
            .unwrap();
    let leaf = leaf_params.signed_by(&leaf_key, &issuer).unwrap();
    let key = p256::ecdsa::SigningKey::from_pkcs8_der(&leaf_key.serialize_der()).unwrap();
    FakeCert {
        handle: handle.into(),
        chain_pem: leaf.pem(),
        ca: ca.der().clone(),
        key,
    }
}

#[derive(Default)]
struct KeydState {
    active: Option<FakeCert>,
    down: bool,
    signs: usize,
    oversize: bool,
    wrong_key: Option<p256::ecdsa::SigningKey>,
    hellos: usize,
}

struct FakeKeyd {
    path: PathBuf,
    state: Arc<Mutex<KeydState>>,
}

impl FakeKeyd {
    fn start(active: Option<FakeCert>) -> Self {
        let dir = short_dir("kd");
        let path = dir.join("k.sock");
        let ln = StdUnixListener::bind(&path).unwrap();
        let state = Arc::new(Mutex::new(KeydState {
            active,
            ..KeydState::default()
        }));
        let st = Arc::clone(&state);
        std::thread::spawn(move || {
            for c in ln.incoming() {
                let Ok(c) = c else { return };
                let st = Arc::clone(&st);
                std::thread::spawn(move || serve_keyd(c, &st));
            }
        });
        Self { path, state }
    }

    fn set(&self, f: impl FnOnce(&mut KeydState)) {
        f(&mut self.state.lock().unwrap());
    }

    fn signs(&self) -> usize {
        self.state.lock().unwrap().signs
    }
}

fn serve_keyd(mut c: StdUnixStream, st: &Mutex<KeydState>) {
    let mut said_hello = false;
    loop {
        let mut hdr = [0u8; 4];
        if c.read_exact(&mut hdr).is_err() {
            return;
        }
        let n = u32::from_be_bytes(hdr) as usize;
        if n == 0 || n > 4 << 20 {
            return;
        }
        let mut body = vec![0u8; n];
        if c.read_exact(&mut body).is_err() {
            return;
        }
        let req: Value = serde_json::from_slice(&body).unwrap();
        let id = req["id"].as_u64().unwrap();
        let op = req["op"].as_str().unwrap().to_owned();
        let mut s = st.lock().unwrap();
        if s.down {
            return;
        }
        if s.oversize {
            let _ = c.write_all(&(5u32 << 20).to_be_bytes());
            return;
        }
        let res = if !said_hello && op != "hello" {
            json!({"id": id, "ok": false, "code": "not-hello", "message": "say hello first"})
        } else {
            match op.as_str() {
                "hello" => {
                    assert_eq!(req["args"]["v"], 1);
                    assert!(req["args"]["component"].is_string());
                    said_hello = true;
                    s.hellos += 1;
                    json!({"id": id, "ok": true, "result": {"v": 1, "publicKey": "00", "hasSwk": true, "hasCgk": true}})
                }
                "tls.active" => match &s.active {
                    None => json!({"id": id, "ok": true, "result": {"active": null}}),
                    Some(a) => json!({"id": id, "ok": true, "result": {"active": {
                        "handle": a.handle, "chainPem": a.chain_pem, "notAfter": 0, "names": [HOME], "legacy": false}}}),
                },
                "tls.sign" => {
                    s.signs += 1;
                    let handle = req["args"]["handle"].as_str().unwrap();
                    let digest = hex(req["args"]["digest"].as_str().unwrap());
                    match &s.active {
                        Some(a) if a.handle == handle => {
                            let key = s.wrong_key.clone().unwrap_or_else(|| a.key.clone());
                            let sig: p256::ecdsa::Signature = key.sign_prehash(&digest).unwrap();
                            json!({"id": id, "ok": true, "result": {"sig": to_hex(sig.to_der().as_bytes())}})
                        }
                        _ => {
                            json!({"id": id, "ok": false, "code": "forbidden", "message": "unknown key"})
                        }
                    }
                }
                _ => json!({"id": id, "ok": false, "code": "unknown-op", "message": "no"}),
            }
        };
        drop(s);
        let out = serde_json::to_vec(&res).unwrap();
        let mut frame = (out.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(&out);
        if c.write_all(&frame).is_err() {
            return;
        }
    }
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The daemon's side: records the header line, echoes everything after it.
struct Upstream {
    path: PathBuf,
    headers: mpsc::UnboundedReceiver<(Value, Vec<u8>)>,
}

async fn start_upstream() -> Upstream {
    let path = short_dir("up").join("u.sock");
    let ln = UnixListener::bind(&path).unwrap();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((c, _)) = ln.accept().await {
            let tx = tx.clone();
            tokio::spawn(async move {
                let (r, mut w) = c.into_split();
                let mut r = BufReader::new(r);
                let mut line = Vec::new();
                if r.read_until(b'\n', &mut line).await.is_err() || line.is_empty() {
                    return;
                }
                let raw = line.clone();
                let _ = tx.send((serde_json::from_slice(&line).unwrap(), raw));
                let _ = tokio::io::copy(&mut r, &mut w).await;
                let _ = w.shutdown().await;
            });
        }
    });
    Upstream { path, headers: rx }
}

struct Ingress {
    addr: SocketAddr,
    source: Arc<CertSource>,
}

async fn start_ingress(
    kd: &FakeKeyd,
    up: &Upstream,
    limits: Limits,
    kx: KxPolicy,
    refresh: Duration,
) -> Ingress {
    let keyd = Arc::new(KeydClient::new(
        &kd.path,
        "ingress-test",
        Duration::from_secs(2),
    ));
    let source = Arc::new(CertSource::new(keyd, limits.handshake_timeout));
    let s = Arc::clone(&source);
    let _ = tokio::task::spawn_blocking(move || s.reload())
        .await
        .unwrap();
    tokio::spawn(Arc::clone(&source).run_reloader(refresh, Duration::from_millis(5), |_| {}));
    let tls = server::tls_configs(&source, kx).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cfg = Arc::new(IngressConfig {
        upstream: up.path.clone(),
        limits,
        kx,
    });
    tokio::spawn(server::serve(listener, cfg, tls, std::future::pending()));
    Ingress { addr, source }
}

fn test_limits() -> Limits {
    Limits {
        handshake_timeout: Duration::from_secs(3),
        max_conns: 64,
        ..Limits::default()
    }
}

struct ClientOpts {
    groups: Vec<&'static dyn SupportedKxGroup>,
    alpn: Vec<&'static [u8]>,
    tls12_only: bool,
}

impl Default for ClientOpts {
    fn default() -> Self {
        Self {
            groups: aws_lc_rs::default_provider().kx_groups,
            alpn: vec![b"http/1.1"],
            tls12_only: false,
        }
    }
}

async fn connect(
    addr: SocketAddr,
    sni: &str,
    trust: &CertificateDer<'static>,
    o: ClientOpts,
) -> std::io::Result<TlsStream<TcpStream>> {
    let mut roots = RootCertStore::empty();
    roots.add(trust.clone()).unwrap();
    let provider = Arc::new(CryptoProvider {
        kx_groups: o.groups,
        ..aws_lc_rs::default_provider()
    });
    let versions: &[&rustls::SupportedProtocolVersion] = if o.tls12_only {
        &[&rustls::version::TLS12]
    } else {
        &[&rustls::version::TLS13, &rustls::version::TLS12]
    };
    let mut cc = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(versions)
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    cc.alpn_protocols = o.alpn.iter().map(|p| p.to_vec()).collect();
    let tcp = TcpStream::connect(addr).await?;
    let name = ServerName::try_from(sni.to_owned()).unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        TlsConnector::from(Arc::new(cc)).connect(name, tcp),
    )
    .await
    .map_err(|_| std::io::Error::other("client handshake timed out"))?
}

async fn echo(c: &mut TlsStream<TcpStream>, msg: &[u8]) -> Vec<u8> {
    c.write_all(msg).await.unwrap();
    let mut got = vec![0u8; msg.len()];
    tokio::time::timeout(Duration::from_secs(3), c.read_exact(&mut got))
        .await
        .unwrap()
        .unwrap();
    got
}

const REQ: &[u8] = b"GET / HTTP/1.1\r\nHost: home.alice.flagship.services\r\n\r\n";

async fn no_header(up: &mut Upstream) {
    if let Ok(Some(h)) = tokio::time::timeout(Duration::from_millis(200), up.headers.recv()).await {
        panic!("a refused connection reached the daemon: {h:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_tls_with_the_key_in_keyd_and_forwards_plaintext() {
    let fc = fake_cert("h1", &[HOME, "*.home.alice.flagship.services"]);
    let kd = FakeKeyd::start(Some(fc.clone()));
    let mut up = start_upstream().await;
    let ing = start_ingress(
        &kd,
        &up,
        test_limits(),
        KxPolicy::PreferHybrid,
        Duration::from_secs(1),
    )
    .await;

    let mut c = connect(ing.addr, CHESS, &fc.ca, ClientOpts::default())
        .await
        .unwrap();
    let (_, conn) = c.get_ref();
    assert_eq!(
        conn.protocol_version(),
        Some(rustls::ProtocolVersion::TLSv1_3)
    );
    assert_eq!(conn.alpn_protocol(), Some(&b"http/1.1"[..]));
    assert_eq!(
        conn.negotiated_key_exchange_group().unwrap().name(),
        NamedGroup::X25519MLKEM768
    );
    assert_eq!(echo(&mut c, REQ).await, REQ);
    let (h, raw) = up.headers.recv().await.unwrap();
    assert_eq!(h, json!({"sni": CHESS, "alpn": "http/1.1", "tls": "1.3"}));
    assert_eq!(
        raw,
        format!("{{\"sni\":\"{CHESS}\",\"alpn\":\"http/1.1\",\"tls\":\"1.3\"}}\n").into_bytes()
    );
    assert!(kd.signs() > 0, "the handshake was not signed by keyd");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_offering_only_x25519mlkem768_negotiates_it() {
    let fc = fake_cert("h1", &[HOME, "*.home.alice.flagship.services"]);
    let kd = FakeKeyd::start(Some(fc.clone()));
    let up = start_upstream().await;
    let ing = start_ingress(
        &kd,
        &up,
        test_limits(),
        KxPolicy::PreferHybrid,
        Duration::from_secs(1),
    )
    .await;
    let o = ClientOpts {
        groups: vec![aws_lc_rs::kx_group::X25519MLKEM768],
        ..ClientOpts::default()
    };
    let mut c = connect(ing.addr, HOME, &fc.ca, o).await.unwrap();
    assert_eq!(
        c.get_ref()
            .1
            .negotiated_key_exchange_group()
            .unwrap()
            .name(),
        NamedGroup::X25519MLKEM768
    );
    assert_eq!(echo(&mut c, REQ).await, REQ);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_server_prefers_the_hybrid_even_when_the_client_lists_x25519_first() {
    let fc = fake_cert("h1", &[HOME]);
    let kd = FakeKeyd::start(Some(fc.clone()));
    let up = start_upstream().await;
    let ing = start_ingress(
        &kd,
        &up,
        test_limits(),
        KxPolicy::PreferHybrid,
        Duration::from_secs(1),
    )
    .await;
    let o = ClientOpts {
        groups: vec![
            aws_lc_rs::kx_group::X25519,
            aws_lc_rs::kx_group::X25519MLKEM768,
        ],
        ..ClientOpts::default()
    };
    let c = connect(ing.addr, HOME, &fc.ca, o).await.unwrap();
    assert_eq!(
        c.get_ref()
            .1
            .negotiated_key_exchange_group()
            .unwrap()
            .name(),
        NamedGroup::X25519MLKEM768
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn classical_clients_are_still_accepted_unless_hybrid_is_required() {
    let fc = fake_cert("h1", &[HOME]);
    let kd = FakeKeyd::start(Some(fc.clone()));
    let mut up = start_upstream().await;
    let ing = start_ingress(
        &kd,
        &up,
        test_limits(),
        KxPolicy::PreferHybrid,
        Duration::from_secs(1),
    )
    .await;
    let o = ClientOpts {
        groups: vec![aws_lc_rs::kx_group::X25519],
        ..ClientOpts::default()
    };
    let mut c = connect(ing.addr, HOME, &fc.ca, o).await.unwrap();
    assert_eq!(
        c.get_ref()
            .1
            .negotiated_key_exchange_group()
            .unwrap()
            .name(),
        NamedGroup::X25519
    );
    assert_eq!(echo(&mut c, REQ).await, REQ);
    up.headers.recv().await.unwrap();

    // TLS 1.2 still works (flagship-tlsd's minimum) and is labelled for the daemon.
    let o = ClientOpts {
        tls12_only: true,
        ..ClientOpts::default()
    };
    let mut c = connect(ing.addr, HOME, &fc.ca, o).await.unwrap();
    assert_eq!(
        c.get_ref().1.protocol_version(),
        Some(rustls::ProtocolVersion::TLSv1_2)
    );
    assert_eq!(echo(&mut c, REQ).await, REQ);
    assert_eq!(up.headers.recv().await.unwrap().0["tls"], "1.2");

    let strict = start_ingress(
        &kd,
        &up,
        test_limits(),
        KxPolicy::RequireHybrid,
        Duration::from_secs(1),
    )
    .await;
    let o = ClientOpts {
        groups: vec![aws_lc_rs::kx_group::X25519],
        ..ClientOpts::default()
    };
    assert!(connect(strict.addr, HOME, &fc.ca, o).await.is_err());
    assert!(
        connect(strict.addr, HOME, &fc.ca, ClientOpts::default())
            .await
            .is_ok()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_name_the_certificate_does_not_cover() {
    let fc = fake_cert("h1", &[HOME, "*.home.alice.flagship.services"]);
    let kd = FakeKeyd::start(Some(fc.clone()));
    let mut up = start_upstream().await;
    let ing = start_ingress(
        &kd,
        &up,
        test_limits(),
        KxPolicy::PreferHybrid,
        Duration::from_secs(1),
    )
    .await;
    for sni in [
        "evil.example.com",
        "alice.flagship.services",
        "a.b.home.alice.flagship.services",
        "127.0.0.1",
    ] {
        assert!(
            connect(ing.addr, sni, &fc.ca, ClientOpts::default())
                .await
                .is_err(),
            "handshake for {sni} succeeded"
        );
    }
    no_header(&mut up).await;
    assert_eq!(kd.signs(), 0, "keyd signed for a refused name");
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_acme_tls_alpn() {
    let fc = fake_cert("h1", &[HOME]);
    let kd = FakeKeyd::start(Some(fc.clone()));
    let mut up = start_upstream().await;
    let ing = start_ingress(
        &kd,
        &up,
        test_limits(),
        KxPolicy::PreferHybrid,
        Duration::from_secs(1),
    )
    .await;
    let o = ClientOpts {
        alpn: vec![b"acme-tls/1"],
        ..ClientOpts::default()
    };
    assert!(connect(ing.addr, HOME, &fc.ca, o).await.is_err());
    let o = ClientOpts {
        alpn: vec![b"h2"],
        ..ClientOpts::default()
    };
    assert!(
        connect(ing.addr, HOME, &fc.ca, o).await.is_err(),
        "h2 is not offered"
    );
    no_header(&mut up).await;
    let o = ClientOpts {
        alpn: vec![b"acme-tls/1", b"h2", b"http/1.1"],
        ..ClientOpts::default()
    };
    let c = connect(ing.addr, HOME, &fc.ca, o).await.unwrap();
    assert_eq!(c.get_ref().1.alpn_protocol(), Some(&b"http/1.1"[..]));
    // No ALPN at all is still served (as Go does), labelled "" for the daemon.
    let o = ClientOpts {
        alpn: vec![],
        ..ClientOpts::default()
    };
    let mut c = connect(ing.addr, HOME, &fc.ca, o).await.unwrap();
    assert_eq!(echo(&mut c, REQ).await, REQ);
    assert_eq!(up.headers.recv().await.unwrap().0["alpn"], "");
}

#[tokio::test(flavor = "multi_thread")]
async fn picks_up_a_renewal_on_the_timer_without_dropping_connections() {
    let old = fake_cert("old1", &[HOME]);
    let kd = FakeKeyd::start(Some(old.clone()));
    let up = start_upstream().await;
    let ing = start_ingress(
        &kd,
        &up,
        test_limits(),
        KxPolicy::PreferHybrid,
        Duration::from_millis(50),
    )
    .await;
    let mut c1 = connect(ing.addr, HOME, &old.ca, ClientOpts::default())
        .await
        .unwrap();
    assert_eq!(echo(&mut c1, REQ).await, REQ);

    let fresh = fake_cert("new1", &[HOME]);
    kd.set(|s| s.active = Some(fresh.clone()));
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut c2 = connect(ing.addr, HOME, &fresh.ca, ClientOpts::default())
        .await
        .unwrap();
    assert_eq!(echo(&mut c2, REQ).await, REQ);
    assert!(
        connect(ing.addr, HOME, &old.ca, ClientOpts::default())
            .await
            .is_err(),
        "the old certificate is still served"
    );
    // The connection opened before the renewal still works.
    assert_eq!(echo(&mut c1, b"still here\n").await, b"still here\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn reloads_on_demand() {
    let old = fake_cert("old2", &[HOME]);
    let kd = FakeKeyd::start(Some(old.clone()));
    let up = start_upstream().await;
    let ing = start_ingress(
        &kd,
        &up,
        test_limits(),
        KxPolicy::PreferHybrid,
        Duration::from_secs(3600),
    )
    .await;
    connect(ing.addr, HOME, &old.ca, ClientOpts::default())
        .await
        .unwrap();
    let fresh = fake_cert("new2", &[HOME]);
    kd.set(|s| s.active = Some(fresh.clone()));
    ing.source.request_reload();
    tokio::time::sleep(Duration::from_millis(150)).await;
    connect(ing.addr, HOME, &fresh.ca, ClientOpts::default())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn no_certificate_yet_is_refused_then_served_once_keyd_has_one() {
    let kd = FakeKeyd::start(None);
    let up = start_upstream().await;
    let ing = start_ingress(
        &kd,
        &up,
        test_limits(),
        KxPolicy::PreferHybrid,
        Duration::from_secs(3600),
    )
    .await;
    let fc = fake_cert("h3", &[HOME]);
    assert!(
        connect(ing.addr, HOME, &fc.ca, ClientOpts::default())
            .await
            .is_err()
    );
    kd.set(|s| s.active = Some(fc.clone()));
    // The refused handshake asked for a reload; the next one is served.
    let _ = connect(ing.addr, HOME, &fc.ca, ClientOpts::default()).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    connect(ing.addr, HOME, &fc.ca, ClientOpts::default())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn fails_closed_when_keyd_is_down() {
    let fc = fake_cert("h1", &[HOME]);
    let kd = FakeKeyd::start(Some(fc.clone()));
    let mut up = start_upstream().await;
    let ing = start_ingress(
        &kd,
        &up,
        test_limits(),
        KxPolicy::PreferHybrid,
        Duration::from_millis(20),
    )
    .await;
    connect(ing.addr, HOME, &fc.ca, ClientOpts::default())
        .await
        .unwrap();
    up.headers.try_recv().ok();
    kd.set(|s| s.down = true);
    std::fs::remove_file(&kd.path).unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;
    // The certificate is cached, but a handshake needs a keyd signature.
    assert!(
        connect(ing.addr, HOME, &fc.ca, ClientOpts::default())
            .await
            .is_err(),
        "handshake succeeded with keyd gone"
    );
    no_header(&mut up).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_signature_by_another_key() {
    let fc = fake_cert("h1", &[HOME]);
    let kd = FakeKeyd::start(Some(fc.clone()));
    let up = start_upstream().await;
    let ing = start_ingress(
        &kd,
        &up,
        test_limits(),
        KxPolicy::PreferHybrid,
        Duration::from_secs(1),
    )
    .await;
    let other = fake_cert("x", &[HOME]);
    kd.set(|s| s.wrong_key = Some(other.key.clone()));
    assert!(
        connect(ing.addr, HOME, &fc.ca, ClientOpts::default())
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_oversize_keyd_frame_fails_closed() {
    let fc = fake_cert("h1", &[HOME]);
    let kd = FakeKeyd::start(Some(fc.clone()));
    let up = start_upstream().await;
    let ing = start_ingress(
        &kd,
        &up,
        test_limits(),
        KxPolicy::PreferHybrid,
        Duration::from_secs(3600),
    )
    .await;
    kd.set(|s| s.oversize = true);
    assert!(
        connect(ing.addr, HOME, &fc.ca, ClientOpts::default())
            .await
            .is_err()
    );

    let client = KeydClient::new(&kd.path, "t", Duration::from_secs(1));
    match client.active() {
        Err(KeydError::Transport(m)) => assert!(m.contains("out of range"), "{m}"),
        other => panic!("oversize frame accepted: {other:?}"),
    }
    kd.set(|s| s.oversize = false);
    assert!(
        client.active().unwrap().is_some(),
        "the client redials after a bad frame"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn says_hello_first_and_redials() {
    let fc = fake_cert("h1", &[HOME]);
    let kd = FakeKeyd::start(Some(fc));
    let client = KeydClient::new(&kd.path, "t", Duration::from_secs(1));
    assert!(client.active().unwrap().is_some());
    assert!(client.active().unwrap().is_some());
    assert_eq!(
        kd.state.lock().unwrap().hellos,
        1,
        "one connection, one hello"
    );
    assert!(matches!(
        client.sign("nope", &[0u8; 32]),
        Err(KeydError::Refused { .. })
    ));
    assert!(
        client.sign("h1", &[0u8; 20]).is_err(),
        "only SHA-256/384 digests"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn handshake_deadline_and_connection_cap() {
    let fc = fake_cert("h1", &[HOME]);
    let kd = FakeKeyd::start(Some(fc.clone()));
    let up = start_upstream().await;
    let limits = Limits {
        handshake_timeout: Duration::from_millis(300),
        max_conns: 2,
        ..Limits::default()
    };
    let ing = start_ingress(
        &kd,
        &up,
        limits,
        KxPolicy::PreferHybrid,
        Duration::from_secs(1),
    )
    .await;

    let mut a = TcpStream::connect(ing.addr).await.unwrap();
    let mut b = TcpStream::connect(ing.addr).await.unwrap();
    // Half a ClientHello record header: a slow handshake.
    b.write_all(&[0x16, 0x03, 0x01]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let mut c = TcpStream::connect(ing.addr).await.unwrap();
    let mut buf = [0u8; 16];
    let r = tokio::time::timeout(Duration::from_millis(200), c.read(&mut buf)).await;
    assert!(
        matches!(r, Ok(Ok(0)) | Ok(Err(_))),
        "a third connection over the cap was kept: {r:?}"
    );

    let started = std::time::Instant::now();
    for s in [&mut a, &mut b] {
        let r = tokio::time::timeout(Duration::from_secs(2), s.read(&mut buf)).await;
        assert!(
            matches!(r, Ok(Ok(0)) | Ok(Err(_))),
            "a stalled handshake was not closed: {r:?}"
        );
    }
    assert!(started.elapsed() < Duration::from_secs(1));
    tokio::time::sleep(Duration::from_millis(50)).await;
    // The slots are free again.
    connect(ing.addr, HOME, &fc.ca, ClientOpts::default())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slow_request_head_gets_408_and_never_reaches_the_daemon() {
    let fc = fake_cert("h1", &[HOME]);
    let kd = FakeKeyd::start(Some(fc.clone()));
    let mut up = start_upstream().await;
    let limits = Limits {
        head_timeout: Duration::from_millis(300),
        ..test_limits()
    };
    let ing = start_ingress(
        &kd,
        &up,
        limits,
        KxPolicy::PreferHybrid,
        Duration::from_secs(1),
    )
    .await;
    let mut c = connect(ing.addr, HOME, &fc.ca, ClientOpts::default())
        .await
        .unwrap();
    c.write_all(b"GET / HTTP/1.1\r\nHost: home.alice.flagship.services\r\n")
        .await
        .unwrap();
    let mut got = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), c.read_to_end(&mut got))
        .await
        .unwrap()
        .ok();
    assert!(
        got.starts_with(b"HTTP/1.1 408"),
        "{:?}",
        String::from_utf8_lossy(&got)
    );
    no_header(&mut up).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_oversize_header_line_gets_431() {
    let fc = fake_cert("h1", &[HOME]);
    let kd = FakeKeyd::start(Some(fc.clone()));
    let mut up = start_upstream().await;
    let limits = Limits {
        max_header_line: 1024,
        max_header_bytes: 4096,
        ..test_limits()
    };
    let ing = start_ingress(
        &kd,
        &up,
        limits,
        KxPolicy::PreferHybrid,
        Duration::from_secs(1),
    )
    .await;

    let mut c = connect(ing.addr, HOME, &fc.ca, ClientOpts::default())
        .await
        .unwrap();
    let mut req = b"GET / HTTP/1.1\r\nX-Big: ".to_vec();
    req.extend(std::iter::repeat_n(b'a', 2000));
    req.extend_from_slice(b"\r\n\r\n");
    let _ = c.write_all(&req).await;
    let mut got = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), c.read_to_end(&mut got))
        .await
        .unwrap()
        .ok();
    assert!(
        got.starts_with(b"HTTP/1.1 431"),
        "{:?}",
        String::from_utf8_lossy(&got)
    );

    let mut c = connect(ing.addr, HOME, &fc.ca, ClientOpts::default())
        .await
        .unwrap();
    let mut req = b"GET / HTTP/1.1\r\n".to_vec();
    for i in 0..400 {
        req.extend_from_slice(format!("X-H{i}: value\r\n").as_bytes());
    }
    req.extend_from_slice(b"\r\n");
    let _ = c.write_all(&req).await;
    let mut got = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), c.read_to_end(&mut got))
        .await
        .unwrap()
        .ok();
    assert!(
        got.starts_with(b"HTTP/1.1 431"),
        "{:?}",
        String::from_utf8_lossy(&got)
    );
    no_header(&mut up).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idle_connection_is_closed() {
    let fc = fake_cert("h1", &[HOME]);
    let kd = FakeKeyd::start(Some(fc.clone()));
    let up = start_upstream().await;
    let limits = Limits {
        idle_timeout: Duration::from_millis(300),
        ..test_limits()
    };
    let ing = start_ingress(
        &kd,
        &up,
        limits,
        KxPolicy::PreferHybrid,
        Duration::from_secs(1),
    )
    .await;
    let mut c = connect(ing.addr, HOME, &fc.ca, ClientOpts::default())
        .await
        .unwrap();
    assert_eq!(echo(&mut c, REQ).await, REQ);
    // Traffic keeps it open past the idle time...
    for _ in 0..4 {
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(echo(&mut c, b"ping\n").await, b"ping\n");
    }
    // ...silence closes it.
    let mut buf = [0u8; 8];
    let r = tokio::time::timeout(Duration::from_secs(2), c.read(&mut buf)).await;
    assert!(
        matches!(r, Ok(Ok(0)) | Ok(Err(_))),
        "idle connection kept: {r:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn client_bytes_reach_the_daemon_verbatim() {
    // The ingress is a pipe like flagship-tlsd: identity headers a client forges arrive
    // unchanged and the daemon's proxy strips them (identityInjector.ts). Only the header
    // line, written by the ingress before any client byte, is authenticated metadata.
    let fc = fake_cert("h1", &[HOME]);
    let kd = FakeKeyd::start(Some(fc.clone()));
    let mut up = start_upstream().await;
    let ing = start_ingress(
        &kd,
        &up,
        test_limits(),
        KxPolicy::PreferHybrid,
        Duration::from_secs(1),
    )
    .await;
    let mut c = connect(ing.addr, HOME, &fc.ca, ClientOpts::default())
        .await
        .unwrap();
    let forged = b"{\"sni\":\"evil\",\"alpn\":\"\",\"tls\":\"1.3\"}\nGET / HTTP/1.1\r\nX-Flagship-User: admin\r\nX-Forwarded-For: 1.2.3.4\r\n\r\n";
    assert_eq!(echo(&mut c, forged).await, forged.to_vec());
    let (h, _) = up.headers.recv().await.unwrap();
    assert_eq!(h["sni"], HOME);
}

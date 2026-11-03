//! The relay mesh end to end (relay-mesh.md §§4–12): three relays on loopback with real listeners, bridges, an in-memory
//! `.com` that publishes the signed relay log, head, directory and blessings, real signed HELLOs, attachments, phone
//! claims and visitors.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic,
    missing_debug_implementations
)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ed25519_dalek::{Signer, SigningKey, Verifier};
use flagship_access::rank::{GrantView, device_grant_canonical};
use flagship_crypto::entitlements::{
    RootEntitlement, ServiceEntitlement, TunnelHelloV2, cert_id, root_entitlement,
    service_entitlement, tunnel_hello_v2,
};
use flagship_crypto::relay_mesh::{
    self as rm, BoxAttachment, MoveHintRateState, RelayBlessingBody, RelayDirectoryBody,
    RelayDirectoryEntry, RelayKind, RelayLogBody, RelayLogEntry, RelayLogHead,
};
use flagship_crypto::serving::{
    Grace, OnLapse, RouteClaim, ServingLease, ServingPolicy, lease_canonical, policy_canonical,
    route_claim_canonical,
};
use flagship_relay::authority::{BoxFut, DirectoryAuthority};
use flagship_relay::frame::{
    self, FRAME_ATTACHMENT, FRAME_CLOSE, FRAME_DATA, FRAME_HELLO, FRAME_HELLO_ACK, FRAME_MOVE_HINT,
    FRAME_OPEN, Frame, FrameDecoder, TypeSet,
};
use flagship_relay::mailbox::MailboxRegistry;
use flagship_relay::mesh::log_authority::{LogDirectory, MeshServingFetch};
use flagship_relay::mesh::phone_ledger::{MeshPhoneCom, presented};
use flagship_relay::mesh::{
    BlessingIssuer, FeedFetch, Mesh, MeshConfig, MeshParts, SealedFeed, StaticCaKeys, wire,
};
use flagship_relay::payload::{self, ParsedHelloAck};
use flagship_relay::phone::{PhoneConfig, PhoneRoutes};
use flagship_relay::relay::{self, Collaborators, Listeners, RelayConfig, RunningRelay};
use flagship_relay::serving::{GateConfig, ServingGate};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

const APEX: &str = "flagship.services";
const T: Duration = Duration::from_secs(15);
const HOLD: Duration = Duration::from_millis(1200);
const REPLY: usize = 70_000;

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn pubhex(k: &SigningKey) -> String {
    flagship_crypto::trust::hex(&k.verifying_key().to_bytes())
}

fn sig(k: &SigningKey, canon: &str) -> String {
    flagship_crypto::trust::hex(&k.sign(canon.as_bytes()).to_bytes())
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn rand_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b).unwrap();
    hex(&b)
}

async fn eventually(what: &str, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(start.elapsed() < T, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

// ── an in-memory `.com`: the relay log, its head, the directory and blessings ──

struct Com {
    ca: SigningKey,
    log: SigningKey,
    entries: Mutex<Vec<(RelayLogEntry, String)>>,
    relays: Mutex<Vec<(String, String)>>,
    published: Mutex<Value>,
    version: AtomicU64,
    paused: AtomicBool,
    /// The mesh-key epoch new files are sealed under (§4.5.1); a retire starts a new one.
    epoch: AtomicU64,
}

fn mesh_key(epoch: u64) -> [u8; 32] {
    [0x60 + epoch as u8; 32]
}

fn base64(b: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in b.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= c.len() {
                out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

impl Com {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            ca: key(1),
            log: key(3),
            entries: Mutex::new(Vec::new()),
            relays: Mutex::new(Vec::new()),
            published: Mutex::new(Value::Null),
            version: AtomicU64::new(0),
            paused: AtomicBool::new(false),
            epoch: AtomicU64::new(1),
        })
    }

    /// `sealRelayFeedObject` under the current epoch.
    fn seal(&self, object: &str, page: Option<u64>, plaintext: &Value) -> Value {
        let epoch = self.epoch.load(Ordering::SeqCst);
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).unwrap();
        let aad = flagship_crypto::relay_feed_seal::relay_feed_aad(APEX, object, page, epoch);
        let ct = flagship_crypto::relay_feed_seal::seal_relay_feed(
            &mesh_key(epoch),
            &nonce,
            &aad,
            plaintext.to_string().as_bytes(),
        )
        .unwrap();
        json!({"kind": "RelayFeedSealed", "version": 1, "servicesApex": APEX, "object": object, "page": page,
            "epoch": epoch, "nonce": hex(&nonce), "ciphertext": base64(&ct)})
    }

    /// `sealRelayMeshKeys` for an admitted relay; `None` for any other.
    fn mesh_keys(&self, id: &str) -> Option<Value> {
        let k = self
            .relays
            .lock()
            .unwrap()
            .iter()
            .find(|(x, _)| x == id)?
            .1
            .clone();
        let kb: [u8; 32] = (0..32)
            .map(|i| u8::from_str_radix(&k[i * 2..i * 2 + 2], 16).unwrap())
            .collect::<Vec<u8>>()
            .try_into()
            .unwrap();
        let current = self.epoch.load(Ordering::SeqCst);
        let epochs: Vec<Value> = (1..=current)
            .map(|e| {
                let line = flagship_crypto::relay_feed_seal::relay_mesh_key_line(
                    APEX,
                    id,
                    e,
                    &mesh_key(e),
                );
                let sealed = flagship_crypto::relay_feed_seal::seal_for_ed25519_recipient(
                    line.as_bytes(),
                    &kb,
                )
                .unwrap();
                json!({"epoch": e, "sealed": hex(&sealed)})
            })
            .collect();
        Some(
            json!({"kind": "RelayMeshKeys", "version": 1, "servicesApex": APEX, "relayId": id, "relayKey": k,
            "current": current, "epochs": epochs}),
        )
    }

    fn append(&self, b: RelayLogBody) {
        let mut e = self.entries.lock().unwrap();
        let entry = rm::make_relay_log_entry(e.len() as u64 + 1, now(), &b).unwrap();
        let s = sig(
            &self.log,
            &rm::relay_log_entry_canonical(APEX, &entry).unwrap(),
        );
        e.push((entry, s));
    }

    fn head(&self) -> Value {
        let e = self.entries.lock().unwrap();
        let tip = e
            .last()
            .map_or(rm::RELAY_LOG_ZERO_TIP.to_owned(), |(x, _)| {
                rm::relay_log_entry_hash(APEX, x).unwrap()
            });
        let h = RelayLogHead {
            services_apex: APEX.into(),
            sequence: e.len() as u64,
            tip_sha256: tip,
            directory_version: self.version.load(Ordering::SeqCst),
            issued_at: now(),
        };
        let s = sig(&self.log, &rm::relay_log_head_canonical(&h).unwrap());
        wire::head_to_json(&h, &s)
    }

    fn bless(&self, id: &str, relay_key: &str) -> Value {
        let t = now();
        let body = RelayBlessingBody {
            relay_id: id.into(),
            relay_key: relay_key.into(),
            services_apex: APEX.into(),
            tunnel_host: rm::relay_tunnel_host(id, APEX),
            relay_kind: RelayKind::Full,
            nonce: rand_hex(16),
            issued_at: t - 1000,
            expires_at: t + rm::RELAY_BLESSING_TTL_MS,
        };
        let s = sig(&self.ca, &rm::relay_blessing_canonical(&body).unwrap());
        json!({"kind": "RelayBlessing", "version": 1, "relayId": body.relay_id, "relayKey": body.relay_key,
            "servicesApex": APEX, "tunnelHost": body.tunnel_host, "relayKind": "full", "nonce": body.nonce,
            "issuedAt": body.issued_at, "expiresAt": body.expires_at, "signedBy": pubhex(&self.ca),
            "signatures": [{"pubkey": pubhex(&self.ca), "sig": s}]})
    }

    fn publish_directory(&self) {
        let version = self.version.fetch_add(1, Ordering::SeqCst) + 1;
        let relays = self.relays.lock().unwrap().clone();
        let t = now();
        let body = RelayDirectoryBody {
            services_apex: APEX.into(),
            directory_version: version,
            issued_at: t - 1000,
            expires_at: t + rm::DIRECTORY_TTL_MS,
            relays: relays
                .iter()
                .map(|(id, k)| RelayDirectoryEntry {
                    relay_id: id.clone(),
                    relay_key: k.clone(),
                    tunnel_host: rm::relay_tunnel_host(id, APEX),
                    relay_kind: RelayKind::Full,
                    region: "lo".into(),
                    ipv4: vec!["127.0.0.1".into()],
                    ipv6: vec![],
                })
                .collect(),
        };
        let s = sig(&self.ca, &rm::relay_directory_canonical(&body).unwrap());
        let d = rm::RelayDirectory {
            body,
            signed_by: pubhex(&self.ca),
            signatures: vec![(pubhex(&self.ca), s)],
        };
        let blessings: Vec<Value> = relays.iter().map(|(id, k)| self.bless(id, k)).collect();
        *self.published.lock().unwrap() =
            json!({"directory": wire::directory_to_json(&d), "blessings": blessings});
    }

    fn account(&self, a: &Acct) {
        self.append(RelayLogBody::AccountAuthority {
            account_hash: rm::account_hash(&a.name).unwrap(),
            admin_root_pub: Some(pubhex(&a.admin)),
            irk_pub: pubhex(&a.irk),
            authority_gen: 1,
        });
    }

    fn register(&self, pod: &str, stk: &SigningKey) {
        self.append(RelayLogBody::BoxRegister {
            name_hash: rm::name_hash(pod).unwrap(),
            box_pub: pubhex(stk),
            reg_gen: 1,
        });
    }

    fn retire(&self, id: &str) {
        let k = {
            let mut r = self.relays.lock().unwrap();
            let k = r.iter().find(|(x, _)| x == id).unwrap().1.clone();
            r.retain(|(x, _)| x != id);
            k
        };
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.append(RelayLogBody::RelayRevoke {
            relay_id: id.into(),
            relay_key: k,
        });
        self.publish_directory();
    }
}

struct Feed(Arc<Com>);

impl FeedFetch for Feed {
    fn get<'a>(&'a self, path: &'a str) -> BoxFut<'a, Result<(u16, Vec<u8>), String>> {
        Box::pin(async move {
            if self.0.paused.load(Ordering::SeqCst) {
                return Err("paused".into());
            }
            let body = match path {
                "head.json" => self.0.seal("head", None, &self.0.head()),
                "directory.json" => self.0.published.lock().unwrap().clone(),
                p if p.starts_with("keys/") => {
                    let id = p.trim_start_matches("keys/").trim_end_matches(".json");
                    match self.0.mesh_keys(id) {
                        Some(doc) => doc,
                        None => return Ok((404, Vec::new())),
                    }
                }
                p => {
                    let page: u64 = p
                        .strip_prefix("log/")
                        .and_then(|x| x.strip_suffix(".json"))
                        .and_then(|x| x.parse().ok())
                        .ok_or("no such file")?;
                    let entries: Vec<Value> = self
                        .0
                        .entries
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|(e, _)| e.sequence / rm::FEED_PAGE_ENTRIES == page)
                        .map(|(e, s)| wire::log_entry_to_json(e, s))
                        .collect();
                    self.0.seal(
                        "log",
                        Some(page),
                        &json!({"page": page, "entries": entries}),
                    )
                }
            };
            Ok((200, body.to_string().into_bytes()))
        })
    }
}

/// `POST /api/services/relay-blessing` with proof of possession (§3.2).
struct Issuer(Arc<Com>);

impl BlessingIssuer for Issuer {
    fn issue<'a>(&'a self, body: Value) -> BoxFut<'a, Result<Value, String>> {
        Box::pin(async move {
            let req = rm::RelayBlessingRequest {
                relay_id: body["relayId"].as_str().unwrap_or_default().into(),
                relay_key: body["relayKey"].as_str().unwrap_or_default().into(),
                services_apex: body["servicesApex"].as_str().unwrap_or_default().into(),
                issued_at: body["issuedAt"].as_u64().unwrap_or(0),
            };
            rm::check_relay_blessing_request(
                &req,
                body["signature"].as_str().unwrap_or(""),
                APEX,
                now(),
            )
            .map_err(str::to_owned)?;
            let admitted = self
                .0
                .relays
                .lock()
                .unwrap()
                .iter()
                .any(|(id, k)| *id == req.relay_id && *k == req.relay_key);
            if !admitted {
                return Err("not admitted".into());
            }
            Ok(
                json!({"relayBlessing": self.0.bless(&req.relay_id, &req.relay_key),
                "serviceBlessing": {"kind": "ServiceBlessing", "hubKeyPub": req.relay_key},
                "meshKeys": self.0.mesh_keys(&req.relay_id)}),
            )
        })
    }
}

// ── three relays ─────────────────────────────────────────────────────────

struct Node {
    id: String,
    key: SigningKey,
    mesh: Mesh,
    relay: Option<RunningRelay>,
    gate_task: JoinHandle<()>,
}

impl Node {
    fn r(&self) -> &RunningRelay {
        self.relay.as_ref().unwrap()
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        self.gate_task.abort();
        self.mesh.shutdown();
    }
}

struct World {
    com: Arc<Com>,
    nodes: Vec<Node>,
}

impl World {
    fn node(&self, id: &str) -> &Node {
        self.nodes.iter().find(|n| n.id == id).unwrap()
    }
}

#[derive(Clone, Copy)]
struct Tune {
    refuse_new: Duration,
    close_all: Duration,
    trust_fly: bool,
}

impl Default for Tune {
    fn default() -> Self {
        Self {
            refuse_new: Duration::from_secs(60),
            close_all: Duration::from_secs(600),
            trust_fly: false,
        }
    }
}

const IDS: [&str; 3] = ["aa1", "bb1", "cc1"];

async fn world(tune: Tune) -> World {
    let com = Com::new();
    let keys: Vec<SigningKey> = (0..3).map(|i| key(0x0b + i as u8)).collect();
    for (id, k) in IDS.iter().zip(&keys) {
        com.relays.lock().unwrap().push(((*id).into(), pubhex(k)));
    }
    com.publish_directory();
    let mut listeners = Vec::new();
    for _ in IDS {
        listeners.push((
            TcpListener::bind("127.0.0.1:0").await.unwrap(),
            TcpListener::bind("127.0.0.1:0").await.unwrap(),
        ));
    }
    let urls: HashMap<String, String> = IDS
        .iter()
        .zip(&listeners)
        .map(|(id, (_, hub))| {
            (
                (*id).to_owned(),
                format!("ws://{}/mesh", hub.local_addr().unwrap()),
            )
        })
        .collect();
    let mut nodes = Vec::new();
    for ((id, k), (sni, hub)) in IDS.iter().zip(keys).zip(listeners) {
        let mut cfg = MeshConfig::new(id, APEX, RelayKind::Full, &pubhex(&com.log));
        cfg.feed_poll = Duration::from_millis(100);
        cfg.peer_urls.clone_from(&urls);
        cfg.query_timeout = Duration::from_millis(400);
        cfg.colocate_every = Duration::from_millis(200);
        cfg.legacy_wait = Duration::from_millis(500);
        cfg.refuse_new_after = tune.refuse_new;
        cfg.close_all_after = tune.close_all;
        cfg.bridge.backoff_max = Duration::from_millis(500);
        let parts = MeshParts {
            feed: Arc::new(Feed(Arc::clone(&com))),
            decrypt: SealedFeed::new(APEX, id, k.to_bytes()),
            ca: Arc::new(StaticCaKeys(vec![pubhex(&com.ca)])),
            issuer: Arc::new(Issuer(Arc::clone(&com))),
        };
        let quiet = std::env::var("MESH_TEST_LOG").is_err();
        let log = move |l: &str| {
            if !quiet {
                eprintln!("{l}");
            }
        };
        let mesh = Mesh::new(cfg, k.clone(), parts, Box::new(log)).unwrap();
        let gate = ServingGate::new(
            Arc::new(MeshServingFetch(mesh.clone())),
            GateConfig {
                refuse_new_after: tune.refuse_new,
                close_all_after: tune.close_all,
                check_every: Duration::from_millis(100),
                keep_indefinite_on_lost: true,
                ..GateConfig::default()
            },
            Box::new(log),
        );
        let gate_task = gate.spawn();
        let phone = PhoneRoutes::new_mesh(
            id,
            APEX,
            Arc::new(MeshPhoneCom(mesh.clone())),
            presented(&mesh),
            PhoneConfig::default(),
            Box::new(log),
        );
        let mut rc = RelayConfig::default();
        rc.hub.apex = APEX.into();
        rc.trust_fly_client_ip = tune.trust_fly;
        rc.router.hold_timeout = HOLD;
        rc.router.hold_poll_interval = Duration::from_millis(20);
        rc.router.sni.deadline = Duration::from_millis(800);
        let running = relay::start_with_mesh(
            rc,
            Listeners {
                sni,
                hub,
                echo: None,
            },
            Collaborators {
                authority: Arc::new(DirectoryAuthority::new(LogDirectory(mesh.clone()))),
                blessing: Some(Arc::new(mesh.clone())),
                meter: None,
                outbound: None,
                mailboxes: Some(Arc::new(MailboxRegistry::default())),
                stats_secret: Some("s".into()),
                serving: Some(gate),
                serving_feed: None,
                phone: Some(phone),
            },
            Some(mesh.clone()),
        )
        .unwrap();
        nodes.push(Node {
            id: (*id).into(),
            key: k,
            mesh,
            relay: Some(running),
            gate_task,
        });
    }
    let w = World { com, nodes };
    for n in &w.nodes {
        eventually(&format!("{} mesh-ready", n.id), || n.mesh.ready().0).await;
    }
    for n in &w.nodes {
        eventually(&format!("{} bridges", n.id), || {
            n.mesh.peer_ids().len() == 2
        })
        .await;
    }
    w
}

async fn synced(w: &World) {
    let want = w.com.entries.lock().unwrap().len() as u64;
    for n in &w.nodes {
        eventually(&format!("{} at sequence {want}", n.id), || {
            n.mesh.log_sequence() >= want && n.mesh.fresh()
        })
        .await;
    }
}

// ── accounts, boxes, visitors ─────────────────────────────────────────────

struct Acct {
    name: String,
    admin: SigningKey,
    irk: SigningKey,
}

fn alice() -> Acct {
    Acct {
        name: "alice".into(),
        admin: key(0x21),
        irk: key(0x22),
    }
}

#[derive(Default, Clone)]
struct BoxOpts {
    mesh: bool,
    /// Answer a visitor and keep the stream open until the visitor closes it.
    linger: bool,
    canonicals: Vec<String>,
    policy: Option<(Value, Value)>,
}

/// A box on a hub: answers every visitor stream with `<pod>|<sni>\n` and a 70 KB pattern, then closes it.
struct SimBox {
    pod: String,
    stk: SigningKey,
    tx: mpsc::UnboundedSender<Vec<u8>>,
    control: mpsc::UnboundedReceiver<Frame>,
    closed: Arc<Mutex<Option<u16>>>,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for SimBox {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

fn reply_for(pod: &str, sni: &str) -> Vec<u8> {
    let mut v = format!("{pod}|{sni}\n").into_bytes();
    v.extend((0..REPLY).map(|i| (i % 251) as u8));
    v
}

fn hello_json(acct: &Acct, pod: &str, stk: &SigningKey, o: &BoxOpts) -> Value {
    let t = now();
    let root = RootEntitlement {
        username: acct.name.clone(),
        pod_pub_key_hex: pubhex(stk),
        pod_canonical: pod.into(),
        issued_at: t - 5000,
    };
    let root_canon = root_entitlement(&root).unwrap();
    let root_id = cert_id(&root_canon);
    let nonce = rand_hex(32);
    let mut v = json!({
        "version": 2, "serverId": pod, "issuedAt": t, "nonce": nonce,
        "rootEntitlement": {"username": acct.name, "podPubKey": pubhex(stk), "podCanonical": pod, "issuedAt": t - 5000},
        "rootEntitlementSig": sig(&acct.admin, &root_canon), "rootEntitlementCertId": root_id,
        "servingAdminKey": pubhex(&acct.admin),
        "capabilities": if o.mesh { vec!["mesh-v1"] } else { vec![] },
    });
    let mut service_id = String::new();
    if !o.canonicals.is_empty() {
        let se = ServiceEntitlement {
            username: acct.name.clone(),
            pod_pub_key_hex: pubhex(stk),
            canonicals: o.canonicals.clone(),
            issued_at: t - 5000,
            expires_at: t + 86_400_000,
        };
        let canon = service_entitlement(&se).unwrap();
        service_id = cert_id(&canon);
        v["serviceEntitlement"] = json!({"username": acct.name, "podPubKey": pubhex(stk), "canonicals": se.canonicals,
            "issuedAt": se.issued_at, "expiresAt": se.expires_at});
        v["serviceEntitlementSig"] = json!(sig(&acct.irk, &canon));
        v["serviceEntitlementCertId"] = json!(service_id);
    }
    if let Some((policy, leases)) = &o.policy {
        v["servingPolicy"] = policy.clone();
        v["servingLeases"] = leases.clone();
    }
    let envelope = tunnel_hello_v2(&TunnelHelloV2 {
        server_id: pod.into(),
        root_entitlement_cert_id: root_id,
        service_entitlement_cert_id: service_id,
        nonce_hex: nonce,
        issued_at: t,
    })
    .unwrap();
    v["signature"] = json!(sig(stk, &envelope));
    v
}

impl SimBox {
    async fn connect(
        hub: SocketAddr,
        acct: &Acct,
        pod: &str,
        stk: &SigningKey,
        o: &BoxOpts,
    ) -> (Self, ParsedHelloAck) {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{hub}/tunnel"))
            .await
            .unwrap();
        let (mut sink, mut stream) = ws.split();
        let (tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (ctl_tx, control) = mpsc::unbounded_channel();
        let closed = Arc::new(Mutex::new(None));
        let types = TypeSet {
            mesh: o.mesh,
            ..TypeSet::V1
        };
        let (cl, pod_s, out) = (Arc::clone(&closed), pod.to_owned(), tx.clone());
        let linger = o.linger;
        let reader = tokio::spawn(async move {
            let mut d = FrameDecoder::new(types, 8 << 20);
            let mut open: HashMap<u32, String> = HashMap::new();
            while let Some(Ok(m)) = stream.next().await {
                match m {
                    Message::Binary(b) => {
                        d.push(&b).unwrap();
                        while let Some(f) = d.next_frame().unwrap() {
                            match f.frame_type {
                                FRAME_OPEN => {
                                    open.insert(f.stream_id, payload::parse_open(&f.payload));
                                }
                                FRAME_DATA => {
                                    if let Some(sni) = open.remove(&f.stream_id) {
                                        if sni.ends_with("/internal/route-nudge") {
                                            continue;
                                        }
                                        for c in reply_for(&pod_s, &sni).chunks(16 * 1024) {
                                            let fr =
                                                Frame::new(f.stream_id, FRAME_DATA, c.to_vec());
                                            let _ = out.send(frame::encode_frame(&fr).unwrap());
                                        }
                                        if !linger {
                                            let fr =
                                                Frame::new(f.stream_id, FRAME_CLOSE, Vec::new());
                                            let _ = out.send(frame::encode_frame(&fr).unwrap());
                                        }
                                    }
                                }
                                frame::FRAME_PB_MAIL_REQ => {
                                    let mut asm = flagship_relay::mail::MailAssembler::new(
                                        flagship_relay::mail::MailKind::Req,
                                    );
                                    if let Ok(Some(env)) = asm.push(&f.payload) {
                                        let mut body = b"reply:".to_vec();
                                        body.extend(env);
                                        for fr in flagship_relay::mail::mail_response_frames(
                                            f.stream_id,
                                            200,
                                            &body,
                                        ) {
                                            let _ = out.send(frame::encode_frame(&fr).unwrap());
                                        }
                                    }
                                }
                                _ => {
                                    let _ = ctl_tx.send(f);
                                }
                            }
                        }
                    }
                    Message::Close(c) => {
                        *cl.lock().unwrap() = Some(c.map_or(1005, |c| u16::from(c.code)));
                        break;
                    }
                    _ => {}
                }
            }
            if cl.lock().unwrap().is_none() {
                *cl.lock().unwrap() = Some(1006);
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
        let mut b = Self {
            pod: pod.into(),
            stk: stk.clone(),
            tx,
            control,
            closed,
            tasks: vec![reader, writer],
        };
        let h = hello_json(acct, pod, stk, o);
        b.send(&Frame::new(0, FRAME_HELLO, h.to_string().into_bytes()));
        let ack = b.next_of(FRAME_HELLO_ACK).await;
        let parsed = payload::parse_hello_ack(&ack.payload).unwrap();
        if let Some(sig_hex) = &parsed.hub_sig {
            let nonce = h["nonce"].as_str().unwrap();
            let nonce_bytes: Vec<u8> = (0..nonce.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&nonce[i..i + 2], 16).unwrap())
                .collect();
            let key_hex = parsed
                .relay_blessing
                .as_ref()
                .and_then(|b| b["relayKey"].as_str().map(str::to_owned));
            if let Some(k) = key_hex {
                let kb: [u8; 32] = (0..32)
                    .map(|i| u8::from_str_radix(&k[i * 2..i * 2 + 2], 16).unwrap())
                    .collect::<Vec<u8>>()
                    .try_into()
                    .unwrap();
                let vk = ed25519_dalek::VerifyingKey::from_bytes(&kb).unwrap();
                let sb: Vec<u8> = (0..sig_hex.len())
                    .step_by(2)
                    .map(|i| u8::from_str_radix(&sig_hex[i..i + 2], 16).unwrap())
                    .collect();
                let s = ed25519_dalek::Signature::from_slice(&sb).unwrap();
                assert!(
                    vk.verify(&nonce_bytes, &s).is_ok(),
                    "hubSig is the relay key over the nonce"
                );
            }
        }
        (b, parsed)
    }

    fn send(&self, f: &Frame) {
        let _ = self.tx.send(frame::encode_frame(f).unwrap());
    }

    async fn next_of(&mut self, ty: u8) -> Frame {
        loop {
            let f = tokio::time::timeout(T, self.control.recv())
                .await
                .unwrap_or_else(|_| panic!("no frame 0x{ty:02x}"))
                .unwrap_or_else(|| panic!("tunnel closed before 0x{ty:02x}"));
            if f.frame_type == ty {
                return f;
            }
        }
    }

    fn attachment(&self, relay: &str, mutate: impl Fn(&mut BoxAttachment)) -> Vec<u8> {
        let t = now();
        let mut a = BoxAttachment {
            server_fqdn: self.pod.clone(),
            box_pub: pubhex(&self.stk),
            reg_gen: 1,
            relay_id: relay.into(),
            attached_at: t - 10,
            issued_at: t,
            not_after: t + rm::ATTACH_TTL_MS,
        };
        mutate(&mut a);
        let s = rm::box_attachment_canonical(&a)
            .map(|c| sig(&self.stk, &c))
            .unwrap_or_else(|_| "00".repeat(64));
        json!({"attachment": wire::attachment_to_json(&a), "signature": s})
            .to_string()
            .into_bytes()
    }

    /// Send an ATTACHMENT and read the answer.
    async fn attach_with(&mut self, payload: Vec<u8>) -> Value {
        self.send(&Frame::new(0, FRAME_ATTACHMENT, payload));
        let f = self.next_of(FRAME_ATTACHMENT).await;
        serde_json::from_slice(&f.payload).unwrap()
    }

    async fn attach(&mut self, relay: &str) {
        let p = self.attachment(relay, |_| {});
        assert_eq!(self.attach_with(p).await, json!({"ok": true}));
    }

    fn close(&self) {
        let _ = self.tx.send(Vec::new());
    }

    fn closed_with(&self) -> Option<u16> {
        *self.closed.lock().unwrap()
    }
}

/// A TLS-1.2-shaped ClientHello naming `sni`.
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

/// Dial a relay's SNI port, send the ClientHello, read to EOF: the bytes and how long until the close.
async fn visit(r: &RunningRelay, sni: &str) -> (Vec<u8>, Duration) {
    let start = Instant::now();
    let mut s = TcpStream::connect(r.sni_addr).await.unwrap();
    s.write_all(&client_hello(sni)).await.unwrap();
    let mut out = Vec::new();
    let _ = tokio::time::timeout(T, s.read_to_end(&mut out)).await;
    (out, start.elapsed())
}

async fn reaches(r: &RunningRelay, sni: &str, pod: &str) {
    let (bytes, _) = visit(r, sni).await;
    assert_eq!(
        bytes.len(),
        reply_for(pod, sni).len(),
        "{sni} via {}",
        r.sni_addr
    );
    assert_eq!(bytes, reply_for(pod, sni), "bytes verbatim");
}

fn assert_held(d: Duration, what: &str) {
    assert!(
        d >= HOLD - Duration::from_millis(50) && d <= HOLD + Duration::from_millis(900),
        "{what} closed after {d:?}, not at the hold time"
    );
}

// ── the scenarios ─────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_box_on_one_relay_is_reached_through_every_other_and_misses_close_at_the_hold() {
    let w = world(Tune::default()).await;
    let a = alice();
    let stk = key(0x31);
    let pod = format!("home.alice.{APEX}");
    w.com.account(&a);
    w.com.register(&pod, &stk);
    w.com.register(&format!("gone.alice.{APEX}"), &key(0x32));
    synced(&w).await;

    let (mut b, ack) = SimBox::connect(
        w.node("aa1").r().hub_addr,
        &a,
        &pod,
        &stk,
        &BoxOpts {
            mesh: true,
            ..BoxOpts::default()
        },
    )
    .await;
    assert!(ack.ok, "{ack:?}");
    assert_eq!(ack.relay_id.as_deref(), Some("aa1"));
    assert!(ack.capabilities.unwrap().contains(&"mesh-v1".to_owned()));
    assert_eq!(
        ack.relay_blessing.unwrap()["relayKey"],
        pubhex(&w.node("aa1").key)
    );
    b.attach("aa1").await;
    for n in &w.nodes {
        eventually("the attachment everywhere", || {
            n.mesh.winner_of(&pod) == Some(("aa1".into(), true))
        })
        .await;
    }
    for id in IDS {
        reaches(w.node(id).r(), &pod, &pod).await;
        reaches(w.node(id).r(), &format!("files.{pod}"), &pod).await;
    }
    // An unknown name, and a registered one nobody holds (a mesh query that finds nothing): both close at the hold.
    let (bytes, d) = visit(w.node("bb1").r(), &format!("ghost.alice.{APEX}")).await;
    assert!(bytes.is_empty());
    assert_held(d, "a local miss");
    let (bytes, d) = visit(w.node("cc1").r(), &format!("gone.alice.{APEX}")).await;
    assert!(bytes.is_empty());
    assert_held(d, "a mesh miss");
    assert!(
        w.node("cc1")
            .mesh
            .counters()
            .queries_sent
            .load(Ordering::Relaxed)
            >= 1
    );
    let (_, d) = visit(w.node("cc1").r(), &format!("gone.alice.{APEX}")).await;
    assert_held(d, "a negative-cached miss");
    assert!(
        w.node("cc1")
            .mesh
            .counters()
            .negative_hits
            .load(Ordering::Relaxed)
            >= 1
    );
    // A newer registration of the name evicts the old key everywhere: the old box is told `replaced`.
    w.com.register(&pod, &key(0x35));
    synced(&w).await;
    let (_old, ack) = SimBox::connect(
        w.node("bb1").r().hub_addr,
        &a,
        &pod,
        &stk,
        &BoxOpts {
            mesh: true,
            ..BoxOpts::default()
        },
    )
    .await;
    assert_eq!((ack.ok, ack.reason.as_deref()), (false, Some("replaced")));
    eventually("the old attachment is dropped", || {
        w.node("cc1").mesh.winner_of(&pod).is_none()
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn attachments_follow_precedence_and_withdrawal_and_forgeries_are_refused() {
    let w = world(Tune::default()).await;
    let a = alice();
    let stk = key(0x31);
    let pod = format!("home.alice.{APEX}");
    w.com.account(&a);
    w.com.register(&pod, &stk);
    synced(&w).await;
    let opts = BoxOpts {
        mesh: true,
        ..BoxOpts::default()
    };
    let (mut on_a, _) = SimBox::connect(w.node("aa1").r().hub_addr, &a, &pod, &stk, &opts).await;

    // Forgeries and mistakes are refused with the frame codes (chunk A's refusal order).
    let wrong_key = {
        let mut p: Value = serde_json::from_slice(&on_a.attachment("aa1", |_| {})).unwrap();
        p["signature"] = json!("ab".repeat(64));
        p.to_string().into_bytes()
    };
    for (payload, code) in [
        (wrong_key, "mismatch"),
        (on_a.attachment("bb1", |_| {}), "mismatch"),
        (on_a.attachment("aa1", |x| x.reg_gen = 2), "mismatch"),
        (
            on_a.attachment("aa1", |x| {
                x.issued_at = now() + 5 * 60_000;
                x.not_after = x.issued_at + 1000;
            }),
            "clock",
        ),
        (
            on_a.attachment("aa1", |x| x.not_after = x.issued_at + rm::ATTACH_TTL_MS + 1),
            "mismatch",
        ),
    ] {
        assert_eq!(
            on_a.attach_with(payload).await,
            json!({"ok": false, "code": code})
        );
    }
    assert!(w.node("bb1").mesh.winner_of(&pod).is_none());

    on_a.attach("aa1").await;
    eventually("aa1 holds it everywhere", || {
        w.node("cc1").mesh.winner_of(&pod) == Some(("aa1".into(), true))
    })
    .await;

    // The box moves to bb1: its newer attachment wins everywhere and aa1 withdraws its own.
    tokio::time::sleep(Duration::from_millis(5)).await;
    let (mut on_b, _) = SimBox::connect(w.node("bb1").r().hub_addr, &a, &pod, &stk, &opts).await;
    on_b.attach("bb1").await;
    for n in &w.nodes {
        eventually("bb1 wins", || {
            n.mesh.winner_of(&pod) == Some(("bb1".into(), true))
        })
        .await;
    }
    eventually("aa1's withdrawal reaches cc1", || {
        w.node("cc1")
            .mesh
            .store_holders(&pod)
            .iter()
            .all(|(r, _)| r != "aa1")
    })
    .await;
    reaches(w.node("aa1").r(), &pod, &pod).await;

    // Its tunnel on bb1 closes: bb1 withdraws, and nobody announces it any more.
    on_a.close();
    on_b.close();
    eventually("bb1's withdrawal reaches cc1", || {
        w.node("cc1").mesh.store_holders(&pod).is_empty()
    })
    .await;

    // An old box (no mesh-v1) is announced by its full relay as legacy; a box-signed attachment beats it.
    let (_old, ack) = SimBox::connect(
        w.node("cc1").r().hub_addr,
        &a,
        &pod,
        &stk,
        &BoxOpts::default(),
    )
    .await;
    assert!(ack.relay_id.is_none(), "an old box gets no mesh fields");
    eventually("the legacy attachment", || {
        w.node("aa1").mesh.winner_of(&pod) == Some(("cc1".into(), false))
    })
    .await;
    reaches(w.node("aa1").r(), &pod, &pod).await;
    let (mut signed, _) = SimBox::connect(w.node("bb1").r().hub_addr, &a, &pod, &stk, &opts).await;
    signed.attach("bb1").await;
    eventually("box-signed beats legacy", || {
        w.node("aa1").mesh.winner_of(&pod) == Some(("bb1".into(), true))
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_revoked_box_is_dropped_by_every_relay_within_the_deadline() {
    let w = world(Tune::default()).await;
    let a = alice();
    let stk = key(0x31);
    let pod = format!("home.alice.{APEX}");
    w.com.account(&a);
    w.com.register(&pod, &stk);
    synced(&w).await;
    let opts = BoxOpts {
        mesh: true,
        ..BoxOpts::default()
    };
    let (mut b, _) = SimBox::connect(w.node("aa1").r().hub_addr, &a, &pod, &stk, &opts).await;
    b.attach("aa1").await;
    eventually("bb1 knows", || w.node("bb1").mesh.winner_of(&pod).is_some()).await;
    reaches(w.node("bb1").r(), &pod, &pod).await;

    let start = Instant::now();
    w.com.append(RelayLogBody::BoxRevoke {
        box_pub: pubhex(&stk),
        reg_gen: 1,
    });
    eventually("the holder closes the tunnel", || b.closed_with().is_some()).await;
    for n in &w.nodes {
        eventually("every relay drops it", || n.mesh.winner_of(&pod).is_none()).await;
    }
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "revocation took {:?}",
        start.elapsed()
    );
    let (bytes, d) = visit(w.node("cc1").r(), &pod).await;
    assert!(bytes.is_empty());
    assert_held(d, "a revoked box");
    // A bridged OPEN for it is refused `revoked` by the holder, explicitly.
    assert_eq!(w.node("aa1").mesh.holder_admits(&pod), Err("revoked"));
    for id in IDS {
        let (b2, ack) = SimBox::connect(w.node(id).r().hub_addr, &a, &pod, &stk, &opts).await;
        assert!(!ack.ok, "a revoked box is refused on {id}");
        drop(b2);
    }
}

/// An un-revoke (the owner's, or the operator's unsuspend) is `.com`'s `box-register` at the next regGen: the same
/// key is admitted again at that generation only, a later revoke at it closes the tunnel, and a register re-sent at the
/// revoked generation brings nothing back.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unrevoked_box_serves_again_at_its_new_reg_gen_until_revoked_again() {
    let w = world(Tune::default()).await;
    let a = alice();
    let stk = key(0x33);
    let pod = format!("back.alice.{APEX}");
    let opts = BoxOpts {
        mesh: true,
        ..BoxOpts::default()
    };
    let reg = |g: u64| RelayLogBody::BoxRegister {
        name_hash: rm::name_hash(&pod).unwrap(),
        box_pub: pubhex(&stk),
        reg_gen: g,
    };
    let revoke = |g: u64| RelayLogBody::BoxRevoke {
        box_pub: pubhex(&stk),
        reg_gen: g,
    };
    w.com.account(&a);
    w.com.append(reg(1));
    w.com.append(revoke(1));
    synced(&w).await;
    for id in IDS {
        let (b, ack) = SimBox::connect(w.node(id).r().hub_addr, &a, &pod, &stk, &opts).await;
        assert!(!ack.ok, "revoked at regGen 1: refused on {id}");
        drop(b);
    }

    w.com.append(reg(2));
    synced(&w).await;
    let (mut b, ack) = SimBox::connect(w.node("aa1").r().hub_addr, &a, &pod, &stk, &opts).await;
    assert!(ack.ok, "un-revoked: admitted");
    let old = b.attachment("aa1", |x| x.reg_gen = 1);
    assert_eq!(
        b.attach_with(old).await,
        json!({"ok": false, "code": "mismatch"}),
        "an attachment at the revoked regGen is refused"
    );
    let cur = b.attachment("aa1", |x| x.reg_gen = 2);
    assert_eq!(b.attach_with(cur).await, json!({"ok": true}));
    eventually("bb1 knows", || w.node("bb1").mesh.winner_of(&pod).is_some()).await;
    reaches(w.node("cc1").r(), &pod, &pod).await;

    w.com.append(revoke(2));
    eventually("the holder closes the tunnel", || b.closed_with().is_some()).await;
    w.com.append(reg(2));
    synced(&w).await;
    for n in &w.nodes {
        eventually("every relay drops it", || n.mesh.winner_of(&pod).is_none()).await;
    }
    for id in IDS {
        let (b2, ack) = SimBox::connect(w.node(id).r().hub_addr, &a, &pod, &stk, &opts).await;
        assert!(
            !ack.ok,
            "revoked at regGen 2, a re-sent register notwithstanding: refused on {id}"
        );
        drop(b2);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_account_has_one_home_and_a_box_elsewhere_is_hinted_to_it() {
    let w = world(Tune::default()).await;
    let a = alice();
    let (stk1, stk2) = (key(0x31), key(0x32));
    let home = format!("home.alice.{APEX}");
    let office = format!("office.alice.{APEX}");
    w.com.account(&a);
    w.com.register(&home, &stk1);
    w.com.register(&office, &stk2);
    synced(&w).await;
    let o1 = BoxOpts {
        mesh: true,
        canonicals: vec![format!("chess.home.alice.{APEX}")],
        ..BoxOpts::default()
    };
    let o2 = BoxOpts {
        mesh: true,
        ..BoxOpts::default()
    };
    let (mut b1, _) = SimBox::connect(w.node("aa1").r().hub_addr, &a, &home, &stk1, &o1).await;
    b1.attach("aa1").await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    let (mut b2, _) = SimBox::connect(w.node("bb1").r().hub_addr, &a, &office, &stk2, &o2).await;
    b2.attach("bb1").await;
    for n in &w.nodes {
        eventually("the home is aa1", || {
            n.mesh.account_home("alice").as_deref() == Some("aa1")
        })
        .await;
    }
    // The shortened name goes to the home from every entry relay.
    for id in IDS {
        reaches(w.node(id).r(), &format!("chess.alice.{APEX}"), &home).await;
    }
    // bb1 hints office to co-locate with aa1; the hint passes the box's own check.
    let hint = b2.next_of(FRAME_MOVE_HINT).await;
    let h: Value = serde_json::from_slice(&hint.payload).unwrap();
    assert_eq!(h["hint"]["reason"], "co-locate");
    assert_eq!(h["hint"]["toRelayId"], "aa1");
    let target = wire::blessing_from_json(&h["target"]).unwrap();
    let dir = wire::directory_from_json(&w.com.published.lock().unwrap()["directory"]).unwrap();
    let mh = rm::MoveHint {
        server_fqdn: h["hint"]["serverFqdn"].as_str().unwrap().into(),
        box_pub: h["hint"]["boxPub"].as_str().unwrap().into(),
        from_relay_id: "bb1".into(),
        to_relay_id: "aa1".into(),
        reason: "co-locate".into(),
        issued_at: h["hint"]["issuedAt"].as_u64().unwrap(),
        not_after: h["hint"]["notAfter"].as_u64().unwrap(),
    };
    let ca = vec![pubhex(&w.com.ca)];
    let rate = MoveHintRateState::default();
    rm::check_move_hint(&rm::MoveHintCheck {
        hint: &mh,
        signature: h["signature"].as_str().unwrap(),
        target: &target,
        box_server_fqdn: &office,
        box_pub: &pubhex(&stk2),
        services_apex: APEX,
        current_relay_id: "bb1",
        current_relay_key: &pubhex(&w.node("bb1").key),
        directory: Some(&dir.body),
        directory_fetched_at: Some(now()),
        ca_keys: &ca,
        rate: &rate,
        now: now(),
    })
    .unwrap();
    // It moves, make-before-break: bb1 is superseded and stops announcing it.
    let (mut moved, _) = SimBox::connect(w.node("aa1").r().hub_addr, &a, &office, &stk2, &o2).await;
    moved.attach("aa1").await;
    eventually("office moved home", || {
        w.node("cc1").mesh.winner_of(&office) == Some(("aa1".into(), true))
            && w.node("cc1")
                .mesh
                .store_holders(&office)
                .iter()
                .all(|(r, _)| r != "bb1")
    })
    .await;
    b2.close();
    reaches(w.node("cc1").r(), &office, &office).await;
}

fn device_grant(a: &Acct, device: &SigningKey, n: u8) -> Value {
    let t = now();
    let g = GrantView {
        grant_id: format!("{n:02x}").repeat(32),
        username: a.name.clone(),
        device_id: format!("{n:02x}").repeat(16),
        device_pub_hex: pubhex(device),
        scopes: vec!["admin".into()],
        issued_at: t - 1000,
        expires_at: t + 86_400_000,
        signature_hex: String::new(),
        signer_root: "admin-root".into(),
        revoked: false,
    };
    let s = sig(&a.admin, &device_grant_canonical(&g).unwrap());
    json!({"grant": {"grantId": g.grant_id, "username": g.username, "deviceId": g.device_id, "devicePubHex": g.device_pub_hex,
        "scopes": g.scopes, "issuedAt": g.issued_at, "expiresAt": g.expires_at}, "signatureHex": s, "signerRoot": "admin-root"})
}

/// A phone on `/phone-tunnel`: control messages in `msgs`, visitor streams answered like a box.
struct SimPhone {
    tx: mpsc::UnboundedSender<Message>,
    msgs: mpsc::UnboundedReceiver<Value>,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for SimPhone {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

impl SimPhone {
    async fn connect(hub: SocketAddr, host: &str) -> Self {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{hub}/phone-tunnel"))
            .await
            .unwrap();
        let (mut sink, mut stream) = ws.split();
        let (tx, mut out) = mpsc::unbounded_channel::<Message>();
        let (mtx, msgs) = mpsc::unbounded_channel();
        let tx2 = tx.clone();
        let host = host.to_owned();
        let reader = tokio::spawn(async move {
            let mut open: HashMap<u32, String> = HashMap::new();
            while let Some(Ok(m)) = stream.next().await {
                match m {
                    Message::Text(t) => {
                        let _ = mtx.send(serde_json::from_str(t.as_str()).unwrap());
                    }
                    Message::Binary(b) => {
                        if let frame::Decoded::Ok {
                            stream_id,
                            frame_type,
                            payload,
                            ..
                        } = frame::decode_frame(&b)
                        {
                            if frame_type == FRAME_OPEN {
                                open.insert(stream_id, payload::parse_open(payload));
                            } else if frame_type == FRAME_DATA
                                && let Some(sni) = open.remove(&stream_id)
                            {
                                for c in reply_for(&host, &sni).chunks(16 * 1024) {
                                    let f = Frame::new(stream_id, FRAME_DATA, c.to_vec());
                                    let _ = tx2.send(Message::Binary(
                                        frame::encode_frame(&f).unwrap().into(),
                                    ));
                                }
                                let f = Frame::new(stream_id, FRAME_CLOSE, Vec::new());
                                let _ = tx2
                                    .send(Message::Binary(frame::encode_frame(&f).unwrap().into()));
                            }
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });
        let writer = tokio::spawn(async move {
            while let Some(m) = out.recv().await {
                if sink.send(m).await.is_err() {
                    return;
                }
            }
        });
        Self {
            tx,
            msgs,
            tasks: vec![reader, writer],
        }
    }

    fn send(&self, v: &Value) {
        let _ = self.tx.send(Message::Text(v.to_string().into()));
    }

    async fn next_of(&mut self, ty: &str) -> Value {
        loop {
            let v = tokio::time::timeout(T, self.msgs.recv())
                .await
                .unwrap_or_else(|_| panic!("no {ty}"))
                .unwrap();
            if v["type"] == ty
                || (ty == "granted|refused" && (v["type"] == "granted" || v["type"] == "refused"))
                || (ty == "challenge|refused"
                    && (v["type"] == "challenge" || v["type"] == "refused"))
            {
                return v;
            }
        }
    }

    /// begin → challenge → claim; the answer (`granted` or `refused`).
    async fn claim(&mut self, a: &Acct, device: &SigningKey, grant: &Value) -> Value {
        self.send(&json!({"type": "begin", "account": a.name, "grants": [grant]}));
        let ch = self.next_of("challenge").await;
        let c = RouteClaim {
            account: a.name.clone(),
            phone_route_pub: pubhex(device),
            hostname: ch["hostname"].as_str().unwrap().into(),
            generation: ch["generation"].as_u64().unwrap(),
            session_nonce: ch["sessionNonce"].as_str().unwrap().into(),
            issued_at: now(),
        };
        let s = sig(device, &route_claim_canonical(&c).unwrap());
        self.send(&json!({"type": "claim", "claim": {"account": c.account, "phoneRoutePub": c.phone_route_pub,
            "hostname": c.hostname, "generation": c.generation, "sessionNonce": c.session_nonce, "issuedAt": c.issued_at},
            "signature": s}));
        self.next_of("granted|refused").await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_bare_name_has_one_holder_across_relays() {
    let w = world(Tune::default()).await;
    let a = alice();
    let host = format!("alice.{APEX}");
    w.com.account(&a);
    synced(&w).await;
    let (d1, d2) = (key(0x41), key(0x42));
    let ledger = w.node("aa1").mesh.ledger_relay("alice").unwrap();
    for n in &w.nodes {
        assert_eq!(
            n.mesh.ledger_relay("alice").as_deref(),
            Some(ledger.as_str()),
            "one ranking"
        );
    }

    let mut p1 = SimPhone::connect(w.node("bb1").r().hub_addr, &host).await;
    let r = p1.claim(&a, &d1, &device_grant(&a, &d1, 1)).await;
    assert_eq!(r["type"], "granted", "{r}");
    for n in &w.nodes {
        eventually("the phone item everywhere", || {
            n.mesh.phone_holder(&host).as_deref() == Some("bb1")
        })
        .await;
    }
    for id in ["aa1", "cc1"] {
        reaches(w.node(id).r(), &host, &host).await;
    }
    // A second phone elsewhere is held off while the first holds the route…
    let mut p2 = SimPhone::connect(w.node("cc1").r().hub_addr, &host).await;
    let r = p2.claim(&a, &d2, &device_grant(&a, &d2, 2)).await;
    assert_eq!(
        (r["type"].as_str(), r["code"].as_str()),
        (Some("refused"), Some("route-held")),
        "{r}"
    );
    // …and a phone that presents no grants is not eligible (§13.1): refused at `begin`, before any generation is
    // revealed (security review 2026-11-02).
    let mut p3 = SimPhone::connect(w.node("aa1").r().hub_addr, &host).await;
    p3.send(&json!({"type": "begin", "account": "alice"}));
    let r = p3.next_of("challenge|refused").await;
    assert_eq!(
        (r["type"].as_str(), r["code"].as_str()),
        (Some("refused"), Some("not-eligible")),
        "{r}"
    );
    assert!(r.get("generation").is_none(), "{r}");
    // A grant with an id the log cannot carry does not count either.
    let mut odd = device_grant(&a, &d2, 2);
    odd["grant"]["grantId"] = json!("not-a-log-id!");
    p3.send(&json!({"type": "begin", "account": "alice", "grants": [odd]}));
    let r = p3.next_of("challenge|refused").await;
    assert_eq!(r["code"], "not-eligible", "{r}");
    // The first phone leaves: the standby hears the vacancy across relays and takes the route.
    drop(p1);
    let v = p2.next_of("route-vacant").await;
    assert_eq!(v["hostname"], host.as_str());
    let r = p2.claim(&a, &d2, &device_grant(&a, &d2, 2)).await;
    assert_eq!(r["type"], "granted", "{r}");
    for n in &w.nodes {
        eventually("the new holder everywhere", || {
            n.mesh.phone_holder(&host).as_deref() == Some("cc1")
        })
        .await;
    }
    reaches(w.node("bb1").r(), &host, &host).await;
    // Revoking its grant in the log ends the route and closes the phone (§8.4).
    w.com.append(RelayLogBody::DeviceGrantRevoke {
        grant_id: "02".repeat(32),
        device_pub: pubhex(&d2),
    });
    let lost = p2.next_of("lost").await;
    assert_eq!(lost["reason"], "revoked");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_relay_leaving_hints_its_boxes_away_and_a_retired_one_is_cut() {
    let mut w = world(Tune::default()).await;
    let a = alice();
    let stk = key(0x31);
    let pod = format!("home.alice.{APEX}");
    w.com.account(&a);
    w.com.register(&pod, &stk);
    synced(&w).await;
    let opts = BoxOpts {
        mesh: true,
        ..BoxOpts::default()
    };
    let (mut b, _) = SimBox::connect(w.node("aa1").r().hub_addr, &a, &pod, &stk, &opts).await;
    b.attach("aa1").await;

    // Retiring cc1: its bridges are cut, nothing it announces is taken any more, and a new mesh-key epoch it never
    // receives keeps it from reading anything published after (it goes stale).
    w.com.retire("cc1");
    for id in ["aa1", "bb1"] {
        eventually("cc1 cut", || {
            !w.node(id).mesh.peer_ids().contains(&"cc1".to_owned())
        })
        .await;
        eventually("the new epoch read", || w.node(id).mesh.fresh()).await;
    }
    eventually("cc1 out of the directory", || !w.node("cc1").mesh.ready().0).await;
    let seq = w.com.entries.lock().unwrap().len() as u64;
    eventually("aa1 read the revocation", || {
        w.node("aa1").mesh.log_sequence() == seq
    })
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        w.node("cc1").mesh.log_sequence() < seq,
        "a retired relay cannot read what is sealed under the new epoch"
    );

    // Draining aa1: unhealthy at once, and its mesh box gets a `retire` hint to bb1.
    let relay = w.nodes[0].relay.take().unwrap();
    let drain = tokio::spawn(async move {
        relay.drain(Duration::from_secs(2)).await;
        relay
    });
    eventually("aa1 draining", || {
        w.node("aa1").mesh.ready() == (false, "draining")
    })
    .await;
    let hint = b.next_of(FRAME_MOVE_HINT).await;
    let h: Value = serde_json::from_slice(&hint.payload).unwrap();
    assert_eq!(
        (
            h["hint"]["reason"].as_str(),
            h["hint"]["toRelayId"].as_str()
        ),
        (Some("retire"), Some("bb1"))
    );
    let relay = drain.await.unwrap();
    relay.shutdown().await;
}

fn policy_for(a: &Acct, stk: &SigningKey) -> (ServingPolicy, Value, Value) {
    let t = now();
    let p = ServingPolicy {
        account: a.name.clone(),
        box_pub: pubhex(stk),
        reg_gen: 1,
        policy_gen: 1,
        grace: Grace::SevenDays,
        on_lapse: OnLapse::StopApps,
        scope_sha256: "ab".repeat(32),
        issued_at: t - 1000,
    };
    let ps = sig(&a.admin, &policy_canonical(&p).unwrap());
    let l = ServingLease {
        account: a.name.clone(),
        box_pub: pubhex(stk),
        reg_gen: 1,
        policy_gen: 1,
        lease_id: "cd".repeat(16),
        issued_at: t - 1000,
        not_after: t + 3_600_000,
    };
    let ls = sig(&a.admin, &lease_canonical(&l).unwrap());
    let policy = json!({"record": {"account": p.account, "box": p.box_pub, "regGen": 1, "policyGen": 1, "grace": "7d",
        "onLapse": "stop-apps", "scopeSha256": p.scope_sha256, "issuedAt": p.issued_at}, "signature": ps});
    let leases = json!([{"record": {"account": l.account, "box": l.box_pub, "regGen": 1, "policyGen": 1,
        "leaseId": l.lease_id, "issuedAt": l.issued_at, "notAfter": l.not_after}, "signature": ls}]);
    (p, policy, leases)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn without_com_new_tunnels_stop_then_only_boxes_without_a_dead_man_keep_serving() {
    let w = world(Tune {
        refuse_new: Duration::from_millis(700),
        close_all: Duration::from_millis(1600),
        trust_fly: false,
    })
    .await;
    let a = alice();
    let (free, timed, spare) = (key(0x31), key(0x32), key(0x33));
    let (pod_free, pod_timed, pod_spare) = (
        format!("home.alice.{APEX}"),
        format!("office.alice.{APEX}"),
        format!("spare.alice.{APEX}"),
    );
    w.com.account(&a);
    w.com.register(&pod_free, &free);
    w.com.register(&pod_timed, &timed);
    w.com.register(&pod_spare, &spare);
    let (p, policy, leases) = policy_for(&a, &timed);
    w.com.append(RelayLogBody::PolicyHead {
        box_pub: pubhex(&timed),
        reg_gen: 1,
        policy_gen: 1,
        policy_sha256: hex(&Sha256::digest(policy_canonical(&p).unwrap().as_bytes())),
    });
    synced(&w).await;
    let r = w.node("aa1").r();
    let opts = BoxOpts {
        mesh: true,
        ..BoxOpts::default()
    };
    let (mut b_free, _) = SimBox::connect(r.hub_addr, &a, &pod_free, &free, &opts).await;
    b_free.attach("aa1").await;
    let timed_opts = BoxOpts {
        mesh: true,
        policy: Some((policy, leases)),
        ..BoxOpts::default()
    };
    let (mut b_timed, _) = SimBox::connect(r.hub_addr, &a, &pod_timed, &timed, &timed_opts).await;
    b_timed.attach("aa1").await;
    eventually("bb1 knows both", || {
        w.node("bb1").mesh.winner_of(&pod_free).is_some()
            && w.node("bb1").mesh.winner_of(&pod_timed).is_some()
    })
    .await;
    reaches(r, &format!("app.{pod_timed}"), &pod_timed).await;

    w.com.paused.store(true, Ordering::SeqCst);
    eventually("stale", || !w.node("aa1").mesh.fresh()).await;
    assert_eq!(w.node("aa1").mesh.ready(), (false, "stale"));
    eventually("new tunnels refused", || {
        !w.node("aa1").mesh.accepting_new()
    })
    .await;
    // Past HEAD_REFUSE_NEW_MS: a time-limited box is told to try again, a box with no time limit is still taken.
    let (_late, ack) = SimBox::connect(r.hub_addr, &a, &pod_timed, &timed, &timed_opts).await;
    assert_eq!((ack.ok, ack.reason.as_deref()), (false, Some("try-again")));
    let (_spare, ack) = SimBox::connect(r.hub_addr, &a, &pod_spare, &spare, &opts).await;
    assert!(ack.ok, "an exempt box is admitted while stale: {ack:?}");
    // Past HEAD_CLOSE_ALL_MS: the time-limited box is closed, the exempt one keeps serving, through a stale entry relay
    // too (the holder re-checks its exemption).
    eventually("the timed box closed", || {
        b_timed.closed_with() == Some(1013)
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        b_free.closed_with(),
        None,
        "an indefinite box keeps serving"
    );
    reaches(r, &pod_free, &pod_free).await;
    assert!(!w.node("bb1").mesh.fresh());
    reaches(w.node("bb1").r(), &pod_free, &pod_free).await;

    w.com.paused.store(false, Ordering::SeqCst);
    eventually("fresh again", || w.node("aa1").mesh.fresh()).await;
    let (_back, ack) = SimBox::connect(r.hub_addr, &a, &pod_timed, &timed, &timed_opts).await;
    assert!(ack.ok, "{ack:?}");
}

/// `POST /pb/m/<id>` on a hub port: status and body.
async fn post_mail(hub: SocketAddr, id: &str, body: &[u8]) -> (u16, Vec<u8>) {
    let mut s = TcpStream::connect(hub).await.unwrap();
    let head = format!(
        "POST /pb/m/{id} HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes()).await.unwrap();
    s.write_all(body).await.unwrap();
    let mut out = Vec::new();
    tokio::time::timeout(T, s.read_to_end(&mut out))
        .await
        .unwrap()
        .unwrap();
    let text = String::from_utf8_lossy(&out).into_owned();
    let status: u16 = text.split(' ').nth(1).unwrap().parse().unwrap();
    let at = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
    (status, out[at..].to_vec())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_mailbox_on_another_relay_is_reached_over_the_bridge() {
    let w = world(Tune::default()).await;
    let a = alice();
    let stk = key(0x31);
    let pod = format!("home.alice.{APEX}");
    w.com.account(&a);
    w.com.register(&pod, &stk);
    synced(&w).await;
    let (mut b, _) = SimBox::connect(
        w.node("aa1").r().hub_addr,
        &a,
        &pod,
        &stk,
        &BoxOpts {
            mesh: true,
            ..BoxOpts::default()
        },
    )
    .await;
    b.attach("aa1").await;
    let pik = key(0x51);
    let epoch = flagship_relay::mailbox::mailbox_epoch(now());
    let ann = payload::MailboxAnnouncement {
        pik_pub_hex: pubhex(&pik),
        epoch: epoch as f64,
        sig_hex: sig(
            &pik,
            &flagship_relay::mailbox::canonical_announce(&pubhex(&pik), epoch),
        ),
        ..Default::default()
    };
    b.send(&payload::mailbox_announce_frame(&[ann]).unwrap());
    let id = flagship_relay::mailbox::mailbox_id(&pubhex(&pik), epoch);
    eventually("bb1 learns the mailbox", || {
        w.node("bb1").mesh.mailbox_holder(&id).as_deref() == Some("aa1")
    })
    .await;
    let (status, body) = post_mail(w.node("bb1").r().hub_addr, &id, b"sealed").await;
    assert_eq!((status, body.as_slice()), (200, b"reply:sealed".as_slice()));
    let (status, _) = post_mail(w.node("bb1").r().hub_addr, &"ab".repeat(16), b"x").await;
    assert_eq!(status, 404);

    // The same (self-authenticating) announcement through another relay does not take the mailbox over: the first
    // holder keeps it until it withdraws it (security review 2026-11-02, §7.6).
    let stk2 = key(0x32);
    let pod2 = format!("cabin.alice.{APEX}");
    w.com.register(&pod2, &stk2);
    synced(&w).await;
    let (mut b2, _) = SimBox::connect(
        w.node("cc1").r().hub_addr,
        &a,
        &pod2,
        &stk2,
        &BoxOpts {
            mesh: true,
            ..BoxOpts::default()
        },
    )
    .await;
    b2.attach("cc1").await;
    let ann2 = payload::MailboxAnnouncement {
        pik_pub_hex: pubhex(&pik),
        epoch: epoch as f64,
        sig_hex: sig(
            &pik,
            &flagship_relay::mailbox::canonical_announce(&pubhex(&pik), epoch),
        ),
        ..Default::default()
    };
    b2.send(&payload::mailbox_announce_frame(&[ann2]).unwrap());
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        w.node("bb1").mesh.mailbox_holder(&id).as_deref(),
        Some("aa1"),
        "the first holder keeps it"
    );
    // aa1's box leaves: aa1 withdraws the id, and the relay that announced it next holds it.
    b.close();
    eventually("aa1 withdrew; cc1 holds it", || {
        w.node("bb1").mesh.mailbox_holder(&id).as_deref() == Some("cc1")
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn phone_tunnels_and_begins_are_capped_per_address() {
    let w = world(Tune::default()).await;
    let a = alice();
    let host = format!("alice.{APEX}");
    w.com.account(&a);
    synced(&w).await;
    let hub = w.node("bb1").r().hub_addr;
    // One phone: its begins come out of its address's budget (refused not-eligible: it presents no grants).
    let mut p = SimPhone::connect(hub, &host).await;
    for _ in 0..flagship_relay::phone::PHONE_BEGIN_BURST {
        p.send(&json!({"type": "begin", "account": "alice"}));
        assert_eq!(p.next_of("refused").await["code"], "not-eligible");
    }
    p.send(&json!({"type": "begin", "account": "alice"}));
    assert_eq!(p.next_of("refused").await["code"], "busy");
    // Tunnels from one address: the cap, then 503 before the upgrade.
    let mut held = vec![p];
    for _ in 1..flagship_relay::phone::PHONE_TUNNEL_MAX_PER_IP {
        held.push(SimPhone::connect(hub, &host).await);
    }
    let over = tokio_tungstenite::connect_async(format!("ws://{hub}/phone-tunnel")).await;
    let Err(tokio_tungstenite::tungstenite::Error::Http(r)) = over else {
        panic!("the tunnel past the cap was not refused");
    };
    assert_eq!(r.status().as_u16(), 503);
    // A tunnel that closes frees its place.
    drop(held.pop());
    let mut ok = false;
    for _ in 0..50 {
        if tokio_tungstenite::connect_async(format!("ws://{hub}/phone-tunnel"))
            .await
            .is_ok()
        {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ok, "a closed tunnel frees its place");
}

async fn mesh_ws(hub: SocketAddr, fly: Option<&str>) -> Result<(), u16> {
    let mut req = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
        format!("ws://{hub}/mesh"),
    )
    .unwrap();
    if let Some(ip) = fly {
        req.headers_mut()
            .insert("fly-client-ip", ip.parse().unwrap());
    }
    match tokio_tungstenite::connect_async(req).await {
        Ok((ws, _)) => {
            // Held open (unauthenticated) until the test ends.
            std::mem::forget(ws);
            Ok(())
        }
        Err(tokio_tungstenite::tungstenite::Error::Http(r)) => Err(r.status().as_u16()),
        Err(e) => panic!("{e}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unauthenticated_mesh_handshakes_are_capped_per_address() {
    let w = world(Tune::default()).await;
    let hub = w.node("bb1").r().hub_addr;
    // 127.0.0.1 is where the peers authenticated from: a known peer address, so it also gets the reserved pool.
    for _ in 0..2 * rm::MESH_HANDSHAKE_MAX_PENDING_PER_IP {
        assert_eq!(mesh_ws(hub, None).await, Ok(()));
    }
    assert_eq!(mesh_ws(hub, None).await, Err(503));
    // Off Fly a forged Fly-Client-IP buys no new allowance (§6.1).
    assert_eq!(mesh_ws(hub, Some("203.0.113.9")).await, Err(503));
    // The real bridges were never in the way: they authenticated long ago.
    assert_eq!(w.node("bb1").mesh.peer_ids().len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn on_fly_unknown_addresses_cannot_take_the_slots_kept_for_peers() {
    let w = world(Tune {
        trust_fly: true,
        ..Tune::default()
    })
    .await;
    let hub = w.node("bb1").r().hub_addr;
    // 16 addresses × 4 fill the 64 general slots.
    let per = rm::MESH_HANDSHAKE_MAX_PENDING_PER_IP;
    for i in 0..rm::MESH_HANDSHAKE_MAX_PENDING / per {
        let ip = format!("198.51.100.{i}");
        for _ in 0..per {
            assert_eq!(mesh_ws(hub, Some(&ip)).await, Ok(()));
        }
    }
    // A new unknown address: refused; the known peer address (the socket peer, no header): still admitted.
    assert_eq!(mesh_ws(hub, Some("203.0.113.9")).await, Err(503));
    assert_eq!(mesh_ws(hub, None).await, Ok(()));
}

#[test]
fn the_holder_reads_the_sni_from_the_visitors_client_hello() {
    let sni = format!("home.alice.{APEX}");
    assert_eq!(
        flagship_relay::mesh::bridge::hello_sni(&client_hello(&sni)).as_deref(),
        Some(sni.as_str())
    );
    assert_eq!(
        flagship_relay::mesh::bridge::hello_sni(b"not a hello"),
        None
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_home_moves_an_account_toward_the_relay_its_visitors_use() {
    let w = world(Tune::default()).await;
    let a = alice();
    let stk = key(0x31);
    let pod = format!("home.alice.{APEX}");
    w.com.account(&a);
    w.com.register(&pod, &stk);
    synced(&w).await;
    let opts = BoxOpts {
        mesh: true,
        ..BoxOpts::default()
    };
    let (mut b, _) = SimBox::connect(w.node("aa1").r().hub_addr, &a, &pod, &stk, &opts).await;
    b.attach("aa1").await;
    for n in &w.nodes {
        eventually("home aa1", || {
            n.mesh.account_home("alice").as_deref() == Some("aa1")
        })
        .await;
    }
    // A bridged visit is counted by entry relay on the home.
    reaches(w.node("cc1").r(), &pod, &pod).await;
    let home = &w.node("aa1").mesh;
    // One address, however much it sends, is one client capped at 8 MiB: no move (§10.1).
    for _ in 0..600 {
        home.count_session("alice", Some("cc1"), "00000000000000aa", 1 << 20);
    }
    assert!(
        home.rebalance_now().is_empty(),
        "one busy client steers nothing"
    );
    // 600 distinct visitors through cc1, a few here.
    for i in 0..600u32 {
        home.count_session("alice", Some("cc1"), &format!("{i:016x}"), 140 << 10);
    }
    for i in 0..10u32 {
        home.count_session("alice", None, &format!("{:016x}", 10_000 + i), 100 << 10);
    }
    assert_eq!(
        home.rebalance_now(),
        vec![("alice".to_owned(), "cc1".to_owned())]
    );
    assert!(
        home.rebalance_now().is_empty(),
        "one move per account per interval"
    );
    let ah = rm::account_hash("alice").unwrap();
    for id in ["bb1", "cc1"] {
        eventually("the move reaches the peers", || {
            w.node(id)
                .mesh
                .accepted_moves()
                .contains(&(ah.clone(), "cc1".to_owned()))
        })
        .await;
    }
    let hint = b.next_of(FRAME_MOVE_HINT).await;
    let h: Value = serde_json::from_slice(&hint.payload).unwrap();
    assert_eq!(
        (
            h["hint"]["reason"].as_str(),
            h["hint"]["toRelayId"].as_str()
        ),
        (Some("locality"), Some("cc1"))
    );
    let (mut moved, _) = SimBox::connect(w.node("cc1").r().hub_addr, &a, &pod, &stk, &opts).await;
    moved.attach("cc1").await;
    for n in &w.nodes {
        eventually("home cc1", || {
            n.mesh.account_home("alice").as_deref() == Some("cc1")
        })
        .await;
    }
    reaches(w.node("aa1").r(), &pod, &pod).await;
}

// ── channel binding (§6.2, review 2026-11-03) ───────────────────────────────

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

async fn next_json(ws: &mut Ws) -> Option<String> {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .ok()??
        {
            Ok(Message::Text(t)) => return Some(t.to_string()),
            Ok(Message::Close(c)) => {
                return c.map(|c| format!("close:{}:{}", u16::from(c.code), c.reason));
            }
            Ok(_) => {}
            Err(_) => return None,
        }
    }
}

/// Dial `hub` as relay `id` (its key), finish the handshake, and return the socket with this side's MAC keys.
async fn fake_dial(w: &World, hub: SocketAddr, id: &str, peer: &str) -> (Ws, rm::BridgeMacKeys) {
    let k = w.node(id).key.clone();
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{hub}/mesh"))
        .await
        .unwrap();
    let hello: Value = serde_json::from_str(&next_json(&mut ws).await.unwrap()).unwrap();
    let ns = hello["nonce"].as_str().unwrap().to_owned();
    let nc = rand_hex(32);
    let (secret, kx) = rm::bridge_ephemeral().unwrap();
    let at = now();
    let b = rm::BridgeAuth {
        role: "client".into(),
        signer_relay_id: id.into(),
        peer_relay_id: peer.into(),
        server_nonce: ns.clone(),
        client_nonce: nc.clone(),
        at,
        kx: kx.clone(),
    };
    let s = sig(&k, &rm::bridge_auth_canonical(&b).unwrap());
    let auth = json!({"type": "mesh-auth", "v": 1, "relayId": id, "peer": peer, "nonce": nc, "at": at, "kx": kx,
        "blessing": w.com.bless(id, &pubhex(&k)), "sig": s});
    ws.send(Message::Text(auth.to_string().into()))
        .await
        .unwrap();
    let reply: Value = serde_json::from_str(&next_json(&mut ws).await.unwrap()).unwrap();
    assert_eq!(reply["type"], "mesh-auth");
    let peer_kx = reply["kx"]
        .as_str()
        .expect("the acceptor's mesh-auth carries kx");
    let keys = rm::bridge_mac_keys(&secret, peer_kx, &ns, &nc, id, peer).unwrap();
    (ws, keys)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bridge_control_messages_are_sealed_and_an_unsealed_one_closes_the_bridge() {
    let w = world(Tune::default()).await;
    let hub = w.node("bb1").r().hub_addr;
    let (mut ws, keys) = fake_dial(&w, hub, "aa1", "bb1").await;
    // The acceptor's first control message (its `sync`) is sealed under s2c at seq 0.
    let first = next_json(&mut ws).await.unwrap();
    let json = rm::open_bridge_text(&keys.s2c, 0, &first).expect("sealed with s2c, seq 0");
    assert_eq!(serde_json::from_str::<Value>(json).unwrap()["type"], "sync");
    // A sealed message is taken; an unsealed one (what a man in the middle would inject) closes 4401 bad-mac.
    ws.send(Message::Text(
        rm::seal_bridge_text(&keys.c2s, 0, r#"{"type":"sync-done"}"#).into(),
    ))
    .await
    .unwrap();
    ws.send(Message::Text(r#"{"type":"sync-done"}"#.into()))
        .await
        .unwrap();
    let mut closed = None;
    while let Some(m) = next_json(&mut ws).await {
        if m.starts_with("close:") {
            closed = Some(m);
            break;
        }
    }
    assert_eq!(closed.as_deref(), Some("close:4401:bad-mac"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_acceptor_waits_only_two_seconds_for_the_first_mesh_auth() {
    let w = world(Tune::default()).await;
    let hub = w.node("bb1").r().hub_addr;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{hub}/mesh"))
        .await
        .unwrap();
    let t0 = Instant::now();
    let _hello = next_json(&mut ws).await.unwrap();
    let end = next_json(&mut ws).await;
    let took = t0.elapsed();
    assert!(
        end.as_ref().is_none_or(|m| m.starts_with("close:")),
        "{end:?}"
    );
    assert!(
        took < Duration::from_millis(rm::MESH_HANDSHAKE_STEP_MS - 1000),
        "closed after {took:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_dialer_refuses_a_stale_mesh_hello() {
    let w = world(Tune::default()).await;
    // A fake acceptor for "zz9" whose mesh-hello is 10 minutes old.
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let (s, _) = l.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
        let hello = json!({"type": "mesh-hello", "v": 1, "relayId": "zz9", "nonce": rand_hex(32), "at": now() - 600_000});
        ws.send(Message::Text(hello.to_string().into()))
            .await
            .unwrap();
        while let Some(Ok(m)) = ws.next().await {
            match m {
                Message::Text(t) => tx.send(format!("text:{t}")).unwrap(),
                Message::Close(c) => {
                    tx.send(format!(
                        "close:{}",
                        c.map(|c| c.reason.to_string()).unwrap_or_default()
                    ))
                    .unwrap();
                    break;
                }
                _ => {}
            }
        }
    });
    let n = &w.nodes[0];
    let mut cfg = MeshConfig::new("aa2", APEX, RelayKind::Full, &pubhex(&w.com.log));
    cfg.peer_urls
        .insert("zz9".into(), format!("ws://{addr}/mesh"));
    let parts = MeshParts {
        feed: Arc::new(Feed(Arc::clone(&w.com))),
        decrypt: SealedFeed::new(APEX, "aa2", n.key.to_bytes()),
        ca: Arc::new(StaticCaKeys(vec![pubhex(&w.com.ca)])),
        issuer: Arc::new(Issuer(Arc::clone(&w.com))),
    };
    let m = Mesh::new(cfg, n.key.clone(), parts, Box::new(|_: &str| {})).unwrap();
    assert!(!m.dial_bridge("zz9").await);
    let got = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap();
    assert_eq!(
        got.as_deref(),
        Some("close:stale"),
        "no mesh-auth to a stale hello"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_requery_that_skipped_a_relay_is_single_flight_and_remembered_briefly() {
    let w = world(Tune::default()).await;
    let m = &w.node("aa1").mesh;
    let name = format!("ghost.alice.{APEX}");
    let hits = || m.counters().negative_hits.load(Ordering::Relaxed);
    let sent = || m.counters().queries_sent.load(Ordering::Relaxed);
    // Concurrent: the plain query and the excluding one are separate flights; two of the same excluding one are one.
    let (a, b, c) = tokio::join!(
        m.query(&name, None),
        m.query(&name, Some("bb1")),
        m.query(&name, Some("bb1"))
    );
    assert!(!a && !b && !c);
    assert_eq!(sent(), 2, "one flight per (name, excluded)");
    // The miss with bb1 excluded is remembered: no new query for 2 s.
    let h0 = hits();
    assert!(!m.query(&name, Some("bb1")).await);
    assert_eq!(hits(), h0 + 1);
    assert_eq!(sent(), 2);
    tokio::time::sleep(Duration::from_millis(rm::MESH_NEG_CACHE_EXCLUDE_MS + 100)).await;
    assert!(!m.query(&name, Some("bb1")).await);
    assert_eq!(sent(), 3, "asked again once the 2 s are over");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_move_for_an_account_the_relay_holds_nothing_of_is_refused() {
    let w = world(Tune::default()).await;
    let hub = w.node("bb1").r().hub_addr;
    let (mut ws, keys) = fake_dial(&w, hub, "aa1", "bb1").await;
    let t = now();
    let mv = rm::AccountMove {
        account_hash: rm::account_hash("nobody").unwrap(),
        from_relay_id: "aa1".into(),
        to_relay_id: "cc1".into(),
        issued_at: t,
        not_after: t + rm::ACCOUNT_MOVE_TTL_MS,
    };
    let s = sig(
        &w.node("aa1").key,
        &rm::account_move_canonical(&mv).unwrap(),
    );
    let msg = wire::account_move_to_json(&mv, &s).to_string();
    ws.send(Message::Text(
        rm::seal_bridge_text(&keys.c2s, 0, &msg).into(),
    ))
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(w.node("bb1").mesh.accepted_moves().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_relay_bound_mailbox_announcement_beats_a_replayed_unbound_copy() {
    let w = world(Tune::default()).await;
    let a = alice();
    w.com.account(&a);
    let pods = [
        ("aa1", format!("home.alice.{APEX}"), key(0x31)),
        ("cc1", format!("cabin.alice.{APEX}"), key(0x32)),
    ];
    for (_, pod, stk) in &pods {
        w.com.register(pod, stk);
    }
    synced(&w).await;
    let mut boxes = Vec::new();
    for (relay, pod, stk) in &pods {
        let opts = BoxOpts {
            mesh: true,
            ..BoxOpts::default()
        };
        let (mut b, _) = SimBox::connect(w.node(relay).r().hub_addr, &a, pod, stk, &opts).await;
        b.attach(relay).await;
        boxes.push(b);
    }
    let pik = key(0x51);
    let epoch = flagship_relay::mailbox::mailbox_epoch(now());
    let v1 = sig(
        &pik,
        &flagship_relay::mailbox::canonical_announce(&pubhex(&pik), epoch),
    );
    let bound = |relay: &str| {
        sig(
            &pik,
            &rm::pb_mailbox_announce_relay_canonical(&pubhex(&pik), epoch, relay).unwrap(),
        )
    };
    let id = flagship_relay::mailbox::mailbox_id(&pubhex(&pik), epoch);
    // The unbound copy (an old box, or a replay) through aa1 arrives first.
    boxes[0].send(
        &payload::mailbox_announce_frame(&[payload::MailboxAnnouncement {
            pik_pub_hex: pubhex(&pik),
            epoch: epoch as f64,
            sig_hex: v1.clone(),
            ..Default::default()
        }])
        .unwrap(),
    );
    eventually("bb1 learns aa1", || {
        w.node("bb1").mesh.mailbox_holder(&id).as_deref() == Some("aa1")
    })
    .await;
    // A binding to another relay is not kept by cc1's hub: still unbound, aa1 keeps it.
    boxes[1].send(
        &payload::mailbox_announce_frame(&[payload::MailboxAnnouncement {
            pik_pub_hex: pubhex(&pik),
            epoch: epoch as f64,
            sig_hex: v1.clone(),
            relay_id: Some("aa1".into()),
            relay_sig_hex: Some(bound("aa1")),
        }])
        .unwrap(),
    );
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        w.node("bb1").mesh.mailbox_holder(&id).as_deref(),
        Some("aa1")
    );
    // The box's own announcement, bound to cc1: cc1 holds it everywhere, though aa1's tunnel is still up.
    boxes[1].send(
        &payload::mailbox_announce_frame(&[payload::MailboxAnnouncement {
            pik_pub_hex: pubhex(&pik),
            epoch: epoch as f64,
            sig_hex: v1,
            relay_id: Some("cc1".into()),
            relay_sig_hex: Some(bound("cc1")),
        }])
        .unwrap(),
    );
    eventually("the bound announcement wins", || {
        w.node("bb1").mesh.mailbox_holder(&id).as_deref() == Some("cc1")
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mail_goes_to_the_next_relay_when_the_first_refuses() {
    let w = world(Tune::default()).await;
    let a = alice();
    let stk = key(0x32);
    let pod = format!("cabin.alice.{APEX}");
    w.com.account(&a);
    w.com.register(&pod, &stk);
    synced(&w).await;
    let pik = key(0x51);
    let epoch = flagship_relay::mailbox::mailbox_epoch(now());
    let v1 = sig(
        &pik,
        &flagship_relay::mailbox::canonical_announce(&pubhex(&pik), epoch),
    );
    let id = flagship_relay::mailbox::mailbox_id(&pubhex(&pik), epoch);
    // A bridge claiming to be aa1 announces the mailbox first, then refuses every stream `not-holder`.
    let hub = w.node("bb1").r().hub_addr;
    let (ws, keys) = fake_dial(&w, hub, "aa1", "bb1").await;
    let (mut sink, mut stream) = ws.split();
    let item = json!({"kind": "mailbox", "announce": {"pikPubHex": pubhex(&pik), "epoch": epoch}, "signature": v1,
        "relayId": "aa1"});
    let ann = json!({"type": "announce", "items": [item]}).to_string();
    sink.send(Message::Text(
        rm::seal_bridge_text(&keys.c2s, 0, &ann).into(),
    ))
    .await
    .unwrap();
    let refuser = tokio::spawn(async move {
        let mut seq = 1u64;
        let mut d = FrameDecoder::new(
            TypeSet {
                stream_credit: true,
                ..TypeSet::V1
            },
            8 << 20,
        );
        while let Some(Ok(m)) = stream.next().await {
            if let Message::Binary(b) = m {
                d.push(&b).unwrap();
                while let Some(f) = d.next_frame().unwrap() {
                    if f.frame_type == FRAME_OPEN {
                        let r =
                            json!({"type": "refuse", "stream": f.stream_id, "code": "not-holder"})
                                .to_string();
                        sink.send(Message::Text(
                            rm::seal_bridge_text(&keys.c2s, seq, &r).into(),
                        ))
                        .await
                        .unwrap();
                        seq += 1;
                    }
                }
            }
        }
    });
    eventually("bb1 learns aa1", || {
        w.node("bb1").mesh.mailbox_holder(&id).as_deref() == Some("aa1")
    })
    .await;
    // The real holder, second in line, through cc1.
    let opts = BoxOpts {
        mesh: true,
        ..BoxOpts::default()
    };
    let (mut b, _) = SimBox::connect(w.node("cc1").r().hub_addr, &a, &pod, &stk, &opts).await;
    b.attach("cc1").await;
    b.send(
        &payload::mailbox_announce_frame(&[payload::MailboxAnnouncement {
            pik_pub_hex: pubhex(&pik),
            epoch: epoch as f64,
            sig_hex: v1.clone(),
            ..Default::default()
        }])
        .unwrap(),
    );
    tokio::time::sleep(Duration::from_millis(600)).await;
    let (status, body) = post_mail(hub, &id, b"sealed").await;
    assert_eq!((status, body.as_slice()), (200, b"reply:sealed".as_slice()));
    refuser.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_completed_sessions_count_toward_rebalancing() {
    let w = world(Tune::default()).await;
    let a = alice();
    let stk = key(0x31);
    let pod = format!("home.alice.{APEX}");
    w.com.account(&a);
    w.com.register(&pod, &stk);
    synced(&w).await;
    let opts = BoxOpts {
        mesh: true,
        linger: true,
        ..BoxOpts::default()
    };
    let (mut b, _) = SimBox::connect(w.node("aa1").r().hub_addr, &a, &pod, &stk, &opts).await;
    b.attach("aa1").await;
    eventually("cc1 knows", || w.node("cc1").mesh.winner_of(&pod).is_some()).await;
    let home = &w.node("aa1").mesh;
    // A ClientHello and nothing after it (the box answered, the visitor never went on): not a completed session.
    let mut s = TcpStream::connect(w.node("cc1").r().sni_addr)
        .await
        .unwrap();
    s.write_all(&client_hello(&pod)).await.unwrap();
    let mut buf = vec![0u8; 64];
    assert!(s.read(&mut buf).await.unwrap() > 0);
    drop(s);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        home.traffic_window("alice").is_empty(),
        "{:?}",
        home.traffic_window("alice")
    );
    // A visitor that keeps talking after the box answered: one session, keyed by cc1's client key.
    let mut s = TcpStream::connect(w.node("cc1").r().sni_addr)
        .await
        .unwrap();
    s.write_all(&client_hello(&pod)).await.unwrap();
    let mut buf = vec![0u8; 64];
    let n = s.read(&mut buf).await.unwrap();
    assert!(n > 0);
    s.write_all(b"finished").await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    drop(s);
    eventually("counted", || {
        home.traffic_window("alice")
            .iter()
            .any(|x| x.relay_id == "cc1" && x.streams == 1)
    })
    .await;
}

#[test]
fn the_test_knob_keys_loopback_visitors_by_port() {
    let com = Com::new();
    let k = key(0x0b);
    let lone = |by_port: bool| {
        let mut cfg = MeshConfig::new("aa1", APEX, RelayKind::Full, &pubhex(&com.log));
        cfg.client_key_by_port = by_port;
        let parts = MeshParts {
            feed: Arc::new(Feed(Arc::clone(&com))),
            decrypt: SealedFeed::new(APEX, "aa1", k.to_bytes()),
            ca: Arc::new(StaticCaKeys(vec![pubhex(&com.ca)])),
            issuer: Arc::new(Issuer(Arc::clone(&com))),
        };
        Mesh::new(cfg, k.clone(), parts, Box::new(|_: &str| {})).unwrap()
    };
    let (a, b): (SocketAddr, SocketAddr) = (
        "127.0.0.1:40001".parse().unwrap(),
        "127.0.0.1:40002".parse().unwrap(),
    );
    let off = lone(false);
    assert_eq!(
        off.visitor_key(a),
        off.visitor_key(b),
        "one IP is one client by default"
    );
    let on = lone(true);
    assert_ne!(
        on.visitor_key(a),
        on.visitor_key(b),
        "two ports are two clients with the knob"
    );
    let vars = |kv: &[(&str, &str)]| -> HashMap<String, String> {
        kv.iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    };
    let base = [
        ("FLAGSHIP_MESH", "on"),
        ("PORT", "3000"),
        ("TUNNEL_TCP_PORT", "8443"),
        ("FLAGSHIP_RELAY_ID", "aa1"),
        (
            "FLAGSHIP_RELAY_KEY_SEED",
            "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
        ),
        ("FLAGSHIP_RELAY_LOG_PUB", "aa".repeat(32).leak()),
    ];
    let s = flagship_relay::config::Settings::from_vars(&vars(&base)).unwrap();
    assert!(!s.mesh.unwrap().client_key_by_port);
    let mut on_vars = base.to_vec();
    on_vars.push(("FLAGSHIP_MESH_CLIENT_KEY_BY_PORT", "1"));
    let s = flagship_relay::config::Settings::from_vars(&vars(&on_vars)).unwrap();
    assert!(s.mesh.unwrap().client_key_by_port);
}

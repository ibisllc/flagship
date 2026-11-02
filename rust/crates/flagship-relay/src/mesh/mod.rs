//! The relay mesh (docs/architecture-v2/relay-mesh.md, release 0.3, chunk D): several relays, one data plane. On only
//! with `FLAGSHIP_MESH=on`; with it off nothing here runs and the relay is exactly today's.
//!
//! One [`Mesh`] per process holds what the relay knows from signed data: the public relay log and its head
//! ([`feed`]), the CA-signed directory and blessings ([`directory`]), every peer's attachments ([`attachments`]), the
//! account moves ([`home`]), the phone ledger it runs for the accounts that rank it first ([`phone_ledger`]) and the
//! traffic it measures as a home ([`rebalance`]). Peers talk over [`bridge`]s; misses are repaired by [`query`]; old
//! boxes are announced by [`legacy`]. Every rule (canonical bytes, signatures, windows, precedence) is chunk A's
//! (`flagship_crypto::relay_mesh`); this module gathers the inputs, keeps the state and acts.
//!
//! Lock order: the mesh state lock is never held across an await, nor while the registry, the serving gate or the
//! phone routes are called.

pub mod attachments;
pub mod bridge;
pub mod ca;
pub mod directory;
pub mod feed;
pub mod home;
pub mod legacy;
pub mod log_authority;
pub mod phone_ledger;
pub mod query;
pub mod rebalance;
pub mod wire;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use ed25519_dalek::SigningKey;
use flagship_crypto::relay_mesh::{
    self as rm, MeshCheckContext, RelayBlessing, RelayDirectory, RelayKind, RelayLogEntry,
    RelayLogHead, RelayLogState, is_bare_phone_name, is_pod_name,
};
use serde_json::Value;

use crate::hub::{SharedRegistry, Tunnel, now_ms};
use crate::phone::PhoneRoutes;
use crate::router::Router;
use crate::serving::ServingGate;

pub use attachments::Store;
pub use ca::{CaKeySource, MaintainersCa, StaticCaKeys};
pub use directory::{BlessingIssuer, HttpIssuer};
pub use feed::{FeedDecrypt, FeedFetch, FeedFile, HttpFeed, PlainFeed, SealedFeed};

/// The mesh's settings (relay-mesh.md §15.7). Tests shorten the timers.
#[derive(Debug, Clone)]
pub struct MeshConfig {
    pub relay_id: String,
    pub apex: String,
    pub kind: RelayKind,
    pub log_key: String,
    /// `FLAGSHIP_MESH_FEED_POLL_MS` (5 s).
    pub feed_poll: Duration,
    /// How often `directory.json` is re-read even when the head names no newer version (60 s, its cache age).
    pub directory_poll: Duration,
    /// The contact rule (§4.6, §15.4.1): fresh while the newest applied head is younger than `HEAD_REFUSE_NEW_MS`
    /// (new tunnels are refused exactly when it is not), every non-exempt tunnel closed once it is `HEAD_CLOSE_ALL_MS`
    /// old; shortened by `FLAGSHIP_SERVING_REFUSE_NEW_MS` / `FLAGSHIP_SERVING_CLOSE_ALL_MS`.
    pub refuse_new_after: Duration,
    pub close_all_after: Duration,
    /// `FLAGSHIP_MESH_REBALANCE_MS` (60 min ± 10).
    pub rebalance_every: Duration,
    /// `FLAGSHIP_MESH_MIN_MOVE_MS` (6 h): the least time between two moves of one account.
    pub min_move: Duration,
    /// `FLAGSHIP_MESH_ATTACH_TTL_MS`: the legacy attachment's TTL (3 min); renewed at a third of it.
    pub legacy_ttl: Duration,
    pub legacy_wait: Duration,
    pub query_timeout: Duration,
    pub bridge: BridgeTimings,
    /// `relayId=url,…` (`FLAGSHIP_MESH_PEER_URLS`): dial a peer here instead of `wss://<tunnelHost>:8443/mesh`.
    pub peer_urls: HashMap<String, String>,
    /// `FLAGSHIP_MESH_CAPACITY`: tunnels this relay takes (its `load.capacity`, default 10,000).
    pub capacity: u64,
    /// The least time between two `co-locate` hints to one box from this relay.
    pub colocate_every: Duration,
}

#[derive(Debug, Clone, Copy)]
pub struct BridgeTimings {
    pub dial: Duration,
    pub step: Duration,
    pub ping: Duration,
    pub down: Duration,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
}

impl Default for BridgeTimings {
    fn default() -> Self {
        Self {
            dial: Duration::from_millis(rm::MESH_DIAL_TIMEOUT_MS),
            step: Duration::from_millis(rm::MESH_HANDSHAKE_STEP_MS),
            ping: Duration::from_millis(rm::MESH_PING_MS),
            down: Duration::from_millis(rm::MESH_PEER_DOWN_MS),
            backoff_min: Duration::from_millis(rm::MESH_BACKOFF_MIN_MS),
            backoff_max: Duration::from_millis(rm::MESH_BACKOFF_MAX_MS),
        }
    }
}

impl MeshConfig {
    #[must_use]
    pub fn new(relay_id: &str, apex: &str, kind: RelayKind, log_key: &str) -> Self {
        Self {
            relay_id: relay_id.to_owned(),
            apex: apex.to_ascii_lowercase(),
            kind,
            log_key: log_key.to_ascii_lowercase(),
            feed_poll: Duration::from_millis(rm::FEED_POLL_MS),
            directory_poll: Duration::from_secs(60),
            refuse_new_after: Duration::from_millis(rm::HEAD_REFUSE_NEW_MS),
            close_all_after: Duration::from_millis(rm::HEAD_CLOSE_ALL_MS),
            rebalance_every: Duration::from_millis(rm::REBALANCE_INTERVAL_MS),
            min_move: Duration::from_millis(rm::ACCOUNT_MOVE_MIN_INTERVAL_MS),
            legacy_ttl: Duration::from_millis(rm::LEGACY_TTL_MS),
            legacy_wait: Duration::from_millis(rm::LEGACY_ATTACH_WAIT_MS),
            query_timeout: Duration::from_millis(rm::MESH_QUERY_TIMEOUT_MS),
            bridge: BridgeTimings::default(),
            peer_urls: HashMap::new(),
            capacity: 10_000,
            colocate_every: Duration::from_millis(rm::MOVE_COLOCATE_MIN_MS),
        }
    }
}

/// What the mesh reads from outside the process.
pub struct MeshParts {
    pub feed: Arc<dyn FeedFetch>,
    pub decrypt: Arc<dyn FeedDecrypt>,
    pub ca: Arc<dyn CaKeySource>,
    pub issuer: Arc<dyn BlessingIssuer>,
}

impl std::fmt::Debug for MeshParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MeshParts").finish_non_exhaustive()
    }
}

/// This relay's own blessing: the RelayBlessing, its JSON as `.com` wrote it, and the v1 ServiceBlessing for old boxes.
#[derive(Debug, Clone)]
pub(crate) struct Own {
    pub blessing: RelayBlessing,
    pub raw: Value,
    pub service: Option<Value>,
}

/// One box tunnel on this relay, as the mesh sees it.
#[derive(Debug, Clone)]
pub(crate) struct LocalBox {
    pub tunnel: Arc<Tunnel>,
    pub box_pub: String,
    pub mesh_v1: bool,
    /// When the HELLO_ACK went out (the legacy attachment's `attachedAt`).
    pub registered_at: u64,
    /// The box signed an attachment that this relay accepted.
    pub attached: bool,
    /// When this relay last minted a legacy attachment for it, and that attachment's `issuedAt`.
    pub legacy_at: Option<u64>,
    pub last_hint_at: Option<u64>,
}

/// An account move this relay accepted (§10.3).
#[derive(Debug, Clone)]
pub(crate) struct AcceptedMove {
    pub to: String,
    pub not_after: u64,
    pub accepted_at: u64,
    pub json: Value,
}

pub(crate) struct State {
    pub log: RelayLogState,
    /// The newest verified head seen (feed or peers) and its signature.
    pub newest_head: Option<(RelayLogHead, String)>,
    /// The newest head this relay has applied the log up to (the contact clock).
    pub applied_head: Option<RelayLogHead>,
    /// The last entries applied, for `log` pushes and `log-since` answers.
    pub recent: VecDeque<(RelayLogEntry, String)>,
    pub directory: Option<RelayDirectory>,
    pub directory_raw: Option<Value>,
    pub directory_checked_at: u64,
    /// Verified RelayBlessings by relay id (directory.json, handshakes): the held copy a restarted peer is let in with.
    pub blessings: HashMap<String, (RelayBlessing, Value)>,
    pub own: Option<Own>,
    pub store: Store,
    /// accountHash → the move this relay accepted.
    pub moves: HashMap<String, AcceptedMove>,
    pub local: HashMap<String, LocalBox>,
    /// Mailbox ids announced by peers' boxes: id → (relayId, epoch).
    pub remote_mailboxes: HashMap<String, (String, u64)>,
    /// Mailbox announcements of this relay's boxes, by mailbox id (part of the dump to a new peer).
    pub local_mail: HashMap<String, wire::WireItem>,
    pub draining: bool,
    /// Fresh at the last contact check (a return to fresh re-decides every box, §4.6 "Recovery").
    pub was_fresh: bool,
}

/// The relay's parts the mesh acts on.
pub struct Hooks {
    pub registry: SharedRegistry,
    pub gate: Option<ServingGate>,
    pub phone: Option<PhoneRoutes>,
    pub router: Router,
    pub mailboxes: Option<Arc<crate::mailbox::MailboxRegistry>>,
}

impl std::fmt::Debug for Hooks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hooks").finish_non_exhaustive()
    }
}

/// Counters for `/api/stats` `mesh`.
#[derive(Debug, Default)]
pub struct MeshStats {
    pub feed_polls: AtomicU64,
    pub feed_errors: AtomicU64,
    pub bad_entries: AtomicU64,
    pub forwarded: AtomicU64,
    pub forward_refused: AtomicU64,
    pub queries_sent: AtomicU64,
    pub query_hits: AtomicU64,
    pub negative_hits: AtomicU64,
    pub moves_sent: AtomicU64,
    pub hints_sent: AtomicU64,
}

pub(crate) struct Inner {
    pub cfg: MeshConfig,
    pub key: SigningKey,
    pub relay_pub: String,
    pub parts: MeshParts,
    pub st: Mutex<State>,
    pub peers: Mutex<HashMap<String, Arc<bridge::Peer>>>,
    pub hooks: OnceLock<Hooks>,
    pub stats: MeshStats,
    pub queries: query::Queries,
    pub ledger: Mutex<phone_ledger::Ledger>,
    pub traffic: Mutex<rebalance::Traffic>,
    pub tasks: Mutex<Vec<tokio::task::AbortHandle>>,
    pub dialers: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    pub banned: Mutex<HashMap<String, u64>>,
    pub outbox: Mutex<bridge::Outbox>,
    pub log: Box<dyn Fn(&str) + Send + Sync>,
}

/// The mesh of one relay process. Cheap to clone.
#[derive(Clone)]
pub struct Mesh(pub(crate) Arc<Inner>);

impl std::fmt::Debug for Mesh {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Mesh")
            .field("relay", &self.0.cfg.relay_id)
            .finish_non_exhaustive()
    }
}

/// How a name routes (§7.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NameClass {
    /// `<server>.<user>`, `<x>.<server>.<user>`: key = the pod name.
    Box(String),
    /// `<app>.<user>`: key = the account.
    Account(String),
    /// `<user>.<apex>`: the phone.
    Bare(String),
    /// Anything else (not under the apex, `<relayId>.tunnel.<apex>`): local only, as today.
    Other,
}

/// The entry relay's decision for a visitor (§7.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Route from this relay's registry, as today (holder duties).
    Local,
    /// Open a bridged stream to this holder; `key` is the pod name a `not-holder` refusal re-queries.
    Forward { holder: String, key: Option<String> },
    /// Ask the peers for this pod name (the log says it exists), then route again.
    Query(String),
    /// Nobody holds it: close at the hold time.
    Drop,
}

pub(crate) fn now() -> u64 {
    now_ms() as u64
}

pub(crate) fn ms(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

impl Mesh {
    /// # Errors
    /// The apex, the relay id or the log key is malformed.
    pub fn new(
        cfg: MeshConfig,
        key: SigningKey,
        parts: MeshParts,
        log: Box<dyn Fn(&str) + Send + Sync>,
    ) -> Result<Self, String> {
        let log_state = RelayLogState::new(&cfg.apex).map_err(|e| e.to_string())?;
        if cfg.log_key.len() != 64 || !cfg.log_key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("the relay log key must be 64 hex".into());
        }
        if !rm::is_relay_id(&cfg.relay_id) {
            return Err(format!("{:?} is not a relay id", cfg.relay_id));
        }
        let relay_pub = flagship_crypto::trust::hex(key.verifying_key().as_bytes());
        let store = Store::new(&cfg.relay_id, &cfg.apex, attachments::Caps::default());
        Ok(Self(Arc::new(Inner {
            st: Mutex::new(State {
                log: log_state,
                newest_head: None,
                applied_head: None,
                recent: VecDeque::new(),
                directory: None,
                directory_raw: None,
                directory_checked_at: 0,
                blessings: HashMap::new(),
                own: None,
                store,
                moves: HashMap::new(),
                local: HashMap::new(),
                remote_mailboxes: HashMap::new(),
                local_mail: HashMap::new(),
                draining: false,
                was_fresh: false,
            }),
            queries: query::Queries::default(),
            ledger: Mutex::new(phone_ledger::Ledger::default()),
            traffic: Mutex::new(rebalance::Traffic::default()),
            peers: Mutex::new(HashMap::new()),
            hooks: OnceLock::new(),
            stats: MeshStats::default(),
            tasks: Mutex::new(Vec::new()),
            dialers: Mutex::new(HashMap::new()),
            banned: Mutex::new(HashMap::new()),
            outbox: Mutex::new(bridge::Outbox::default()),
            relay_pub,
            key,
            parts,
            cfg,
            log,
        })))
    }

    #[must_use]
    pub fn relay_id(&self) -> &str {
        &self.0.cfg.relay_id
    }

    #[must_use]
    pub fn relay_pub(&self) -> &str {
        &self.0.relay_pub
    }

    #[must_use]
    pub fn config(&self) -> &MeshConfig {
        &self.0.cfg
    }

    #[must_use]
    pub fn counters(&self) -> &MeshStats {
        &self.0.stats
    }

    #[must_use]
    pub fn is_full(&self) -> bool {
        self.0.cfg.kind == RelayKind::Full
    }

    pub(crate) fn log(&self, line: &str) {
        (self.0.log)(&format!("[mesh {}] {line}", self.0.cfg.relay_id));
    }

    pub(crate) fn hooks(&self) -> Option<&Hooks> {
        self.0.hooks.get()
    }

    /// Wire the relay's parts in (once, before [`Mesh::spawn`]).
    pub fn attach_hooks(&self, hooks: Hooks) {
        let _ = self.0.hooks.set(hooks);
    }

    pub(crate) fn with_state<T>(&self, f: impl FnOnce(&mut State) -> T) -> Option<T> {
        self.0.st.lock().ok().map(|mut s| f(&mut s))
    }

    /// Run `f` with chunk A's check context (apex, log, directory, now) and the store.
    pub(crate) fn with_ctx<T>(
        &self,
        f: impl FnOnce(&MeshCheckContext<'_>, &mut Store) -> T,
    ) -> Option<T> {
        let mut st = self.0.st.lock().ok()?;
        let State {
            log,
            directory,
            store,
            ..
        } = &mut *st;
        let ctx = MeshCheckContext {
            services_apex: &self.0.cfg.apex,
            log,
            directory: directory.as_ref().map(|d| &d.body),
            now: now(),
        };
        Some(f(&ctx, store))
    }

    pub(crate) fn ca_keys(&self) -> Vec<String> {
        self.0.parts.ca.keys(now())
    }

    /// Start every background task: the feed, the blessing, the dialers, the announcer, legacy, homes, rebalancing.
    pub fn spawn(&self) {
        let mut handles = vec![
            self.spawn_feed(),
            self.spawn_blessing(),
            self.spawn_dialers(),
            self.spawn_announcer(),
            self.spawn_legacy(),
            self.spawn_homes(),
            self.spawn_rebalance(),
        ];
        if let Ok(mut t) = self.0.tasks.lock() {
            t.append(&mut handles);
        }
    }

    /// Stop every task and close every bridge.
    pub fn shutdown(&self) {
        if let Ok(mut t) = self.0.tasks.lock() {
            for h in t.drain(..) {
                h.abort();
            }
        }
        if let Ok(mut d) = self.0.dialers.lock() {
            for (_, h) in d.drain() {
                h.abort();
            }
        }
        for p in self.live_peers() {
            p.close(1001, "shutdown");
        }
    }

    // ── names ─────────────────────────────────────────────────────────────

    /// §7.1. A two-label name is a box when the log registers it (or a box holds it here), else an account-level name.
    #[must_use]
    pub fn classify(&self, sni: &str) -> NameClass {
        let lower = sni.to_ascii_lowercase();
        let apex = self.0.cfg.apex.clone();
        let Some(head) = lower
            .strip_suffix(apex.as_str())
            .and_then(|h| h.strip_suffix('.'))
        else {
            return NameClass::Other;
        };
        if lower.contains('*') {
            return NameClass::Other;
        }
        let labels: Vec<&str> = head.split('.').collect();
        if labels.last() == Some(&"tunnel") {
            return NameClass::Other;
        }
        match labels.len() {
            1 if is_bare_phone_name(&lower, &apex) => NameClass::Bare(lower),
            2 if is_pod_name(&lower, &apex) => {
                let known = self
                    .with_state(|s| {
                        rm::relay_log_box(&s.log, &lower).is_some()
                            || s.local.contains_key(&lower)
                            || !s.store.box_items(&lower).is_empty()
                    })
                    .unwrap_or(false);
                if known {
                    NameClass::Box(lower)
                } else {
                    labels
                        .get(1)
                        .map_or(NameClass::Other, |u| NameClass::Account((*u).to_owned()))
                }
            }
            n if n >= 3 => {
                let tail = labels
                    .get(n.saturating_sub(2)..)
                    .unwrap_or_default()
                    .join(".");
                let pod = format!("{tail}.{apex}");
                if is_pod_name(&pod, &apex) {
                    NameClass::Box(pod)
                } else {
                    NameClass::Other
                }
            }
            _ => NameClass::Other,
        }
    }

    /// Fresh (§4.6): the newest verified head is applied and younger than `HEAD_FRESH_MS`.
    #[must_use]
    pub fn fresh(&self) -> bool {
        let refuse = ms(self.0.cfg.refuse_new_after);
        self.with_state(|s| {
            s.newest_head.as_ref().is_some_and(|(h, _)| {
                h.issued_at >= now().saturating_sub(refuse)
                    && rm::relay_log_head_status(&s.log, h) == "applied"
            })
        })
        .unwrap_or(false)
    }

    fn registry_has(&self, pod: &str) -> bool {
        self.hooks()
            .and_then(|h| h.registry.lock().ok().map(|r| r.is_current(pod, |_| true)))
            .unwrap_or(false)
    }

    /// The entry relay's decision (§7.2 steps 1–3; the query and the forward happen in the router).
    #[must_use]
    pub fn route(&self, sni: &str) -> Route {
        let me = self.relay_id().to_owned();
        let t = now();
        match self.classify(sni) {
            NameClass::Other => Route::Local,
            NameClass::Box(pod) => {
                let (winner, known) = self
                    .with_state(|s| {
                        let w = s
                            .store
                            .winner(&pod, t)
                            .map(|w| w.attachment.relay_id.clone());
                        let known = rm::relay_log_box(&s.log, &pod).is_some_and(|b| {
                            s.log.revoked_boxes.get(&b.box_pub).copied().unwrap_or(0) < b.reg_gen
                        });
                        (w, known)
                    })
                    .unwrap_or((None, false));
                match winner {
                    Some(r) if r == me => Route::Local,
                    Some(r) => Route::Forward {
                        holder: r,
                        key: Some(pod),
                    },
                    None if self.registry_has(&pod) => Route::Local,
                    None if known => Route::Query(pod),
                    None => Route::Drop,
                }
            }
            NameClass::Account(account) => match self.account_home(&account) {
                Some(h) if h == me => Route::Local,
                Some(h) => Route::Forward {
                    holder: h,
                    key: None,
                },
                None => Route::Local,
            },
            NameClass::Bare(host) => {
                let w = self
                    .with_state(|s| {
                        s.store
                            .phone_winner(&host, t)
                            .map(|p| p.grant.holder_relay_id.clone())
                    })
                    .flatten();
                match w {
                    Some(r) if r == me => Route::Local,
                    Some(r) => Route::Forward {
                        holder: r,
                        key: None,
                    },
                    None => Route::Local,
                }
            }
        }
    }

    /// The holder's admission of a bridged OPEN (§6.4, §7.4): `Ok` to route it locally, else the refusal code.
    ///
    /// # Errors
    /// `stale`, `not-holder` or `apps-off`.
    pub fn holder_admits(&self, sni: &str) -> Result<(), &'static str> {
        let me = self.relay_id().to_owned();
        let t = now();
        let Some(h) = self.hooks() else {
            return Err("not-holder");
        };
        let class = self.classify(sni);
        if !self.fresh() {
            // Stale: only a box here that is exempt (a decision with no end, §4.6 as amended).
            let exempt = match &class {
                NameClass::Box(pod) => {
                    let local = self
                        .with_state(|s| s.local.get(pod).map(|b| b.box_pub.clone()))
                        .flatten();
                    let user = rm::account_of_pod_name(pod, &self.0.cfg.apex);
                    match (local, user, &h.gate) {
                        (Some(b), Some(u), Some(g)) => g.exempt(u, &b),
                        _ => false,
                    }
                }
                _ => false,
            };
            if !exempt {
                return Err("stale");
            }
        }
        let ours = match &class {
            NameClass::Other => false,
            NameClass::Box(pod) => match self
                .with_state(|s| {
                    s.store
                        .winner(pod, t)
                        .map(|w| w.attachment.relay_id.clone())
                })
                .flatten()
            {
                Some(r) => r == me,
                None => self.registry_has(pod),
            },
            NameClass::Account(a) => match self.account_home(a) {
                Some(home) => home == me,
                None => h
                    .registry
                    .lock()
                    .is_ok_and(|r| r.has_online_tunnels_for_user(a)),
            },
            NameClass::Bare(host) => match self
                .with_state(|s| {
                    s.store
                        .phone_winner(host, t)
                        .map(|p| p.grant.holder_relay_id.clone())
                })
                .flatten()
            {
                Some(r) => r == me,
                None => h
                    .phone
                    .as_ref()
                    .is_some_and(|p| p.tunnel_for(host).is_some()),
            },
        };
        if !ours {
            return Err("not-holder");
        }
        let Ok(reg) = h.registry.lock() else {
            return Err("not-holder");
        };
        if reg.find_by_sni(sni).is_some() {
            return Ok(());
        }
        match &class {
            NameClass::Account(_) if reg.is_nudgeable_sni(sni) => Ok(()),
            NameClass::Box(pod) => match reg.serving_of(pod) {
                Some(v) if !v.apps => Err("apps-off"),
                _ => Err("not-holder"),
            },
            _ => Err("not-holder"),
        }
    }

    /// `/api/health` (§2): a valid blessing, listed in the current directory under this key, fresh, not draining, bridges
    /// to at least half of the other relays, and a directory not expired for more than a day.
    #[must_use]
    pub fn ready(&self) -> (bool, &'static str) {
        let t = now();
        let me = self.relay_id().to_owned();
        let (blessed, listed, draining, expired_long, others) = self
            .with_state(|s| {
                let blessed = s
                    .own
                    .as_ref()
                    .is_some_and(|o| o.blessing.body.expires_at > t);
                let dir = s.directory.as_ref().map(|d| &d.body);
                let listed = rm::directory_relay(dir, &me)
                    .is_some_and(|e| e.relay_key == self.0.relay_pub)
                    && !s.log.revoked_relays.contains_key(&me);
                let expired_long = dir.is_some_and(|d| {
                    t >= d
                        .expires_at
                        .saturating_add(rm::DIRECTORY_EXPIRED_UNHEALTHY_MS)
                });
                let others: Vec<String> = dir
                    .map(|d| {
                        d.relays
                            .iter()
                            .filter(|r| {
                                r.relay_id != me && !s.log.revoked_relays.contains_key(&r.relay_id)
                            })
                            .map(|r| r.relay_id.clone())
                            .collect()
                    })
                    .unwrap_or_default();
                (blessed, listed, s.draining, expired_long, others)
            })
            .unwrap_or_default();
        if !blessed {
            return (false, "no-blessing");
        }
        if !listed {
            return (false, "not-in-directory");
        }
        if expired_long {
            return (false, "directory-expired");
        }
        if !self.fresh() {
            return (false, "stale");
        }
        if draining {
            return (false, "draining");
        }
        let up = others.iter().filter(|r| self.peer(r).is_some()).count();
        if up.saturating_mul(2) < others.len() {
            return (false, "bridges");
        }
        (true, "ready")
    }

    pub(crate) fn peer(&self, relay_id: &str) -> Option<Arc<bridge::Peer>> {
        let p = self.0.peers.lock().ok()?.get(relay_id).cloned()?;
        (!p.is_closed()).then_some(p)
    }

    pub(crate) fn live_peers(&self) -> Vec<Arc<bridge::Peer>> {
        self.0
            .peers
            .lock()
            .map(|p| p.values().filter(|x| !x.is_closed()).cloned().collect())
            .unwrap_or_default()
    }

    /// The bridges that are up, by relay id (tests and ops).
    #[must_use]
    pub fn peer_ids(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .live_peers()
            .iter()
            .filter(|p| p.is_synced())
            .map(|p| p.relay_id.clone())
            .collect();
        v.sort();
        v
    }

    /// The `/api/stats` `mesh` block (§14.3).
    #[must_use]
    pub fn stats_json(&self) -> Value {
        let t = now();
        let (ready, why) = self.ready();
        let s = &self.0.stats;
        let n = |c: &AtomicU64| c.load(Ordering::Relaxed);
        let st = self
            .with_state(|st| {
                serde_json::json!({
                    "sequence": st.log.sequence,
                    "headAgeMs": st.newest_head.as_ref().map(|(h, _)| t.saturating_sub(h.issued_at)),
                    "directoryVersion": st.directory.as_ref().map(|d| d.body.directory_version),
                    "boxItems": st.store.box_count(),
                    "phoneItems": st.store.phone_count(),
                    "perRelay": st.store.per_relay(),
                    "localBoxes": st.local.len(),
                    "accountMoves": st.moves.len(),
                    "draining": st.draining,
                })
            })
            .unwrap_or(Value::Null);
        let peers: Vec<Value> = self.live_peers().iter().map(|p| p.stats_json()).collect();
        serde_json::json!({
            "relayId": self.relay_id(), "kind": self.0.cfg.kind.as_str(), "ready": ready, "readiness": why,
            "fresh": self.fresh(), "state": st, "peers": peers,
            "counters": {
                "feedPolls": n(&s.feed_polls), "feedErrors": n(&s.feed_errors), "badEntries": n(&s.bad_entries),
                "forwarded": n(&s.forwarded), "forwardRefused": n(&s.forward_refused), "queriesSent": n(&s.queries_sent),
                "queryHits": n(&s.query_hits), "negativeHits": n(&s.negative_hits), "movesSent": n(&s.moves_sent),
                "hintsSent": n(&s.hints_sent),
            },
        })
    }

    /// The winning attachment for a pod: its relay and whether it is box-signed.
    #[must_use]
    pub fn winner_of(&self, pod: &str) -> Option<(String, bool)> {
        let t = now();
        self.with_state(|s| {
            s.store.winner(pod, t).map(|w| {
                (
                    w.attachment.relay_id.clone(),
                    w.kind == rm::AttachmentKind::Box,
                )
            })
        })
        .flatten()
    }

    /// The winning phone item's holder for a bare hostname.
    #[must_use]
    pub fn phone_holder(&self, host: &str) -> Option<String> {
        let t = now();
        self.with_state(|s| {
            s.store
                .phone_winner(host, t)
                .map(|p| p.grant.holder_relay_id.clone())
        })
        .flatten()
    }
}

//! The phone's bare `<account>.<apex>` route (plan H3; `docs/architecture-v2/phone-route.md`), the Rust twin of
//! `apps/web/src/tunnel/phoneRoute.ts` and `phoneTunnel.ts`, rules from `packages/protocol/src/phoneRoute.ts`.
//!
//! A phone holds `/phone-tunnel` while the app is in the foreground. It begins (gets a session nonce and the ledger's
//! next generation), signs a `route-claim/v1`, and the relay checks it, checks the key is an admin-root-granted
//! `admin` device of the account (`.com`'s eligibility, verified here), and asks `.com`'s ledger to commit the
//! generation, which it does only while the route is vacant. A refused eligible phone waits as a standby and gets
//! `route-vacant` when the holder's tunnel drops, it releases (`route-release/v1`) or its lease lapses (the feed's
//! `phone-route` push, with a 15 s ledger re-read as the backstop). A revoked grant closes the phone's tunnel with 4403
//! and its streams at once. The bare name routes only to the holding session while its lease is confirmed, never to a
//! box. Text messages are JSON control; binary messages carry exactly one v1 frame.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use flagship_access::rank::{GrantView, device_grant_canonical};
use flagship_crypto::entitlements::verify;
use flagship_crypto::serving::{RouteClaim, route_claim_canonical, verify_canonical};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use crate::authority::BoxFut;
use crate::frame::{Decoded, FRAME_CLOSE, FRAME_CLOSE_REMOTE, FRAME_DATA, decode_frame};
use crate::hub::{HubConfig, Tunnel, now_ms};

pub const PHONE_TUNNEL_PATH: &str = "/phone-tunnel";
pub const LEASE_MS: u64 = 60_000;
pub const CLAIM_SKEW_MS: u64 = 60_000;
pub const CHALLENGE_TTL_MS: u64 = 30_000;
const MAX_CONTROL_BYTES: usize = 16 * 1024;
const MAX_CONTROL_PER_MINUTE: u32 = 30;
const TAG_ROUTE_CLAIM: &str = "flagship/route-claim/v1";
const TAG_ROUTE_RELEASE: &str = "flagship/route-release/v1";

#[derive(Debug, Clone, Copy)]
pub struct PhoneConfig {
    pub renew: Duration,
    pub confirmed: Duration,
    pub recheck: Duration,
    pub standby_poll: Duration,
    pub ping: Duration,
    pub silence: Duration,
    /// Visitor streams one phone may have open at once.
    pub max_streams: usize,
}

impl Default for PhoneConfig {
    fn default() -> Self {
        Self {
            renew: Duration::from_secs(15),
            confirmed: Duration::from_secs(30),
            recheck: Duration::from_secs(30),
            standby_poll: Duration::from_secs(15),
            ping: Duration::from_secs(15),
            silence: Duration::from_secs(45),
            max_streams: 64,
        }
    }
}

fn is_account(a: &str) -> bool {
    let b = a.as_bytes();
    let alnum = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty()
        && b.len() <= 63
        && b.first().is_some_and(alnum)
        && b.last().is_some_and(alnum)
        && b.iter().all(|c| alnum(c) || *c == b'-')
}

fn lower_hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `phoneHostname`.
#[must_use]
pub fn phone_hostname(account: &str, apex: &str) -> String {
    format!("{}.{}", account.to_lowercase(), apex.to_lowercase())
}

fn claim_of(v: &Value) -> Option<RouteClaim> {
    let s = |k: &str| v.get(k)?.as_str().map(str::to_owned);
    Some(RouteClaim {
        account: s("account")?,
        phone_route_pub: s("phoneRoutePub")?,
        hostname: s("hostname")?,
        generation: v.get("generation")?.as_u64()?,
        session_nonce: s("sessionNonce")?,
        issued_at: v.get("issuedAt")?.as_u64()?,
    })
}

fn within_skew(issued_at: u64, now: u64) -> bool {
    issued_at.abs_diff(now) <= CLAIM_SKEW_MS
}

/// `checkRouteClaim`: the refusal code, or `Ok`.
pub fn check_route_claim(
    claim: &Value,
    signature: &str,
    apex: &str,
    account: &str,
    session_nonce: &str,
    generation: u64,
    now: u64,
) -> Result<RouteClaim, &'static str> {
    let c = claim_of(claim).ok_or("malformed")?;
    let canonical = route_claim_canonical(&c);
    if canonical.is_err() {
        return Err("malformed");
    }
    if c.account != account {
        return Err("wrong-account");
    }
    if c.hostname != phone_hostname(account, apex) {
        return Err("wrong-hostname");
    }
    if !lower_hex(session_nonce, 32) || c.session_nonce != session_nonce {
        return Err("wrong-session");
    }
    if c.generation != generation {
        return Err("wrong-generation");
    }
    if !within_skew(c.issued_at, now) {
        return Err("stale");
    }
    if !verify_canonical(&canonical, signature, &c.phone_route_pub) {
        return Err("bad-signature");
    }
    Ok(c)
}

/// `canonicalRouteRelease`: the claim's fields under the release tag.
#[must_use]
pub fn route_release_canonical(r: &RouteClaim) -> Option<String> {
    let c = route_claim_canonical(r).ok()?;
    Some(format!(
        "{TAG_ROUTE_RELEASE}{}",
        c.strip_prefix(TAG_ROUTE_CLAIM)?
    ))
}

/// What a session holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    pub account: String,
    pub hostname: String,
    pub generation: u64,
    pub phone_route_pub: String,
    pub session_nonce: String,
    pub confirmed_at: u64,
}

/// `checkRouteRelease`.
pub fn check_route_release(
    release: &Value,
    signature: &str,
    held: &Held,
    now: u64,
) -> Result<(), &'static str> {
    let r = claim_of(release).ok_or("malformed")?;
    let canonical = route_release_canonical(&r).ok_or("malformed")?;
    if r.account != held.account
        || r.hostname != held.hostname
        || r.phone_route_pub != held.phone_route_pub
    {
        return Err("not-holder");
    }
    if r.generation != held.generation {
        return Err("wrong-generation");
    }
    if r.session_nonce != held.session_nonce {
        return Err("wrong-session");
    }
    if !within_skew(r.issued_at, now) {
        return Err("stale");
    }
    if lower_hex(signature, 128) && verify(&canonical, signature, &r.phone_route_pub) {
        Ok(())
    } else {
        Err("bad-signature")
    }
}

// ── eligibility ──────────────────────────────────────────────────────────

/// `.com`'s eligibility answer.
#[derive(Debug, Clone, Default)]
pub struct Eligibility {
    pub admin_root: Option<String>,
    pub grants: Vec<GrantView>,
}

/// `parsePhoneEligibility`.
#[must_use]
pub fn parse_eligibility(body: &Value) -> Option<Eligibility> {
    let o = body.as_object()?;
    let admin_root = o
        .get("adminRootPub")
        .and_then(Value::as_str)
        .filter(|k| lower_hex(k, 64))
        .map(str::to_owned);
    let mut grants = Vec::new();
    for g in o
        .get("grants")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let s = |k: &str| g.get(k).and_then(Value::as_str).map(str::to_owned);
        let (
            Some(grant_id),
            Some(username),
            Some(device_id),
            Some(device_pub_hex),
            Some(scopes),
            Some(issued_at),
            Some(expires_at),
            Some(signature_hex),
        ) = (
            s("grantId"),
            s("username"),
            s("deviceId"),
            s("devicePubHex").filter(|k| lower_hex(k, 64)),
            g.get("scopes").and_then(Value::as_array),
            g.get("issuedAt").and_then(Value::as_u64),
            g.get("expiresAt").and_then(Value::as_u64),
            s("signatureHex").filter(|h| {
                h.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            }),
        )
        else {
            continue;
        };
        grants.push(GrantView {
            grant_id,
            username,
            device_id,
            device_pub_hex,
            scopes: scopes
                .iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect(),
            issued_at,
            expires_at,
            signature_hex,
            signer_root: if g.get("signerRoot").and_then(Value::as_str) == Some("admin-root") {
                "admin-root".into()
            } else {
                "membership".into()
            },
            revoked: g.get("revokedAt").is_some_and(Value::is_number),
        });
    }
    Some(Eligibility { admin_root, grants })
}

/// `phoneRouteEligibility` (with `requireMasterAdmin`): the grant's expiry when `pub_hex` may claim the bare name.
pub fn eligible(
    pub_hex: &str,
    account: &str,
    e: &Eligibility,
    now: u64,
) -> Result<u64, &'static str> {
    let key = pub_hex.to_ascii_lowercase();
    if !lower_hex(&key, 64) {
        return Err("bad key");
    }
    let root = e
        .admin_root
        .as_deref()
        .ok_or("no admin root")?
        .to_ascii_lowercase();
    if key == root {
        return Err("the admin root is not a phone key");
    }
    let g = e
        .grants
        .iter()
        .find(|g| g.device_pub_hex.to_ascii_lowercase() == key && !g.revoked)
        .ok_or("no active admin grant")?;
    if g.username.to_lowercase() != account.to_lowercase() {
        return Err("username mismatch");
    }
    if now >= g.expires_at {
        return Err("grant expired");
    }
    if g.signer_root != "admin-root" {
        return Err("grant not admin-root-signed");
    }
    if !g.scopes.iter().any(|s| s == "admin") {
        return Err("missing admin scope");
    }
    if !device_grant_canonical(g)
        .is_some_and(|c| verify(&c, &g.signature_hex.to_ascii_lowercase(), &root))
    {
        return Err("grant signature failed verification");
    }
    Ok(g.expires_at)
}

// ── `.com` ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holder {
    pub relay_id: String,
    pub session_id: String,
    pub phone_route_pub: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub generation: u64,
    pub holder: Option<Holder>,
    pub lease_until: u64,
}

#[derive(Debug, Clone)]
pub enum LedgerOp {
    Acquire {
        hostname: String,
        generation: u64,
        holder: Holder,
    },
    Renew {
        hostname: String,
        generation: u64,
        session_id: String,
    },
    Release {
        hostname: String,
        generation: u64,
        session_id: String,
    },
}

impl LedgerOp {
    fn to_json(&self) -> Value {
        match self {
            Self::Acquire {
                hostname,
                generation,
                holder,
            } => json!({"op": "acquire", "hostname": hostname, "generation": generation,
                "holder": {"relayId": holder.relay_id, "sessionId": holder.session_id, "phoneRoutePub": holder.phone_route_pub}}),
            Self::Renew {
                hostname,
                generation,
                session_id,
            } => {
                json!({"op": "renew", "hostname": hostname, "generation": generation, "sessionId": session_id})
            }
            Self::Release {
                hostname,
                generation,
                session_id,
            } => {
                json!({"op": "release", "hostname": hostname, "generation": generation, "sessionId": session_id})
            }
        }
    }
}

#[derive(Debug, Clone)]
pub enum LedgerResult {
    Ok(Entry),
    Refused(&'static str, Entry),
}

/// Every `.com` call the phone route makes; `None` from any of them: `.com` could not be asked.
pub trait PhoneCom: Send + Sync + 'static {
    fn read<'a>(&'a self, hostname: &'a str) -> BoxFut<'a, Option<Entry>>;
    fn apply<'a>(&'a self, op: LedgerOp) -> BoxFut<'a, Option<LedgerResult>>;
    fn eligibility<'a>(&'a self, account: &'a str) -> BoxFut<'a, Option<Eligibility>>;
}

fn parse_entry(v: &Value) -> Option<Entry> {
    let holder = v.get("holder").and_then(|h| {
        Some(Holder {
            relay_id: h.get("relayId")?.as_str()?.to_owned(),
            session_id: h.get("sessionId")?.as_str()?.to_owned(),
            phone_route_pub: h.get("phoneRoutePub")?.as_str()?.to_owned(),
        })
    });
    Some(Entry {
        generation: v.get("generation")?.as_u64()?,
        holder,
        lease_until: v.get("leaseUntil")?.as_f64()? as u64,
    })
}

/// `.com` over HTTPS with the services control secret (`/api/internal/phone-route/...`).
pub struct ComPhone {
    base: String,
    secret: String,
    agent: ureq::Agent,
}

impl std::fmt::Debug for ComPhone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ComPhone")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

impl ComPhone {
    #[must_use]
    pub fn new(com_base_url: &str, secret: &str) -> Arc<Self> {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(5)))
            .max_redirects(0)
            .proxy(None)
            .http_status_as_error(false)
            .build();
        Arc::new(Self {
            base: com_base_url.trim_end_matches('/').to_owned(),
            secret: secret.to_owned(),
            agent: ureq::Agent::new_with_config(config),
        })
    }

    fn call(&self, path: &str, body: Option<&Value>) -> Option<(u16, Value)> {
        let url = format!("{}{path}", self.base);
        let auth = format!("Bearer {}", self.secret);
        let mut resp = match body {
            None => self
                .agent
                .get(&url)
                .header("authorization", &auth)
                .call()
                .ok()?,
            Some(b) => self
                .agent
                .post(&url)
                .header("authorization", &auth)
                .header("content-type", "application/json")
                .send(b.to_string())
                .ok()?,
        };
        let status = resp.status().as_u16();
        let text = resp
            .body_mut()
            .with_config()
            .limit(1 << 20)
            .read_to_string()
            .ok()?;
        Some((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
    }

    async fn blocking<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(&Self) -> Option<T> + Send + 'static,
    ) -> Option<T> {
        let me = Arc::clone(self);
        tokio::task::spawn_blocking(move || f(&me))
            .await
            .ok()
            .flatten()
    }
}

impl PhoneCom for Arc<ComPhone> {
    fn read<'a>(&'a self, hostname: &'a str) -> BoxFut<'a, Option<Entry>> {
        let path = format!(
            "/api/internal/phone-route/ledger?hostname={}",
            crate::com::segment(hostname)
        );
        Box::pin(self.blocking(move |c| {
            let (s, b) = c.call(&path, None)?;
            if s != 200 {
                return None;
            }
            parse_entry(b.get("entry")?)
        }))
    }

    fn apply<'a>(&'a self, op: LedgerOp) -> BoxFut<'a, Option<LedgerResult>> {
        let body = op.to_json();
        Box::pin(self.blocking(move |c| {
            let (s, b) = c.call("/api/internal/phone-route/ledger", Some(&body))?;
            if s != 200 {
                return None;
            }
            let entry = parse_entry(b.get("entry")?)?;
            if b.get("ok") == Some(&Value::Bool(true)) {
                return Some(LedgerResult::Ok(entry));
            }
            let code = match b.get("code").and_then(Value::as_str)? {
                "route-held" => "route-held",
                "stale-generation" => "stale-generation",
                "not-holder" => "not-holder",
                "expired" => "expired",
                "malformed" => "malformed",
                _ => return None,
            };
            Some(LedgerResult::Refused(code, entry))
        }))
    }

    fn eligibility<'a>(&'a self, account: &'a str) -> BoxFut<'a, Option<Eligibility>> {
        let path = format!(
            "/api/internal/phone-route/{}/eligibility",
            crate::com::segment(account)
        );
        Box::pin(self.blocking(move |c| {
            let (s, b) = c.call(&path, None)?;
            match s {
                404 => Some(Eligibility::default()),
                200 => parse_eligibility(&b),
                _ => None,
            }
        }))
    }
}

// ── sessions ─────────────────────────────────────────────────────────────

/// What a phone session's writer sends.
#[derive(Debug)]
pub enum PhoneOut {
    Text(String),
    Ping,
    Close(u16, String),
}

#[derive(Debug, Clone)]
struct Offer {
    account: String,
    hostname: String,
    nonce: String,
    generation: u64,
    expires_at: u64,
}

#[derive(Debug, Default)]
struct SessState {
    offer: Option<Offer>,
    held: Option<Held>,
    standby: Option<String>,
    eligible_until: u64,
    closed: bool,
    timers: Vec<tokio::task::AbortHandle>,
    /// Mesh mode: the admin grant chain the phone presented in `begin` (relay-mesh.md §8.2).
    grants: Option<Value>,
}

#[derive(Debug)]
pub struct PhoneSession {
    pub id: String,
    pub tunnel: Arc<Tunnel>,
    out: mpsc::UnboundedSender<PhoneOut>,
    st: Mutex<SessState>,
}

impl PhoneSession {
    fn send(&self, v: &Value) {
        if !self.st.lock().is_ok_and(|s| s.closed) {
            let _ = self.out.send(PhoneOut::Text(v.to_string()));
        }
    }

    fn held(&self) -> Option<Held> {
        self.st.lock().ok().and_then(|s| s.held.clone())
    }

    fn closed(&self) -> bool {
        self.st.lock().map_or(true, |s| s.closed)
    }

    fn clear_timers(&self) {
        if let Ok(mut s) = self.st.lock() {
            for t in s.timers.drain(..) {
                t.abort();
            }
        }
    }
}

struct Standby {
    sessions: Vec<Arc<PhoneSession>>,
    poll: tokio::task::AbortHandle,
    notified: u64,
}

#[derive(Default)]
struct RoutesState {
    sessions: HashMap<String, Arc<PhoneSession>>,
    holders: HashMap<String, Arc<PhoneSession>>,
    standbys: HashMap<String, Standby>,
    refused: BTreeMap<String, u64>,
    lost: BTreeMap<String, u64>,
}

/// Mesh mode: does the relay take new phone routes now?
pub type AcceptingFn = dyn Fn() -> bool + Send + Sync;

/// Mesh mode's eligibility (relay-mesh.md §8.2): the phone's own presented grants, judged under the log's admin root.
pub type PresentedEligibility = dyn Fn(&str, &Value) -> Option<Eligibility> + Send + Sync;

struct Inner {
    relay_id: String,
    apex: String,
    com: Arc<dyn PhoneCom>,
    presented: Option<Arc<PresentedEligibility>>,
    /// Mesh mode: false while the relay is stale (a `begin` then is refused and the tunnel closed 1013 `try-again`).
    accepting: std::sync::OnceLock<Arc<AcceptingFn>>,
    cfg: PhoneConfig,
    st: Mutex<RoutesState>,
    log: Box<dyn Fn(&str) + Send + Sync>,
}

/// The phone sessions on this relay and which one (if any) each account's bare name routes to.
#[derive(Clone)]
pub struct PhoneRoutes(Arc<Inner>);

impl std::fmt::Debug for PhoneRoutes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PhoneRoutes")
            .field("relay", &self.0.relay_id)
            .finish_non_exhaustive()
    }
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    let _ = getrandom::fill(&mut b);
    flagship_crypto::trust::hex(&b)
}

fn now() -> u64 {
    now_ms() as u64
}

impl PhoneRoutes {
    pub fn new(
        relay_id: &str,
        apex: &str,
        com: Arc<dyn PhoneCom>,
        cfg: PhoneConfig,
        log: Box<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        Self(Arc::new(Inner {
            relay_id: relay_id.to_owned(),
            apex: apex.to_lowercase(),
            com,
            presented: None,
            accepting: std::sync::OnceLock::new(),
            cfg,
            st: Mutex::new(RoutesState::default()),
            log,
        }))
    }

    /// Mesh mode (relay-mesh.md §8): the ledger is a relay's (`com`), and eligibility comes from the grants the phone
    /// presents in `begin`, judged by `presented` (a phone without them is refused `not-eligible`).
    pub fn new_mesh(
        relay_id: &str,
        apex: &str,
        com: Arc<dyn PhoneCom>,
        presented: Arc<PresentedEligibility>,
        cfg: PhoneConfig,
        log: Box<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        Self(Arc::new(Inner {
            relay_id: relay_id.to_owned(),
            apex: apex.to_lowercase(),
            com,
            presented: Some(presented),
            accepting: std::sync::OnceLock::new(),
            cfg,
            st: Mutex::new(RoutesState::default()),
            log,
        }))
    }

    #[must_use]
    pub fn relay_id(&self) -> &str {
        &self.0.relay_id
    }

    /// The account's eligibility: `.com`'s answer, or in mesh mode the session's presented grants.
    async fn eligibility_for(&self, s: &PhoneSession, account: &str) -> Option<Eligibility> {
        match &self.0.presented {
            Some(f) => {
                let grants = s.st.lock().ok().and_then(|x| x.grants.clone());
                Some(grants.and_then(|g| f(account, &g)).unwrap_or_default())
            }
            None => self.0.com.eligibility(account).await,
        }
    }

    /// Mesh mode: whether the relay takes new phone routes now (it is fresh).
    pub fn set_accepting(&self, f: Arc<AcceptingFn>) {
        let _ = self.0.accepting.set(f);
    }

    /// Close every phone tunnel (mesh mode past close-all: phones follow the strict rule, §4.6).
    pub fn close_all(&self, code: u16, reason: &str) {
        let all: Vec<Arc<PhoneSession>> = self
            .0
            .st
            .lock()
            .map(|st| st.sessions.values().cloned().collect())
            .unwrap_or_default();
        for s in all {
            let _ = s.out.send(PhoneOut::Close(code, reason.to_owned()));
        }
    }

    /// Re-check every held route now (a log entry revoked a grant or changed an account's authority).
    pub async fn recheck_all(&self) {
        let all: Vec<Arc<PhoneSession>> = self
            .0
            .st
            .lock()
            .map(|st| st.holders.values().cloned().collect())
            .unwrap_or_default();
        for s in all {
            self.recheck(&s).await;
        }
    }

    #[must_use]
    pub fn config(&self) -> PhoneConfig {
        self.0.cfg
    }

    pub fn attach(
        &self,
        tunnel: Arc<Tunnel>,
        out: mpsc::UnboundedSender<PhoneOut>,
    ) -> Arc<PhoneSession> {
        let s = Arc::new(PhoneSession {
            id: random_hex(16),
            tunnel,
            out,
            st: Mutex::new(SessState::default()),
        });
        if let Ok(mut st) = self.0.st.lock() {
            st.sessions.insert(s.id.clone(), Arc::clone(&s));
        }
        s
    }

    /// The phone tunnel closed: the route is vacant at once, its streams went with it.
    pub fn detach(&self, s: &Arc<PhoneSession>) {
        if let Ok(mut ss) = s.st.lock() {
            if ss.closed {
                return;
            }
            ss.closed = true;
        }
        s.clear_timers();
        let held = s.held();
        let was_holder = {
            let Ok(mut st) = self.0.st.lock() else { return };
            st.sessions.remove(&s.id);
            Self::leave_standby_locked(&mut st, s);
            match &held {
                Some(h)
                    if st
                        .holders
                        .get(&h.hostname)
                        .is_some_and(|x| Arc::ptr_eq(x, s)) =>
                {
                    st.holders.remove(&h.hostname);
                    true
                }
                _ => false,
            }
        };
        if let (true, Some(h)) = (was_holder, held) {
            let com = Arc::clone(&self.0.com);
            let op = LedgerOp::Release {
                hostname: h.hostname.clone(),
                generation: h.generation,
                session_id: s.id.clone(),
            };
            tokio::spawn(async move {
                let _ = com.apply(op).await;
            });
            self.notify_vacant(&h.hostname, h.generation);
        }
    }

    /// The SNI router's question for a bare name: the local session holding it, while its lease is confirmed, it is
    /// eligible and it has room for another stream.
    #[must_use]
    pub fn tunnel_for(&self, hostname: &str) -> Option<Arc<Tunnel>> {
        let s = self
            .0
            .st
            .lock()
            .ok()?
            .holders
            .get(&hostname.to_lowercase())
            .cloned()?;
        let ss = s.st.lock().ok()?;
        let h = ss.held.as_ref()?;
        let t = now();
        if ss.closed
            || t.saturating_sub(h.confirmed_at) >= self.0.cfg.confirmed.as_millis() as u64
            || ss.eligible_until <= t
        {
            return None;
        }
        drop(ss);
        (s.tunnel.stream_count() < self.0.cfg.max_streams).then(|| Arc::clone(&s.tunnel))
    }

    fn refuse(&self, s: &PhoneSession, code: &str, generation: Option<u64>) {
        if let Ok(mut st) = self.0.st.lock() {
            let c = st.refused.entry(code.to_owned()).or_default();
            *c = c.saturating_add(1);
        }
        let mut m = json!({"type": "refused", "code": code});
        if let (Some(g), Some(o)) = (generation, m.as_object_mut()) {
            o.insert("generation".into(), json!(g));
        }
        s.send(&m);
    }

    fn holds(&self, s: &Arc<PhoneSession>, hostname: &str) -> bool {
        self.0
            .st
            .lock()
            .is_ok_and(|st| st.holders.get(hostname).is_some_and(|x| Arc::ptr_eq(x, s)))
    }

    /// Step 1: the phone names its account; it gets a nonce for this session and the next generation.
    pub async fn begin(
        &self,
        s: &Arc<PhoneSession>,
        account: Option<&str>,
        grants: Option<&Value>,
    ) {
        let Some(account) = account.filter(|a| is_account(a)) else {
            return self.refuse(s, "malformed", None);
        };
        if self.0.accepting.get().is_some_and(|f| !f()) {
            self.refuse(s, "unavailable", None);
            let _ = s.out.send(PhoneOut::Close(1013, "try-again".into()));
            return;
        }
        if self.0.presented.is_some()
            && let Ok(mut ss) = s.st.lock()
        {
            ss.grants = grants.filter(|g| g.is_array()).cloned();
        }
        if let Some(h) = s.held()
            && self.holds(s, &h.hostname)
        {
            return self.refuse(s, "holding", Some(h.generation));
        }
        let hostname = phone_hostname(account, &self.0.apex);
        let entry = self.0.com.read(&hostname).await;
        if s.closed() {
            return;
        }
        let Some(entry) = entry else {
            return self.refuse(s, "unavailable", None);
        };
        let t = now();
        let offer = Offer {
            account: account.to_owned(),
            hostname: hostname.clone(),
            nonce: random_hex(16),
            generation: entry.generation.saturating_add(1),
            expires_at: t.saturating_add(CHALLENGE_TTL_MS),
        };
        let msg = json!({"type": "challenge", "account": account, "hostname": hostname, "generation": offer.generation,
            "sessionNonce": offer.nonce, "serverTime": t, "expiresAt": offer.expires_at});
        if let Ok(mut ss) = s.st.lock() {
            ss.offer = Some(offer);
        }
        s.send(&msg);
    }

    /// Step 2: the signed claim; committed in the ledger only while the route is vacant.
    pub async fn claim(
        &self,
        s: &Arc<PhoneSession>,
        claim: Option<&Value>,
        signature: Option<&str>,
    ) {
        let offer = s.st.lock().ok().and_then(|mut ss| ss.offer.take());
        let t = now();
        let Some(offer) = offer.filter(|o| o.expires_at > t) else {
            return self.refuse(s, "no-challenge", None);
        };
        let (Some(claim), Some(signature)) = (claim.filter(|c| c.is_object()), signature) else {
            return self.refuse(s, "malformed", None);
        };
        let c = match check_route_claim(
            claim,
            signature,
            &self.0.apex,
            &offer.account,
            &offer.nonce,
            offer.generation,
            t,
        ) {
            Ok(c) => c,
            Err(code) => return self.refuse(s, code, None),
        };
        let elig = self.eligibility_for(s, &offer.account).await;
        if s.closed() {
            return;
        }
        let Some(elig) = elig else {
            return self.refuse(s, "unavailable", None);
        };
        let Ok(eligible_until) = eligible(&c.phone_route_pub, &offer.account, &elig, now()) else {
            return self.refuse(s, "not-eligible", None);
        };
        let r = self
            .0
            .com
            .apply(LedgerOp::Acquire {
                hostname: offer.hostname.clone(),
                generation: offer.generation,
                holder: Holder {
                    relay_id: self.0.relay_id.clone(),
                    session_id: s.id.clone(),
                    phone_route_pub: c.phone_route_pub.clone(),
                },
            })
            .await;
        if s.closed() {
            if matches!(r, Some(LedgerResult::Ok(_))) {
                let _ = self
                    .0
                    .com
                    .apply(LedgerOp::Release {
                        hostname: offer.hostname,
                        generation: offer.generation,
                        session_id: s.id.clone(),
                    })
                    .await;
            }
            return;
        }
        match r {
            None => self.refuse(s, "unavailable", None),
            Some(LedgerResult::Refused(code, entry)) => {
                // An eligible phone refused because the route is taken (or was just taken) waits as a standby.
                if code == "route-held" || code == "stale-generation" {
                    self.enter_standby(s, &offer.hostname, 0);
                }
                let code = if code == "stale-generation" {
                    "route-held"
                } else {
                    code
                };
                self.refuse(s, code, Some(entry.generation));
            }
            Some(LedgerResult::Ok(_)) => {
                {
                    let Ok(mut st) = self.0.st.lock() else { return };
                    Self::leave_standby_locked(&mut st, s);
                    st.holders.insert(offer.hostname.clone(), Arc::clone(s));
                }
                s.clear_timers();
                let held = Held {
                    account: offer.account.clone(),
                    hostname: offer.hostname.clone(),
                    generation: offer.generation,
                    phone_route_pub: c.phone_route_pub.clone(),
                    session_nonce: offer.nonce.clone(),
                    confirmed_at: t,
                };
                s.tunnel.set_pod_canonical(Some(offer.hostname.clone()));
                let timers = vec![
                    self.repeat(s, self.0.cfg.renew, Job::Renew),
                    self.repeat(s, self.0.cfg.recheck, Job::Recheck),
                    self.once(
                        s,
                        Duration::from_millis(eligible_until.saturating_sub(t)),
                        Job::Recheck,
                    ),
                ];
                if let Ok(mut ss) = s.st.lock() {
                    ss.held = Some(held);
                    ss.eligible_until = eligible_until;
                    ss.timers = timers;
                }
                (self.0.log)(&format!(
                    "[phone-route] {}: held by session {} at generation {}",
                    offer.hostname,
                    s.id.get(..8).unwrap_or_default(),
                    offer.generation
                ));
                s.send(&json!({"type": "granted", "hostname": offer.hostname, "generation": offer.generation, "leaseMs": LEASE_MS}));
            }
        }
    }

    /// The holder gives the route up (signed, bound to the claim it holds).
    pub async fn release(
        &self,
        s: &Arc<PhoneSession>,
        release: Option<&Value>,
        signature: Option<&str>,
    ) {
        let Some(h) = s.held().filter(|h| self.holds(s, &h.hostname)) else {
            return self.refuse(s, "not-holder", None);
        };
        let (Some(release), Some(signature)) = (release.filter(|r| r.is_object()), signature)
        else {
            return self.refuse(s, "malformed", None);
        };
        if let Err(code) = check_route_release(release, signature, &h, now()) {
            return self.refuse(s, code, None);
        }
        self.lose(s, "released");
        let r = self
            .0
            .com
            .apply(LedgerOp::Release {
                hostname: h.hostname.clone(),
                generation: h.generation,
                session_id: s.id.clone(),
            })
            .await;
        s.send(
            &json!({"type": "released", "hostname": h.hostname, "generation": h.generation,
            "confirmed": matches!(r, Some(LedgerResult::Ok(_)))}),
        );
        self.notify_vacant(&h.hostname, h.generation);
        // Its tunnel stays open, so it waits as a standby too, but only for a later vacancy (not the one it just made).
        if !s.closed() {
            self.enter_standby(s, &h.hostname, h.generation.saturating_add(1));
        }
    }

    pub async fn renew(&self, s: &Arc<PhoneSession>) {
        let Some(h) = s
            .held()
            .filter(|h| !s.closed() && self.holds(s, &h.hostname))
        else {
            return;
        };
        let r = self
            .0
            .com
            .apply(LedgerOp::Renew {
                hostname: h.hostname.clone(),
                generation: h.generation,
                session_id: s.id.clone(),
            })
            .await;
        if s.closed()
            || !self.holds(s, &h.hostname)
            || s.held().is_none_or(|x| x.generation != h.generation)
        {
            return;
        }
        let t = now();
        match r {
            Some(LedgerResult::Ok(_)) => {
                if let Ok(mut ss) = s.st.lock()
                    && let Some(x) = ss.held.as_mut()
                {
                    x.confirmed_at = t;
                }
            }
            Some(LedgerResult::Refused(..)) => self.lose(s, "expired"),
            // `.com` unreachable: routing already stopped at the confirmed window; past the lease the route is gone.
            None if t.saturating_sub(h.confirmed_at) >= LEASE_MS => self.lose(s, "contact"),
            None => {}
        }
    }

    pub async fn renew_all(&self) {
        let all: Vec<Arc<PhoneSession>> = self
            .0
            .st
            .lock()
            .map(|st| st.holders.values().cloned().collect())
            .unwrap_or_default();
        for s in all {
            self.renew(&s).await;
        }
    }

    /// The feed: the ledger committed `generation` for `hostname` (a new holder) or it became vacant.
    pub fn pushed(&self, hostname: &str, generation: u64, vacant: bool) {
        let host = hostname.to_lowercase();
        if vacant {
            return self.notify_vacant(&host, generation);
        }
        // A newer holder elsewhere means this one's lease had lapsed: it is not the holder any more.
        let s = self
            .0
            .st
            .lock()
            .ok()
            .and_then(|st| st.holders.get(&host).cloned());
        if let Some(s) = s
            && s.held().is_some_and(|h| h.generation < generation)
        {
            self.lose(&s, "expired");
        }
    }

    /// The feed says a device or admin grant of `username` changed: re-check every route of the account now.
    pub async fn eligibility_changed(&self, username: &str) {
        let u = username.to_lowercase();
        let all: Vec<Arc<PhoneSession>> = self
            .0
            .st
            .lock()
            .map(|st| {
                st.holders
                    .values()
                    .filter(|s| s.held().is_some_and(|h| h.account == u))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        for s in all {
            self.recheck(&s).await;
        }
    }

    /// The feed came back: confirm every held route and standby now.
    pub async fn resync(&self) {
        self.renew_all().await;
        let (holders, hosts): (Vec<Arc<PhoneSession>>, Vec<String>) = self
            .0
            .st
            .lock()
            .map(|st| {
                (
                    st.holders.values().cloned().collect(),
                    st.standbys.keys().cloned().collect(),
                )
            })
            .unwrap_or_default();
        for s in holders {
            self.recheck(&s).await;
        }
        for h in hosts {
            self.poll_standby(&h).await;
        }
    }

    pub async fn recheck(&self, s: &Arc<PhoneSession>) {
        let Some(h) = s.held().filter(|_| !s.closed()) else {
            return;
        };
        let elig = self.eligibility_for(s, &h.account).await;
        if s.closed() || s.held().as_ref() != Some(&h) {
            return;
        }
        let Some(elig) = elig else { return };
        match eligible(&h.phone_route_pub, &h.account, &elig, now()) {
            Ok(until) => {
                if let Ok(mut ss) = s.st.lock() {
                    ss.eligible_until = until;
                }
            }
            Err(_) => self.revoke(s),
        }
    }

    /// A standby relay's own look at the ledger (the bound when a vacancy push is lost).
    pub async fn poll_standby(&self, hostname: &str) {
        if !self
            .0
            .st
            .lock()
            .is_ok_and(|st| st.standbys.contains_key(hostname))
        {
            return;
        }
        let e = self.0.com.read(hostname).await;
        let notified = self
            .0
            .st
            .lock()
            .ok()
            .and_then(|st| st.standbys.get(hostname).map(|x| x.notified));
        if let (Some(e), Some(n)) = (e, notified)
            && e.holder.is_none_or(|_| e.lease_until <= now())
            && n < e.generation.saturating_add(1)
        {
            self.notify_vacant(hostname, e.generation);
        }
    }

    #[must_use]
    pub fn stats(&self) -> Value {
        let Ok(st) = self.0.st.lock() else {
            return Value::Null;
        };
        let standby: usize = st.standbys.values().map(|x| x.sessions.len()).sum();
        json!({"sessions": st.sessions.len(), "holding": st.holders.len(), "standby": standby, "refused": st.refused, "lost": st.lost})
    }

    /// `notified_floor`: vacancies below it are not told to this standby (a releaser waits for a later one).
    fn enter_standby(&self, s: &Arc<PhoneSession>, hostname: &str, notified_floor: u64) {
        let Ok(mut st) = self.0.st.lock() else { return };
        Self::leave_standby_locked(&mut st, s);
        if let Ok(mut ss) = s.st.lock() {
            ss.standby = Some(hostname.to_owned());
        }
        if !st.standbys.contains_key(hostname) {
            let me = self.clone();
            let host = hostname.to_owned();
            let every = self.0.cfg.standby_poll;
            let poll = tokio::spawn(async move {
                let mut t = tokio::time::interval(every);
                t.tick().await;
                loop {
                    t.tick().await;
                    me.poll_standby(&host).await;
                }
            })
            .abort_handle();
            st.standbys.insert(
                hostname.to_owned(),
                Standby {
                    sessions: Vec::new(),
                    poll,
                    notified: 0,
                },
            );
        }
        if let Some(sb) = st.standbys.get_mut(hostname) {
            sb.notified = sb.notified.max(notified_floor);
            sb.sessions.push(Arc::clone(s));
        }
    }

    fn leave_standby_locked(st: &mut RoutesState, s: &Arc<PhoneSession>) {
        let Some(host) = s.st.lock().ok().and_then(|mut ss| ss.standby.take()) else {
            return;
        };
        let empty = st.standbys.get_mut(&host).is_some_and(|sb| {
            sb.sessions.retain(|x| !Arc::ptr_eq(x, s));
            sb.sessions.is_empty()
        });
        if empty && let Some(sb) = st.standbys.remove(&host) {
            sb.poll.abort();
        }
    }

    /// Tell every standby of `hostname` on this relay that it is free: the first valid claim wins in the ledger.
    fn notify_vacant(&self, hostname: &str, generation: u64) {
        let waiting: Vec<Arc<PhoneSession>> = {
            let Ok(mut st) = self.0.st.lock() else { return };
            let Some(sb) = st.standbys.get_mut(hostname) else {
                return;
            };
            sb.notified = sb.notified.max(generation.saturating_add(1));
            sb.sessions.clone()
        };
        for s in waiting {
            s.send(
                &json!({"type": "route-vacant", "hostname": hostname, "generation": generation}),
            );
        }
    }

    /// No longer eligible: give up the route, end its streams, close its tunnel with 4403.
    fn revoke(&self, s: &Arc<PhoneSession>) {
        let h = s.held();
        self.lose(s, "revoked");
        if let Some(h) = h {
            let com = Arc::clone(&self.0.com);
            let op = LedgerOp::Release {
                hostname: h.hostname.clone(),
                generation: h.generation,
                session_id: s.id.clone(),
            };
            tokio::spawn(async move {
                let _ = com.apply(op).await;
            });
            self.notify_vacant(&h.hostname, h.generation);
        }
        let _ = s.out.send(PhoneOut::Close(4403, "not-eligible".into()));
    }

    /// The route is gone from this session: no new visitors, and its streams end with it (no drain).
    fn lose(&self, s: &Arc<PhoneSession>, reason: &str) {
        let Some(h) = s.st.lock().ok().and_then(|mut ss| ss.held.take()) else {
            return;
        };
        if let Ok(mut st) = self.0.st.lock() {
            if st
                .holders
                .get(&h.hostname)
                .is_some_and(|x| Arc::ptr_eq(x, s))
            {
                st.holders.remove(&h.hostname);
            }
            let c = st.lost.entry(reason.to_owned()).or_default();
            *c = c.saturating_add(1);
        }
        s.clear_timers();
        (self.0.log)(&format!(
            "[phone-route] {}: session {} lost the route ({reason})",
            h.hostname,
            s.id.get(..8).unwrap_or_default()
        ));
        s.tunnel.close_app_streams("\u{0}");
        s.tunnel.set_pod_canonical(None);
        s.send(&json!({"type": "lost", "hostname": h.hostname, "generation": h.generation, "reason": reason}));
    }

    fn repeat(&self, s: &Arc<PhoneSession>, every: Duration, job: Job) -> tokio::task::AbortHandle {
        let me = self.clone();
        let s = Arc::clone(s);
        tokio::spawn(async move {
            let mut t = tokio::time::interval(every);
            t.tick().await;
            loop {
                t.tick().await;
                me.run(&s, job).await;
            }
        })
        .abort_handle()
    }

    fn once(&self, s: &Arc<PhoneSession>, after: Duration, job: Job) -> tokio::task::AbortHandle {
        let me = self.clone();
        let s = Arc::clone(s);
        let after = after.min(Duration::from_secs(u64::from(u32::MAX)));
        tokio::spawn(async move {
            tokio::time::sleep(after).await;
            me.run(&s, job).await;
        })
        .abort_handle()
    }

    async fn run(&self, s: &Arc<PhoneSession>, job: Job) {
        match job {
            Job::Renew => self.renew(s).await,
            Job::Recheck => self.recheck(s).await,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum Job {
    Renew,
    Recheck,
}

/// One `/phone-tunnel` WebSocket until it closes.
pub async fn run_phone_tunnel<S>(ws: WebSocketStream<S>, routes: PhoneRoutes, cfg: Arc<HubConfig>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let tunnel = Tunnel::new(cfg);
    let (tx, mut rx) = mpsc::unbounded_channel::<PhoneOut>();
    let session = routes.attach(Arc::clone(&tunnel), tx.clone());
    let (mut sink, mut stream) = ws.split();
    let _ = tx.send(PhoneOut::Text(
        json!({"type": "hello", "relayId": routes.relay_id(), "serverTime": now()}).to_string(),
    ));

    let writer = {
        let tunnel = Arc::clone(&tunnel);
        tokio::spawn(async move {
            loop {
                let woke = tunnel.wake.notified();
                while let Some(f) = tunnel.next_frame() {
                    if sink.send(Message::Binary(f.into())).await.is_err() {
                        return;
                    }
                }
                if tunnel.is_closed() {
                    let _ = sink.send(Message::Close(None)).await;
                    return;
                }
                tokio::select! {
                    _ = woke => {}
                    out = rx.recv() => match out {
                        Some(PhoneOut::Text(t)) => {
                            if sink.send(Message::Text(t.into())).await.is_err() { return; }
                        }
                        Some(PhoneOut::Ping) => {
                            if sink.send(Message::Ping(Vec::new().into())).await.is_err() { return; }
                        }
                        Some(PhoneOut::Close(code, reason)) => {
                            while let Some(f) = tunnel.next_frame() {
                                let _ = sink.send(Message::Binary(f.into())).await;
                            }
                            let _ = sink.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))).await;
                            let _ = sink.close().await;
                            tunnel.close();
                            return;
                        }
                        None => return,
                    }
                }
            }
        })
    };

    let pc = routes.config();
    let last_heard = Arc::new(Mutex::new(Instant::now()));
    let pinger = {
        let last = Arc::clone(&last_heard);
        let tx = tx.clone();
        let every = pc.ping.min(pc.silence.checked_div(3).unwrap_or(pc.silence));
        tokio::spawn(async move {
            let mut t = tokio::time::interval(every);
            t.tick().await;
            loop {
                t.tick().await;
                if last.lock().is_ok_and(|l| l.elapsed() >= pc.silence) {
                    let _ = tx.send(PhoneOut::Close(1001, "silent".into()));
                    return;
                }
                let _ = tx.send(PhoneOut::Ping);
            }
        })
    };

    let mut window = Instant::now();
    let mut count: u32 = 0;
    let mut closed = tunnel.closed_signal();
    loop {
        let msg = tokio::select! {
            m = stream.next() => m,
            _ = closed.changed() => break,
        };
        if let Ok(mut l) = last_heard.lock() {
            *l = Instant::now();
        }
        match msg {
            Some(Ok(Message::Binary(b))) => match decode_frame(&b) {
                Decoded::Ok {
                    stream_id,
                    frame_type,
                    payload,
                    consumed,
                } if consumed == b.len() => match frame_type {
                    FRAME_DATA => tunnel.deliver(stream_id, payload.to_vec()).await,
                    FRAME_CLOSE | FRAME_CLOSE_REMOTE => {
                        tunnel.remote_close(stream_id, false);
                    }
                    _ => {
                        let _ = tx.send(PhoneOut::Close(1002, "unexpected frame".into()));
                    }
                },
                _ => {
                    let _ = tx.send(PhoneOut::Close(
                        1002,
                        "one whole frame per binary message".into(),
                    ));
                }
            },
            Some(Ok(Message::Text(t))) => {
                if t.len() > MAX_CONTROL_BYTES {
                    let _ = tx.send(PhoneOut::Close(1009, "control message too large".into()));
                    continue;
                }
                if window.elapsed() >= Duration::from_secs(60) {
                    window = Instant::now();
                    count = 0;
                }
                count = count.saturating_add(1);
                if count > MAX_CONTROL_PER_MINUTE {
                    let _ = tx.send(PhoneOut::Text(
                        json!({"type": "refused", "code": "busy"}).to_string(),
                    ));
                    let _ = tx.send(PhoneOut::Close(1008, "too many control messages".into()));
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else {
                    continue;
                };
                if !v.is_object() {
                    continue;
                }
                let (routes, session) = (routes.clone(), Arc::clone(&session));
                tokio::spawn(async move {
                    let sig = v.get("signature").and_then(Value::as_str);
                    match v.get("type").and_then(Value::as_str) {
                        Some("begin") => {
                            routes
                                .begin(
                                    &session,
                                    v.get("account").and_then(Value::as_str),
                                    v.get("grants"),
                                )
                                .await
                        }
                        Some("claim") => routes.claim(&session, v.get("claim"), sig).await,
                        Some("release") => routes.release(&session, v.get("release"), sig).await,
                        _ => {}
                    }
                });
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
            Some(Ok(Message::Close(_)) | Err(_)) | None => break,
        }
    }
    pinger.abort();
    routes.detach(&session);
    tunnel.close();
    let _ = tokio::time::timeout(Duration::from_secs(5), writer).await;
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    const VECTORS: &str =
        include_str!("../../../../packages/protocol/test-vectors/phone-route/vectors.json");

    #[test]
    fn claims_and_releases_agree_with_typescript() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        let c = &v["claim"];
        assert_eq!(
            route_claim_canonical(&claim_of(&c["record"]).unwrap()).unwrap(),
            c["canonical"].as_str().unwrap()
        );
        for case in c["cases"].as_array().unwrap() {
            let s = &case["session"];
            let got = check_route_claim(
                &case["claim"],
                case["signature"].as_str().unwrap(),
                s["apex"].as_str().unwrap(),
                s["account"].as_str().unwrap(),
                s["sessionNonce"].as_str().unwrap(),
                s["generation"].as_u64().unwrap(),
                s["now"].as_u64().unwrap(),
            );
            let want = case["expected"].as_str().unwrap();
            assert_eq!(
                got.map(|_| "ok").unwrap_or_else(|e| e),
                want,
                "{}",
                case["name"]
            );
        }
        let r = &v["release"];
        assert_eq!(
            route_release_canonical(&claim_of(&r["record"]).unwrap()).unwrap(),
            r["canonical"].as_str().unwrap()
        );
        let h = &r["held"];
        let held = Held {
            account: h["account"].as_str().unwrap().into(),
            hostname: h["hostname"].as_str().unwrap().into(),
            generation: h["generation"].as_u64().unwrap(),
            phone_route_pub: h["phoneRoutePub"].as_str().unwrap().into(),
            session_nonce: h["sessionNonce"].as_str().unwrap().into(),
            confirmed_at: 0,
        };
        let at = r["record"]["issuedAt"].as_u64().unwrap();
        assert_eq!(
            check_route_release(&r["record"], r["signature"].as_str().unwrap(), &held, at),
            Ok(())
        );
        let mut other = held.clone();
        other.generation += 1;
        assert_eq!(
            check_route_release(&r["record"], r["signature"].as_str().unwrap(), &other, at),
            Err("wrong-generation")
        );
    }
}

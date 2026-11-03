//! The relay half of the serving authority (`docs/architecture-v2/serving-wiring.md` §2; the TypeScript
//! `apps/web/src/tunnel/servingGate.ts`): per connected box, the decision `serving_decision` gives from `.com`'s records,
//! the box's HELLO and the pushed revocation log, kept current on HELLO, on a `changed` frame and at the decision's
//! `until`; and the fail-closed rule when the feed from `.com` goes quiet (no new tunnels after 60 s, every tunnel
//! closed after 10 min). Every rule lives in `flagship_crypto::serving`; this module gathers the inputs and acts.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use flagship_crypto::serving::{
    Grace, OnLapse, PolicyHead, RenewalKeyDelegation, RevocationState, ServingDecision,
    ServingInput, ServingLease, ServingPolicy, SignedLease, box_revoked, serving_decision,
    serving_decision_at_head,
};
use serde_json::Value;

use crate::authority::BoxFut;
use crate::com::{HttpGet, segment};
use crate::hub::now_ms;

/// `.com`'s answer to `GET /api/internal/serving/:u/:boxPub`, parsed.
#[derive(Debug, Clone, Default)]
pub struct ComServingRecord {
    /// The account's sensitive-order key (admin root, else IRK), hex.
    pub admin_key: Option<String>,
    pub reg_gen: u64,
    /// `.com` has revoked this registration (the name was revoked and not re-registered).
    pub revoked: bool,
    pub policy: Option<(ServingPolicy, String)>,
    pub leases: Vec<SignedLease>,
    /// Mesh mode (relay-mesh.md §4.4): the record comes from the relay log, the policy and leases from the box's own
    /// HELLO; only a policy matching the log's head for (box, regGen) counts.
    pub mesh: Option<MeshRecord>,
    /// `.com` derives this account's keys itself (a demo account), so a box that pins no admin key (a 0.2 box) is
    /// judged under `admin_key` instead of keeping only its control name. Never in mesh mode.
    pub admin_key_held_by_com: bool,
}

/// The log's part of a mesh-mode record.
#[derive(Debug, Clone, Default)]
pub struct MeshRecord {
    pub policy_head: Option<PolicyHead>,
}

/// `unknown-box`: `.com` answered that the account has no server under this key (deleted, or its name now belongs to
/// another key).
pub const UNKNOWN_BOX: &str = "unknown-box";

/// `.com`'s definitive answer about a box.
#[derive(Debug, Clone)]
#[allow(clippy::large_enum_variant)]
pub enum ServingFetched {
    Record(ComServingRecord),
    /// [`UNKNOWN_BOX`].
    UnknownBox,
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `{record, signature}` (or `{<alt>, signature}`, the name the POST bodies use).
fn signed<'a>(raw: &'a Value, alt: &str) -> Option<(&'a Value, String)> {
    let o = raw.as_object()?;
    let record = o.get("record").or_else(|| o.get(alt))?;
    if !record.is_object() {
        return None;
    }
    Some((record, o.get("signature")?.as_str()?.to_owned()))
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k)?.as_str().map(str::to_owned)
}

fn n(v: &Value, k: &str) -> Option<u64> {
    v.get(k)?.as_u64()
}

fn policy_of(v: &Value) -> Option<ServingPolicy> {
    Some(ServingPolicy {
        account: s(v, "account")?,
        box_pub: s(v, "box")?,
        reg_gen: n(v, "regGen")?,
        policy_gen: n(v, "policyGen")?,
        grace: Grace::parse(&s(v, "grace")?).ok()?,
        on_lapse: OnLapse::parse(&s(v, "onLapse")?).ok()?,
        scope_sha256: s(v, "scopeSha256")?,
        issued_at: n(v, "issuedAt")?,
    })
}

fn delegation_of(v: &Value) -> Option<RenewalKeyDelegation> {
    Some(RenewalKeyDelegation {
        account: s(v, "account")?,
        alg: s(v, "alg")?,
        renewal_pub: s(v, "renewalPub")?,
        device_id: s(v, "deviceId")?,
        issued_at: n(v, "issuedAt")?,
        expires_at: n(v, "expiresAt")?,
    })
}

fn lease_of(v: &Value) -> Option<ServingLease> {
    Some(ServingLease {
        account: s(v, "account")?,
        box_pub: s(v, "box")?,
        reg_gen: n(v, "regGen")?,
        policy_gen: n(v, "policyGen")?,
        lease_id: s(v, "leaseId")?,
        issued_at: n(v, "issuedAt")?,
        not_after: n(v, "notAfter")?,
    })
}

/// A signed policy as the box's HELLO or `.com` carries it; `None` when it is not one (the decision then ignores it).
#[must_use]
pub fn parse_signed_policy(raw: &Value) -> Option<(ServingPolicy, String)> {
    let (r, sig) = signed(raw, "policy")?;
    Some((policy_of(r)?, sig))
}

/// `parseComServingRecord`: leases are joined with the delegation that signed them; a lease with no hint is offered
/// under the admin key and under each delegation (one must verify).
#[must_use]
pub fn parse_com_serving_record(body: &Value) -> Option<ComServingRecord> {
    let o = body.as_object()?;
    let reg_gen = o.get("regGen")?.as_u64().filter(|g| *g >= 1)?;
    let admin_key = o
        .get("adminKey")
        .and_then(Value::as_str)
        .filter(|k| is_hex64(k))
        .map(str::to_owned);
    let policy = o.get("policy").and_then(parse_signed_policy);
    let mut delegations: Vec<(RenewalKeyDelegation, String)> = Vec::new();
    for d in o
        .get("delegations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some((r, sig)) = signed(d, "delegation")
            && let Some(rec) = delegation_of(r)
        {
            delegations.push((rec, sig));
        }
    }
    let mut leases = Vec::new();
    for raw in o
        .get("leases")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some((r, sig)) = signed(raw, "lease") else {
            continue;
        };
        let Some(lease) = lease_of(r) else {
            continue;
        };
        let inline = raw
            .get("delegation")
            .and_then(|d| signed(d, "delegation"))
            .and_then(|(r, sig)| Some((delegation_of(r)?, sig)));
        let hint = raw
            .get("delegationPub")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| inline.as_ref().map(|(d, _)| d.renewal_pub.clone()));
        let one = |delegation| SignedLease {
            lease: lease.clone(),
            signature: sig.clone(),
            delegation,
        };
        if let Some(d) = inline {
            leases.push(one(Some(d)));
        } else if let Some(pubk) = hint {
            leases.push(one(delegations
                .iter()
                .find(|(d, _)| d.renewal_pub == pubk)
                .cloned()));
        } else {
            leases.push(one(None));
            for d in &delegations {
                leases.push(one(Some(d.clone())));
            }
        }
    }
    Some(ComServingRecord {
        admin_key,
        reg_gen,
        revoked: o.get("revoked").and_then(Value::as_bool) == Some(true),
        policy,
        leases,
        mesh: None,
        admin_key_held_by_com: o.get("adminKeyHeldByCom").and_then(Value::as_bool) == Some(true),
    })
}

/// The box's own leases from its HELLO (`servingLeases`, relay-mesh.md §9.5): `[{record, signature, delegation?:
/// {record, signature}}]`, at most 8; entries out of shape are skipped.
#[must_use]
pub fn parse_hello_leases(raw: &Value) -> Vec<SignedLease> {
    raw.get("servingLeases")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(8)
        .filter_map(|l| {
            let (r, sig) = signed(l, "lease")?;
            let delegation = match l.get("delegation") {
                None | Some(Value::Null) => None,
                Some(d) => {
                    let (dr, dsig) = signed(d, "delegation")?;
                    Some((delegation_of(dr)?, dsig))
                }
            };
            Some(SignedLease {
                lease: lease_of(r)?,
                signature: sig,
                delegation,
            })
        })
        .collect()
}

/// Where the gate reads `.com`'s record and the account's sensitive-order key.
pub trait ServingFetch: Send + Sync + 'static {
    /// `None`: `.com` could not be asked (an outage, not an answer).
    fn record<'a>(
        &'a self,
        username: &'a str,
        box_pub: &'a str,
    ) -> BoxFut<'a, Option<ServingFetched>>;
    /// The per-account authority lookup's admin key (admin root, else IRK); used when `.com`'s record names none.
    fn admin_key<'a>(&'a self, username: &'a str) -> BoxFut<'a, Option<String>>;
}

/// `comServingFetcher` over a blocking client that sends the services control secret.
pub struct ComServingFetch<H: HttpGet> {
    base: String,
    http: Arc<H>,
    admin: Box<dyn Fn(String) -> BoxFut<'static, Option<String>> + Send + Sync>,
}

impl<H: HttpGet> std::fmt::Debug for ComServingFetch<H> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ComServingFetch")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

impl<H: HttpGet> ComServingFetch<H> {
    pub fn new(
        com_base_url: &str,
        http: H,
        admin: Box<dyn Fn(String) -> BoxFut<'static, Option<String>> + Send + Sync>,
    ) -> Self {
        Self {
            base: com_base_url.trim_end_matches('/').to_owned(),
            http: Arc::new(http),
            admin,
        }
    }
}

impl<H: HttpGet> ServingFetch for ComServingFetch<H> {
    fn record<'a>(
        &'a self,
        username: &'a str,
        box_pub: &'a str,
    ) -> BoxFut<'a, Option<ServingFetched>> {
        Box::pin(async move {
            let url = format!(
                "{}/api/internal/serving/{}/{}",
                self.base,
                segment(username),
                segment(box_pub)
            );
            let http = Arc::clone(&self.http);
            let got = tokio::task::spawn_blocking(move || http.get_json(&url))
                .await
                .ok()?;
            match got {
                Ok((200, body)) => parse_com_serving_record(&body).map(ServingFetched::Record),
                Ok((404, body))
                    if body.get("code").and_then(Value::as_str) == Some("serving-unknown-box") =>
                {
                    Some(ServingFetched::UnknownBox)
                }
                _ => None,
            }
        })
    }

    fn admin_key<'a>(&'a self, username: &'a str) -> BoxFut<'a, Option<String>> {
        (self.admin)(username.to_owned())
    }
}

/// What the box said about itself in its HELLO.
#[derive(Debug, Clone)]
pub struct ServingHello {
    pub username: String,
    /// The box's identity key (the HELLO's verified podPubKey), hex.
    pub box_pub: String,
    pub pod_canonical: String,
    /// `servingAdminKey`: the admin key the box pinned.
    pub admin_key: Option<String>,
    /// `servingPolicy`: the box's stored signed policy.
    pub policy: Option<(ServingPolicy, String)>,
    /// `servingLeases` (mesh mode reads them; `.com`'s copies count otherwise).
    pub leases: Vec<SignedLease>,
}

/// How the gate acts on one tunnel. Called with no gate lock held.
pub trait ServingHandle: Send + Sync + 'static {
    /// The box may not keep its tunnel (revoked, admin keys differ, or contact with `.com` lost).
    fn close_tunnel(&self, code: u16, reason: &str);
    /// Its app routes just stopped: end every open visitor stream that is not its control name.
    fn close_app_streams(&self);
    /// Its app routes stopped or came back: the allocator hands its slots on or takes free ones back.
    fn on_apps_changed(&self, apps: bool);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateDecision {
    Serve {
        until: Option<u64>,
    },
    /// `unavailable`: `.com`'s record for the box could not be read (apps stay off); [`UNKNOWN_BOX`]: `.com` has no
    /// such box (the tunnel is refused).
    Deny {
        control: bool,
        reason: String,
    },
}

impl GateDecision {
    #[must_use]
    pub const fn control(&self) -> bool {
        match self {
            Self::Serve { .. } => true,
            Self::Deny { control, .. } => *control,
        }
    }

    #[must_use]
    pub const fn apps(&self) -> bool {
        matches!(self, Self::Serve { .. })
    }

    #[must_use]
    pub fn reason(&self) -> &str {
        match self {
            Self::Serve { .. } => "serving",
            Self::Deny { reason, .. } => reason,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Contact {
    Ok,
    RefuseNew,
    Lost,
}

impl Contact {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::RefuseNew => "refuse-new",
            Self::Lost => "lost",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct GateConfig {
    /// No frame from `.com` for this long: refuse new tunnels. Default 60 s.
    pub refuse_new_after: Duration,
    /// No frame for this long: close every tunnel until contact returns. Default 10 min.
    pub close_all_after: Duration,
    /// A box whose record could not be read is asked again after this long. Default 30 s.
    pub retry: Duration,
    /// How often the contact thresholds are checked. Default 5 s.
    pub check_every: Duration,
    /// Mesh mode (owner decision 2026-11-01, relay-mesh.md §4.6 as amended): past close-all, a box whose decision has no
    /// end (no dead-man to enforce) keeps its tunnel; every other one is closed.
    pub keep_indefinite_on_lost: bool,
}

impl Default for GateConfig {
    fn default() -> Self {
        Self {
            refuse_new_after: Duration::from_secs(60),
            close_all_after: Duration::from_secs(600),
            retry: Duration::from_secs(30),
            check_every: Duration::from_secs(5),
            keep_indefinite_on_lost: false,
        }
    }
}

struct BoxState {
    hello: ServingHello,
    decision: GateDecision,
    com: Option<ComServingRecord>,
    /// `.com`'s last answer was "no such box".
    unknown: bool,
    timer: Option<tokio::task::AbortHandle>,
    fetch_gen: u64,
    closed: bool,
}

/// One tunnel's place in the gate.
pub struct ServingBox {
    id: u64,
    gate: Weak<GateInner>,
    handle: Arc<dyn ServingHandle>,
    st: Mutex<BoxState>,
}

impl std::fmt::Debug for ServingBox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServingBox")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl ServingBox {
    #[must_use]
    pub fn decision(&self) -> GateDecision {
        self.st.lock().map_or(
            GateDecision::Deny {
                control: false,
                reason: "refused".into(),
            },
            |s| s.decision.clone(),
        )
    }

    /// A HELLO refresh on the same tunnel: re-read `.com` and decide again.
    pub async fn update(self: &Arc<Self>, hello: ServingHello) -> GateDecision {
        if let Ok(mut s) = self.st.lock() {
            s.hello = hello;
        }
        match self.gate.upgrade() {
            Some(g) => ServingGate(g).refresh(self, false).await,
            None => self.decision(),
        }
    }

    pub fn detach(self: &Arc<Self>) {
        if let Some(g) = self.gate.upgrade() {
            ServingGate(g).detach(self);
        }
    }

    fn key(&self) -> String {
        self.st
            .lock()
            .map(|s| box_key(&s.hello.username, &s.hello.box_pub))
            .unwrap_or_default()
    }
}

struct GateState {
    boxes: HashMap<String, Vec<Arc<ServingBox>>>,
    revocations: RevocationState,
    last_contact: Instant,
    lost_closed: bool,
    logged: Contact,
    latest_sequence: u64,
    refused_tunnels: u64,
}

struct GateInner {
    fetch: Arc<dyn ServingFetch>,
    cfg: GateConfig,
    st: Mutex<GateState>,
    next_id: AtomicU64,
    log: Box<dyn Fn(&str) + Send + Sync>,
}

/// Counts for `/api/stats` (`ServingGateStats`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateStats {
    pub boxes: u64,
    pub serving: u64,
    pub apps_stopped: u64,
    pub revoked: u64,
    pub refused_tunnels: u64,
    pub contact: Contact,
    pub last_contact_age_ms: u64,
    pub sequence: u64,
    pub latest: u64,
}

impl GateStats {
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "boxes": self.boxes,
            "serving": self.serving,
            "appsStopped": self.apps_stopped,
            "revoked": self.revoked,
            "refusedTunnels": self.refused_tunnels,
            "contact": self.contact.as_str(),
            "lastContactAgeMs": self.last_contact_age_ms,
            "feed": {"sequence": self.sequence, "latest": self.latest, "lag": self.latest.saturating_sub(self.sequence)},
        })
    }
}

#[derive(Clone)]
pub struct ServingGate(Arc<GateInner>);

impl std::fmt::Debug for ServingGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServingGate")
            .field("cfg", &self.0.cfg)
            .finish_non_exhaustive()
    }
}

fn box_key(username: &str, box_pub: &str) -> String {
    format!("{username}|{box_pub}")
}

fn now_u64() -> u64 {
    now_ms() as u64
}

/// What to do after a decision, run with no lock held.
enum Act {
    Close(u16, String),
    AppsChanged { apps: bool, close_streams: bool },
}

impl ServingGate {
    pub fn new(
        fetch: Arc<dyn ServingFetch>,
        cfg: GateConfig,
        log: Box<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        Self(Arc::new(GateInner {
            fetch,
            cfg,
            st: Mutex::new(GateState {
                boxes: HashMap::new(),
                revocations: RevocationState::default(),
                // A relay that just started gets the same grace to reach `.com` as one that just lost it.
                last_contact: Instant::now(),
                lost_closed: false,
                logged: Contact::Ok,
                latest_sequence: 0,
                refused_tunnels: 0,
            }),
            next_id: AtomicU64::new(1),
            log,
        }))
    }

    /// Check the contact thresholds every `check_every`; stops when every handle to the gate is gone.
    pub fn spawn(&self) -> tokio::task::JoinHandle<()> {
        let weak = Arc::downgrade(&self.0);
        let every = self.0.cfg.check_every;
        tokio::spawn(async move {
            let mut t = tokio::time::interval(every);
            t.tick().await;
            loop {
                t.tick().await;
                let Some(g) = weak.upgrade() else { return };
                ServingGate(g).tick();
            }
        })
    }

    pub fn note_contact(&self) {
        if let Ok(mut s) = self.0.st.lock() {
            s.last_contact = Instant::now();
            s.lost_closed = false;
        }
    }

    /// Mesh mode: contact as of `at` (the issue time of the newest head applied), never moving backwards.
    pub fn note_contact_at(&self, at: Instant) {
        if let Ok(mut s) = self.0.st.lock()
            && at > s.last_contact
        {
            s.last_contact = at;
            if self.contact_of(&s) != Contact::Lost {
                s.lost_closed = false;
            }
        }
    }

    fn contact_of(&self, s: &GateState) -> Contact {
        let quiet = s.last_contact.elapsed();
        if quiet >= self.0.cfg.close_all_after {
            Contact::Lost
        } else if quiet >= self.0.cfg.refuse_new_after {
            Contact::RefuseNew
        } else {
            Contact::Ok
        }
    }

    #[must_use]
    pub fn contact(&self) -> Contact {
        self.0
            .st
            .lock()
            .map_or(Contact::Lost, |s| self.contact_of(&s))
    }

    #[must_use]
    pub fn accepting_new_tunnels(&self) -> bool {
        self.contact() == Contact::Ok
    }

    /// Close every tunnel once contact has been gone for `close_all_after`; they come back when it returns.
    pub fn tick(&self) {
        let victims: Vec<Arc<ServingBox>> = {
            let Ok(mut s) = self.0.st.lock() else { return };
            let c = self.contact_of(&s);
            if c != s.logged {
                let tail = if c == Contact::Ok {
                    String::new()
                } else {
                    format!(
                        " ({} s without a frame)",
                        s.last_contact.elapsed().as_secs()
                    )
                };
                (self.0.log)(&format!(
                    "[serving] contact with .com: {}{tail}",
                    c.as_str()
                ));
                s.logged = c;
            }
            let keep = self.0.cfg.keep_indefinite_on_lost;
            // Mesh mode keeps checking while lost: a box whose decision loses its exemption (a HELLO refresh) goes too.
            if c != Contact::Lost || (s.lost_closed && !keep) {
                return;
            }
            s.lost_closed = true;
            s.boxes
                .values()
                .flatten()
                .filter(|b| !(keep && b.decision() == GateDecision::Serve { until: None }))
                .cloned()
                .collect()
        };
        for b in victims {
            b.handle.close_tunnel(1013, "serving-feed-lost");
        }
    }

    /// Is this box exempt from the lost-contact rule (§4.6 as amended): attached here with a decision that serves its
    /// apps with no end?
    #[must_use]
    pub fn exempt(&self, username: &str, box_pub: &str) -> bool {
        self.boxes_of(&box_key(&username.to_lowercase(), &box_pub.to_lowercase()))
            .iter()
            .any(|b| b.decision() == GateDecision::Serve { until: None })
    }

    #[must_use]
    pub fn revocations(&self) -> RevocationState {
        self.0
            .st
            .lock()
            .map(|s| s.revocations.clone())
            .unwrap_or_default()
    }

    /// The feed applied entries: every box whose key it touched decides again.
    pub fn adopt_revocations(&self, next: RevocationState) {
        let touched: Vec<Arc<ServingBox>> = {
            let Ok(mut s) = self.0.st.lock() else { return };
            let prev = std::mem::replace(&mut s.revocations, next.clone());
            let box_keys: Vec<String> = next
                .boxes
                .iter()
                .filter(|(k, g)| prev.boxes.get(*k) != Some(g))
                .map(|(k, _)| k.clone())
                .collect();
            let new_keys: Vec<&String> = next
                .renewal_keys
                .iter()
                .filter(|k| !prev.renewal_keys.contains(*k))
                .collect();
            s.boxes
                .values()
                .flatten()
                .filter(|b| {
                    let Ok(bs) = b.st.lock() else { return false };
                    box_keys.contains(&bs.hello.box_pub)
                        || (!new_keys.is_empty()
                            && bs.com.as_ref().is_some_and(|c| {
                                c.leases.iter().any(|l| {
                                    l.delegation
                                        .as_ref()
                                        .is_some_and(|(d, _)| new_keys.contains(&&d.renewal_pub))
                                })
                            }))
                })
                .cloned()
                .collect()
        };
        for b in touched {
            self.redecide(&b, false, false);
        }
    }

    pub fn note_latest_sequence(&self, seq: u64) {
        if let Ok(mut s) = self.0.st.lock()
            && seq > s.latest_sequence
        {
            s.latest_sequence = seq;
        }
    }

    /// A HELLO passed authentication: read `.com`'s record and decide. The caller refuses the tunnel when `control` is
    /// false.
    pub async fn attach(
        &self,
        hello: ServingHello,
        handle: Arc<dyn ServingHandle>,
    ) -> Arc<ServingBox> {
        let key = box_key(&hello.username, &hello.box_pub);
        let b = Arc::new(ServingBox {
            id: self.0.next_id.fetch_add(1, Ordering::Relaxed),
            gate: Arc::downgrade(&self.0),
            handle,
            st: Mutex::new(BoxState {
                hello,
                decision: GateDecision::Deny {
                    control: true,
                    reason: "unavailable".into(),
                },
                com: None,
                unknown: false,
                timer: None,
                fetch_gen: 0,
                closed: false,
            }),
        });
        if let Ok(mut s) = self.0.st.lock() {
            s.boxes.entry(key).or_default().push(Arc::clone(&b));
        }
        self.refresh(&b, true).await;
        b
    }

    pub fn detach(&self, b: &Arc<ServingBox>) {
        let key = b.key();
        if let Ok(mut bs) = b.st.lock() {
            bs.closed = true;
            if let Some(t) = bs.timer.take() {
                t.abort();
            }
        }
        if let Ok(mut s) = self.0.st.lock()
            && let Some(list) = s.boxes.get_mut(&key)
        {
            list.retain(|x| x.id != b.id);
            if list.is_empty() {
                s.boxes.remove(&key);
            }
        }
    }

    fn boxes_of(&self, key: &str) -> Vec<Arc<ServingBox>> {
        self.0
            .st
            .lock()
            .ok()
            .and_then(|s| s.boxes.get(key).cloned())
            .unwrap_or_default()
    }

    /// `.com` says this box's policy, leases or delegations changed.
    pub async fn changed(&self, username: &str, box_pub: &str) {
        let key = box_key(&username.to_lowercase(), &box_pub.to_lowercase());
        for b in self.boxes_of(&key) {
            self.refresh(&b, false).await;
        }
    }

    /// Re-read every box (after the feed reconnects: `changed` frames sent while it was away were missed).
    pub async fn refresh_all(&self) {
        let all: Vec<Arc<ServingBox>> = self
            .0
            .st
            .lock()
            .map(|s| s.boxes.values().flatten().cloned().collect())
            .unwrap_or_default();
        for b in all {
            self.refresh(&b, false).await;
        }
    }

    async fn refresh(&self, b: &Arc<ServingBox>, initial: bool) -> GateDecision {
        let (fetch_gen, user, box_pub) = {
            let Ok(mut bs) = b.st.lock() else {
                return b.decision();
            };
            bs.fetch_gen = bs.fetch_gen.wrapping_add(1);
            (
                bs.fetch_gen,
                bs.hello.username.clone(),
                bs.hello.box_pub.clone(),
            )
        };
        let fetched = self.0.fetch.record(&user, &box_pub).await;
        let rec = match &fetched {
            Some(ServingFetched::Record(r)) => Some(r),
            _ => None,
        };
        let mut com_key = rec.and_then(|r| r.admin_key.clone());
        if rec.is_some() && com_key.is_none() {
            com_key = self.0.fetch.admin_key(&user).await;
        }
        {
            let Ok(mut bs) = b.st.lock() else {
                return b.decision();
            };
            if bs.closed || fetch_gen != bs.fetch_gen {
                return bs.decision.clone();
            }
            // A record read is not contact: only the feed carries revocations. An outage keeps the last answer.
            match &fetched {
                Some(ServingFetched::UnknownBox) => {
                    bs.com = None;
                    bs.unknown = true;
                }
                Some(ServingFetched::Record(r)) => {
                    let mut r = r.clone();
                    r.admin_key = com_key;
                    bs.com = Some(r);
                    bs.unknown = false;
                }
                None => {}
            }
        }
        self.redecide(b, initial, fetched.is_none());
        b.decision()
    }

    fn decide(&self, bs: &BoxState, revs: &RevocationState) -> GateDecision {
        let deny = |control: bool, reason: &str| GateDecision::Deny {
            control,
            reason: reason.into(),
        };
        if bs.unknown {
            return deny(false, UNKNOWN_BOX);
        }
        let Some(rec) = &bs.com else {
            return deny(true, "unavailable");
        };
        let h = &bs.hello;
        if rec.revoked {
            return deny(false, "revoked");
        }
        // `serving_decision` checks the revocation log itself; the paths that stop short of it check it here.
        // A box that pins no key is judged under `.com`'s only where `.com` holds that key anyway (demo accounts).
        let waived = if rec.admin_key_held_by_com && rec.mesh.is_none() {
            rec.admin_key.as_ref()
        } else {
            None
        };
        let (Some(com_key), Some(box_key)) = (&rec.admin_key, h.admin_key.as_ref().or(waived))
        else {
            if box_revoked(revs, &h.username, &h.box_pub, rec.reg_gen) {
                return deny(false, "revoked");
            }
            if rec.admin_key.is_none() {
                return deny(true, "unavailable");
            }
            // An older box that pins nothing keeps its control name (recovery stays possible) but serves no app.
            return deny(true, "admin-keys-differ");
        };
        let policies: Vec<(ServingPolicy, String)> = match &rec.mesh {
            Some(_) => h.policy.iter().cloned().collect(),
            None => rec.policy.iter().chain(h.policy.iter()).cloned().collect(),
        };
        let leases = if rec.mesh.is_some() {
            &h.leases
        } else {
            &rec.leases
        };
        let input = ServingInput {
            account: &h.username,
            box_pub: &h.box_pub,
            reg_gen: rec.reg_gen,
            admin_key_from_com: com_key,
            admin_key_from_box: box_key,
            policies: &policies,
            leases,
            revocations: revs,
            now: now_u64(),
        };
        let decided = match &rec.mesh {
            Some(m) => serving_decision_at_head(&input, m.policy_head.as_ref()),
            None => serving_decision(&input),
        };
        match decided {
            ServingDecision::Serve { until, .. } => GateDecision::Serve { until },
            ServingDecision::Refuse {
                control, reason, ..
            } => GateDecision::Deny {
                control,
                reason: reason.to_owned(),
            },
        }
    }

    /// Decide from what is held, act on a change, and arm the timer for the next one.
    fn redecide(&self, b: &Arc<ServingBox>, initial: bool, failed: bool) {
        let revs = self.revocations();
        let act = {
            let Ok(mut bs) = b.st.lock() else { return };
            if bs.closed {
                return;
            }
            let prev = bs.decision.clone();
            let next = self.decide(&bs, &revs);
            bs.decision = next.clone();
            if let Some(t) = bs.timer.take() {
                t.abort();
            }
            let who = format!("{} ({})", bs.hello.pod_canonical, bs.hello.username);
            if !next.control() {
                (self.0.log)(&format!(
                    "[serving] {who}: tunnel refused ({})",
                    next.reason()
                ));
                (!initial).then(|| Act::Close(1008, next.reason().to_owned()))
            } else {
                if prev.apps() != next.apps() && (!initial || !next.apps()) {
                    let what = if next.apps() {
                        "served".to_owned()
                    } else {
                        format!("stopped ({})", next.reason())
                    };
                    (self.0.log)(&format!("[serving] {who}: app routes {what}"));
                }
                match &next {
                    GateDecision::Serve { until: Some(until) } => {
                        let wait = Duration::from_millis(until.saturating_sub(now_u64()));
                        bs.timer = Some(self.arm(b, wait, false));
                    }
                    _ if bs.com.is_none() || failed => {
                        bs.timer = Some(self.arm(b, self.0.cfg.retry, true));
                    }
                    _ => {}
                }
                (!initial && prev.apps() != next.apps()).then(|| Act::AppsChanged {
                    apps: next.apps(),
                    close_streams: !next.apps(),
                })
            }
        };
        // Lock order: the gate's lock is never taken while a box's is held.
        if !b.decision().control()
            && let Ok(mut s) = self.0.st.lock()
        {
            s.refused_tunnels = s.refused_tunnels.saturating_add(1);
        }
        match act {
            Some(Act::Close(code, reason)) => b.handle.close_tunnel(code, &reason),
            Some(Act::AppsChanged {
                apps,
                close_streams,
            }) => {
                if close_streams {
                    b.handle.close_app_streams();
                }
                b.handle.on_apps_changed(apps);
            }
            None => {}
        }
    }

    fn arm(&self, b: &Arc<ServingBox>, wait: Duration, refetch: bool) -> tokio::task::AbortHandle {
        let weak = Arc::downgrade(&self.0);
        let b = Arc::clone(b);
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            let Some(g) = weak.upgrade() else { return };
            let gate = ServingGate(g);
            if refetch {
                gate.refresh(&b, false).await;
            } else {
                gate.redecide(&b, false, false);
            }
        })
        .abort_handle()
    }

    #[must_use]
    pub fn stats(&self) -> GateStats {
        let Ok(s) = self.0.st.lock() else {
            return GateStats {
                boxes: 0,
                serving: 0,
                apps_stopped: 0,
                revoked: 0,
                refused_tunnels: 0,
                contact: Contact::Lost,
                last_contact_age_ms: 0,
                sequence: 0,
                latest: 0,
            };
        };
        let (mut boxes, mut serving, mut stopped) = (0u64, 0u64, 0u64);
        for b in s.boxes.values().flatten() {
            boxes = boxes.saturating_add(1);
            let d = b.decision();
            if d.apps() {
                serving = serving.saturating_add(1);
            } else if d.control() {
                stopped = stopped.saturating_add(1);
            }
        }
        let sequence = s.revocations.sequence;
        GateStats {
            boxes,
            serving,
            apps_stopped: stopped,
            revoked: s.revocations.boxes.len() as u64,
            refused_tunnels: s.refused_tunnels,
            contact: self.contact_of(&s),
            last_contact_age_ms: u64::try_from(s.last_contact.elapsed().as_millis())
                .unwrap_or(u64::MAX),
            sequence,
            latest: s.latest_sequence.max(sequence),
        }
    }
}

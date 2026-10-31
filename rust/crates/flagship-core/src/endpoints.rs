//! How the controller reaches an app: the endpoint table and the address pool
//! (docs/architecture-v2/app-endpoints.md), the Rust twin of `packages/server-daemon/src/endpoints.ts`.
//!
//! Callers name a service and never supply an address. The table holds, per service, the one
//! endpoint the controller itself verified for the container it created, tagged with the deploy it
//! belongs to (`generation`) and the container start it belongs to (`incarnation`). Anything not in
//! the table, or invalidated, is unavailable: there is no fallback to another path.
//!
//! An address belongs to a SERVICE for as long as the service exists ([`AddressPool`]), so a stale
//! dial can only reach nothing or a later incarnation of the same service, never another app. An
//! address goes back to the pool only after the service's endpoint is invalidated, its
//! connections are closed and a quarantine has passed.
//!
//! Sans-IO: the clock is an argument and the engine's answer is a value, so the shared vectors
//! (`packages/server-daemon/test-vectors/endpoints.json`) run the same cases through the
//! TypeScript and the Rust implementation.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

pub const LABEL_SERVICE: &str = "flagship.service";
pub const LABEL_GENERATION: &str = "flagship.generation";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum EndpointEnv {
    Live,
    Staging,
    Build,
}

impl EndpointEnv {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Staging => "staging",
            Self::Build => "build",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "live" => Some(Self::Live),
            "staging" => Some(Self::Staging),
            "build" => Some(Self::Build),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EndpointRole {
    Http,
    Data,
    Ai,
}

impl EndpointRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Data => "data",
            Self::Ai => "ai",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "http" => Some(Self::Http),
            "data" => Some(Self::Data),
            "ai" => Some(Self::Ai),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EndpointKey {
    pub service_id: String,
    pub env: EndpointEnv,
    /// `main` for a single-process app, the component's name inside an app group.
    pub component: String,
    pub role: EndpointRole,
}

impl EndpointKey {
    /// The table's key string (`env/service/component/role`).
    pub fn key_string(&self) -> String {
        format!(
            "{}/{}/{}/{}",
            self.env.as_str(),
            self.service_id,
            self.component,
            self.role.as_str()
        )
    }

    fn drain_key(&self, with_component: bool) -> String {
        drain_key(
            &self.service_id,
            self.env,
            with_component.then_some(self.component.as_str()),
        )
    }
}

fn drain_key(service_id: &str, env: EndpointEnv, component: Option<&str>) -> String {
    match component {
        None => format!("{}/{service_id}", env.as_str()),
        Some(c) => format!("{}/{service_id}/{c}", env.as_str()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    /// One per deploy (install, update, rollback).
    pub generation: i64,
    /// One per container start: the engine's container id plus its StartedAt.
    pub incarnation: String,
}

#[derive(Default)]
struct Inner {
    entries: HashMap<String, Endpoint>,
    /// Services (or one component of a service) being stopped: nothing is admitted until the next publish.
    draining: HashSet<String>,
    leases: HashMap<String, Vec<Arc<LeaseState>>>,
}

type Hook = Box<dyn FnOnce() + Send>;

struct LeaseState {
    done: AtomicBool,
    hooks: Mutex<Vec<Hook>>,
}

impl LeaseState {
    fn cancel(&self) {
        if self.done.swap(true, Ordering::SeqCst) {
            return;
        }
        let hooks = std::mem::take(&mut *self.hooks.lock().unwrap_or_else(PoisonError::into_inner));
        for h in hooks {
            h();
        }
    }
}

/// One caller's hold on an endpoint, taken BEFORE it dials so an invalidation cannot miss it.
pub struct Lease {
    pub endpoint: Endpoint,
    key: String,
    drains: [String; 2],
    state: Arc<LeaseState>,
    inner: Arc<Mutex<Inner>>,
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lease")
            .field("endpoint", &self.endpoint)
            .field("key", &self.key)
            .finish_non_exhaustive()
    }
}

impl Lease {
    /// Tie a request or socket to this lease: `on_cancel` runs if the endpoint is invalidated (at once
    /// when it already was).
    pub fn bind(&self, on_cancel: impl FnOnce() + Send + 'static) {
        if self.state.done.load(Ordering::SeqCst) {
            on_cancel();
            return;
        }
        self.state
            .hooks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Box::new(on_cancel));
        // An invalidation between the check and the push would have missed the hook.
        if self.state.done.load(Ordering::SeqCst) {
            let hooks = std::mem::take(
                &mut *self
                    .state
                    .hooks
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner),
            );
            for h in hooks {
                h();
            }
        }
    }

    /// True while the incarnation this lease was issued for is still the current one.
    pub fn current(&self) -> bool {
        if self.state.done.load(Ordering::SeqCst) {
            return false;
        }
        let g = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        match g.entries.get(&self.key) {
            Some(cur) => {
                !self.drains.iter().any(|d| g.draining.contains(d))
                    && cur.incarnation == self.endpoint.incarnation
                    && cur.generation == self.endpoint.generation
            }
            None => false,
        }
    }

    pub fn release(&self) {
        if self.state.done.swap(true, Ordering::SeqCst) {
            return;
        }
        self.state
            .hooks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
        let mut g = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(set) = g.leases.get_mut(&self.key) {
            set.retain(|s| !Arc::ptr_eq(s, &self.state));
        }
    }
}

#[derive(Clone, Default)]
pub struct EndpointTable {
    inner: Arc<Mutex<Inner>>,
}

impl std::fmt::Debug for EndpointTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EndpointTable").finish_non_exhaustive()
    }
}

impl EndpointTable {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Make an endpoint available. The caller verified the container (see [`publish_from_observation`]).
    pub fn publish(&self, key: &EndpointKey, endpoint: Endpoint) {
        let mut g = self.lock();
        g.entries.insert(key.key_string(), endpoint);
        g.draining.remove(&key.drain_key(false));
        g.draining.remove(&key.drain_key(true));
    }

    pub fn lookup(&self, key: &EndpointKey) -> Option<Endpoint> {
        let g = self.lock();
        if g.draining.contains(&key.drain_key(false)) || g.draining.contains(&key.drain_key(true)) {
            return None;
        }
        g.entries.get(&key.key_string()).cloned()
    }

    /// Take a lease on the current endpoint, or `None` (the proxy answers 503).
    pub fn acquire(&self, key: &EndpointKey) -> Option<Lease> {
        let endpoint = self.lookup(key)?;
        let k = key.key_string();
        let state = Arc::new(LeaseState {
            done: AtomicBool::new(false),
            hooks: Mutex::new(Vec::new()),
        });
        self.lock()
            .leases
            .entry(k.clone())
            .or_default()
            .push(Arc::clone(&state));
        Some(Lease {
            endpoint,
            key: k,
            drains: [key.drain_key(false), key.drain_key(true)],
            state,
            inner: Arc::clone(&self.inner),
        })
    }

    /// Stop admitting, drop the endpoint, and cancel every connection and pending dial for the service.
    pub fn invalidate(&self, service_id: &str, env: Option<EndpointEnv>, component: Option<&str>) {
        let hit = |k: &str| {
            let mut parts = k.split('/');
            let (k_env, k_service, k_component) = (parts.next(), parts.next(), parts.next());
            k_service == Some(service_id)
                && env.is_none_or(|e| k_env == Some(e.as_str()))
                && component.is_none_or(|c| k_component == Some(c))
        };
        let mut cancel: Vec<Arc<LeaseState>> = Vec::new();
        {
            let mut g = self.lock();
            let entry_keys: Vec<String> = g.entries.keys().filter(|k| hit(k)).cloned().collect();
            for k in entry_keys {
                g.entries.remove(&k);
                if let Some(set) = g.leases.remove(&k) {
                    cancel.extend(set);
                }
            }
            let lease_keys: Vec<String> = g.leases.keys().filter(|k| hit(k)).cloned().collect();
            for k in lease_keys {
                if let Some(set) = g.leases.remove(&k) {
                    cancel.extend(set);
                }
            }
        }
        // Hooks run outside the lock: a hook may call back into the table.
        for s in cancel {
            s.cancel();
        }
    }

    /// The first step of a stop, replace, update or rollback: refuse new connections, close the old ones.
    pub fn begin_stop(&self, service_id: &str, env: EndpointEnv, component: Option<&str>) {
        self.lock()
            .draining
            .insert(drain_key(service_id, env, component));
        self.invalidate(service_id, Some(env), component);
    }

    /// Leases currently open for a service (tests, diagnostics).
    pub fn open_leases(&self, service_id: &str) -> usize {
        let g = self.lock();
        g.leases
            .iter()
            .filter(|(k, _)| k.split('/').nth(1) == Some(service_id))
            .map(|(_, v)| v.len())
            .sum()
    }
}

// ---------------------------------------------------------------------------------------------
// Address ownership

fn parse_ip(ip: &str) -> Option<u32> {
    let mut out: u32 = 0;
    let mut n: u8 = 0;
    for part in ip.split('.') {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let v: u32 = part.parse().ok()?;
        if v > 255 {
            return None;
        }
        out = (out << 8) | v;
        n = n.saturating_add(1);
    }
    (n == 4).then_some(out)
}

fn format_ip(n: u32) -> String {
    let b = n.to_be_bytes();
    format!("{}.{}.{}.{}", b[0], b[1], b[2], b[3])
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PoolError {
    BadSubnet(String),
    Full,
}

impl std::fmt::Display for PoolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadSubnet(m) => write!(f, "{m}"),
            Self::Full => write!(f, "no free address on the app network"),
        }
    }
}

impl std::error::Error for PoolError {}

/// One pool per bridge. An owner (a service, or one component of a group) keeps its address until it
/// is released; a released address is quarantined before another owner can get it.
#[derive(Debug)]
pub struct AddressPool {
    first: u32,
    last: u32,
    by_owner: BTreeMap<String, String>,
    by_ip: BTreeMap<String, String>,
    quarantine: BTreeMap<String, u64>,
    reserved: BTreeSet<String>,
    quarantine_ms: u64,
}

impl AddressPool {
    pub const DEFAULT_QUARANTINE_MS: u64 = 60_000;

    pub fn new(subnet: &str, reserved: &[&str], quarantine_ms: u64) -> Result<Self, PoolError> {
        let bad = || PoolError::BadSubnet(format!("bad subnet {subnet:?}"));
        let (addr, bits) = subnet.split_once('/').ok_or_else(bad)?;
        let base_ip = parse_ip(addr).ok_or_else(bad)?;
        if bits.is_empty() || !bits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(bad());
        }
        let bits: u32 = bits.parse().map_err(|_| bad())?;
        if !(16..=29).contains(&bits) {
            return Err(PoolError::BadSubnet(format!(
                "subnet /{bits} is outside the supported range"
            )));
        }
        let host_bits = 32u32.saturating_sub(bits);
        let mask = u32::MAX.checked_shl(host_bits).unwrap_or(0);
        let base = base_ip & mask;
        let size = 1u32.checked_shl(host_bits).unwrap_or(0);
        Ok(Self {
            // The network address and the conventional gateway .1 are never given out; nor is the broadcast address.
            first: base.saturating_add(2),
            last: base.saturating_add(size).saturating_sub(2),
            by_owner: BTreeMap::new(),
            by_ip: BTreeMap::new(),
            quarantine: BTreeMap::new(),
            reserved: reserved.iter().map(|s| (*s).to_string()).collect(),
            quarantine_ms,
        })
    }

    /// The owner's address, assigned on first use.
    pub fn assign(&mut self, owner: &str, now_ms: u64) -> Result<String, PoolError> {
        if let Some(have) = self.by_owner.get(owner) {
            return Ok(have.clone());
        }
        self.quarantine.retain(|_, until| *until > now_ms);
        let mut n = self.first;
        while n <= self.last {
            let ip = format_ip(n);
            if !(self.by_ip.contains_key(&ip)
                || self.quarantine.contains_key(&ip)
                || self.reserved.contains(&ip))
            {
                self.by_owner.insert(owner.to_string(), ip.clone());
                self.by_ip.insert(ip.clone(), owner.to_string());
                return Ok(ip);
            }
            n = n.saturating_add(1);
            if n == 0 {
                break;
            }
        }
        Err(PoolError::Full)
    }

    /// Every owner whose name starts with `prefix` (a service and all of its components).
    pub fn release_prefix(&mut self, prefix: &str, now_ms: u64) {
        let owners: Vec<String> = self
            .by_owner
            .keys()
            .filter(|o| o.starts_with(prefix))
            .cloned()
            .collect();
        for o in owners {
            self.release(&o, now_ms);
        }
    }

    /// An address a container already holds that this process did not give out (it survived a restart,
    /// or was left by an earlier run). Nothing is assigned it until the owner is released or the container is gone.
    pub fn occupy(&mut self, ip: &str, tag: &str) {
        if self.by_ip.contains_key(ip) {
            return;
        }
        self.by_ip.insert(ip.to_string(), format!("engine:{tag}"));
    }

    /// A container already holds `ip` for `owner` (the owner is known from the container's name and service label).
    pub fn adopt(&mut self, owner: &str, ip: &str) {
        if self.by_owner.contains_key(owner) || self.by_ip.contains_key(ip) {
            self.occupy(ip, owner);
            return;
        }
        self.by_owner.insert(owner.to_string(), ip.to_string());
        self.by_ip.insert(ip.to_string(), owner.to_string());
    }

    /// The engine no longer has the container behind an occupied address.
    pub fn vacate(&mut self, ip: &str) {
        if self.by_ip.get(ip).is_some_and(|o| o.starts_with("engine:")) {
            self.by_ip.remove(ip);
        }
    }

    pub fn owner_of(&self, ip: &str) -> Option<&str> {
        self.by_ip.get(ip).map(String::as_str)
    }

    pub fn address_of(&self, owner: &str) -> Option<&str> {
        self.by_owner.get(owner).map(String::as_str)
    }

    /// Only for a service that is being deleted. The address stays out of use for the quarantine.
    pub fn release(&mut self, owner: &str, now_ms: u64) {
        let Some(ip) = self.by_owner.remove(owner) else {
            return;
        };
        self.by_ip.remove(&ip);
        self.quarantine
            .insert(ip, now_ms.saturating_add(self.quarantine_ms));
    }
}

// ---------------------------------------------------------------------------------------------
// What the engine says about a container (typed; raw inspect output never leaves this function)

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerObservation {
    pub container_id: String,
    pub generation: Option<i64>,
    pub service_label: Option<String>,
    pub running: bool,
    pub started_at: String,
    /// Network name -> the container's IPv4 on it.
    pub addresses: BTreeMap<String, String>,
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// JavaScript's `Number(text)` for a generation label that is a plain decimal integer; `None` for
/// anything that is not a safe integer.
fn label_number(text: &str) -> Option<i64> {
    let t = text.trim();
    if t.is_empty() {
        return Some(0);
    }
    let f: f64 = t.parse().ok()?;
    if !f.is_finite() || f.fract() != 0.0 || f.abs() > MAX_SAFE_INTEGER {
        return None;
    }
    Some(f as i64)
}

fn is_ipv4_text(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// The fields the resolver needs from `inspect --format {{json .}}`, in Docker's and Podman's shared shape.
pub fn parse_observation(json: &str) -> Option<ContainerObservation> {
    let raw: serde_json::Value = serde_json::from_str(json).ok()?;
    let c = match &raw {
        serde_json::Value::Array(a) => a.first()?,
        v => v,
    };
    let obj = c.as_object()?;
    let state = obj.get("State").and_then(|v| v.as_object());
    let labels = obj
        .get("Config")
        .and_then(|v| v.get("Labels"))
        .and_then(|v| v.as_object());
    let mut addresses = BTreeMap::new();
    if let Some(nets) = obj
        .get("NetworkSettings")
        .and_then(|v| v.get("Networks"))
        .and_then(|v| v.as_object())
    {
        for (name, n) in nets {
            if let Some(ip) = n.get("IPAddress").and_then(|v| v.as_str())
                && is_ipv4_text(ip)
            {
                addresses.insert(name.clone(), ip.to_string());
            }
        }
    }
    let generation = labels
        .and_then(|l| l.get(LABEL_GENERATION))
        .and_then(|v| v.as_str())
        .and_then(label_number);
    let id = obj
        .get("Id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())?;
    Some(ContainerObservation {
        container_id: id.to_string(),
        generation,
        service_label: labels
            .and_then(|l| l.get(LABEL_SERVICE))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        running: state
            .and_then(|s| s.get("Running"))
            .and_then(|v| v.as_bool())
            == Some(true),
        started_at: state
            .and_then(|s| s.get("StartedAt"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        addresses,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedContainer {
    pub service_id: String,
    pub container: String,
    pub network: String,
    /// Podman: the address the pool assigned; the container must be there and nowhere else. `None`: Docker's loopback publish.
    pub address: Option<String>,
    pub port: u16,
    pub generation: i64,
    /// Docker only: a container an earlier release created carries no labels. It is accepted as the service's own only if
    /// it has none at all (a container labelled for another service is still refused).
    pub unlabelled: bool,
}

/// Whether the engine's record is the container the controller expects (labels, deploy, running, place);
/// `None` when it is, else the reason it is not.
pub fn matches_expected(o: &ContainerObservation, want: &ExpectedContainer) -> Option<String> {
    if want.unlabelled {
        if o.service_label.is_some() || o.generation.is_some() {
            return Some("the container is labelled for another deploy".into());
        }
    } else {
        if o.service_label.as_deref() != Some(want.service_id.as_str()) {
            return Some("the container is not labelled for this service".into());
        }
        if o.generation != Some(want.generation) {
            return Some("the container belongs to another deploy".into());
        }
    }
    if !o.running {
        return Some("the container is not running".into());
    }
    let Some(ip) = o.addresses.get(&want.network) else {
        return Some(format!("the container is not on {}", want.network));
    };
    if let Some(a) = &want.address
        && ip != a
    {
        return Some("the container is not at the address assigned to its service".into());
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PublishResult {
    Ok(Endpoint),
    Refused(String),
}

/// Publish an endpoint only for the container the controller created: right service label, this
/// deploy's generation, running, and on the expected network at the address the pool assigned.
/// Anything else is not published (the proxy answers 503).
pub fn publish_from_observation(
    table: &EndpointTable,
    key: &EndpointKey,
    want: &ExpectedContainer,
    observed: Option<&ContainerObservation>,
) -> PublishResult {
    let Some(o) = observed else {
        return PublishResult::Refused("the engine has no such container".into());
    };
    if let Some(bad) = matches_expected(o, want) {
        return PublishResult::Refused(bad);
    }
    let host = match &want.address {
        None => "127.0.0.1".to_string(),
        Some(_) => o.addresses.get(&want.network).cloned().unwrap_or_default(),
    };
    let endpoint = Endpoint {
        host,
        port: want.port,
        generation: want.generation,
        incarnation: format!("{}:{}", o.container_id, o.started_at),
    };
    table.publish(key, endpoint.clone());
    PublishResult::Ok(endpoint)
}

/// Keeps the table true to the engine. Each published endpoint is checked against its container: gone,
/// stopped, relabelled or moved means invalidated (connections closed); the same container started
/// again means a NEW incarnation, so the old one's connections close and the new one is published.
#[derive(Debug)]
pub struct EndpointReconciler {
    table: EndpointTable,
    watched: BTreeMap<String, (EndpointKey, ExpectedContainer)>,
}

impl EndpointReconciler {
    pub fn new(table: EndpointTable) -> Self {
        Self {
            table,
            watched: BTreeMap::new(),
        }
    }

    pub fn watch(&mut self, key: EndpointKey, want: ExpectedContainer) {
        self.watched.insert(key.key_string(), (key, want));
    }

    pub fn unwatch(&mut self, service_id: &str, env: Option<EndpointEnv>, component: Option<&str>) {
        self.watched.retain(|_, (k, _)| {
            !(k.service_id == service_id
                && env.is_none_or(|e| k.env == e)
                && component.is_none_or(|c| k.component == c))
        });
    }

    /// One pass over the watched endpoints; `observe` is the engine's answer for a container name.
    pub fn tick(&mut self, observe: &mut dyn FnMut(&str) -> Option<ContainerObservation>) {
        for (key, want) in self.watched.values() {
            let before = self.table.lookup(key);
            let o = observe(&want.container);
            let Some(o) = o.filter(|o| matches_expected(o, want).is_none()) else {
                if before.is_some() {
                    self.table
                        .invalidate(&key.service_id, Some(key.env), Some(&key.component));
                }
                continue;
            };
            let incarnation = format!("{}:{}", o.container_id, o.started_at);
            if before.as_ref().is_none_or(|b| b.incarnation != incarnation) {
                if before.is_some() {
                    self.table
                        .invalidate(&key.service_id, Some(key.env), Some(&key.component));
                }
                publish_from_observation(&self.table, key, want, Some(&o));
            }
        }
    }
}

/// A number no earlier deploy of this process (or, by the clock, an earlier process) has had.
pub fn next_generation(last: &mut i64, now_ms: i64) -> i64 {
    *last = last.saturating_add(1).max(now_ms);
    *last
}

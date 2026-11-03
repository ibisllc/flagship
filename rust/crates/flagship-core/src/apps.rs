//! App reconciliation on an arch-v2 box (G3/R2): desired workloads against what the engine runs,
//! one journalled effect at a time, with the address pool, scheduling and generations owned here.
//!
//! The daemon is the executor, not a controller. It tells core what it wants (a snapshot of
//! desired workloads, each with an opaque digest of its full spec), what the engine shows (typed
//! observations) and the networks and capacity it has. Core answers with effects (deploy this
//! workload at this generation and address, remove that generation), journals each as intent
//! before handing it out, and is told the outcome. The daemon performs only the effects core hands
//! it, so there is one writer: core, through its journal, fenced by its controller term.
//!
//! Modes (the owner's `reconciler` setting, docs/architecture-v2/broker-runtime-core.md §11):
//! - `shadow` (default): core keeps the desired state, compares it with the engine and journals each
//!   change of verdict; it hands out no effect. The daemon deploys as before.
//! - `rust`: on the first sync in this mode core adopts what runs (generation, address), then owns
//!   every effect. Back to `shadow` turns its effects off at once; what runs keeps running.
//!
//! Crash rules: an intent handed to an executor that is gone (a daemon restart: a new executor id)
//! or left by an earlier core is settled from what the engine shows. Deploy and remove name one
//! generation, and a container name is unique, so redoing either never makes a second copy and
//! never removes another generation's container.

use crate::endpoints::{AddressPool, next_generation};
use crate::journal::{Journal, JournalError, store};
use crate::schedule::{self, Capacity, Fit};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// How long a failed or abandoned deploy of one workload waits before the next try, doubling up to
/// [`MAX_BACKOFF_MS`].
pub const FIRST_BACKOFF_MS: u64 = 5_000;
pub const MAX_BACKOFF_MS: u64 = 5 * 60_000;
/// Consecutive agreeing shadow passes before the cut-over rule lets `rust` mode start.
pub const CUTOVER_AGREE_PASSES: u64 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    App,
    LocalAi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    Shadow,
    Rust,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resources {
    pub memory_bytes: u64,
    pub cpu_millis: u64,
}

/// One workload the daemon wants, keyed by installation and component.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesiredWorkload {
    pub installation: String,
    pub component: String,
    pub kind: Kind,
    /// The bridge it joins; its address comes from that network's pool.
    pub network: String,
    /// SHA-256 (hex) of the daemon's full spec: a change means a new deploy.
    pub spec_digest: String,
    pub running: bool,
    /// Raised by the daemon for an explicit restart of the same spec.
    pub epoch: u64,
    #[serde(default)]
    pub resources: Resources,
    /// Podman: the container gets its own address from the pool. Docker publishes a port instead.
    pub wants_address: bool,
}

/// One container as the engine reports it (`docker|podman inspect`, parsed by the daemon).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedContainer {
    pub name: String,
    pub container_id: String,
    pub installation: String,
    pub component: String,
    pub generation: Option<i64>,
    pub running: bool,
    #[serde(default)]
    pub started_at: String,
    /// Network name -> IPv4 on it.
    #[serde(default)]
    pub addresses: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkInfo {
    pub name: String,
    pub subnet: String,
    #[serde(default)]
    pub gateways: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncRequest {
    /// Random per daemon process: an intent handed to another executor is settled by observation.
    pub executor: String,
    pub mode: Mode,
    #[serde(default)]
    pub desired: Vec<DesiredWorkload>,
    /// Workloads the daemon dropped for good (an uninstall): removed, then forgotten.
    #[serde(default)]
    pub forget: Vec<WorkloadKey>,
    #[serde(default)]
    pub observed: Vec<ObservedContainer>,
    #[serde(default)]
    pub networks: Vec<NetworkInfo>,
    /// Addresses containers core does not own hold on its networks (staging copies, builds).
    #[serde(default)]
    pub occupied: Vec<OccupiedAddress>,
    #[serde(default)]
    pub capacity: Capacity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OccupiedAddress {
    pub network: String,
    pub ip: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkloadKey {
    pub installation: String,
    pub component: String,
}

impl WorkloadKey {
    pub fn id(&self) -> String {
        format!("{}/{}", self.installation, self.component)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EffectKind {
    Deploy,
    Remove,
}

impl EffectKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Deploy => "deploy",
            Self::Remove => "remove",
        }
    }
}

/// One effect for the executor. A deploy creates and starts the workload's container labelled
/// with `generation`, with `address` on its network when given; a remove stops and deletes the
/// container of exactly `generation`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub op: i64,
    pub kind: EffectKind,
    pub installation: String,
    pub component: String,
    pub generation: i64,
    pub spec_digest: Option<String>,
    pub epoch: u64,
    pub network: String,
    pub address: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Ok,
    /// The effect certainly did not happen.
    Definite,
    /// Nobody knows; the engine is asked at the next sync.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettleRequest {
    pub executor: String,
    pub op: i64,
    pub outcome: Outcome,
    #[serde(default)]
    pub detail: Option<String>,
    /// The engine said this address is held by something the pool did not place.
    #[serde(default)]
    pub conflict_ip: Option<String>,
}

/// What core says about one workload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadStatus {
    pub installation: String,
    pub component: String,
    /// running, pending, stopped, unschedulable, failed, waiting (an effect is with the executor)
    pub state: String,
    pub generation: Option<i64>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    pub mode: Mode,
    /// True once core owns the effects (rust mode, after adoption).
    pub live: bool,
    pub effects: Vec<Effect>,
    pub workloads: Vec<WorkloadStatus>,
    /// Shadow: where core and the engine disagree (`<key>: <what core would do>`).
    pub divergent: Vec<String>,
    /// Consecutive shadow passes with nothing divergent (the cut-over rule reads it).
    pub agree_passes: u64,
    /// Containers with a Flagship label that nobody wants: reported, never touched.
    pub unmanaged: Vec<String>,
    pub term: u64,
}

#[derive(Debug, Clone)]
struct Deployed {
    generation: i64,
    spec_digest: String,
    epoch: u64,
    network: String,
    address: Option<String>,
}

#[derive(Debug, Clone)]
struct OpRow {
    id: i64,
    key: String,
    kind: EffectKind,
    generation: i64,
    spec_digest: Option<String>,
    epoch: u64,
    network: String,
    address: Option<String>,
    executor: String,
    state: String,
    updated_at: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum AppsError {
    #[error(transparent)]
    Journal(#[from] JournalError),
    #[error("bad request: {0}")]
    Bad(String),
}

fn valid_name(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !s.starts_with('-')
}

fn valid_network(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

fn valid_hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl DesiredWorkload {
    pub fn key(&self) -> WorkloadKey {
        WorkloadKey {
            installation: self.installation.clone(),
            component: self.component.clone(),
        }
    }

    pub fn validate(&self) -> Result<(), AppsError> {
        if !valid_name(&self.installation, 160) || !valid_name(&self.component, 64) {
            return Err(AppsError::Bad(format!(
                "bad workload name {}/{}",
                self.installation, self.component
            )));
        }
        if !valid_network(&self.network) {
            return Err(AppsError::Bad(format!("bad network {}", self.network)));
        }
        if !valid_hex64(&self.spec_digest) {
            return Err(AppsError::Bad("spec digest is not 64 lowercase hex".into()));
        }
        Ok(())
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn i(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

fn u(v: i64) -> u64 {
    u64::try_from(v).unwrap_or(0)
}

/// The app reconciler: owns the journal (and with it the controller term) and the address pools.
#[derive(Debug)]
pub struct AppController {
    journal: Journal,
    pools: BTreeMap<String, AddressPool>,
    /// Per network, the addresses others held at the last sync (vacated once they are gone).
    foreign: BTreeMap<String, BTreeSet<String>>,
    clock: fn() -> u64,
}

impl AppController {
    pub fn new(journal: Journal) -> Self {
        Self {
            journal,
            pools: BTreeMap::new(),
            foreign: BTreeMap::new(),
            clock: now_ms,
        }
    }

    /// For tests: a fixed or stepped clock.
    pub fn with_clock(journal: Journal, clock: fn() -> u64) -> Self {
        Self {
            journal,
            pools: BTreeMap::new(),
            foreign: BTreeMap::new(),
            clock,
        }
    }

    pub fn journal(&mut self) -> &mut Journal {
        &mut self.journal
    }

    pub fn live(&self) -> Result<bool, AppsError> {
        Ok(self.journal.meta("apps_live")?.as_deref() == Some("1"))
    }

    fn agree_passes(&self) -> Result<u64, AppsError> {
        Ok(self
            .journal
            .meta("apps_agree_passes")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0))
    }

    // ---- store ------------------------------------------------------------------------------

    fn upsert_desired(&mut self, d: &DesiredWorkload, now: u64) -> Result<(), AppsError> {
        let body = serde_json::to_string(d).map_err(|e| AppsError::Bad(e.to_string()))?;
        let tx = self.journal.write()?;
        tx.execute(
            "INSERT INTO app_desired (key, body, forgotten, updated_at) VALUES (?1, ?2, 0, ?3)
             ON CONFLICT (key) DO UPDATE SET body = excluded.body, forgotten = 0, updated_at = excluded.updated_at
             WHERE app_desired.body != excluded.body OR app_desired.forgotten != 0",
            params![d.key().id(), body, i(now)],
        )
        .map_err(store)?;
        tx.commit().map_err(store)?;
        Ok(())
    }

    fn mark_forgotten(&mut self, key: &WorkloadKey, now: u64) -> Result<(), AppsError> {
        let tx = self.journal.write()?;
        tx.execute(
            "UPDATE app_desired SET forgotten = 1, updated_at = ?2 WHERE key = ?1",
            params![key.id(), i(now)],
        )
        .map_err(store)?;
        tx.commit().map_err(store)?;
        Ok(())
    }

    fn desired_all(&self) -> Result<Vec<(DesiredWorkload, bool)>, AppsError> {
        let mut st = self
            .journal
            .conn()
            .prepare("SELECT body, forgotten FROM app_desired ORDER BY key")
            .map_err(store)?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(store)?;
        let mut out = Vec::new();
        for row in rows {
            let (body, forgotten) = row.map_err(store)?;
            let d: DesiredWorkload = serde_json::from_str(&body)
                .map_err(|e| JournalError::Corrupt(format!("desired workload: {e}")))?;
            out.push((d, forgotten != 0));
        }
        Ok(out)
    }

    fn drop_desired(&mut self, key: &str) -> Result<(), AppsError> {
        let tx = self.journal.write()?;
        tx.execute("DELETE FROM app_desired WHERE key = ?1", [key])
            .map_err(store)?;
        tx.execute("DELETE FROM app_deployed WHERE key = ?1", [key])
            .map_err(store)?;
        tx.commit().map_err(store)?;
        Ok(())
    }

    fn deployed(&self, key: &str) -> Result<Option<Deployed>, AppsError> {
        Ok(self
            .journal
            .conn()
            .query_row(
                "SELECT generation, spec_digest, epoch, network, address FROM app_deployed WHERE key = ?1",
                [key],
                |r| {
                    Ok(Deployed {
                        generation: r.get(0)?,
                        spec_digest: r.get(1)?,
                        epoch: u(r.get(2)?),
                        network: r.get(3)?,
                        address: r.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(store)?)
    }

    fn set_deployed(&mut self, key: &str, d: &Deployed, adopted: bool) -> Result<(), AppsError> {
        let tx = self.journal.write()?;
        tx.execute(
            "INSERT INTO app_deployed (key, generation, spec_digest, epoch, network, address, adopted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (key) DO UPDATE SET generation = excluded.generation, spec_digest = excluded.spec_digest, epoch = excluded.epoch,
               network = excluded.network, address = excluded.address, adopted = excluded.adopted",
            params![key, d.generation, d.spec_digest, i(d.epoch), d.network, d.address, i64::from(adopted)],
        )
        .map_err(store)?;
        tx.commit().map_err(store)?;
        Ok(())
    }

    fn clear_deployed(&mut self, key: &str, generation: i64) -> Result<(), AppsError> {
        let tx = self.journal.write()?;
        tx.execute(
            "DELETE FROM app_deployed WHERE key = ?1 AND generation = ?2",
            params![key, generation],
        )
        .map_err(store)?;
        tx.commit().map_err(store)?;
        Ok(())
    }

    fn ops_where(&self, clause: &str, key: Option<&str>) -> Result<Vec<OpRow>, AppsError> {
        let sql = format!("SELECT {OP_COLUMNS} FROM app_ops WHERE {clause} ORDER BY id");
        let mut st = self.journal.conn().prepare(&sql).map_err(store)?;
        let rows = match key {
            Some(k) => st
                .query_map([k], op_row)
                .map_err(store)?
                .collect::<Result<Vec<_>, _>>(),
            None => st
                .query_map([], op_row)
                .map_err(store)?
                .collect::<Result<Vec<_>, _>>(),
        };
        Ok(rows.map_err(store)?)
    }

    fn intent(
        &mut self,
        key: &str,
        e: &Effect,
        executor: &str,
        now: u64,
    ) -> Result<i64, AppsError> {
        let term = self.journal.term();
        let tx = self.journal.write()?;
        tx.execute(
            "INSERT INTO app_ops (key, kind, generation, spec_digest, epoch, network, address, executor, state, term, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'intent', ?9, ?10, ?10)",
            params![key, e.kind.as_str(), e.generation, e.spec_digest, i(e.epoch), e.network, e.address, executor, i(term), i(now)],
        )
        .map_err(store)?;
        let id = tx.last_insert_rowid();
        tx.commit().map_err(store)?;
        Ok(id)
    }

    fn settle_op(
        &mut self,
        id: i64,
        state: &str,
        detail: Option<&str>,
        now: u64,
    ) -> Result<(), AppsError> {
        let tx = self.journal.write()?;
        tx.execute(
            "UPDATE app_ops SET state = ?2, detail = ?3, updated_at = ?4 WHERE id = ?1 AND state = 'intent'",
            params![id, state, detail, i(now)],
        )
        .map_err(store)?;
        tx.commit().map_err(store)?;
        Ok(())
    }

    fn persist_address(
        &mut self,
        network: &str,
        owner: &str,
        ip: Option<&str>,
    ) -> Result<(), AppsError> {
        let tx = self.journal.write()?;
        match ip {
            Some(ip) => tx.execute(
                "INSERT INTO app_addresses (network, owner, ip) VALUES (?1, ?2, ?3)
                 ON CONFLICT (network, owner) DO UPDATE SET ip = excluded.ip",
                params![network, owner, ip],
            ),
            None => tx.execute(
                "DELETE FROM app_addresses WHERE network = ?1 AND owner = ?2",
                params![network, owner],
            ),
        }
        .map_err(store)?;
        tx.commit().map_err(store)?;
        Ok(())
    }

    fn persisted_addresses(&self, network: &str) -> Result<Vec<(String, String)>, AppsError> {
        let mut st = self
            .journal
            .conn()
            .prepare("SELECT owner, ip FROM app_addresses WHERE network = ?1 ORDER BY owner")
            .map_err(store)?;
        let rows = st
            .query_map([network], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(store)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(store)?;
        Ok(rows)
    }

    // ---- the pass ---------------------------------------------------------------------------

    /// Build each network's pool from the persisted assignments and what containers hold.
    fn refresh_pools(&mut self, req: &SyncRequest) -> Result<(), AppsError> {
        for n in &req.networks {
            if !valid_network(&n.name) || self.pools.contains_key(&n.name) {
                continue;
            }
            let reserved: Vec<&str> = n.gateways.iter().map(String::as_str).collect();
            let Ok(mut pool) =
                AddressPool::new(&n.subnet, &reserved, AddressPool::DEFAULT_QUARANTINE_MS)
            else {
                continue;
            };
            for (owner, ip) in self.persisted_addresses(&n.name)? {
                pool.adopt(&owner, &ip);
            }
            self.pools.insert(n.name.clone(), pool);
        }
        let mut foreign: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for a in &req.occupied {
            if let Some(pool) = self.pools.get_mut(&a.network)
                && pool.owner_of(&a.ip).is_none()
            {
                pool.occupy(&a.ip, "engine");
            }
            foreign
                .entry(a.network.clone())
                .or_default()
                .insert(a.ip.clone());
        }
        for (net, before) in &self.foreign {
            let now_held = foreign.get(net);
            if let Some(pool) = self.pools.get_mut(net) {
                for ip in before {
                    if now_held.is_none_or(|h| !h.contains(ip)) {
                        pool.vacate(ip);
                    }
                }
            }
        }
        self.foreign = foreign;
        for o in &req.observed {
            let owner = format!("{}/{}", o.installation, o.component);
            for (net, ip) in &o.addresses {
                if let Some(pool) = self.pools.get_mut(net)
                    && pool.owner_of(ip).is_none_or(|have| have != owner)
                    && pool.address_of(&owner) != Some(ip.as_str())
                {
                    pool.occupy(ip, &o.name);
                }
            }
        }
        Ok(())
    }

    fn address_for(&mut self, d: &DesiredWorkload, now: u64) -> Result<Option<String>, String> {
        if !d.wants_address {
            return Ok(None);
        }
        let owner = d.key().id();
        let pool = self
            .pools
            .get_mut(&d.network)
            .ok_or_else(|| format!("the {} network's subnet is not known yet", d.network))?;
        let ip = pool.assign(&owner, now).map_err(|e| e.to_string())?;
        self.persist_address(&d.network, &owner, Some(&ip))
            .map_err(|e| e.to_string())?;
        Ok(Some(ip))
    }

    fn release_address(&mut self, network: &str, owner: &str, now: u64) -> Result<(), AppsError> {
        if let Some(pool) = self.pools.get_mut(network) {
            pool.release(owner, now);
        }
        self.persist_address(network, owner, None)
    }

    /// Settle intents whose executor is gone, from what the engine shows now.
    fn recover(
        &mut self,
        executor: &str,
        seen: &BTreeMap<String, &ObservedContainer>,
        now: u64,
    ) -> Result<(), AppsError> {
        for op in self.ops_where("state = 'intent'", None)? {
            if op.executor == executor {
                continue;
            }
            let obs = seen.get(&op.key);
            match op.kind {
                EffectKind::Deploy => {
                    if obs.is_some_and(|o| o.generation == Some(op.generation)) {
                        self.settle_op(
                            op.id,
                            "done",
                            Some("inspection: the container it deployed exists"),
                            now,
                        )?;
                        let d = Deployed {
                            generation: op.generation,
                            spec_digest: op.spec_digest.clone().unwrap_or_default(),
                            epoch: op.epoch,
                            network: op.network.clone(),
                            address: op.address.clone(),
                        };
                        self.set_deployed(&op.key, &d, false)?;
                    } else {
                        self.settle_op(
                            op.id,
                            "abandoned",
                            Some("interrupted before the engine created it; decided again"),
                            now,
                        )?;
                    }
                }
                EffectKind::Remove => {
                    let still = obs.is_some_and(|o| o.generation == Some(op.generation));
                    if still {
                        self.settle_op(
                            op.id,
                            "abandoned",
                            Some("interrupted; the container is still there, decided again"),
                            now,
                        )?;
                    } else {
                        self.settle_op(
                            op.id,
                            "done",
                            Some("inspection: the container is gone"),
                            now,
                        )?;
                        self.clear_deployed(&op.key, op.generation)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// On the first sync in rust mode: adopt each wanted workload that runs, so nothing restarts.
    fn adopt_running(
        &mut self,
        desired: &BTreeMap<String, DesiredWorkload>,
        seen: &BTreeMap<String, &ObservedContainer>,
    ) -> Result<Vec<String>, AppsError> {
        let mut adopted = Vec::new();
        for (key, d) in desired {
            let Some(o) = seen.get(key) else { continue };
            let Some(generation) = o.generation else {
                continue;
            };
            if !o.running || !d.running || self.deployed(key)?.is_some() {
                continue;
            }
            let address = o.addresses.get(&d.network).cloned();
            if let Some(ip) = &address {
                if let Some(pool) = self.pools.get_mut(&d.network) {
                    pool.adopt(key, ip);
                }
                self.persist_address(&d.network, key, Some(ip))?;
            }
            let rec = Deployed {
                generation,
                spec_digest: d.spec_digest.clone(),
                epoch: d.epoch,
                network: d.network.clone(),
                address,
            };
            self.set_deployed(key, &rec, true)?;
            adopted.push(key.clone());
        }
        Ok(adopted)
    }

    fn backoff_until(&self, key: &str) -> Result<Option<u64>, AppsError> {
        let ops = self.ops_where("key = ?1 AND kind = 'deploy'", Some(key))?;
        let mut misses: u32 = 0;
        let mut last = 0u64;
        for op in ops.iter().rev() {
            // Only a definite refusal counts: an effect lost with its executor is not the app's fault.
            match op.state.as_str() {
                "abandoned" => {}
                "failed" => {
                    misses = misses.saturating_add(1);
                    last = last.max(op.updated_at);
                }
                _ => break,
            }
        }
        if misses == 0 {
            return Ok(None);
        }
        let shift = misses.saturating_sub(1).min(16);
        let wait = FIRST_BACKOFF_MS
            .checked_shl(shift)
            .unwrap_or(MAX_BACKOFF_MS)
            .min(MAX_BACKOFF_MS);
        Ok(Some(last.saturating_add(wait)))
    }

    fn validate(req: &SyncRequest) -> Result<(), AppsError> {
        if req.executor.is_empty() || req.executor.len() > 64 {
            return Err(AppsError::Bad("bad executor id".into()));
        }
        let mut keys = BTreeSet::new();
        for d in &req.desired {
            d.validate()?;
            if !keys.insert(d.key()) {
                return Err(AppsError::Bad(format!("{} is listed twice", d.key().id())));
            }
        }
        for o in &req.observed {
            if !valid_name(&o.installation, 160) || !valid_name(&o.component, 64) {
                return Err(AppsError::Bad(format!("bad observed workload {}", o.name)));
            }
        }
        Ok(())
    }

    /// One pass for the executor that called.
    pub fn sync(&mut self, req: &SyncRequest) -> Result<SyncResponse, AppsError> {
        Self::validate(req)?;
        let now = (self.clock)();
        for d in &req.desired {
            self.upsert_desired(d, now)?;
        }
        for k in &req.forget {
            self.mark_forgotten(k, now)?;
        }
        let all = self.desired_all()?;
        let forgotten: BTreeSet<String> = all
            .iter()
            .filter(|(_, f)| *f)
            .map(|(d, _)| d.key().id())
            .collect();
        let desired: BTreeMap<String, DesiredWorkload> =
            all.into_iter().map(|(d, _)| (d.key().id(), d)).collect();
        // One container per key is what the engine allows (the name is unique); if two carry a
        // key, the running one wins.
        let mut seen: BTreeMap<String, &ObservedContainer> = BTreeMap::new();
        for o in &req.observed {
            let k = format!("{}/{}", o.installation, o.component);
            let keep = seen.get(&k).is_none_or(|prev| !prev.running && o.running);
            if keep {
                seen.insert(k, o);
            }
        }
        self.refresh_pools(req)?;
        let unmanaged: Vec<String> = seen
            .iter()
            .filter(|(k, _)| !desired.contains_key(*k))
            .map(|(_, o)| o.name.clone())
            .collect();

        let mut was_live = self.live()?;
        if req.mode == Mode::Shadow && was_live {
            self.journal.set_meta("apps_live", "0")?;
            was_live = false;
        }
        if req.mode == Mode::Shadow {
            return self.shadow_pass(&desired, &forgotten, &seen, unmanaged, now);
        }
        self.recover(&req.executor, &seen, now)?;
        if !was_live {
            self.adopt_running(&desired, &seen)?;
            self.journal.set_meta("apps_live", "1")?;
        }

        let outstanding: BTreeMap<String, OpRow> = self
            .ops_where("state = 'intent'", None)?
            .into_iter()
            .map(|o| (o.key.clone(), o))
            .collect();
        let mut effects = Vec::new();
        let mut statuses = Vec::new();
        // An uninstall of something core never had a record of (it ran before core's time): its
        // labelled container still goes, by its exact generation.
        for k in &req.forget {
            let id = k.id();
            if desired.contains_key(&id) || outstanding.contains_key(&id) {
                continue;
            }
            let Some(o) = seen.get(&id) else { continue };
            let e = Effect {
                op: 0,
                kind: EffectKind::Remove,
                installation: k.installation.clone(),
                component: k.component.clone(),
                generation: o.generation.unwrap_or(0),
                spec_digest: None,
                epoch: 0,
                network: o.addresses.keys().next().cloned().unwrap_or_default(),
                address: None,
            };
            let op = self.intent(&id, &e, &req.executor, now)?;
            effects.push(Effect { op, ..e });
        }
        let mut committed = self.committed_memory(&desired, &seen)?;
        for (key, d) in &desired {
            let status =
                |state: &str, generation: Option<i64>, reason: Option<String>| WorkloadStatus {
                    installation: d.installation.clone(),
                    component: d.component.clone(),
                    state: state.to_owned(),
                    generation,
                    reason,
                };
            if let Some(op) = outstanding.get(key) {
                statuses.push(status(
                    "waiting",
                    Some(op.generation),
                    Some(format!("{} with the executor", op.kind.as_str())),
                ));
                // Hand the same effect again only to the executor it was given to (it lost its answer).
                if op.executor == req.executor {
                    effects.push(effect_of(op, d));
                }
                continue;
            }
            let obs = seen.get(key).copied();
            let rec = self.deployed(key)?;
            let gone = forgotten.contains(key);
            if gone || !d.running {
                if let Some(o) = obs {
                    let generation = o.generation.unwrap_or(0);
                    let e = Effect {
                        op: 0,
                        kind: EffectKind::Remove,
                        installation: d.installation.clone(),
                        component: d.component.clone(),
                        generation,
                        spec_digest: None,
                        epoch: d.epoch,
                        network: d.network.clone(),
                        address: None,
                    };
                    let id = self.intent(key, &e, &req.executor, now)?;
                    effects.push(Effect { op: id, ..e });
                    statuses.push(status("pending", Some(generation), Some("removing".into())));
                } else if gone {
                    if let Some(r) = &rec {
                        self.clear_deployed(key, r.generation)?;
                    }
                    self.release_address(&d.network, key, now)?;
                    self.drop_desired(key)?;
                } else {
                    statuses.push(status("stopped", None, None));
                }
                continue;
            }
            let current = match (&rec, obs) {
                (Some(r), Some(o)) => {
                    o.generation == Some(r.generation)
                        && r.spec_digest == d.spec_digest
                        && r.epoch == d.epoch
                        && o.running
                }
                _ => false,
            };
            if current {
                statuses.push(status("running", rec.as_ref().map(|r| r.generation), None));
                continue;
            }
            if let Some(o) = obs {
                // A container of another generation, an old spec, or one that stopped: it goes first.
                let generation = o.generation.unwrap_or(0);
                let e = Effect {
                    op: 0,
                    kind: EffectKind::Remove,
                    installation: d.installation.clone(),
                    component: d.component.clone(),
                    generation,
                    spec_digest: None,
                    epoch: d.epoch,
                    network: d.network.clone(),
                    address: None,
                };
                let id = self.intent(key, &e, &req.executor, now)?;
                effects.push(Effect { op: id, ..e });
                statuses.push(status(
                    "pending",
                    Some(generation),
                    Some("replacing".into()),
                ));
                continue;
            }
            if let Some(until) = self.backoff_until(key)?
                && now < until
            {
                let last = self
                    .ops_where("key = ?1 AND kind = 'deploy'", Some(key))?
                    .into_iter()
                    .last();
                let why = last
                    .and_then(|o| self.op_detail(o.id).ok().flatten())
                    .unwrap_or_else(|| "the last deploy failed".into());
                statuses.push(status("failed", None, Some(why)));
                continue;
            }
            let others = committed
                .iter()
                .filter(|(k, _)| *k != key)
                .map(|(_, m)| *m)
                .fold(0u64, u64::saturating_add);
            if let Fit::No(reason) = schedule::fits(&req.capacity, others, &d.resources) {
                statuses.push(status("unschedulable", None, Some(reason)));
                continue;
            }
            let address = match self.address_for(d, now) {
                Ok(a) => a,
                Err(reason) => {
                    statuses.push(status("unschedulable", None, Some(reason)));
                    continue;
                }
            };
            let mut last: i64 = self
                .journal
                .meta("apps_last_generation")?
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let generation = next_generation(&mut last, i(now));
            self.journal
                .set_meta("apps_last_generation", &last.to_string())?;
            let e = Effect {
                op: 0,
                kind: EffectKind::Deploy,
                installation: d.installation.clone(),
                component: d.component.clone(),
                generation,
                spec_digest: Some(d.spec_digest.clone()),
                epoch: d.epoch,
                network: d.network.clone(),
                address,
            };
            let id = self.intent(key, &e, &req.executor, now)?;
            effects.push(Effect { op: id, ..e });
            committed.insert(key.clone(), d.resources.memory_bytes);
            statuses.push(status(
                "pending",
                Some(generation),
                Some("deploying".into()),
            ));
        }
        Ok(SyncResponse {
            mode: Mode::Rust,
            live: true,
            effects,
            workloads: statuses,
            divergent: Vec::new(),
            agree_passes: self.agree_passes()?,
            unmanaged,
            term: self.journal.term(),
        })
    }

    fn op_detail(&self, id: i64) -> Result<Option<String>, AppsError> {
        Ok(self
            .journal
            .conn()
            .query_row("SELECT detail FROM app_ops WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(store)?
            .flatten())
    }

    /// Memory already promised: every running wanted workload's limit.
    fn committed_memory(
        &self,
        desired: &BTreeMap<String, DesiredWorkload>,
        seen: &BTreeMap<String, &ObservedContainer>,
    ) -> Result<BTreeMap<String, u64>, AppsError> {
        Ok(desired
            .iter()
            .filter(|(k, d)| d.running && seen.get(*k).is_some_and(|o| o.running))
            .map(|(k, d)| (k.clone(), d.resources.memory_bytes))
            .collect())
    }

    fn shadow_pass(
        &mut self,
        desired: &BTreeMap<String, DesiredWorkload>,
        forgotten: &BTreeSet<String>,
        seen: &BTreeMap<String, &ObservedContainer>,
        unmanaged: Vec<String>,
        now: u64,
    ) -> Result<SyncResponse, AppsError> {
        let mut divergent = Vec::new();
        let mut statuses = Vec::new();
        for (key, d) in desired {
            let o = seen.get(key);
            let want = d.running && !forgotten.contains(key);
            let running = o.is_some_and(|o| o.running);
            let (state, verdict) = match (want, running) {
                (true, true) => ("running", None),
                (false, false) => ("stopped", None),
                (true, false) => (
                    "pending",
                    Some(format!("{key}: would deploy (the engine runs none)")),
                ),
                (false, true) => (
                    "pending",
                    Some(format!(
                        "{key}: would remove (not wanted, the engine runs it)"
                    )),
                ),
            };
            statuses.push(WorkloadStatus {
                installation: d.installation.clone(),
                component: d.component.clone(),
                state: state.into(),
                generation: o.and_then(|o| o.generation),
                reason: verdict.clone(),
            });
            if let Some(v) = verdict {
                divergent.push(v);
            }
            if forgotten.contains(key) && !running {
                self.drop_desired(key)?;
            }
        }
        let passes = if divergent.is_empty() {
            self.agree_passes()?.saturating_add(1)
        } else {
            0
        };
        self.journal
            .set_meta("apps_agree_passes", &passes.to_string())?;
        let summary = if divergent.is_empty() {
            "agree".to_owned()
        } else {
            divergent.join("; ")
        };
        if self.journal.meta("apps_last_shadow")?.as_deref() != Some(summary.as_str()) {
            self.journal.set_meta("apps_last_shadow", &summary)?;
            if let Ok(id) = flagship_runtime::InstallationId::parse("apps") {
                self.journal.record_shadow(&id, &summary, now / 1000)?;
            }
        }
        Ok(SyncResponse {
            mode: Mode::Shadow,
            live: false,
            effects: Vec::new(),
            workloads: statuses,
            divergent,
            agree_passes: passes,
            unmanaged,
            term: self.journal.term(),
        })
    }

    /// The executor's report of one effect.
    pub fn settle(&mut self, s: &SettleRequest) -> Result<(), AppsError> {
        let now = (self.clock)();
        let row = self
            .journal
            .conn()
            .query_row(
                &format!("SELECT {OP_COLUMNS} FROM app_ops WHERE id = ?1"),
                [s.op],
                op_row,
            )
            .optional()
            .map_err(store)?;
        let Some(op) = row else {
            return Err(AppsError::Bad(format!("no operation {}", s.op)));
        };
        if op.executor != s.executor {
            return Err(AppsError::Bad(
                "this operation was handed to another executor".into(),
            ));
        }
        if op.state != "intent" {
            return Ok(());
        }
        let detail = s
            .detail
            .as_deref()
            .map(|d| d.chars().take(2000).collect::<String>());
        match (s.outcome, op.kind) {
            (Outcome::Ok, EffectKind::Deploy) => {
                self.settle_op(op.id, "done", detail.as_deref(), now)?;
                let d = Deployed {
                    generation: op.generation,
                    spec_digest: op.spec_digest.clone().unwrap_or_default(),
                    epoch: op.epoch,
                    network: op.network.clone(),
                    address: op.address.clone(),
                };
                self.set_deployed(&op.key, &d, false)?;
            }
            (Outcome::Ok, EffectKind::Remove) => {
                self.settle_op(op.id, "done", detail.as_deref(), now)?;
                self.clear_deployed(&op.key, op.generation)?;
            }
            // The engine refused the address core picked because something it doesn't own holds it:
            // not the app's failure, so no back-off; the next pass deploys at another address.
            (Outcome::Definite, EffectKind::Deploy) if s.conflict_ip.is_some() => {
                self.settle_op(op.id, "abandoned", detail.as_deref(), now)?;
            }
            (Outcome::Definite, _) => {
                self.settle_op(op.id, "failed", detail.as_deref(), now)?;
            }
            (Outcome::Unknown, _) => {
                self.settle_op(op.id, "abandoned", detail.as_deref(), now)?;
            }
        }
        if let Some(ip) = &s.conflict_ip
            && let Some(pool) = self.pools.get_mut(&op.network)
        {
            pool.occupy(ip, "unknown-holder");
            pool.release(&op.key, now);
            self.persist_address(&op.network, &op.key, None)?;
        }
        Ok(())
    }

    /// For the status file and the daemon: mode, ownership and the shadow agreement count.
    pub fn summary(&self) -> Result<serde_json::Value, AppsError> {
        let open = self.ops_where("state = 'intent'", None)?.len();
        let desired = self.desired_all()?.len();
        Ok(serde_json::json!({
            "live": self.live()?,
            "agreePasses": self.agree_passes()?,
            "cutoverPasses": CUTOVER_AGREE_PASSES,
            "lastShadow": self.journal.meta("apps_last_shadow")?,
            "desired": desired,
            "openEffects": open,
            "term": self.journal.term(),
        }))
    }
}

const OP_COLUMNS: &str =
    "id, key, kind, generation, spec_digest, epoch, network, address, executor, state, updated_at";

fn op_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<OpRow> {
    Ok(OpRow {
        id: r.get(0)?,
        key: r.get(1)?,
        kind: if r.get::<_, String>(2)? == "deploy" {
            EffectKind::Deploy
        } else {
            EffectKind::Remove
        },
        generation: r.get(3)?,
        spec_digest: r.get(4)?,
        epoch: u(r.get(5)?),
        network: r.get(6)?,
        address: r.get(7)?,
        executor: r.get(8)?,
        state: r.get(9)?,
        updated_at: u(r.get(10)?),
    })
}

fn effect_of(op: &OpRow, d: &DesiredWorkload) -> Effect {
    Effect {
        op: op.id,
        kind: op.kind,
        installation: d.installation.clone(),
        component: d.component.clone(),
        generation: op.generation,
        spec_digest: op.spec_digest.clone(),
        epoch: op.epoch,
        network: op.network.clone(),
        address: op.address.clone(),
    }
}

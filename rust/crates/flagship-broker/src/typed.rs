//! The v2 typed operations (IMPLEMENTATION-PLAN.md §4.2). Every effect independently verifies a
//! signed capability bound to the exact object it acts on (plan digest, policy digest, volume
//! binding, release, shutdown action), its installation and generation, the revision it expects
//! and the revocation epoch, and then consumes it before acting. The envelope's own fields grant
//! nothing: they must agree with the signed capability or the request is refused.

use crate::audit::Audit;
use crate::capability::{AuthorityError, Capability, CapabilityVerifier, EpochStatement, OpKind};
use crate::fsobj::SafeDir;
use crate::netpolicy::NetworkPolicy;
use crate::peer::Peer;
use crate::server::{Connection, ConnectionFactory, Reply};
use crate::state::{AdmitUpdate, BrokerState, PostUpdate, Refusal, ScopeRow};
use crate::wire::encode_frame;
use flagship_runtime::exec::{Exec, Executor};
use flagship_runtime::plan::{ExecutionPlan, NetworkAttachment};
use flagship_runtime::{
    Digest, FilesVolumeName, InstallationId, ResolvedNetwork, ResolvedWorkload, Runtime,
    RuntimeError, SandboxDns, SecretHandle, VolumeId, WorkloadName, WorkloadState,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const TYPED_PROTOCOL_VERSION: u64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Code {
    BadRequest,
    UnknownOp,
    UnsupportedVersion,
    Expired,
    Forbidden,
    BadSignature,
    Revoked,
    Replayed,
    Stale,
    Conflict,
    Unsupported,
    Failed,
    TimedOut,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypedError {
    pub code: Code,
    pub message: String,
}

fn err(code: Code, message: impl Into<String>) -> TypedError {
    TypedError {
        code,
        message: message.into(),
    }
}

impl From<AuthorityError> for TypedError {
    fn from(e: AuthorityError) -> Self {
        let code = match e {
            AuthorityError::Malformed(_) => Code::BadRequest,
            _ => Code::BadSignature,
        };
        err(code, e.to_string())
    }
}

impl From<Refusal> for TypedError {
    fn from(r: Refusal) -> Self {
        match r {
            Refusal::Revoked { epoch, current } => err(
                Code::Revoked,
                format!("the capability's epoch {epoch} is revoked (now {current})"),
            ),
            Refusal::Replayed => err(Code::Replayed, "this capability was already used"),
            Refusal::Stale { expected, found } => err(
                Code::Stale,
                format!("the capability expects revision {expected}; the broker is at {found}"),
            ),
            Refusal::Store(m) => err(
                Code::Failed,
                format!("the broker's state store failed: {m}"),
            ),
        }
    }
}

impl From<RuntimeError> for TypedError {
    fn from(e: RuntimeError) -> Self {
        let code = match e {
            RuntimeError::Conflict => Code::Conflict,
            RuntimeError::Unsupported(_) => Code::Unsupported,
            RuntimeError::TimedOut { .. } => Code::TimedOut,
            RuntimeError::Refused(_) => Code::Forbidden,
            _ => Code::Failed,
        };
        err(code, e.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub installation: Option<InstallationId>,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope {
    pub protocol_version: u64,
    pub request_id: String,
    pub op: String,
    pub operation_ref: String,
    pub target: Target,
    pub expected_revision: u64,
    pub deadline_unix_ms: u64,
    #[serde(default)]
    pub payload: Map<String, Value>,
    #[serde(default)]
    pub capability: Option<Capability>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VolumePayload {
    volume_id: VolumeId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PolicyPayload {
    policy: NetworkPolicy,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartPayload {
    plan: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StopPayload {
    remove: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleasePayload {
    commit: String,
    release_digest: Digest,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ShutdownAction {
    Poweroff,
    Reboot,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShutdownPayload {
    action: ShutdownAction,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EpochPayload {
    statement: EpochStatement,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

fn payload<T: for<'de> Deserialize<'de>>(p: &Map<String, Value>) -> Result<T, TypedError> {
    serde_json::from_value(Value::Object(p.clone()))
        .map_err(|e| err(Code::BadRequest, format!("bad payload: {e}")))
}

/// The subjects capabilities bind for objects that are not plans or policies.
pub fn volume_subject(
    installation: &InstallationId,
    volume: &VolumeId,
    name: &FilesVolumeName,
) -> Digest {
    Digest::of(
        format!(
            "flagship/app-volume/v1|{installation}|{volume}|{}",
            name.as_str()
        )
        .as_bytes(),
    )
}
pub fn stop_subject(installation: &InstallationId, generation: u64, remove: bool) -> Digest {
    Digest::of(
        format!(
            "flagship/stop-workload/v1|{installation}|{generation}|{}",
            if remove { "remove" } else { "keep" }
        )
        .as_bytes(),
    )
}
pub fn release_subject(generation: u64, commit: &str, release: &Digest) -> Digest {
    Digest::of(format!("flagship/activate-release/v1|{generation}|{commit}|{release}").as_bytes())
}
pub fn shutdown_subject(action: &str) -> Digest {
    Digest::of(format!("flagship/request-shutdown/v1|{action}").as_bytes())
}

pub trait Clock: Send + Sync {
    fn now_unix(&self) -> u64;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_unix(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

/// Secret values by handle. A handle resolves only for the installation that owns it.
pub trait SecretStore: Send + Sync {
    fn resolve(&self, installation: &InstallationId, handle: &SecretHandle) -> Option<String>;
}

/// The egress gateway's address on the apps bridge, once it is up (today's `sandboxRunArgs`).
pub trait SandboxNetwork: Send + Sync {
    fn apps_sandbox(&self) -> Option<SandboxDns>;
}

#[derive(Debug, Clone)]
pub struct BrokerConfig {
    /// Where files-volume images are mounted (`/var/lib/flagship-files`).
    pub files_root: PathBuf,
    /// The broker's own state (`/var/lib/flagship-broker`).
    pub state_dir: PathBuf,
    /// Refuse a volume whose folder is not a mounted image (fail closed, as loopVolumes.ts).
    pub require_mounted_volumes: bool,
    pub app_uid: u32,
    pub app_gid: u32,
    pub max_capability_lifetime_secs: u64,
    pub clock_skew_secs: u64,
    pub max_deadline_secs: u64,
}

impl BrokerConfig {
    pub fn production(files_root: PathBuf, state_dir: PathBuf) -> Self {
        Self {
            files_root,
            state_dir,
            require_mounted_volumes: true,
            app_uid: 10001,
            app_gid: 10001,
            max_capability_lifetime_secs: 15 * 60,
            clock_skew_secs: 60,
            max_deadline_secs: 10 * 60,
        }
    }
}

pub struct TypedBroker {
    pub config: BrokerConfig,
    state: Mutex<BrokerState>,
    effects: Mutex<()>,
    verifier: Box<dyn CapabilityVerifier>,
    runtime: Box<dyn Runtime>,
    host: Box<dyn Executor>,
    secrets: Box<dyn SecretStore>,
    network: Box<dyn SandboxNetwork>,
    clock: Box<dyn Clock>,
    audit: Arc<Audit>,
}

impl std::fmt::Debug for TypedBroker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TypedBroker")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

#[allow(missing_debug_implementations)]
pub struct Parts {
    pub verifier: Box<dyn CapabilityVerifier>,
    pub runtime: Box<dyn Runtime>,
    pub host: Box<dyn Executor>,
    pub secrets: Box<dyn SecretStore>,
    pub network: Box<dyn SandboxNetwork>,
    pub clock: Box<dyn Clock>,
    pub audit: Arc<Audit>,
}

fn scope_of(installation: Option<&InstallationId>) -> String {
    installation.map_or_else(|| "host".to_owned(), |i| format!("app:{i}"))
}

fn is_token(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b':')
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl TypedBroker {
    pub fn new(config: BrokerConfig, state: BrokerState, parts: Parts) -> Self {
        Self {
            config,
            state: Mutex::new(state),
            effects: Mutex::new(()),
            verifier: parts.verifier,
            runtime: parts.runtime,
            host: parts.host,
            secrets: parts.secrets,
            network: parts.network,
            clock: parts.clock,
            audit: parts.audit,
        }
    }

    /// Answer one frame from an authenticated peer.
    pub fn handle(&self, peer: &Peer, raw: &Value) -> Value {
        let request_id = raw
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|s| is_token(s, 64))
            .unwrap_or_default()
            .to_owned();
        let (op, outcome) = match self.dispatch(raw) {
            Ok((op, v)) => (op, Ok(v)),
            Err((op, e)) => (op, Err(e)),
        };
        let mut a = Map::new();
        a.insert("op".into(), Value::from(op.clone()));
        a.insert("peerUid".into(), Value::from(peer.uid));
        a.insert("requestId".into(), Value::from(request_id.clone()));
        if let Some(i) = raw
            .get("target")
            .and_then(|t| t.get("installation"))
            .and_then(Value::as_str)
        {
            a.insert(
                "installation".into(),
                Value::from(crate::js::slice_units(i, 80)),
            );
        }
        match outcome {
            Ok(result) => {
                a.insert("ok".into(), Value::from(true));
                self.audit.record(a);
                json!({ "requestId": request_id, "ok": true, "result": result })
            }
            Err(e) => {
                a.insert("ok".into(), Value::from(false));
                a.insert(
                    "code".into(),
                    serde_json::to_value(e.code).unwrap_or_default(),
                );
                self.audit.record(a);
                json!({ "requestId": request_id, "ok": false, "code": e.code, "message": e.message })
            }
        }
    }

    fn dispatch(&self, raw: &Value) -> Result<(String, Value), (String, TypedError)> {
        let op_name = raw
            .get("op")
            .and_then(Value::as_str)
            .map(|s| crate::js::slice_units(s, 40).to_owned())
            .unwrap_or_default();
        let tag = |e: TypedError| (op_name.clone(), e);
        if !raw.is_object() {
            return Err(tag(err(Code::BadRequest, "request must be an object")));
        }
        if raw.get("protocolVersion").and_then(Value::as_u64) != Some(TYPED_PROTOCOL_VERSION) {
            return Err(tag(err(
                Code::UnsupportedVersion,
                "this socket speaks typed protocol version 2 only",
            )));
        }
        let env: Envelope = serde_json::from_value(raw.clone())
            .map_err(|e| tag(err(Code::BadRequest, format!("bad request: {e}"))))?;
        if !is_token(&env.request_id, 64) || !is_token(&env.operation_ref, 128) {
            return Err(tag(err(
                Code::BadRequest,
                "requestId and operationRef are short tokens",
            )));
        }
        let now = self.clock.now_unix();
        let deadline = env.deadline_unix_ms / 1000;
        if deadline < now {
            return Err(tag(err(Code::Expired, "the request's deadline has passed")));
        }
        if deadline > now.saturating_add(self.config.max_deadline_secs) {
            return Err(tag(err(
                Code::BadRequest,
                "the request's deadline is too far away",
            )));
        }
        let result = match env.op.as_str() {
            "Describe" => self.describe(&env),
            "ListWorkloads" => self.list(&env),
            "AdvanceRevocationEpoch" => self.advance_epoch(&env),
            "PrepareAppVolume" => self.prepare_volume(&env, now),
            "ApplyNetworkPolicy" => self.apply_policy(&env, now),
            "StartApprovedWorkload" => self.start(&env, now),
            "StopWorkload" => self.stop(&env, now),
            "ActivateRelease" => self.activate_release(&env, now),
            "RequestShutdown" => self.shutdown(&env, now),
            _ => Err(err(Code::UnknownOp, "unknown operation")),
        };
        result.map(|v| (op_name.clone(), v)).map_err(tag)
    }

    /// Everything about a capability that can be checked without the state store.
    fn authorize<'a>(
        &self,
        env: &'a Envelope,
        kind: OpKind,
        subject: &Digest,
        now: u64,
    ) -> Result<&'a Capability, TypedError> {
        let cap = env
            .capability
            .as_ref()
            .ok_or_else(|| err(Code::Forbidden, "this operation needs a capability"))?;
        cap.check_shape()?;
        self.verifier.verify(&cap.signed_bytes(), &cap.signature)?;
        if cap.op != kind {
            return Err(err(
                Code::Forbidden,
                "the capability is for another operation",
            ));
        }
        if env.target.installation != cap.installation
            || env.target.generation != cap.generation
            || env.expected_revision != cap.expected_prior_revision
        {
            return Err(err(
                Code::Forbidden,
                "the request does not match its capability",
            ));
        }
        if &cap.subject != subject {
            return Err(err(
                Code::Forbidden,
                "the capability is for a different object",
            ));
        }
        if cap.expires_at.saturating_sub(cap.not_before) > self.config.max_capability_lifetime_secs
        {
            return Err(err(
                Code::Expired,
                "the capability lives longer than this broker accepts",
            ));
        }
        if now.saturating_add(self.config.clock_skew_secs) < cap.not_before || now >= cap.expires_at
        {
            return Err(err(Code::Expired, "the capability is not valid now"));
        }
        Ok(cap)
    }

    fn installation<'a>(&self, env: &'a Envelope) -> Result<&'a InstallationId, TypedError> {
        env.target
            .installation
            .as_ref()
            .ok_or_else(|| err(Code::BadRequest, "this operation names an installation"))
    }

    /// The scope's state, with the capability's expected revision checked up front so a stale
    /// request is refused before anything (even a runtime inspection) happens. `admit` checks it
    /// again inside its transaction.
    fn scope_row(&self, scope: &str, cap: &Capability) -> Result<ScopeRow, TypedError> {
        let st = lock(&self.state);
        if st.is_consumed(&cap.id)? {
            return Err(Refusal::Replayed.into());
        }
        let row = st.scope(scope)?;
        if row.revision != cap.expected_prior_revision {
            return Err(Refusal::Stale {
                expected: cap.expected_prior_revision,
                found: row.revision,
            }
            .into());
        }
        Ok(row)
    }

    fn admit(
        &self,
        cap: &Capability,
        scope: &str,
        now: u64,
        update: &AdmitUpdate,
    ) -> Result<i64, TypedError> {
        Ok(lock(&self.state).admit(cap, scope, now, update)?)
    }

    fn finish<T>(
        &self,
        effect: i64,
        r: Result<T, TypedError>,
        post: &PostUpdate,
    ) -> Result<T, TypedError> {
        let (outcome, post) = match &r {
            Ok(_) => ("ok".to_owned(), post.clone()),
            Err(e) => (
                format!("failed: {}", crate::js::slice_units(&e.message, 200)),
                PostUpdate::Nothing,
            ),
        };
        lock(&self.state).finish(effect, &outcome, &post)?;
        r
    }

    fn describe(&self, env: &Envelope) -> Result<Value, TypedError> {
        payload::<Empty>(&env.payload)?;
        let scope = scope_of(env.target.installation.as_ref());
        let st = lock(&self.state);
        let row = st.scope(&scope)?;
        let epoch = st.epoch()?;
        let volume = match &env.target.installation {
            Some(i) => st.volume_of(i)?.map(
                |v| json!({ "volumeId": v.volume_id.as_str(), "name": v.name, "ready": v.ready }),
            ),
            None => None,
        };
        Ok(json!({
            "scope": scope,
            "revision": row.revision,
            "admittedGeneration": row.admitted_generation,
            "admittedPlan": row.admitted_plan.map(|d| d.to_string()),
            "policyDigest": row.policy_digest.map(|d| d.to_string()),
            "revocationEpoch": epoch,
            "volume": volume,
        }))
    }

    fn list(&self, env: &Envelope) -> Result<Value, TypedError> {
        payload::<Empty>(&env.payload)?;
        let items: Vec<Value> = self
            .runtime
            .list()?
            .into_iter()
            .map(|o| {
                json!({
                    "runtimeId": o.runtime_id,
                    "name": o.name.as_str(),
                    "installation": o.installation.as_str(),
                    "generation": o.generation,
                    "planDigest": o.plan_digest.map(|d| d.to_string()),
                    "state": o.state.as_str(),
                })
            })
            .collect();
        Ok(json!({ "workloads": items }))
    }

    fn advance_epoch(&self, env: &Envelope) -> Result<Value, TypedError> {
        let p: EpochPayload = payload(&env.payload)?;
        if p.statement.epoch > i64::MAX as u64 {
            return Err(err(Code::BadRequest, "epoch out of range"));
        }
        self.verifier
            .verify(&p.statement.signed_bytes(), &p.statement.signature)?;
        let epoch = lock(&self.state).advance_epoch(p.statement.epoch)?;
        Ok(json!({ "revocationEpoch": epoch }))
    }

    fn not_stale(row: &ScopeRow, generation: u64) -> Result<(), TypedError> {
        if generation < row.admitted_generation {
            return Err(err(
                Code::Stale,
                format!(
                    "generation {generation} is older than the admitted {}",
                    row.admitted_generation
                ),
            ));
        }
        Ok(())
    }

    fn prepare_volume(&self, env: &Envelope, now: u64) -> Result<Value, TypedError> {
        let p: VolumePayload = payload(&env.payload)?;
        let inst = self.installation(env)?;
        let name = FilesVolumeName::for_installation(inst)
            .map_err(|e| err(Code::BadRequest, e.to_string()))?;
        let cap = self.authorize(
            env,
            OpKind::PrepareAppVolume,
            &volume_subject(inst, &p.volume_id, &name),
            now,
        )?;
        let _effects = lock(&self.effects);
        let scope = scope_of(Some(inst));
        Self::not_stale(&self.scope_row(&scope, cap)?, cap.generation)?;
        {
            let st = lock(&self.state);
            if let Some(v) = st.volume(&p.volume_id)?
                && &v.installation != inst
            {
                return Err(err(
                    Code::Forbidden,
                    "that volume belongs to another installation",
                ));
            }
            if let Some(v) = st.volume_of(inst)?
                && v.volume_id != p.volume_id
            {
                return Err(err(
                    Code::Forbidden,
                    "this installation already has a different volume",
                ));
            }
        }
        let update = AdmitUpdate::RegisterVolume {
            volume_id: p.volume_id.clone(),
            installation: inst.clone(),
            name: name.as_str().to_owned(),
        };
        let effect = self.admit(cap, &scope, now, &update)?;
        let r = self.prepare_volume_effect(&name, inst);
        self.finish(
            effect,
            r,
            &PostUpdate::VolumeReady {
                volume_id: p.volume_id.clone(),
            },
        )?;
        Ok(
            json!({ "volume": name.as_str(), "revision": cap.expected_prior_revision.saturating_add(1) }),
        )
    }

    fn prepare_volume_effect(
        &self,
        name: &FilesVolumeName,
        inst: &InstallationId,
    ) -> Result<(), TypedError> {
        let io = |what: &str, e: std::io::Error| err(Code::Failed, format!("{what}: {e}"));
        let root = SafeDir::open_root(&self.config.files_root).map_err(|e| io("files root", e))?;
        let mount = root
            .open_child(name.as_str())
            .map_err(|e| io("the volume's image is not mounted", e))?;
        if self.config.require_mounted_volumes
            && !mount
                .is_mount_below(&root)
                .map_err(|e| io("mount check", e))?
        {
            return Err(err(
                Code::Failed,
                "the volume's image is not mounted, so its folder would land on the box's disk",
            ));
        }
        let data = mount
            .ensure_child("data", 0o700)
            .map_err(|e| io("data folder", e))?;
        data.set_owner_and_mode(self.config.app_uid, self.config.app_gid, 0o700)
            .map_err(|e| io("data folder ownership", e))?;
        self.runtime.ensure_files_volume(name, inst)?;
        Ok(())
    }

    fn apply_policy(&self, env: &Envelope, now: u64) -> Result<Value, TypedError> {
        let p: PolicyPayload = payload(&env.payload)?;
        let inst = self.installation(env)?;
        p.policy.validate().map_err(|e| err(Code::BadRequest, e))?;
        if &p.policy.installation != inst || p.policy.generation != env.target.generation {
            return Err(err(
                Code::Forbidden,
                "the policy is for another installation or generation",
            ));
        }
        let digest = p.policy.digest();
        let cap = self.authorize(env, OpKind::ApplyNetworkPolicy, &digest, now)?;
        let _effects = lock(&self.effects);
        let scope = scope_of(Some(inst));
        Self::not_stale(&self.scope_row(&scope, cap)?, cap.generation)?;
        let effect = self.admit(cap, &scope, now, &AdmitUpdate::Nothing)?;
        let r = (|| {
            let body =
                serde_json::to_vec(&p.policy).map_err(|e| err(Code::Failed, e.to_string()))?;
            let root = SafeDir::open_root(&self.config.state_dir)
                .map_err(|e| err(Code::Failed, format!("state dir: {e}")))?;
            let dir = root
                .ensure_child("egress", 0o750)
                .map_err(|e| err(Code::Failed, format!("egress dir: {e}")))?;
            dir.write_atomic(&format!("{inst}.json"), &body)
                .map_err(|e| err(Code::Failed, format!("egress policy: {e}")))
        })();
        self.finish(
            effect,
            r,
            &PostUpdate::PolicyInstalled {
                scope: scope.clone(),
                digest,
            },
        )?;
        Ok(
            json!({ "policyDigest": digest.to_string(), "revision": cap.expected_prior_revision.saturating_add(1) }),
        )
    }

    fn start(&self, env: &Envelope, now: u64) -> Result<Value, TypedError> {
        let p: StartPayload = payload(&env.payload)?;
        let plan =
            ExecutionPlan::from_value(&p.plan).map_err(|e| err(Code::Forbidden, e.to_string()))?;
        let inst = self.installation(env)?;
        if &plan.installation != inst || plan.generation != env.target.generation {
            return Err(err(
                Code::Forbidden,
                "the plan is for another installation or generation",
            ));
        }
        let digest = plan.digest();
        let cap = self.authorize(env, OpKind::StartApprovedWorkload, &digest, now)?;
        let _effects = lock(&self.effects);
        let scope = scope_of(Some(inst));
        let row = self.scope_row(&scope, cap)?;
        let same_plan_again =
            plan.generation == row.admitted_generation && row.admitted_plan == Some(digest);
        if plan.generation <= row.admitted_generation && !same_plan_again {
            return Err(err(
                Code::Stale,
                format!(
                    "generation {} is not newer than the admitted {}",
                    plan.generation, row.admitted_generation
                ),
            ));
        }
        if row.policy_digest != Some(plan.network_policy_digest) {
            return Err(err(
                Code::Forbidden,
                "the plan's network policy is not the one installed for this app",
            ));
        }
        let mut volumes = Vec::new();
        for claim in &plan.volumes {
            let v = lock(&self.state).volume(&claim.id)?.ok_or_else(|| {
                err(
                    Code::Forbidden,
                    format!("volume {} is not prepared", claim.id),
                )
            })?;
            if &v.installation != inst {
                return Err(err(
                    Code::Forbidden,
                    "that volume belongs to another installation",
                ));
            }
            if !v.ready {
                return Err(err(
                    Code::Forbidden,
                    format!("volume {} is not ready", claim.id),
                ));
            }
            volumes.push((
                claim.id.clone(),
                FilesVolumeName::parse(&v.name).map_err(|e| err(Code::Failed, e.to_string()))?,
            ));
        }
        let mut secrets = Vec::new();
        for s in &plan.secrets {
            let value = self.secrets.resolve(inst, &s.handle).ok_or_else(|| {
                err(
                    Code::Forbidden,
                    format!("secret {} does not belong to this installation", s.handle),
                )
            })?;
            secrets.push((s.handle.clone(), value));
        }
        let network = match plan.capabilities.network {
            NetworkAttachment::Apps => ResolvedNetwork::Apps {
                sandbox: self.network.apps_sandbox(),
            },
            NetworkAttachment::None => ResolvedNetwork::None,
        };
        let workload = ResolvedWorkload::resolve(&plan, network, &volumes, &secrets)?;
        let existing = self.runtime.inspect(workload.name())?;
        if let Some(o) = &existing
            && o.plan_digest != Some(digest)
        {
            return Err(err(
                Code::Conflict,
                "another generation of this app is still there; stop and remove it first",
            ));
        }
        let effect = self.admit(
            cap,
            &scope,
            now,
            &AdmitUpdate::Generation {
                generation: plan.generation,
                plan: Some(digest),
            },
        )?;
        let r = (|| -> Result<String, TypedError> {
            match existing {
                Some(o) if o.state == WorkloadState::Running => Ok(o.runtime_id),
                Some(o) => {
                    self.runtime.start(workload.name())?;
                    Ok(o.runtime_id)
                }
                None => {
                    self.runtime.prepare_image(&plan.image)?;
                    let id = self.runtime.create(&workload)?;
                    self.runtime.start(workload.name())?;
                    Ok(id)
                }
            }
        })();
        let id = self.finish(effect, r, &PostUpdate::Nothing)?;
        Ok(
            json!({ "runtimeId": id, "planDigest": digest.to_string(), "revision": cap.expected_prior_revision.saturating_add(1) }),
        )
    }

    fn stop(&self, env: &Envelope, now: u64) -> Result<Value, TypedError> {
        let p: StopPayload = payload(&env.payload)?;
        let inst = self.installation(env)?;
        let cap = self.authorize(
            env,
            OpKind::StopWorkload,
            &stop_subject(inst, env.target.generation, p.remove),
            now,
        )?;
        let _effects = lock(&self.effects);
        let scope = scope_of(Some(inst));
        let row = self.scope_row(&scope, cap)?;
        if cap.generation != row.admitted_generation {
            return Err(err(
                Code::Stale,
                format!(
                    "generation {} is not the admitted {}",
                    cap.generation, row.admitted_generation
                ),
            ));
        }
        let name = WorkloadName::for_installation(inst);
        let existing = self.runtime.inspect(&name)?;
        if let Some(o) = &existing
            && o.generation.is_some_and(|g| g != cap.generation)
        {
            return Err(err(
                Code::Stale,
                "the running workload is another generation",
            ));
        }
        let effect = self.admit(cap, &scope, now, &AdmitUpdate::Nothing)?;
        let r = (|| -> Result<(), TypedError> {
            if existing.is_none() {
                return Ok(());
            }
            match self.runtime.stop(&name, 10) {
                Ok(()) | Err(RuntimeError::NotFound) => {}
                Err(e) => return Err(e.into()),
            }
            if p.remove {
                match self.runtime.delete(&name) {
                    Ok(()) | Err(RuntimeError::NotFound) => {}
                    Err(e) => return Err(e.into()),
                }
            }
            Ok(())
        })();
        self.finish(effect, r, &PostUpdate::Nothing)?;
        Ok(
            json!({ "stopped": existing.is_some(), "removed": p.remove, "revision": cap.expected_prior_revision.saturating_add(1) }),
        )
    }

    fn systemctl(&self, args: &[&str]) -> Result<(), TypedError> {
        let out = self.host.run(&Exec {
            file: "/usr/bin/systemctl",
            args: args.iter().map(|s| (*s).to_owned()).collect(),
            timeout: Duration::from_secs(60),
            input: None,
        });
        if out.timed_out {
            return Err(err(
                Code::TimedOut,
                "systemctl ran too long and was stopped",
            ));
        }
        if out.code != Some(0) {
            return Err(err(
                Code::Failed,
                format!(
                    "systemctl exited with {:?}: {}",
                    out.code,
                    crate::js::slice_units(crate::js::trim(&out.stderr), 300)
                ),
            ));
        }
        Ok(())
    }

    fn activate_release(&self, env: &Envelope, now: u64) -> Result<Value, TypedError> {
        let p: ReleasePayload = payload(&env.payload)?;
        if env.target.installation.is_some() {
            return Err(err(Code::BadRequest, "a release is host-wide"));
        }
        let hex_ok = (p.commit.len() == 40 || p.commit.len() == 64)
            && p.commit
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !hex_ok {
            return Err(err(
                Code::BadRequest,
                "commit must be a full lowercase git object id",
            ));
        }
        let generation = env.target.generation;
        let cap = self.authorize(
            env,
            OpKind::ActivateRelease,
            &release_subject(generation, &p.commit, &p.release_digest),
            now,
        )?;
        let _effects = lock(&self.effects);
        let row = self.scope_row("host", cap)?;
        if generation <= row.admitted_generation {
            return Err(err(
                Code::Stale,
                format!(
                    "release generation {generation} is not newer than {}",
                    row.admitted_generation
                ),
            ));
        }
        let effect = self.admit(
            cap,
            "host",
            now,
            &AdmitUpdate::Generation {
                generation,
                plan: Some(p.release_digest),
            },
        )?;
        let r = (|| {
            let body = serde_json::to_vec(&json!({ "generation": generation, "commit": p.commit, "releaseDigest": p.release_digest.to_string() }))
                .map_err(|e| err(Code::Failed, e.to_string()))?;
            let root = SafeDir::open_root(&self.config.state_dir)
                .map_err(|e| err(Code::Failed, format!("state dir: {e}")))?;
            let dir = root
                .ensure_child("release", 0o750)
                .map_err(|e| err(Code::Failed, format!("release dir: {e}")))?;
            dir.write_atomic("active.json", &body)
                .map_err(|e| err(Code::Failed, format!("release pointer: {e}")))?;
            self.systemctl(&["restart", "flagship-daemon.service"])
        })();
        self.finish(effect, r, &PostUpdate::Nothing)?;
        Ok(
            json!({ "generation": generation, "revision": cap.expected_prior_revision.saturating_add(1) }),
        )
    }

    fn shutdown(&self, env: &Envelope, now: u64) -> Result<Value, TypedError> {
        let p: ShutdownPayload = payload(&env.payload)?;
        let action = match p.action {
            ShutdownAction::Poweroff => "poweroff",
            ShutdownAction::Reboot => "reboot",
        };
        let cap = self.authorize(env, OpKind::RequestShutdown, &shutdown_subject(action), now)?;
        let _effects = lock(&self.effects);
        let row = self.scope_row("host", cap)?;
        if cap.generation != row.admitted_generation {
            return Err(err(
                Code::Stale,
                "the capability names another release generation",
            ));
        }
        let effect = self.admit(cap, "host", now, &AdmitUpdate::Nothing)?;
        let r = self.systemctl(&[action]);
        self.finish(effect, r, &PostUpdate::Nothing)?;
        Ok(json!({ "action": action }))
    }
}

/// Connections on the typed socket: no hello (every request carries its version), the same
/// per-connection rate limit as v1.
pub struct TypedFactory {
    pub broker: Arc<TypedBroker>,
    pub max_per_second: u32,
}

impl std::fmt::Debug for TypedFactory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TypedFactory").finish_non_exhaustive()
    }
}

impl ConnectionFactory for TypedFactory {
    fn open(&self, peer: Peer) -> Box<dyn Connection> {
        Box::new(TypedConnection {
            broker: Arc::clone(&self.broker),
            peer,
            max_per_second: self.max_per_second,
            window: (Instant::now(), 0),
        })
    }
}

pub struct TypedConnection {
    broker: Arc<TypedBroker>,
    peer: Peer,
    max_per_second: u32,
    window: (Instant, u32),
}

impl std::fmt::Debug for TypedConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TypedConnection")
            .field("peer", &self.peer)
            .finish_non_exhaustive()
    }
}

impl Connection for TypedConnection {
    fn deadline_passed(&self, _: Duration) -> bool {
        false
    }

    fn on_frame(&mut self, raw: Value) -> Reply {
        let now = Instant::now();
        if now.duration_since(self.window.0) > Duration::from_millis(1000) {
            self.window = (now, 0);
        }
        self.window.1 = self.window.1.saturating_add(1);
        let answer = if self.window.1 > self.max_per_second {
            json!({ "requestId": raw.get("requestId").cloned().unwrap_or(Value::Null), "ok": false, "code": "forbidden", "message": "slow down" })
        } else {
            self.broker.handle(&self.peer, &raw)
        };
        match encode_frame(&answer) {
            Ok(b) => Reply::Send(b),
            Err(_) => Reply::Nothing,
        }
    }
}

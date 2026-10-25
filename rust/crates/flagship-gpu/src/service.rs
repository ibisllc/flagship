//! `flagship-gpud`'s operations: the allocator as the box's runtime layer
//! and the AI tool broker reach it. One JSON request, one JSON answer; the
//! socket, framing and peer check live in the binary. Owner authority (a
//! maintenance order, an approval) is verified by the daemon before it
//! calls, as for privd v1; this service re-checks everything it can check
//! itself (catalog, qualification, CDI, journal rules, IOMMU) and never
//! takes an app's word for sharing, secrecy or capabilities.
//!
//! | op | does |
//! |---|---|
//! | `gpu.inventory` | devices, qualification, holders, quarantine, catalog, honest unavailability |
//! | `gpu.status` | open allocations and the fair queue |
//! | `gpu.claim` | request, admit against the approval, queue fairly, reserve if free |
//! | `gpu.attach` | CDI (gVisor) or VFIO (VM) attachment, write-ahead, engine arguments |
//! | `gpu.started` / `gpu.heartbeat` | the workload runs |
//! | `gpu.release` | drain, settle (proof or quarantine), give VFIO groups back |
//! | `gpu.settle` | retry a settle that was held |
//! | `gpu.revokeApp` | the approval was withdrawn or the app removed |
//! | `gpu.reconcile` | re-inventory, regenerate CDI, reconcile |
//! | `gpu.quarantine.clear` | maintenance only |
//! | `gpu.mig.profiles` / `gpu.mig.apply` | MIG layout, maintenance only |
//! | `gpu.selftest` | the simulated-device matrix (`selftest.rs`) |

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::attach::{Engine, RuntimeNames, ShareEnv, engine_args};
use crate::catalog::{HostFacts, VerifiedCatalog};
use crate::cdi::ApprovedClaim;
use crate::cdi_gen::{
    WrittenSpec, generate_and_write, nvidia_policy, render_nodes, validate_written,
};
use crate::coop::{
    CoopDecision, CoopLedger, PidOwner, ShareLimits, attribute, parse_pmon, shares_fit,
};
use crate::device::{Backend, Capability, DeviceRecord, PartitionMode};
use crate::ids::{LocalDeviceId, LocalIdKey};
use crate::journal::{AllocationRecord, AllocationState, DeviceClaim, JournalStore};
use crate::maintenance::{
    DriverMaintenance, HostPackages, MaintState, MaintenanceStore, PostBoot, Proposal,
    SharedPackages,
};
use crate::manager::{DeviceManager, ManagerError, Settle, WorkloadRuntime};
use crate::mig::{apply as mig_apply, parse_lgip, plan as mig_plan};
use crate::numerics::{VectorAddReport, verify_vector_add};
use crate::observe::ObserverRoots;
use crate::policy::{AllocationId, PolicyKind};
use crate::provider::{DeviceProvider, IsolationProfile, Tool, ToolRunner};
use crate::request::{AcceleratorRequirement, AppInstallation, GpuApproval, GpuRequest};
use crate::scrub::{ScrubCleanup, ScrubRunner};
use crate::sqlite::SqliteJournal;
use crate::sysfs::SysfsRoot;
use crate::vendor::amd::AmdProvider;
use crate::vendor::intel::IntelProvider;
use crate::vendor::nvidia::{NvidiaProvider, parse_compute_apps};
use crate::vfio::{SysfsWrite, VfioBinding, VfioHost};

/// The container runtime as both presence oracle and pid owner.
pub trait Runtime: WorkloadRuntime + PidOwner + Send + Sync + std::fmt::Debug {}
impl<T: WorkloadRuntime + PidOwner + Send + Sync + std::fmt::Debug> Runtime for T {}

#[derive(Clone)]
pub struct ServiceParts {
    pub tools: Arc<dyn ToolRunner>,
    pub runtime: Arc<dyn Runtime>,
    pub scrub: Arc<dyn ScrubRunner>,
    pub sysfs_writer: Arc<dyn SysfsWrite>,
    /// apt/dpkg for driver maintenance; `None` leaves the pipeline off.
    pub packages: Option<Arc<dyn HostPackages>>,
}

impl std::fmt::Debug for ServiceParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ServiceParts")
    }
}

#[derive(Clone, Debug)]
pub enum CatalogSource {
    Loaded(VerifiedCatalog),
    Missing,
    Invalid(String),
}

#[derive(Clone, Debug)]
pub struct ServiceConfig {
    pub state_dir: PathBuf,
    pub sys_root: PathBuf,
    pub proc_root: PathBuf,
    pub dev_root: PathBuf,
    pub cdi_dir: PathBuf,
    pub enforce_root_owned_cdi: bool,
    pub catalog: CatalogSource,
    pub host: HostFacts,
    pub names: RuntimeNames,
    pub cdi_hook_path: String,
    pub driver_lib_dir: String,
    pub rocm_version: Option<String>,
    pub level_zero_version: Option<String>,
    pub queue_per_app: usize,
    pub queue_total: usize,
    pub coop_window_ms: u64,
    /// Where the attached allocations are published for privd and the broker.
    pub run_claims_path: PathBuf,
    /// Off for a one-shot probe, which must not overwrite a running gpud's claims.
    pub publish_claims: bool,
}

impl ServiceConfig {
    pub fn system(state_dir: PathBuf, catalog: CatalogSource, host: HostFacts) -> Self {
        Self {
            state_dir,
            sys_root: "/sys".into(),
            proc_root: "/proc".into(),
            dev_root: "/dev".into(),
            cdi_dir: "/var/run/cdi".into(),
            enforce_root_owned_cdi: true,
            catalog,
            host,
            names: RuntimeNames::default(),
            cdi_hook_path: "/usr/bin/nvidia-cdi-hook".into(),
            driver_lib_dir: if cfg!(target_arch = "aarch64") {
                "/usr/lib/aarch64-linux-gnu".into()
            } else {
                "/usr/lib/x86_64-linux-gnu".into()
            },
            rocm_version: None,
            level_zero_version: None,
            queue_per_app: 4,
            queue_total: 64,
            coop_window_ms: 60_000,
            run_claims_path: "/run/flagship-gpu/run-claims.json".into(),
            publish_claims: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceError {
    pub code: &'static str,
    pub message: String,
}

fn bad(m: impl Into<String>) -> ServiceError {
    ServiceError {
        code: "bad-request",
        message: m.into(),
    }
}

fn err(code: &'static str, m: impl Into<String>) -> ServiceError {
    ServiceError {
        code,
        message: m.into(),
    }
}

fn from_manager(e: ManagerError) -> ServiceError {
    let code = match &e {
        ManagerError::NotApproved(_) => "forbidden",
        ManagerError::Request(_) => "bad-request",
        ManagerError::Queue(_) => "busy",
        ManagerError::Journal(crate::journal::JournalError::NotFound(_)) => "not-found",
        ManagerError::Journal(crate::journal::JournalError::Duplicate(_)) => "conflict",
        _ => "failed",
    };
    err(code, e.to_string())
}

fn args<T: for<'de> Deserialize<'de>>(v: &Value) -> Result<T, ServiceError> {
    serde_json::from_value(v.clone()).map_err(|e| bad(e.to_string()))
}

fn alloc_id(s: &str) -> Result<AllocationId, ServiceError> {
    AllocationId::new(s).ok_or_else(|| bad("allocation ids are 1 to 128 of [A-Za-z0-9._-]"))
}

/// The box-local key for device ids: 32 random bytes, root-only, made once.
pub fn load_or_create_key(path: &Path) -> Result<[u8; 32], String> {
    if let Ok(b) = fs::read(path) {
        return <[u8; 32]>::try_from(b.as_slice())
            .map_err(|_| "the local id key is corrupt".to_owned());
    }
    let mut k = [0u8; 32];
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut k))
        .map_err(|e| format!("no randomness: {}", e.kind()))?;
    if let Some(d) = path.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, k).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(k)
}

#[derive(Debug, Clone, Default)]
struct Extra {
    share: Option<ShareLimits>,
    max_runtime_ms: Option<u64>,
    started_ms: Option<u64>,
    vfio: Vec<VfioBinding>,
    /// The one container this allocation may be run in.
    container: Option<String>,
    /// What the privileged brokers let that container's `run` name, once attached.
    run_claim: Option<Value>,
}

/// The schema of `run-claims.json`, which privd and the Rust broker read (their `GpuRunClaim`).
pub const RUN_CLAIMS_SCHEMA: &str = "flagship/gpu-run-claims/v1";

fn write_public(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(d) = path.parent() {
        fs::create_dir_all(d)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o644))?;
    }
    fs::rename(&tmp, path)
}

fn container_ok(c: &str) -> bool {
    !c.is_empty()
        && c.len() <= 128
        && c.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && c.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

pub struct GpuService {
    config: ServiceConfig,
    parts: ServiceParts,
    manager: DeviceManager<SqliteJournal>,
    cleanup: Arc<ScrubCleanup>,
    vfio: VfioHost,
    cdi: Option<(WrittenSpec, crate::cdi::CdiPolicy)>,
    cdi_error: Option<String>,
    unavailable: Vec<(Backend, String)>,
    extras: BTreeMap<AllocationId, Extra>,
    ledger: CoopLedger,
    last_tick_ms: Option<u64>,
    maintenance: Option<DriverMaintenance<SharedPackages>>,
}

impl std::fmt::Debug for GpuService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GpuService")
            .field("manager", &self.manager)
            .finish_non_exhaustive()
    }
}

fn catalog_status(c: &CatalogSource) -> Value {
    match c {
        CatalogSource::Loaded(v) => {
            json!({"status": "verified", "serial": v.serial(), "digest": v.digest(), "entries": v.entries().len()})
        }
        CatalogSource::Missing => json!({"status": "missing"}),
        CatalogSource::Invalid(why) => json!({"status": "refused", "reason": why}),
    }
}

impl GpuService {
    pub fn new(config: ServiceConfig, parts: ServiceParts) -> Result<Self, String> {
        let key = LocalIdKey::new(load_or_create_key(&config.state_dir.join("local-id.key"))?);
        let journal =
            SqliteJournal::open(&config.state_dir.join("journal.db")).map_err(|e| e.to_string())?;
        let cleanup = Arc::new(ScrubCleanup::new(Arc::clone(&parts.scrub)));
        let roots = ObserverRoots {
            sys: config.sys_root.clone(),
            proc: config.proc_root.clone(),
        };
        let providers: Vec<Arc<dyn DeviceProvider>> = vec![
            Arc::new(NvidiaProvider::new(Arc::clone(&parts.tools)).with_cleanup(cleanup.clone())),
            Arc::new(
                AmdProvider::new(Arc::clone(&parts.tools), config.rocm_version.clone())
                    .with_cleanup(cleanup.clone())
                    .with_observer_roots(roots.clone()),
            ),
            Arc::new(
                IntelProvider::new(Arc::clone(&parts.tools), config.level_zero_version.clone())
                    .with_cleanup(cleanup.clone())
                    .with_observer_roots(roots),
            ),
        ];
        let catalog = match &config.catalog {
            CatalogSource::Loaded(c) => c.clone(),
            _ => VerifiedCatalog::empty(),
        };
        let manager = DeviceManager::new(
            journal,
            key,
            providers,
            catalog,
            config.host.clone(),
            config.queue_per_app,
            config.queue_total,
        );
        let vfio = VfioHost::new(
            &config.sys_root,
            &config.dev_root,
            Arc::clone(&parts.sysfs_writer),
        );
        let ledger = CoopLedger::new(config.coop_window_ms);
        let maintenance = match &parts.packages {
            Some(p) => Some(DriverMaintenance::new(
                MaintenanceStore::open(&config.state_dir.join("maintenance.db"))
                    .map_err(|e| e.to_string())?,
                SharedPackages(Arc::clone(p)),
                config.state_dir.join("driver-staging"),
                if cfg!(target_arch = "aarch64") {
                    "arm64"
                } else {
                    "amd64"
                },
            )),
            None => None,
        };
        let mut s = Self {
            config,
            parts,
            manager,
            cleanup,
            vfio,
            cdi: None,
            cdi_error: None,
            unavailable: Vec::new(),
            extras: BTreeMap::new(),
            ledger,
            last_tick_ms: None,
            maintenance,
        };
        if let Some(m) = &s.maintenance {
            s.manager
                .set_admission_paused(m.admission_pause().map_err(|e| e.to_string())?);
        }
        s.refresh().map_err(|e| e.message)?;
        s.manager
            .reconcile(s.parts.runtime.as_ref())
            .map_err(|e| e.to_string())?;
        // Nothing is attached after a restart until a claim attaches again.
        let _ = s.publish();
        Ok(s)
    }

    pub fn manager(&self) -> &DeviceManager<SqliteJournal> {
        &self.manager
    }

    pub fn manager_mut(&mut self) -> &mut DeviceManager<SqliteJournal> {
        &mut self.manager
    }

    /// Re-read the inventory, configure each device's qualified cleanup, and
    /// regenerate the CDI spec when NVIDIA devices are present.
    pub fn refresh(&mut self) -> Result<(), ServiceError> {
        let pci = SysfsRoot::new(&self.config.sys_root)
            .accelerators()
            .unwrap_or_default();
        let r = self
            .manager
            .refresh_inventory_with_provider_topology(&pci)
            .map_err(from_manager)?;
        self.unavailable = r.unavailable;
        let devices: Vec<DeviceRecord> = self.manager.inventory().to_vec();
        let compute = std::collections::BTreeSet::from([Capability::Compute]);
        for d in &devices {
            for profile in [
                IsolationProfile::GvisorNvproxy,
                IsolationProfile::VmPassthrough,
            ] {
                if let Ok(e) =
                    self.manager
                        .catalog()
                        .qualify(d, self.manager.host(), profile, &compute)
                {
                    self.cleanup.set_procedure(&d.id, e.cleanup);
                    self.parts.scrub.configure(d, e, profile);
                    break;
                }
            }
        }
        self.cdi = None;
        self.cdi_error = None;
        let nvidia: Vec<(&DeviceRecord, Vec<String>)> = devices
            .iter()
            .filter(|d| d.backend == Backend::NvidiaCuda)
            .map(|d| (d, render_nodes(&self.config.sys_root, &d.pci)))
            .collect();
        if !nvidia.is_empty() {
            let generator = self
                .manager
                .host()
                .cdi_generator
                .clone()
                .unwrap_or_else(|| "unpinned".into());
            let policy = nvidia_policy(
                &generator,
                &self.config.cdi_hook_path,
                &self.config.driver_lib_dir,
                &nvidia,
            );
            match generate_and_write(
                self.parts.tools.as_ref(),
                &generator,
                &policy,
                &self.config.cdi_dir,
                self.config.enforce_root_owned_cdi,
            ) {
                Ok(w) => self.cdi = Some((w, policy)),
                Err(e) => self.cdi_error = Some(e),
            }
        }
        Ok(())
    }

    /// One JSON operation.
    pub fn handle(&mut self, op: &str, a: &Value) -> Result<Value, ServiceError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Timed {
            allocation_id: String,
            now_ms: u64,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Release {
            allocation_id: String,
            #[serde(default)]
            reason: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct One {
            allocation_id: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct App {
            app_id: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Clear {
            device: String,
            maintenance_ref: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Dev {
            device: String,
        }
        match op {
            "gpu.inventory" => Ok(self.inventory()),
            "gpu.status" => self.status(),
            "gpu.claim" => self.claim(a),
            "gpu.attach" => self.attach(a),
            "gpu.started" => {
                let x: Timed = args(a)?;
                let id = alloc_id(&x.allocation_id)?;
                let rec = self.manager.started(&id).map_err(from_manager)?;
                self.extras.entry(id).or_default().started_ms = Some(x.now_ms);
                Ok(json!({"state": rec.state.as_str()}))
            }
            "gpu.heartbeat" => {
                let x: Timed = args(a)?;
                self.manager
                    .heartbeat(&alloc_id(&x.allocation_id)?, x.now_ms)
                    .map_err(from_manager)?;
                Ok(json!({}))
            }
            "gpu.release" => {
                let x: Release = args(a)?;
                let id = alloc_id(&x.allocation_id)?;
                self.release(
                    &id,
                    x.reason
                        .as_deref()
                        .unwrap_or("released by the app's runtime"),
                )
            }
            "gpu.settle" => {
                let x: One = args(a)?;
                let s = self.settle(&alloc_id(&x.allocation_id)?)?;
                Ok(json!({"settle": s}))
            }
            "gpu.revokeApp" => {
                let x: App = args(a)?;
                let ids = self
                    .manager
                    .revoke_app(&x.app_id, self.parts.runtime.as_ref())
                    .map_err(from_manager)?;
                let mut out = Vec::new();
                for id in ids {
                    let s = self.settle(&id).unwrap_or_else(|e| e.message);
                    out.push(json!({"allocationId": id.as_str(), "settle": s}));
                }
                Ok(json!({"revoked": out}))
            }
            "gpu.reconcile" => {
                self.refresh()?;
                let actions = self
                    .manager
                    .reconcile(self.parts.runtime.as_ref())
                    .map_err(from_manager)?;
                Ok(
                    json!({"actions": actions.iter().map(|(id, a)| json!({"allocationId": id.as_str(), "action": format!("{a:?}")})).collect::<Vec<_>>()}),
                )
            }
            "gpu.quarantine.clear" => {
                let x: Clear = args(a)?;
                let d = LocalDeviceId::parse(&x.device).ok_or_else(|| bad("not a device id"))?;
                self.manager
                    .store()
                    .clear_quarantine(&d, &x.maintenance_ref)
                    .map_err(|e| bad(e.to_string()))?;
                Ok(json!({}))
            }
            "gpu.mig.profiles" => {
                let x: Dev = args(a)?;
                let d = self.device_by_id(&x.device)?;
                let idx: u32 = d.cdi_name.parse().map_err(|_| bad("no device index"))?;
                let text = self
                    .parts
                    .tools
                    .output(&Tool::NvidiaSmiMigProfiles(idx))
                    .map_err(|e| err("unavailable", e.to_string()))?;
                let p = parse_lgip(&text).map_err(|e| err("failed", e.to_string()))?;
                Ok(json!({"profiles": p}))
            }
            "gpu.mig.apply" => self.mig_apply(a),
            "gpu.maintenance.status" => {
                let m = self
                    .maintenance
                    .as_ref()
                    .ok_or_else(|| err("unavailable", "driver maintenance is off on this host"))?;
                Ok(
                    json!({"maintenance": m.current().map_err(|e| err("failed", e.to_string()))?, "admissionPaused": self.manager.admission_paused()}),
                )
            }
            "gpu.maintenance.propose" => self.maintenance_propose(a),
            "gpu.maintenance.advance" => self.maintenance_advance(a),
            "gpu.selftest" => {
                Ok(serde_json::to_value(crate::selftest::run(None)).unwrap_or(Value::Null))
            }
            _ => Err(err("unknown-op", format!("{op} is not a GPU operation"))),
        }
    }

    fn device_by_id(&self, id: &str) -> Result<DeviceRecord, ServiceError> {
        let d = LocalDeviceId::parse(id).ok_or_else(|| bad("not a device id"))?;
        self.manager
            .device_record(&d)
            .cloned()
            .ok_or_else(|| err("not-found", "no such device"))
    }

    fn holders(&self) -> BTreeMap<LocalDeviceId, Vec<Value>> {
        let mut m: BTreeMap<LocalDeviceId, Vec<Value>> = BTreeMap::new();
        for rec in self.manager.open_allocations().unwrap_or_default() {
            for c in &rec.claims {
                m.entry(c.device.clone()).or_default().push(json!({
                    "allocationId": rec.id.as_str(),
                    "appId": rec.request.app.app_id,
                    "state": rec.state.as_str(),
                    "partition": c.partition.as_ref().map(ToString::to_string),
                }));
            }
        }
        m
    }

    pub fn inventory(&self) -> Value {
        let quarantined: BTreeMap<LocalDeviceId, String> = self
            .manager
            .store()
            .quarantined()
            .unwrap_or_default()
            .into_iter()
            .collect();
        let holders = self.holders();
        let compute = std::collections::BTreeSet::from([Capability::Compute]);
        let devices: Vec<Value> = self
            .manager
            .inventory()
            .iter()
            .map(|d| {
                let mut qualified = Vec::new();
                let mut reasons = Vec::new();
                for p in [IsolationProfile::GvisorNvproxy, IsolationProfile::VmPassthrough] {
                    match self.manager.catalog().qualify(d, self.manager.host(), p, &compute) {
                        Ok(e) => qualified.push(json!({"profile": p, "entry": e.id})),
                        Err(u) => reasons.extend(u.0),
                    }
                }
                let passthrough = match self.vfio.qualify(d) {
                    Ok(q) => json!({"ok": true, "group": q.group}),
                    Err(w) => json!({"ok": false, "reasons": w}),
                };
                json!({
                    "id": d.id.as_str(),
                    "vendor": d.vendor,
                    "backend": d.backend,
                    "model": d.model,
                    "memoryMiB": d.memory_mib,
                    "driver": d.driver_version,
                    "toolkit": d.toolkit_version,
                    "capabilities": d.capabilities,
                    "displayOwned": d.display_owned,
                    "partitionMode": d.partition_mode,
                    "partitions": d.partitions.iter().map(|p| json!({"id": p.id.to_string(), "memoryMiB": p.memory_mib})).collect::<Vec<_>>(),
                    "qualified": qualified,
                    "unqualifiedReasons": if qualified.is_empty() { reasons } else { Vec::new() },
                    "passthrough": passthrough,
                    "quarantined": quarantined.get(&d.id),
                    "holders": holders.get(&d.id).cloned().unwrap_or_default(),
                })
            })
            .collect();
        json!({
            "available": !devices.is_empty(),
            "reason": if devices.is_empty() { Some("no-accelerators") } else { None },
            "devices": devices,
            "unavailable": self.unavailable.iter().map(|(b, r)| json!({"backend": b, "reason": r})).collect::<Vec<_>>(),
            "topologyLinks": self.manager.topology().len(),
            "generation": self.manager.generation(),
            "admissionPaused": self.manager.admission_paused(),
            "catalog": catalog_status(&self.config.catalog),
            "cdi": match (&self.cdi, &self.cdi_error) {
                (Some((w, _)), _) => json!({"status": "written", "digest": w.digest}),
                (None, Some(e)) => json!({"status": "failed", "reason": e}),
                _ => json!({"status": "not-needed"}),
            },
            "host": {"kernel": self.manager.host().kernel, "moduleSigningEnforced": self.manager.host().module_signing_enforced},
        })
    }

    fn view(rec: &AllocationRecord) -> Value {
        json!({
            "allocationId": rec.id.as_str(),
            "appId": rec.request.app.app_id,
            "generation": rec.request.app.generation,
            "state": rec.state.as_str(),
            "backend": rec.request.backend,
            "policy": rec.request.policy.kind(),
            "devices": rec.claims.iter().map(|c| json!({"device": c.device.as_str(), "partition": c.partition.as_ref().map(ToString::to_string), "memoryMiB": c.memory_mib})).collect::<Vec<_>>(),
            "reason": rec.reason,
        })
    }

    pub fn status(&self) -> Result<Value, ServiceError> {
        let open = self.manager.open_allocations().map_err(from_manager)?;
        let queue: Vec<Value> = self
            .manager
            .queue_snapshot()
            .into_iter()
            .map(|(app, ids)| json!({"appId": app, "allocations": ids.iter().map(AllocationId::as_str).collect::<Vec<_>>()}))
            .collect();
        Ok(json!({
            "allocations": open.iter().map(Self::view).collect::<Vec<_>>(),
            "queue": queue,
            "admissionPaused": self.manager.admission_paused(),
        }))
    }

    fn claim(&mut self, a: &Value) -> Result<Value, ServiceError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct A {
            allocation_id: String,
            app: AppInstallation,
            operation_id: String,
            requirement: AcceleratorRequirement,
            approval: GpuApproval,
            #[serde(default)]
            userspace: Option<String>,
            #[serde(default)]
            max_runtime_ms: Option<u64>,
            #[serde(default)]
            share: Option<ShareLimits>,
            container: String,
        }
        let x: A = args(a)?;
        let id = alloc_id(&x.allocation_id)?;
        if !container_ok(&x.container) {
            return Err(bad("container names are 1 to 128 of [A-Za-z0-9_.-]"));
        }
        let mut req =
            GpuRequest::from_manifest(x.app, &x.operation_id, &x.requirement, &x.approval);
        req.userspace = x.userspace;
        if req.policy.kind() == PolicyKind::Cooperative {
            let s = x
                .share
                .ok_or_else(|| bad("cooperative sharing needs the owner's share limits"))?;
            s.check().map_err(bad)?;
            req.minimum_memory_mib = s.memory_mib;
        }
        self.manager
            .request(id.clone(), req, x.approval.secrecy)
            .map_err(from_manager)?;
        self.manager
            .admit(&id, Some(&x.approval))
            .map_err(from_manager)?;
        self.extras.insert(
            id.clone(),
            Extra {
                share: x.share,
                max_runtime_ms: x.max_runtime_ms,
                container: Some(x.container),
                ..Extra::default()
            },
        );
        if let Err(e) = self.manager.enqueue(&id) {
            let _ = self
                .manager
                .cancel(&id, self.parts.runtime.as_ref(), "the GPU queue is full");
            self.extras.remove(&id);
            return Err(from_manager(e));
        }
        self.manager.pump().map_err(from_manager)?;
        let rec = self
            .manager
            .store()
            .get(&id)
            .map_err(|e| bad(e.to_string()))?
            .ok_or_else(|| bad("vanished"))?;
        if rec.state == AllocationState::Reserved
            && let Some(Err(why)) = self.share_fits(&rec)
        {
            let _ = self.release(&id, why);
            return Err(err("conflict", why));
        }
        let position = self
            .manager
            .queue_snapshot()
            .iter()
            .find_map(|(_, ids)| ids.iter().position(|i| *i == id));
        Ok(json!({
            "allocationId": id.as_str(),
            "state": rec.state.as_str(),
            "queuePosition": position,
        }))
    }

    fn share_fits(&self, rec: &AllocationRecord) -> Option<Result<(), &'static str>> {
        let mine = self.extras.get(&rec.id)?.share?;
        let claim = rec.claims.first()?;
        let mut shares = vec![mine];
        for other in self.manager.open_allocations().ok()? {
            if other.id != rec.id
                && other.claims.iter().any(|c| c.device == claim.device)
                && let Some(s) = self.extras.get(&other.id).and_then(|e| e.share)
            {
                shares.push(s);
            }
        }
        let mem = self.manager.device_record(&claim.device)?.memory_mib;
        Some(shares_fit(&shares, mem))
    }

    fn mig_minors(&self) -> BTreeMap<String, u32> {
        let text = fs::read_to_string(self.config.proc_root.join("driver/nvidia-caps/mig-minors"))
            .unwrap_or_default();
        text.lines()
            .filter_map(|l| {
                let (k, v) = l.split_once(' ')?;
                Some((k.to_owned(), v.trim().parse().ok()?))
            })
            .collect()
    }

    fn claim_nodes(&self, c: &DeviceClaim) -> Vec<String> {
        let Some(d) = self.manager.device_record(&c.device) else {
            return Vec::new();
        };
        let mut nodes = vec![format!("/dev/nvidia{}", d.cdi_name)];
        match &c.partition {
            None => {
                for r in render_nodes(&self.config.sys_root, &d.pci) {
                    nodes.push(format!("/dev/dri/{r}"));
                }
            }
            Some(p) => {
                let minors = self.mig_minors();
                for k in [
                    format!("gpu{}/gi{}/access", d.cdi_name, p.gpu_instance),
                    format!(
                        "gpu{}/gi{}/ci{}/access",
                        d.cdi_name, p.gpu_instance, p.compute_instance
                    ),
                ] {
                    if let Some(m) = minors.get(&k) {
                        nodes.push(format!("/dev/nvidia-caps/nvidia-cap{m}"));
                    }
                }
            }
        }
        nodes
    }

    fn release_bindings(&self, bindings: &[VfioBinding]) {
        for b in bindings {
            let _ = self.vfio.release(b);
        }
    }

    fn attach(&mut self, a: &Value) -> Result<Value, ServiceError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct A {
            allocation_id: String,
            engine: Engine,
        }
        let x: A = args(a)?;
        let _ = x.engine;
        let id = alloc_id(&x.allocation_id)?;
        let rec = self
            .manager
            .store()
            .get(&id)
            .map_err(|e| bad(e.to_string()))?
            .ok_or_else(|| err("not-found", "no such allocation"))?;
        if rec.state != AllocationState::Reserved {
            return Err(err(
                "conflict",
                format!("the allocation is {}, not reserved", rec.state),
            ));
        }
        let mut bindings = Vec::new();
        let plan = match rec.request.isolation {
            IsolationProfile::GvisorNvproxy => {
                let (w, policy) = self.cdi.as_ref().ok_or_else(|| {
                    err(
                        "unavailable",
                        self.cdi_error
                            .clone()
                            .unwrap_or_else(|| "no CDI spec".into()),
                    )
                })?;
                let claim = ApprovedClaim {
                    device_names: rec.claims.iter().map(|c| c.cdi_name.clone()).collect(),
                    device_nodes: rec
                        .claims
                        .iter()
                        .flat_map(|c| self.claim_nodes(c))
                        .collect(),
                    capabilities: rec.request.capabilities.clone(),
                };
                let v = validate_written(w, policy, &claim)
                    .map_err(|v| err("forbidden", format!("the CDI spec was refused: {v:?}")))?;
                self.manager.attach(&id, Some(&v)).map_err(from_manager)?
            }
            IsolationProfile::VmPassthrough => {
                for c in &rec.claims {
                    let Some(d) = self.manager.device_record(&c.device).cloned() else {
                        self.release_bindings(&bindings);
                        return Err(bad("reserved device is gone"));
                    };
                    let bound = self
                        .vfio
                        .qualify(&d)
                        .map_err(|w| err("forbidden", w.join("; ")))
                        .and_then(|q| self.vfio.bind(&q).map_err(|e| err("failed", e)));
                    match bound {
                        Ok(b) => bindings.push(b),
                        Err(e) => {
                            self.release_bindings(&bindings);
                            return Err(e);
                        }
                    }
                }
                match self.manager.attach(&id, None) {
                    Ok(p) => p,
                    Err(e) => {
                        self.release_bindings(&bindings);
                        return Err(from_manager(e));
                    }
                }
            }
        };
        let share = self
            .extras
            .get(&id)
            .and_then(|e| e.share)
            .map(|s| ShareEnv {
                memory_mib: s.memory_mib,
                compute_percent: s.compute_percent,
            });
        let att = engine_args(&plan, &self.config.names, &bindings, share)
            .map_err(|e| err("failed", e))?;
        let runtime = match plan.isolation {
            IsolationProfile::GvisorNvproxy => self.config.names.gvisor_gpu.clone(),
            IsolationProfile::VmPassthrough => self.config.names.vm.clone(),
        };
        let devices: Vec<String> = att
            .args
            .windows(2)
            .filter(|w| w.first().is_some_and(|a| a == "--device"))
            .filter_map(|w| w.get(1).cloned())
            .collect();
        let e = self.extras.entry(id.clone()).or_default();
        e.vfio = bindings;
        e.run_claim = Some(json!({
            "allocationId": id.as_str(),
            "appId": rec.request.app.app_id,
            "container": e.container.clone().unwrap_or_default(),
            "runtime": runtime,
            "devices": devices,
        }));
        self.publish().map_err(|why| {
            err(
                "failed",
                format!("the GPU claim could not be published: {why}"),
            )
        })?;
        Ok(serde_json::to_value(att).unwrap_or(Value::Null))
    }

    /// Write what the privileged brokers check a GPU `run` against, and the VFIO groups' CDI spec,
    /// from the attached allocations. Root-owned, mode 0644: nobody else writes them.
    fn publish(&self) -> Result<(), String> {
        if !self.config.publish_claims {
            return Ok(());
        }
        let claims: Vec<&Value> = self
            .extras
            .values()
            .filter_map(|e| e.run_claim.as_ref())
            .collect();
        let doc = json!({"schema": RUN_CLAIMS_SCHEMA, "claims": claims});
        write_public(&self.config.run_claims_path, &doc.to_string())
            .map_err(|e| e.kind().to_string())?;
        let mut groups: Vec<u32> = self
            .extras
            .values()
            .flat_map(|e| e.vfio.iter().map(|b| b.group))
            .collect();
        groups.sort_unstable();
        groups.dedup();
        write_public(
            &self.config.cdi_dir.join("flagship_vfio_group.json"),
            &crate::vfio::vfio_cdi_spec(&groups).to_string(),
        )
        .map_err(|e| e.kind().to_string())
    }

    fn settle(&mut self, id: &AllocationId) -> Result<String, ServiceError> {
        let s = self
            .manager
            .settle(id, self.parts.runtime.as_ref())
            .map_err(from_manager)?;
        let text = match &s {
            Settle::Released => "released".to_owned(),
            Settle::Quarantined(r) => format!("quarantined: {r}"),
            Settle::Held(r) => format!("held: {r}"),
        };
        if !matches!(s, Settle::Held(_))
            && let Some(e) = self.extras.remove(id)
        {
            self.ledger.forget(id);
            self.release_bindings(&e.vfio);
            let _ = self.publish();
        }
        Ok(text)
    }

    fn release(&mut self, id: &AllocationId, reason: &str) -> Result<Value, ServiceError> {
        let rec = self
            .manager
            .cancel(id, self.parts.runtime.as_ref(), reason)
            .map_err(from_manager)?;
        let settle = if rec.state.is_terminal() {
            if let Some(e) = self.extras.remove(id) {
                self.release_bindings(&e.vfio);
                let _ = self.publish();
            }
            "released".to_owned()
        } else {
            self.settle(id)?
        };
        Ok(json!({"allocationId": id.as_str(), "settle": settle}))
    }

    fn mig_apply(&mut self, a: &Value) -> Result<Value, ServiceError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct A {
            device: String,
            profiles: Vec<String>,
            maintenance_ref: String,
        }
        let x: A = args(a)?;
        if x.maintenance_ref.is_empty() {
            return Err(err(
                "forbidden",
                "a MIG layout change needs the owner's maintenance order",
            ));
        }
        let d = self.device_by_id(&x.device)?;
        if d.partition_mode == PartitionMode::Unsupported {
            return Err(bad("this device has no MIG support"));
        }
        let held = !self
            .manager
            .store()
            .holdings(&d.id)
            .unwrap_or_default()
            .is_empty();
        let idx: u32 = d.cdi_name.parse().map_err(|_| bad("no device index"))?;
        let text = self
            .parts
            .tools
            .output(&Tool::NvidiaSmiMigProfiles(idx))
            .map_err(|e| err("unavailable", e.to_string()))?;
        let profiles = parse_lgip(&text).map_err(|e| err("failed", e.to_string()))?;
        let p = mig_plan(&d, &profiles, &x.profiles, held).map_err(|e| err("conflict", e))?;
        mig_apply(self.parts.tools.as_ref(), &p).map_err(|e| err("failed", e))?;
        self.refresh()?;
        let actions = self
            .manager
            .reconcile(self.parts.runtime.as_ref())
            .map_err(from_manager)?;
        Ok(json!({"plan": p, "reconciled": actions.len(), "generation": self.manager.generation()}))
    }

    fn maintenance_propose(&mut self, a: &Value) -> Result<Value, ServiceError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct A {
            id: String,
            maintenance_ref: String,
            backend: Backend,
            driver: String,
        }
        let x: A = args(a)?;
        let current = self
            .manager
            .inventory()
            .iter()
            .find(|d| d.backend == x.backend)
            .map(|d| d.driver_version.clone());
        let m = self
            .maintenance
            .as_ref()
            .ok_or_else(|| err("unavailable", "driver maintenance is off on this host"))?;
        let p = Proposal {
            id: x.id,
            order_ref: x.maintenance_ref,
            backend: x.backend,
            driver: x.driver,
            current_driver: current,
        };
        let rec = m
            .propose(&p, self.manager.catalog(), self.manager.host())
            .map_err(|e| err("conflict", e.to_string()))?;
        Ok(json!({"maintenance": rec}))
    }

    /// One step of the pipeline. After the reboot the caller passes the
    /// vector-add report it ran on the new driver (`smokeReport`).
    fn maintenance_advance(&mut self, a: &Value) -> Result<Value, ServiceError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct A {
            #[serde(default)]
            smoke_report: Option<VectorAddReport>,
            #[serde(default)]
            enrolled_signer: Option<String>,
        }
        let x: A = args(a)?;
        let state = self
            .maintenance
            .as_ref()
            .ok_or_else(|| err("unavailable", "driver maintenance is off on this host"))?
            .current()
            .map_err(|e| err("failed", e.to_string()))?
            .map(|r| (r.state, r.backend))
            .ok_or_else(|| err("not-found", "no driver maintenance"))?;
        let rt = Arc::clone(&self.parts.runtime);
        let m_err = |e: crate::maintenance::MaintError| err("conflict", e.to_string());
        let rec = match state.0 {
            MaintState::Proposed => self.maintenance.as_ref().map(DriverMaintenance::stage),
            MaintState::Staged => {
                let r = self
                    .maintenance
                    .as_ref()
                    .map(DriverMaintenance::begin_drain);
                self.manager
                    .set_admission_paused(Some("driver maintenance is running".into()));
                self.manager
                    .drain_all(rt.as_ref(), "driver maintenance")
                    .map_err(from_manager)?;
                r
            }
            MaintState::Draining => {
                for rec in self.manager.open_allocations().map_err(from_manager)? {
                    let _ = self.settle(&rec.id);
                }
                let open = self.manager.open_allocations().map_err(from_manager)?.len();
                self.maintenance.as_ref().map(|m| m.install(open))
            }
            MaintState::Installed | MaintState::Verifying | MaintState::RollingBack => {
                self.refresh()?;
                let backend = state.1;
                let devices: Vec<DeviceRecord> = self
                    .manager
                    .inventory()
                    .iter()
                    .filter(|d| d.backend == backend)
                    .cloned()
                    .collect();
                let compute = std::collections::BTreeSet::from([Capability::Compute]);
                let qualified = devices.iter().try_for_each(|d| {
                    [
                        IsolationProfile::GvisorNvproxy,
                        IsolationProfile::VmPassthrough,
                    ]
                    .iter()
                    .find_map(|p| {
                        self.manager
                            .catalog()
                            .qualify(d, self.manager.host(), *p, &compute)
                            .ok()
                    })
                    .map(|_| ())
                    .ok_or_else(|| format!("{} is not qualified on its new driver", d.id))
                });
                let smoke = match &x.smoke_report {
                    Some(r) => verify_vector_add(r, "cuda")
                        .or_else(|_| verify_vector_add(r, "hip"))
                        .or_else(|_| verify_vector_add(r, "sycl")),
                    None => Err("no numerical smoke test report".into()),
                };
                let module = match backend {
                    Backend::NvidiaCuda => "nvidia",
                    Backend::AmdRocm => "amdgpu",
                    Backend::IntelLevelZero => "i915",
                };
                let facts = PostBoot {
                    host: self.manager.host().clone(),
                    drivers: devices.iter().map(|d| d.driver_version.clone()).collect(),
                    module_signer: self
                        .parts
                        .packages
                        .as_ref()
                        .and_then(|p| p.module_signer(module)),
                    qualified,
                    smoke,
                };
                self.maintenance
                    .as_ref()
                    .map(|m| m.after_boot(&facts, x.enrolled_signer.as_deref()))
            }
            s => {
                return Err(err(
                    "conflict",
                    format!("maintenance is {s:?}; nothing to advance"),
                ));
            }
        }
        .ok_or_else(|| err("unavailable", "driver maintenance is off on this host"))?
        .map_err(m_err)?;
        let pause = self
            .maintenance
            .as_ref()
            .map(DriverMaintenance::admission_pause)
            .transpose()
            .map_err(m_err)?
            .flatten();
        self.manager.set_admission_paused(pause);
        Ok(json!({"maintenance": rec, "admissionPaused": self.manager.admission_paused()}))
    }

    /// Periodic work: reserve queued claims in fair order, stop workloads
    /// past their maximum runtime, retry held settles, and hold cooperative
    /// sharers to their budgets.
    pub fn tick(&mut self, now_ms: u64) -> Result<Value, ServiceError> {
        let elapsed = self.last_tick_ms.map_or(0, |t| now_ms.saturating_sub(t));
        self.last_tick_ms = Some(now_ms);
        let reserved = self.manager.pump().map_err(from_manager)?;
        let mut stopped = Vec::new();
        let open = self.manager.open_allocations().map_err(from_manager)?;
        for rec in &open {
            let over = self.extras.get(&rec.id).is_some_and(|e| {
                matches!((e.max_runtime_ms, e.started_ms), (Some(m), Some(s)) if now_ms.saturating_sub(s) > m)
            });
            if over && rec.state == AllocationState::Running {
                let _ = self.release(&rec.id, "the job ran past its maximum runtime");
                stopped.push(json!({"allocationId": rec.id.as_str(), "why": "max-runtime"}));
                continue;
            }
            if matches!(
                rec.state,
                AllocationState::Draining | AllocationState::Failed
            ) {
                let _ = self.settle(&rec.id);
            }
        }
        for (id, why) in self.coop_sample(now_ms, elapsed) {
            let _ = self.release(&id, &why);
            stopped.push(json!({"allocationId": id.as_str(), "why": why}));
        }
        Ok(json!({
            "reserved": reserved.iter().map(AllocationId::as_str).collect::<Vec<_>>(),
            "stopped": stopped,
        }))
    }

    fn coop_sample(&mut self, now_ms: u64, elapsed_ms: u64) -> Vec<(AllocationId, String)> {
        let sharers: Vec<(AllocationRecord, ShareLimits)> = self
            .manager
            .open_allocations()
            .unwrap_or_default()
            .into_iter()
            .filter(|r| {
                r.state == AllocationState::Running
                    && r.request.policy.kind() == PolicyKind::Cooperative
            })
            .filter_map(|r| {
                let s = self.extras.get(&r.id).and_then(|e| e.share)?;
                Some((r, s))
            })
            .collect();
        if sharers.is_empty() {
            return Vec::new();
        }
        let pmon = self
            .parts
            .tools
            .output(&Tool::NvidiaSmiPmon)
            .ok()
            .and_then(|t| parse_pmon(&t).ok());
        let apps = self
            .parts
            .tools
            .output(&Tool::NvidiaSmiComputeApps)
            .ok()
            .and_then(|t| parse_compute_apps(&t).ok());
        let (Some(pmon), Some(apps)) = (pmon, apps) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (rec, limits) in sharers {
            let Some(d) = rec
                .claims
                .first()
                .and_then(|c| self.manager.device_record(&c.device))
                .cloned()
            else {
                continue;
            };
            let idx: u32 = d.cdi_name.parse().unwrap_or(u32::MAX);
            let owner: &dyn PidOwner = self.parts.runtime.as_ref();
            let (usage, _) = attribute(&d.pci, idx, &pmon, &apps, owner);
            let u = usage.get(&rec.id).copied().unwrap_or(crate::coop::Usage {
                used_mib: 0,
                sm_percent: 0,
            });
            if let CoopDecision::Revoke(why) =
                self.ledger.record(&rec.id, &limits, u, now_ms, elapsed_ms)
            {
                out.push((rec.id.clone(), format!("cooperative share exceeded: {why}")));
            }
        }
        out
    }
}

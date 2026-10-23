#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use flagship_gpu::catalog::{
    ApprovedImage, CATALOG_SCHEMA, CatalogEntry, CatalogEnvelope, CatalogPayload, CatalogVerifier,
    HostFacts, VerifiedCatalog, signing_bytes,
};
use flagship_gpu::device::{
    Backend, Capability, DeviceRecord, PartitionId, PartitionMode, PartitionRecord, PciAddress,
    Vendor,
};
use flagship_gpu::ids::{LocalDeviceId, LocalIdKey};
use flagship_gpu::manager::{DeviceManager, Presence, WorkloadRuntime};
use flagship_gpu::policy::{AllocationId, AllocationPolicy, PolicyKind};
use flagship_gpu::provider::{
    CleanupOutcome, DeviceActivity, DeviceProvider, IsolationProfile, ProviderError,
};
use flagship_gpu::request::{AppInstallation, GpuApproval, GpuRequest};
use flagship_gpu::sqlite::SqliteJournal;
use flagship_gpu::sysfs::PciDevice;
use flagship_gpu::topology::{GangRequirement, Topology};
use sha2::{Digest, Sha256};

pub const KERNEL: &str = "6.12.48+deb13-amd64";
pub const DRIVER: &str = "580.95.05";
pub const RUNSC: &str = "20260921.0";
pub const NVCTK: &str = "nvidia-ctk 1.18.0";
pub const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

pub fn fixture(name: &str) -> String {
    std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}

pub fn key() -> LocalIdKey {
    LocalIdKey::new([7; 32])
}

/// Test signer: the "signature" is SHA-256 of the message under key "test".
#[derive(Debug)]
pub struct TestVerifier;

impl CatalogVerifier for TestVerifier {
    fn verify(&self, key_id: &str, message: &[u8], signature: &[u8]) -> Result<(), String> {
        if key_id != "test" {
            return Err("unknown key".into());
        }
        if Sha256::digest(message).as_slice() != signature {
            return Err("bad signature".into());
        }
        Ok(())
    }
}

pub fn sign(payload: &CatalogPayload) -> CatalogEnvelope {
    let text = serde_json::to_string(payload).unwrap();
    let sig = Sha256::digest(signing_bytes("test", payload.serial, &text));
    CatalogEnvelope {
        schema: CATALOG_SCHEMA.into(),
        key_id: "test".into(),
        serial: payload.serial,
        payload: text,
        signature: sig.iter().map(|b| format!("{b:02x}")).collect(),
    }
}

pub fn entry(id: &str, backend: Backend, pci_ids: &[&str], toolkit: &str) -> CatalogEntry {
    let nvidia = backend == Backend::NvidiaCuda;
    CatalogEntry {
        id: id.into(),
        backend,
        pci_device_ids: pci_ids.iter().map(|s| (*s).to_owned()).collect(),
        model: id.into(),
        kernels: vec![KERNEL.into()],
        module_signing_required: true,
        drivers: vec![DRIVER.into()],
        toolkits: vec![toolkit.into()],
        cdi_generators: vec![NVCTK.into()],
        runsc: if nvidia { vec![RUNSC.into()] } else { vec![] },
        isolation: if nvidia {
            vec![
                IsolationProfile::GvisorNvproxy,
                IsolationProfile::VmPassthrough,
            ]
        } else {
            vec![IsolationProfile::VmPassthrough]
        },
        capabilities: vec![Capability::Compute],
        partitioning: nvidia,
        cooperative_sharing: true,
        images: vec![ApprovedImage {
            purpose: "runtime".into(),
            reference: format!("registry.example/{id}@sha256:{DIGEST}"),
        }],
    }
}

pub fn catalog() -> VerifiedCatalog {
    let payload = CatalogPayload {
        schema: CATALOG_SCHEMA.into(),
        serial: 3,
        issued_at: "2026-10-01T00:00:00Z".into(),
        entries: vec![
            entry("h100", Backend::NvidiaCuda, &["0x2330"], "13.0"),
            entry("a100", Backend::NvidiaCuda, &["0x20b0"], "13.0"),
            entry("mi210", Backend::AmdRocm, &["0x740f"], "6.4.3"),
        ],
    };
    VerifiedCatalog::open(&sign(&payload), &TestVerifier, 0).unwrap()
}

pub fn host() -> HostFacts {
    HostFacts {
        kernel: KERNEL.into(),
        module_signing_enforced: true,
        runsc: Some(RUNSC.into()),
        cdi_generator: Some(NVCTK.into()),
    }
}

pub fn device(
    name: &str,
    backend: Backend,
    pci_id: u16,
    bus: u8,
    memory_mib: u64,
    index: u32,
) -> DeviceRecord {
    let vendor = backend.vendor();
    let pci = PciAddress::parse(&format!("0000:{bus:02x}:00.0")).unwrap();
    DeviceRecord {
        id: LocalDeviceId::derive(&key(), vendor, name),
        vendor,
        backend,
        model: name.into(),
        pci: pci.clone(),
        pci_device_id: Some(pci_id),
        memory_mib,
        driver_version: DRIVER.into(),
        toolkit_version: Some(
            if vendor == Vendor::Amd {
                "6.4.3"
            } else {
                "13.0"
            }
            .into(),
        ),
        capabilities: BTreeSet::from([Capability::Compute]),
        display_owned: false,
        iommu_group: Some(u32::from(bus)),
        iommu_group_members: vec![pci],
        numa_node: Some(0),
        kernel_driver: None,
        partition_mode: PartitionMode::Disabled,
        partitions: Vec::new(),
        cdi_name: index.to_string(),
    }
}

pub fn h100(i: u8) -> DeviceRecord {
    device(
        &format!("h100-{i}"),
        Backend::NvidiaCuda,
        0x2330,
        0x10 + i,
        81_559,
        u32::from(i),
    )
}

pub fn a100_mig(partitions: &[(u32, u32, u64)]) -> DeviceRecord {
    let mut d = device("a100", Backend::NvidiaCuda, 0x20b0, 0x41, 40_960, 9);
    d.partition_mode = PartitionMode::Enabled;
    d.partitions = partitions
        .iter()
        .enumerate()
        .map(|(i, (gi, ci, mem))| PartitionRecord {
            id: PartitionId {
                gpu_instance: *gi,
                compute_instance: *ci,
            },
            memory_mib: *mem,
            cdi_name: format!("9:{i}"),
        })
        .collect();
    d
}

pub fn activity_key(d: &LocalDeviceId, p: Option<&PartitionId>) -> String {
    match p {
        Some(p) => format!("{d}/{p}"),
        None => d.to_string(),
    }
}

/// A provider whose devices, activity and cleanup the test controls.
#[derive(Debug)]
pub struct FakeProvider {
    pub backend: Backend,
    pub devices: Mutex<Vec<DeviceRecord>>,
    pub activity: Mutex<BTreeMap<String, DeviceActivity>>,
    pub cleanup: Mutex<CleanupOutcome>,
}

impl FakeProvider {
    pub fn new(backend: Backend, devices: Vec<DeviceRecord>) -> Arc<Self> {
        Arc::new(Self {
            backend,
            devices: Mutex::new(devices),
            activity: Mutex::new(BTreeMap::new()),
            cleanup: Mutex::new(CleanupOutcome::Proven),
        })
    }

    pub fn set_activity(&self, d: &LocalDeviceId, p: Option<&PartitionId>, a: DeviceActivity) {
        self.activity.lock().unwrap().insert(activity_key(d, p), a);
    }
}

impl DeviceProvider for FakeProvider {
    fn backend(&self) -> Backend {
        self.backend
    }

    fn enumerate(
        &self,
        _: &LocalIdKey,
        _: &[PciDevice],
    ) -> Result<Vec<DeviceRecord>, ProviderError> {
        Ok(self.devices.lock().unwrap().clone())
    }

    fn observe(&self, d: &DeviceRecord, p: Option<&PartitionId>) -> DeviceActivity {
        let a = self.activity.lock().unwrap();
        a.get(&activity_key(&d.id, p))
            .or_else(|| a.get(d.id.as_str()))
            .copied()
            .unwrap_or(DeviceActivity::Idle)
    }

    fn cleanup(&self, _: &DeviceRecord, _: Option<&PartitionId>) -> CleanupOutcome {
        self.cleanup.lock().unwrap().clone()
    }

    fn isolation_profiles(&self) -> &'static [IsolationProfile] {
        match self.backend {
            Backend::NvidiaCuda => &[
                IsolationProfile::GvisorNvproxy,
                IsolationProfile::VmPassthrough,
            ],
            _ => &[IsolationProfile::VmPassthrough],
        }
    }
}

/// The runtime as the test arranges it.
#[derive(Debug, Default)]
pub struct FakeRuntime {
    pub presence: Mutex<BTreeMap<AllocationId, Presence>>,
    pub stops: Mutex<Vec<AllocationId>>,
    /// When true, `stop` doesn't make the workload absent (a slow stop).
    pub sticky: Mutex<bool>,
}

impl FakeRuntime {
    pub fn set(&self, id: &AllocationId, p: Presence) {
        self.presence.lock().unwrap().insert(id.clone(), p);
    }
}

impl WorkloadRuntime for FakeRuntime {
    fn presence(&self, id: &AllocationId) -> Presence {
        self.presence
            .lock()
            .unwrap()
            .get(id)
            .copied()
            .unwrap_or(Presence::Absent)
    }

    fn stop(&self, id: &AllocationId) -> Result<(), String> {
        self.stops.lock().unwrap().push(id.clone());
        if !*self.sticky.lock().unwrap() {
            self.presence
                .lock()
                .unwrap()
                .insert(id.clone(), Presence::Absent);
        }
        Ok(())
    }
}

pub fn manager(
    journal: SqliteJournal,
    providers: Vec<Arc<dyn DeviceProvider>>,
    topology: Topology,
) -> DeviceManager<SqliteJournal> {
    let mut m = DeviceManager::new(journal, key(), providers, catalog(), host(), 4, 16);
    m.refresh_inventory(&[], topology).unwrap();
    m
}

pub fn app(name: &str) -> AppInstallation {
    AppInstallation {
        app_id: name.into(),
        installation_id: format!("{name}-inst"),
        generation: 1,
    }
}

pub fn aid(s: &str) -> AllocationId {
    AllocationId::new(s).unwrap()
}

pub struct Ask {
    pub backend: Backend,
    pub count: u32,
    pub memory: u64,
    pub policy: AllocationPolicy,
    pub isolation: IsolationProfile,
    pub gang: GangRequirement,
    pub secrecy: bool,
}

impl Default for Ask {
    fn default() -> Self {
        Self {
            backend: Backend::NvidiaCuda,
            count: 1,
            memory: 1024,
            policy: AllocationPolicy::Exclusive,
            isolation: IsolationProfile::GvisorNvproxy,
            gang: GangRequirement::Any,
            secrecy: false,
        }
    }
}

pub fn cooperative(domain: &str) -> AllocationPolicy {
    AllocationPolicy::Cooperative {
        trust_domain: domain.into(),
        owner_consent: format!("consent-{domain}"),
    }
}

pub fn gpu_request(app_name: &str, ask: &Ask) -> GpuRequest {
    GpuRequest {
        app: app(app_name),
        operation_id: "op".into(),
        backend: ask.backend,
        count: ask.count,
        minimum_memory_mib: ask.memory,
        capabilities: BTreeSet::from([Capability::Compute]),
        policy: ask.policy.clone(),
        isolation: ask.isolation,
        gang: ask.gang,
        userspace: None,
    }
}

pub fn approval_for(req: &GpuRequest, secrecy: bool) -> GpuApproval {
    let (domain, consent) = match &req.policy {
        AllocationPolicy::Cooperative {
            trust_domain,
            owner_consent,
        } => (Some(trust_domain.clone()), Some(owner_consent.clone())),
        _ => (None, None),
    };
    GpuApproval {
        app: req.app.clone(),
        backend: req.backend,
        max_count: 16,
        capabilities: req.capabilities.clone(),
        policies: BTreeSet::from([
            PolicyKind::Exclusive,
            PolicyKind::Partition,
            PolicyKind::Cooperative,
        ]),
        isolation: req.isolation,
        secrecy,
        trust_domain: domain,
        owner_consent: consent,
    }
}

/// request + admit with a matching approval.
pub fn admitted(
    m: &DeviceManager<SqliteJournal>,
    id: &str,
    app_name: &str,
    ask: &Ask,
) -> AllocationId {
    let req = gpu_request(app_name, ask);
    let approval = approval_for(&req, ask.secrecy);
    let id = aid(id);
    m.request(id.clone(), req, ask.secrecy).unwrap();
    m.admit(&id, Some(&approval)).unwrap();
    id
}

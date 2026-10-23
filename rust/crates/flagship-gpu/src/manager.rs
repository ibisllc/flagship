//! The lifecycle half of the device-provider interface: enumerate,
//! validate, reserve, attach, observe, drain and release or quarantine,
//! all through the journal. Only the broker owns a `DeviceManager`.

use std::collections::BTreeSet;
use std::fmt;
use std::sync::Arc;

use sha2::{Digest, Sha256};

use crate::catalog::{ApprovedImage, CatalogEntry, HostFacts, VerifiedCatalog};
use crate::cdi::ValidatedCdi;
use crate::device::{Backend, DeviceRecord, PartitionMode, PciAddress};
use crate::ids::{LocalDeviceId, LocalIdKey};
use crate::journal::{
    AllocationRecord, AllocationState, DeviceClaim, Finish, JournalError, JournalStore,
};
use crate::policy::{AllocationId, AllocationPolicy, Holding, PolicyKind, admissible};
use crate::provider::{CleanupOutcome, DeviceActivity, DeviceProvider, IsolationProfile};
use crate::queue::{FairQueue, QueueError};
use crate::request::{GpuApproval, GpuRequest};
use crate::sysfs::PciDevice;
use crate::topology::{Topology, check_gang};

/// What the runtime says about an allocation's workload.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presence {
    Present,
    Absent,
    /// The runtime couldn't answer. Never treated as absent.
    Unknown,
}

/// The runtime adapter's view, implemented by `flagship-runtime`.
pub trait WorkloadRuntime {
    fn presence(&self, allocation: &AllocationId) -> Presence;
    fn stop(&self, allocation: &AllocationId) -> Result<(), String>;
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ManagerError {
    #[error(transparent)]
    Journal(#[from] JournalError),
    #[error("invalid GPU request: {0}")]
    Request(&'static str),
    #[error("GPU access not approved: {0}")]
    NotApproved(String),
    #[error("no {0} provider on this host")]
    NoProvider(Backend),
    #[error("attach refused: {0}")]
    Attach(String),
    #[error(transparent)]
    Queue(#[from] QueueError),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReserveOutcome {
    Reserved(Box<AllocationRecord>),
    /// Nothing fits right now; each reason says why a device was skipped.
    NoCapacity(Vec<String>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachPlan {
    pub allocation: AllocationId,
    pub isolation: IsolationProfile,
    /// Fully qualified CDI names for gVisor/nvproxy.
    pub cdi_devices: Vec<String>,
    pub cdi_spec_digest: Option<String>,
    /// PCI functions to bind to VFIO for VM passthrough.
    pub vfio_functions: Vec<PciAddress>,
    pub image: ApprovedImage,
    pub catalog_entry: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Settle {
    Released,
    Quarantined(String),
    /// Not provably free yet; the device stays held.
    Held(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InventoryReport {
    pub devices: usize,
    pub unavailable: Vec<(Backend, String)>,
    pub generation: u64,
    pub reconcile_required: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReconcileAction {
    /// The workload is still there and its allocation was running: keep it.
    Adopted,
    /// Re-queued for reservation after a restart.
    Requeued,
    /// Never admitted before the restart; closed, resubmit.
    Closed,
    Settled(Settle),
}

pub struct DeviceManager<S: JournalStore> {
    store: S,
    key: LocalIdKey,
    providers: Vec<Arc<dyn DeviceProvider>>,
    catalog: VerifiedCatalog,
    host: HostFacts,
    inventory: Vec<DeviceRecord>,
    topology: Topology,
    generation: u64,
    queue: FairQueue,
}

impl<S: JournalStore> fmt::Debug for DeviceManager<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceManager")
            .field("devices", &self.inventory.len())
            .field("generation", &self.generation)
            .field("queued", &self.queue.len())
            .finish_non_exhaustive()
    }
}

/// Fingerprint of everything that changes what can be claimed: devices,
/// partition mode and the partition layout.
fn fingerprint(devices: &[DeviceRecord]) -> String {
    let mut h = Sha256::new();
    let mut ids: Vec<&DeviceRecord> = devices.iter().collect();
    ids.sort_by(|a, b| a.id.cmp(&b.id));
    for d in ids {
        h.update(d.id.as_str().as_bytes());
        h.update(format!("|{:?}|", d.partition_mode).as_bytes());
        for p in &d.partitions {
            h.update(format!("{}:{}:{};", p.id, p.memory_mib, p.cdi_name).as_bytes());
        }
        h.update(b"\n");
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

impl<S: JournalStore> DeviceManager<S> {
    pub fn new(
        store: S,
        key: LocalIdKey,
        providers: Vec<Arc<dyn DeviceProvider>>,
        catalog: VerifiedCatalog,
        host: HostFacts,
        queue_per_app: usize,
        queue_total: usize,
    ) -> Self {
        Self {
            store,
            key,
            providers,
            catalog,
            host,
            inventory: Vec::new(),
            topology: Topology::new(),
            generation: 0,
            queue: FairQueue::new(queue_per_app, queue_total),
        }
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    pub fn inventory(&self) -> &[DeviceRecord] {
        &self.inventory
    }

    fn provider(&self, b: Backend) -> Option<&Arc<dyn DeviceProvider>> {
        self.providers.iter().find(|p| p.backend() == b)
    }

    fn device(&self, id: &LocalDeviceId) -> Option<&DeviceRecord> {
        self.inventory.iter().find(|d| d.id == *id)
    }

    /// Enumerate every provider and record the inventory fingerprint. A
    /// changed device set or partition layout bumps the topology generation
    /// and blocks reservations until [`DeviceManager::reconcile`].
    pub fn refresh_inventory(
        &mut self,
        pci: &[PciDevice],
        topology: Topology,
    ) -> Result<InventoryReport, ManagerError> {
        let mut devices = Vec::new();
        let mut unavailable = Vec::new();
        for p in &self.providers {
            match p.enumerate(&self.key, pci) {
                Ok(mut d) => devices.append(&mut d),
                Err(e) => unavailable.push((p.backend(), e.to_string())),
            }
        }
        let t = self.store.record_topology(&fingerprint(&devices))?;
        self.inventory = devices;
        self.topology = topology;
        self.generation = t.generation;
        Ok(InventoryReport {
            devices: self.inventory.len(),
            unavailable,
            generation: t.generation,
            reconcile_required: t.generation != t.reconciled,
        })
    }

    /// The catalog entry qualifying `device` for `req`, or why not.
    pub fn validate(
        &self,
        device: &DeviceRecord,
        req: &GpuRequest,
    ) -> Result<&CatalogEntry, Vec<String>> {
        let provider = self
            .provider(device.backend)
            .ok_or_else(|| vec![format!("no {} provider", device.backend)])?;
        provider
            .validate_compatibility(
                device,
                &self.host,
                &self.catalog,
                req.isolation,
                &req.capabilities,
            )
            .map_err(|u| u.0)
    }

    pub fn request(
        &self,
        id: AllocationId,
        req: GpuRequest,
        secrecy: bool,
    ) -> Result<AllocationRecord, ManagerError> {
        if let Some(why) = req.shape_error() {
            return Err(ManagerError::Request(why));
        }
        let rec = AllocationRecord::new(id, req, secrecy);
        self.store.create(&rec)?;
        Ok(rec)
    }

    /// `requested -> admitted` if the owner's approval covers the request,
    /// else `-> failed`. An app without a GPU approval is always refused.
    pub fn admit(
        &self,
        id: &AllocationId,
        approval: Option<&GpuApproval>,
    ) -> Result<AllocationRecord, ManagerError> {
        let rec = self.get(id)?;
        let why = match approval {
            None => Some("this app has no GPU approval".to_owned()),
            Some(a) if a.secrecy != rec.secrecy => {
                Some("secrecy differs from the approval".to_owned())
            }
            Some(a) => a.refuses(&rec.request),
        };
        if let Some(why) = why {
            self.store.transition(
                id,
                AllocationState::Requested,
                AllocationState::Failed,
                Some(&why),
            )?;
            self.store
                .finish(id, AllocationState::Failed, &Finish::Released)?;
            return Err(ManagerError::NotApproved(why));
        }
        Ok(self.store.transition(
            id,
            AllocationState::Requested,
            AllocationState::Admitted,
            None,
        )?)
    }

    fn get(&self, id: &AllocationId) -> Result<AllocationRecord, ManagerError> {
        self.store
            .get(id)?
            .ok_or_else(|| ManagerError::Journal(JournalError::NotFound(id.clone())))
    }

    fn holdings(&self, d: &LocalDeviceId) -> Vec<Holding> {
        self.store.holdings(d).unwrap_or_default()
    }

    /// Devices (or partitions) this request could use, each with a reason
    /// when skipped.
    fn eligible(
        &self,
        rec: &AllocationRecord,
        quarantined: &BTreeSet<LocalDeviceId>,
    ) -> (Vec<DeviceClaim>, Vec<String>) {
        let req = &rec.request;
        let mut out = Vec::new();
        let mut why = Vec::new();
        for d in self.inventory.iter().filter(|d| d.backend == req.backend) {
            let skip = |why: &mut Vec<String>, r: &str| why.push(format!("{}: {r}", d.id));
            if d.display_owned {
                skip(&mut why, "drives a display");
                continue;
            }
            if quarantined.contains(&d.id) {
                skip(&mut why, "quarantined");
                continue;
            }
            if !req.capabilities.is_subset(&d.capabilities) {
                skip(&mut why, "lacks a requested capability");
                continue;
            }
            let entry = match self.validate(d, req) {
                Ok(e) => e,
                Err(reasons) => {
                    why.extend(reasons);
                    continue;
                }
            };
            if req.isolation == IsolationProfile::VmPassthrough
                && let Err(r) = passthrough_safe(d)
            {
                skip(&mut why, &r);
                continue;
            }
            match &req.policy {
                AllocationPolicy::Partition => {
                    if !entry.partitioning || d.partition_mode != PartitionMode::Enabled {
                        skip(&mut why, "no qualified hardware partitions");
                        continue;
                    }
                    let held = self.holdings(&d.id);
                    for p in d
                        .partitions
                        .iter()
                        .filter(|p| p.memory_mib >= req.minimum_memory_mib)
                    {
                        let ours = held.iter().any(|h| h.partition.as_ref() == Some(&p.id));
                        if !ours && self.foreign_activity(d, Some(&p.id)) {
                            skip(
                                &mut why,
                                &format!("{} shows processes no allocation accounts for", p.id),
                            );
                            continue;
                        }
                        out.push(DeviceClaim {
                            device: d.id.clone(),
                            partition: Some(p.id.clone()),
                            memory_mib: p.memory_mib,
                            cdi_name: p.cdi_name.clone(),
                        });
                    }
                }
                AllocationPolicy::Exclusive | AllocationPolicy::Cooperative { .. } => {
                    if d.partition_mode == PartitionMode::Enabled {
                        skip(&mut why, "partitioned; whole-device use needs MIG off");
                        continue;
                    }
                    if d.memory_mib < req.minimum_memory_mib {
                        skip(&mut why, "not enough memory");
                        continue;
                    }
                    if self.holdings(&d.id).is_empty() && self.foreign_activity(d, None) {
                        skip(&mut why, "shows processes no allocation accounts for");
                        continue;
                    }
                    let cooperative = req.policy.kind() == PolicyKind::Cooperative;
                    if cooperative && !entry.cooperative_sharing {
                        skip(&mut why, "cooperative sharing not qualified");
                        continue;
                    }
                    out.push(DeviceClaim {
                        device: d.id.clone(),
                        partition: None,
                        memory_mib: if cooperative {
                            req.minimum_memory_mib
                        } else {
                            d.memory_mib
                        },
                        cdi_name: d.cdi_name.clone(),
                    });
                }
            }
        }
        (out, why)
    }

    /// Positive evidence that something outside the journal uses a device
    /// it calls free. `Unknown` is not evidence either way at admission;
    /// release still demands proof.
    fn foreign_activity(
        &self,
        d: &DeviceRecord,
        partition: Option<&crate::device::PartitionId>,
    ) -> bool {
        self.provider(d.backend)
            .is_some_and(|p| matches!(p.observe(d, partition), DeviceActivity::Busy { .. }))
    }

    /// `admitted -> reserved`, all devices or none. A gang must also pass
    /// the topology check.
    pub fn reserve(&mut self, id: &AllocationId) -> Result<ReserveOutcome, ManagerError> {
        let rec = self.get(id)?;
        if rec.state != AllocationState::Admitted {
            return Err(JournalError::StateConflict {
                expected: AllocationState::Admitted,
                actual: rec.state,
            }
            .into());
        }
        let quarantined: BTreeSet<LocalDeviceId> = self
            .store
            .quarantined()?
            .into_iter()
            .map(|(d, _)| d)
            .collect();
        let (eligible, mut why) = self.eligible(&rec, &quarantined);
        // Pre-filter with the same rule the journal enforces, then let the
        // journal decide atomically.
        let free: Vec<DeviceClaim> = eligible
            .into_iter()
            .filter(|c| {
                let probe = rec.holding(c);
                let total = self.device(&c.device).map_or(0, |d| d.memory_mib);
                match admissible(&self.holdings(&c.device), &probe, total) {
                    Ok(()) => true,
                    Err(conflict) => {
                        why.push(format!("{}: {conflict}", c.device));
                        false
                    }
                }
            })
            .collect();
        let count = usize::try_from(rec.request.count).unwrap_or(usize::MAX);
        let Some(claims) = self.pick(&free, count, &rec) else {
            if why.is_empty() {
                why.push("no device matches".into());
            }
            return Ok(ReserveOutcome::NoCapacity(why));
        };
        let memory: Vec<(LocalDeviceId, u64)> = claims
            .iter()
            .filter_map(|c| self.device(&c.device).map(|d| (d.id.clone(), d.memory_mib)))
            .collect();
        match self.store.reserve(id, &claims, &memory, self.generation) {
            Ok(r) => Ok(ReserveOutcome::Reserved(Box::new(r))),
            Err(JournalError::Conflict { device, conflict }) => Ok(ReserveOutcome::NoCapacity(
                vec![format!("{device}: {conflict}")],
            )),
            Err(e) => Err(e.into()),
        }
    }

    /// First set of `count` claims on distinct devices that passes the gang
    /// topology check.
    fn pick(
        &self,
        free: &[DeviceClaim],
        count: usize,
        rec: &AllocationRecord,
    ) -> Option<Vec<DeviceClaim>> {
        if count == 1 {
            return free.first().cloned().map(|c| vec![c]);
        }
        let mut chosen: Vec<usize> = Vec::new();
        self.combine(free, count, 0, &mut chosen, rec)
            .map(|idx| idx.iter().filter_map(|i| free.get(*i).cloned()).collect())
    }

    fn combine(
        &self,
        free: &[DeviceClaim],
        count: usize,
        start: usize,
        chosen: &mut Vec<usize>,
        rec: &AllocationRecord,
    ) -> Option<Vec<usize>> {
        if chosen.len() == count {
            let devs: Vec<&DeviceRecord> = chosen
                .iter()
                .filter_map(|i| free.get(*i).and_then(|c| self.device(&c.device)))
                .collect();
            return check_gang(&devs, &self.topology, rec.request.gang)
                .ok()
                .map(|()| chosen.clone());
        }
        for i in start..free.len() {
            let dup = free.get(i).is_some_and(|c| {
                chosen
                    .iter()
                    .any(|j| free.get(*j).map(|x| &x.device) == Some(&c.device))
            });
            if dup {
                continue;
            }
            chosen.push(i);
            if let Some(found) = self.combine(free, count, i.saturating_add(1), chosen, rec) {
                return Some(found);
            }
            chosen.pop();
        }
        None
    }

    pub fn enqueue(&mut self, id: &AllocationId) -> Result<usize, ManagerError> {
        let rec = self.get(id)?;
        if rec.state != AllocationState::Admitted {
            return Err(ManagerError::Request("only admitted allocations queue"));
        }
        Ok(self.queue.enqueue(&rec.request.app.app_id, id.clone())?)
    }

    /// Reserve queued allocations in fair order until nothing more fits.
    pub fn pump(&mut self) -> Result<Vec<AllocationId>, ManagerError> {
        let mut done = Vec::new();
        loop {
            let mut progressed = false;
            for id in self.queue.candidates() {
                match self.get(&id).map(|r| r.state) {
                    Ok(AllocationState::Admitted) => {}
                    _ => {
                        self.queue.remove(&id);
                        continue;
                    }
                }
                if let ReserveOutcome::Reserved(_) = self.reserve(&id)? {
                    self.queue.remove(&id);
                    done.push(id);
                    progressed = true;
                    break;
                }
            }
            if !progressed {
                return Ok(done);
            }
        }
    }

    /// `reserved -> attached`, recorded before the runtime starts anything
    /// (write-ahead), returning exactly what the runtime may inject.
    pub fn attach(
        &self,
        id: &AllocationId,
        cdi: Option<&ValidatedCdi>,
    ) -> Result<AttachPlan, ManagerError> {
        let rec = self.get(id)?;
        if rec.state != AllocationState::Reserved {
            return Err(ManagerError::Attach(format!("allocation is {}", rec.state)));
        }
        let req = &rec.request;
        let first = rec
            .claims
            .first()
            .and_then(|c| self.device(&c.device))
            .ok_or_else(|| ManagerError::Attach("reserved device is gone".into()))?;
        let entry = self
            .validate(first, req)
            .map_err(|r| ManagerError::Attach(r.join("; ")))?;
        let image = match &req.userspace {
            Some(p) => entry.images.iter().find(|i| i.purpose == *p),
            None => entry.images.first(),
        }
        .cloned()
        .ok_or_else(|| {
            ManagerError::Attach("no approved userspace image for that purpose".into())
        })?;
        let (cdi_devices, cdi_spec_digest, vfio_functions) = match req.isolation {
            IsolationProfile::GvisorNvproxy => {
                let cdi = cdi.ok_or_else(|| {
                    ManagerError::Attach("gVisor attach needs a validated CDI spec".into())
                })?;
                let want: BTreeSet<String> = rec
                    .claims
                    .iter()
                    .map(|c| format!("{}={}", req.backend.cdi_kind(), c.cdi_name))
                    .collect();
                let got: BTreeSet<String> = cdi.devices.iter().cloned().collect();
                if want != got {
                    return Err(ManagerError::Attach(
                        "CDI devices differ from the reservation".into(),
                    ));
                }
                (
                    cdi.devices.clone(),
                    Some(cdi.spec_digest.clone()),
                    Vec::new(),
                )
            }
            IsolationProfile::VmPassthrough => {
                if cdi.is_some() {
                    return Err(ManagerError::Attach(
                        "VM passthrough takes no CDI spec".into(),
                    ));
                }
                let mut f = Vec::new();
                for c in &rec.claims {
                    let d = self
                        .device(&c.device)
                        .ok_or_else(|| ManagerError::Attach("reserved device is gone".into()))?;
                    passthrough_safe(d).map_err(ManagerError::Attach)?;
                    f.extend(d.iommu_group_members.iter().cloned());
                }
                (Vec::new(), None, f)
            }
        };
        self.store.transition(
            id,
            AllocationState::Reserved,
            AllocationState::Attached,
            None,
        )?;
        Ok(AttachPlan {
            allocation: id.clone(),
            isolation: req.isolation,
            cdi_devices,
            cdi_spec_digest,
            vfio_functions,
            image,
            catalog_entry: entry.id.clone(),
        })
    }

    pub fn started(&self, id: &AllocationId) -> Result<AllocationRecord, ManagerError> {
        Ok(self.store.transition(
            id,
            AllocationState::Attached,
            AllocationState::Running,
            None,
        )?)
    }

    pub fn heartbeat(&self, id: &AllocationId, now_ms: u64) -> Result<(), ManagerError> {
        Ok(self.store.heartbeat(id, now_ms)?)
    }

    pub fn observe(&self, claim: &DeviceClaim) -> DeviceActivity {
        match (
            self.device(&claim.device),
            self.device(&claim.device)
                .and_then(|d| self.provider(d.backend)),
        ) {
            (Some(d), Some(p)) => p.observe(d, claim.partition.as_ref()),
            _ => DeviceActivity::Unknown,
        }
    }

    /// Stop the workload and move to `draining`. Ownership is kept until
    /// [`DeviceManager::settle`] proves the device free and clean.
    pub fn drain(
        &self,
        id: &AllocationId,
        runtime: &dyn WorkloadRuntime,
        reason: &str,
    ) -> Result<AllocationRecord, ManagerError> {
        let rec = self.get(id)?;
        let rec = match rec.state {
            AllocationState::Reserved | AllocationState::Attached | AllocationState::Running => {
                self.store
                    .transition(id, rec.state, AllocationState::Draining, Some(reason))?
            }
            AllocationState::Draining | AllocationState::Failed => rec,
            other => {
                return Err(JournalError::IllegalTransition {
                    from: other,
                    to: AllocationState::Draining,
                }
                .into());
            }
        };
        let _ = runtime.stop(id);
        Ok(rec)
    }

    /// The owner withdrew approval (or the app was removed or updated to a
    /// new generation): drain every open allocation of that app.
    pub fn revoke_app(
        &self,
        app_id: &str,
        runtime: &dyn WorkloadRuntime,
    ) -> Result<Vec<AllocationId>, ManagerError> {
        let mut out = Vec::new();
        for rec in self.store.list_open()? {
            if rec.request.app.app_id != app_id {
                continue;
            }
            match rec.state {
                AllocationState::Requested | AllocationState::Admitted => {
                    self.store.transition(
                        &rec.id,
                        rec.state,
                        AllocationState::Failed,
                        Some("approval revoked"),
                    )?;
                    self.store
                        .finish(&rec.id, AllocationState::Failed, &Finish::Released)?;
                }
                _ => {
                    self.drain(&rec.id, runtime, "approval revoked")?;
                }
            }
            out.push(rec.id);
        }
        Ok(out)
    }

    pub fn fail(&self, id: &AllocationId, reason: &str) -> Result<AllocationRecord, ManagerError> {
        let rec = self.get(id)?;
        Ok(self
            .store
            .transition(id, rec.state, AllocationState::Failed, Some(reason))?)
    }

    /// Release only on proof: no workload, every device idle, and cleanup
    /// proven. Unproven cleanup quarantines; anything unknown keeps holding.
    pub fn settle(
        &self,
        id: &AllocationId,
        runtime: &dyn WorkloadRuntime,
    ) -> Result<Settle, ManagerError> {
        let rec = self.get(id)?;
        if !matches!(
            rec.state,
            AllocationState::Draining | AllocationState::Failed
        ) {
            return Ok(Settle::Held(format!("allocation is {}", rec.state)));
        }
        if rec.claims.is_empty() {
            self.store.finish(id, rec.state, &Finish::Released)?;
            return Ok(Settle::Released);
        }
        match runtime.presence(id) {
            Presence::Absent => {}
            Presence::Present => {
                let _ = runtime.stop(id);
                return Ok(Settle::Held("workload still present".into()));
            }
            Presence::Unknown => {
                return Ok(Settle::Held(
                    "runtime cannot confirm the workload is gone".into(),
                ));
            }
        }
        for c in &rec.claims {
            match self.observe(c) {
                DeviceActivity::Idle => {}
                DeviceActivity::Busy { processes } => {
                    return Ok(Settle::Held(format!(
                        "{} still has {processes} processes",
                        c.device
                    )));
                }
                DeviceActivity::Unknown => {
                    return Ok(Settle::Held(format!("{} cannot be observed", c.device)));
                }
            }
        }
        let mut unproven = Vec::new();
        let mut reasons = Vec::new();
        for c in &rec.claims {
            let outcome = match self
                .device(&c.device)
                .and_then(|d| self.provider(d.backend).map(|p| (d, p)))
            {
                Some((d, p)) => p.cleanup(d, c.partition.as_ref()),
                None => CleanupOutcome::Unproven("device is gone".into()),
            };
            if let CleanupOutcome::Unproven(r) = outcome {
                unproven.push(c.device.clone());
                reasons.push(format!("{}: {r}", c.device));
            }
        }
        if unproven.is_empty() {
            self.store.finish(id, rec.state, &Finish::Released)?;
            return Ok(Settle::Released);
        }
        let reason = reasons.join("; ");
        self.store.finish(
            id,
            rec.state,
            &Finish::Quarantined {
                devices: unproven,
                reason: reason.clone(),
            },
        )?;
        Ok(Settle::Quarantined(reason))
    }

    /// After a broker restart or a topology change. A stale heartbeat is
    /// never evidence: only the runtime's answer, the device's own report
    /// and a proven cleanup free a device.
    pub fn reconcile(
        &mut self,
        runtime: &dyn WorkloadRuntime,
    ) -> Result<Vec<(AllocationId, ReconcileAction)>, ManagerError> {
        let mut out = Vec::new();
        for rec in self.store.list_open()? {
            let action = match rec.state {
                AllocationState::Requested => {
                    self.store.transition(
                        &rec.id,
                        AllocationState::Requested,
                        AllocationState::Failed,
                        Some("broker restarted before admission; resubmit"),
                    )?;
                    self.store
                        .finish(&rec.id, AllocationState::Failed, &Finish::Released)?;
                    ReconcileAction::Closed
                }
                AllocationState::Admitted => {
                    match self.queue.enqueue(&rec.request.app.app_id, rec.id.clone()) {
                        Ok(_) | Err(QueueError::Duplicate) => ReconcileAction::Requeued,
                        Err(_) => {
                            self.store.transition(
                                &rec.id,
                                AllocationState::Admitted,
                                AllocationState::Failed,
                                Some("queue full after restart"),
                            )?;
                            self.store.finish(
                                &rec.id,
                                AllocationState::Failed,
                                &Finish::Released,
                            )?;
                            ReconcileAction::Closed
                        }
                    }
                }
                _ => self.reconcile_held(&rec, runtime)?,
            };
            out.push((rec.id, action));
        }
        self.store.mark_reconciled(self.generation)?;
        Ok(out)
    }

    fn reconcile_held(
        &self,
        rec: &AllocationRecord,
        runtime: &dyn WorkloadRuntime,
    ) -> Result<ReconcileAction, ManagerError> {
        // A claimed device or partition that vanished or changed layout can't
        // be proven clean: stop the workload and quarantine.
        let moved: Vec<LocalDeviceId> = rec
            .claims
            .iter()
            .filter(|c| match (self.device(&c.device), &c.partition) {
                (None, _) => true,
                (Some(d), Some(p)) => d.partition(p).is_none_or(|now| now.cdi_name != c.cdi_name),
                (Some(d), None) => d.partition_mode == PartitionMode::Enabled,
            })
            .map(|c| c.device.clone())
            .collect();
        if !moved.is_empty() {
            let _ = runtime.stop(&rec.id);
            let from = if rec.state == AllocationState::Failed {
                AllocationState::Failed
            } else {
                self.store.transition(
                    &rec.id,
                    rec.state,
                    AllocationState::Draining,
                    Some("device topology changed under the allocation"),
                )?;
                AllocationState::Draining
            };
            let reason =
                "device or partition changed while held; cleanup cannot be proven".to_owned();
            let mut devices: Vec<LocalDeviceId> =
                rec.claims.iter().map(|c| c.device.clone()).collect();
            devices.sort();
            devices.dedup();
            self.store.finish(
                &rec.id,
                from,
                &Finish::Quarantined {
                    devices,
                    reason: reason.clone(),
                },
            )?;
            return Ok(ReconcileAction::Settled(Settle::Quarantined(reason)));
        }
        let presence = runtime.presence(&rec.id);
        match (rec.state, presence) {
            (AllocationState::Running, Presence::Present) => Ok(ReconcileAction::Adopted),
            (_, Presence::Unknown) => Ok(ReconcileAction::Settled(Settle::Held(
                "runtime cannot confirm the workload's state".into(),
            ))),
            (
                AllocationState::Reserved | AllocationState::Attached | AllocationState::Running,
                _,
            ) => {
                self.drain(&rec.id, runtime, "reconciled after restart")?;
                Ok(ReconcileAction::Settled(self.settle(&rec.id, runtime)?))
            }
            _ => Ok(ReconcileAction::Settled(self.settle(&rec.id, runtime)?)),
        }
    }
}

/// A VM may take a device only if its IOMMU group holds nothing but that
/// card's own functions and it doesn't drive a display.
pub fn passthrough_safe(d: &DeviceRecord) -> Result<(), String> {
    if d.display_owned {
        return Err("drives a display".into());
    }
    if d.iommu_group.is_none() || d.iommu_group_members.is_empty() {
        return Err("no IOMMU group (IOMMU off or unsupported)".into());
    }
    if d.iommu_group_members
        .iter()
        .any(|m| m.slot() != d.pci.slot())
    {
        return Err("IOMMU group is shared with another device".into());
    }
    Ok(())
}

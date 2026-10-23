//! The durable allocation journal: state machine, records and the storage
//! trait. Device ownership is written in the same transaction as the state
//! change that takes it, so a crash never leaves a device owned by nobody.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::device::PartitionId;
use crate::ids::LocalDeviceId;
use crate::policy::{AllocationId, Conflict, Holding};
use crate::request::GpuRequest;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AllocationState {
    Requested,
    Admitted,
    Reserved,
    Attached,
    Running,
    Draining,
    Released,
    Failed,
    Quarantined,
}

impl AllocationState {
    pub fn can_transition_to(self, to: Self) -> bool {
        use AllocationState::*;
        matches!(
            (self, to),
            (Requested, Admitted | Failed)
                | (Admitted, Reserved | Failed)
                | (Reserved, Attached | Draining | Failed)
                | (Attached, Running | Draining | Failed)
                | (Running, Draining | Failed)
                | (Draining, Released | Quarantined | Failed)
                | (Failed, Released | Quarantined)
        )
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Released | Self::Quarantined)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Requested => "requested",
            Self::Admitted => "admitted",
            Self::Reserved => "reserved",
            Self::Attached => "attached",
            Self::Running => "running",
            Self::Draining => "draining",
            Self::Released => "released",
            Self::Failed => "failed",
            Self::Quarantined => "quarantined",
        }
    }
}

impl fmt::Display for AllocationState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceClaim {
    pub device: LocalDeviceId,
    pub partition: Option<PartitionId>,
    pub memory_mib: u64,
    pub cdi_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationRecord {
    pub id: AllocationId,
    pub request: GpuRequest,
    pub secrecy: bool,
    pub state: AllocationState,
    pub claims: Vec<DeviceClaim>,
    pub topology_generation: u64,
    pub reason: Option<String>,
    /// Informational only: reconciliation never frees a device because a
    /// heartbeat is old.
    pub last_heartbeat_ms: Option<u64>,
    pub revision: u64,
}

impl AllocationRecord {
    pub fn new(id: AllocationId, request: GpuRequest, secrecy: bool) -> Self {
        Self {
            id,
            request,
            secrecy,
            state: AllocationState::Requested,
            claims: Vec::new(),
            topology_generation: 0,
            reason: None,
            last_heartbeat_ms: None,
            revision: 0,
        }
    }

    pub fn holding(&self, claim: &DeviceClaim) -> Holding {
        Holding {
            allocation: self.id.clone(),
            app_id: self.request.app.app_id.clone(),
            device: claim.device.clone(),
            partition: claim.partition.clone(),
            policy: self.request.policy.clone(),
            secrecy: self.secrecy,
            memory_mib: claim.memory_mib,
        }
    }
}

/// How an allocation ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Finish {
    /// Cleanup of every claimed device was proven; ownership is dropped.
    Released,
    /// Cleanup couldn't be proven; ownership is dropped and these devices
    /// are blocked until maintenance clears them.
    Quarantined {
        devices: Vec<LocalDeviceId>,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct TopologyState {
    pub generation: u64,
    pub reconciled: u64,
    pub fingerprint: String,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum JournalError {
    #[error("allocation {0} not found")]
    NotFound(AllocationId),
    #[error("allocation {0} already exists")]
    Duplicate(AllocationId),
    #[error("allocation is {actual}, expected {expected}")]
    StateConflict {
        expected: AllocationState,
        actual: AllocationState,
    },
    #[error("{from} -> {to} is not a legal transition")]
    IllegalTransition {
        from: AllocationState,
        to: AllocationState,
    },
    #[error("device {device}: {conflict}")]
    Conflict {
        device: LocalDeviceId,
        conflict: Conflict,
    },
    #[error("device topology changed; reconcile before admitting work")]
    ReconcileRequired,
    #[error("unknown device {0}")]
    UnknownDevice(LocalDeviceId),
    #[error("storage: {0}")]
    Storage(String),
}

/// Durable storage for allocations and device ownership.
pub trait JournalStore: Send + Sync + fmt::Debug {
    fn create(&self, rec: &AllocationRecord) -> Result<(), JournalError>;
    fn get(&self, id: &AllocationId) -> Result<Option<AllocationRecord>, JournalError>;
    /// Every allocation not yet released or quarantined, oldest first.
    fn list_open(&self) -> Result<Vec<AllocationRecord>, JournalError>;
    /// Compare-and-set a state change that doesn't touch ownership.
    fn transition(
        &self,
        id: &AllocationId,
        from: AllocationState,
        to: AllocationState,
        reason: Option<&str>,
    ) -> Result<AllocationRecord, JournalError>;
    /// `admitted -> reserved` with every claim's ownership, or nothing.
    /// `device_memory` gives each claimed device's total memory.
    fn reserve(
        &self,
        id: &AllocationId,
        claims: &[DeviceClaim],
        device_memory: &[(LocalDeviceId, u64)],
        topology_generation: u64,
    ) -> Result<AllocationRecord, JournalError>;
    /// `draining|failed -> released|quarantined`, dropping ownership.
    fn finish(
        &self,
        id: &AllocationId,
        from: AllocationState,
        how: &Finish,
    ) -> Result<AllocationRecord, JournalError>;
    fn heartbeat(&self, id: &AllocationId, now_ms: u64) -> Result<(), JournalError>;
    fn holdings(&self, device: &LocalDeviceId) -> Result<Vec<Holding>, JournalError>;
    fn quarantined(&self) -> Result<Vec<(LocalDeviceId, String)>, JournalError>;
    /// Maintenance only: `maintenance_ref` names the signed maintenance order.
    fn clear_quarantine(
        &self,
        device: &LocalDeviceId,
        maintenance_ref: &str,
    ) -> Result<(), JournalError>;
    fn topology(&self) -> Result<TopologyState, JournalError>;
    /// Record the inventory fingerprint; a change bumps the generation and
    /// blocks reservations until [`JournalStore::mark_reconciled`].
    fn record_topology(&self, fingerprint: &str) -> Result<TopologyState, JournalError>;
    fn mark_reconciled(&self, generation: u64) -> Result<(), JournalError>;
}

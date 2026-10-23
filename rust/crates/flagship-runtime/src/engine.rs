//! The adapter contract (IMPLEMENTATION-PLAN.md §8.2). Operations take broker-owned values only;
//! there is no generic passthrough to the engine's CLI or API.

use crate::error::RuntimeError;
use crate::ids::{Digest, InstallationId, WorkloadName};
use crate::plan::ImageSpec;
use crate::workload::{FilesVolumeName, ResolvedWorkload};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineCapabilities {
    pub engine: &'static str,
    pub version: String,
    /// gVisor is registered with the engine. No app starts without it.
    pub runsc: bool,
    pub rootless: bool,
    pub cdi: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkloadState {
    Created,
    Running,
    Restarting,
    Paused,
    Exited,
    Dead,
    Removing,
    Unknown,
}

impl WorkloadState {
    pub fn parse(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "created" | "configured" | "initialized" => Self::Created,
            "running" => Self::Running,
            "restarting" => Self::Restarting,
            "paused" => Self::Paused,
            "exited" | "stopped" => Self::Exited,
            "dead" => Self::Dead,
            "removing" => Self::Removing,
            _ => Self::Unknown,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Running => "running",
            Self::Restarting => "restarting",
            Self::Paused => "paused",
            Self::Exited => "exited",
            Self::Dead => "dead",
            Self::Removing => "removing",
            Self::Unknown => "unknown",
        }
    }
}

/// One workload as the engine reports it. `installation`/`generation`/`plan_digest` come from
/// the deterministic labels; a container the TS controller started has none of them and is
/// recognised by its name alone (`legacy`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedWorkload {
    pub runtime_id: String,
    pub name: WorkloadName,
    pub installation: InstallationId,
    pub generation: Option<u64>,
    pub plan_digest: Option<Digest>,
    pub image: String,
    pub state: WorkloadState,
}

impl ObservedWorkload {
    pub fn legacy(&self) -> bool {
        self.generation.is_none() || self.plan_digest.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeEvent {
    pub time_unix: u64,
    pub action: String,
    pub runtime_id: String,
    pub installation: Option<InstallationId>,
}

pub trait Runtime: Send + Sync {
    fn inspect_capabilities(&self) -> Result<EngineCapabilities, RuntimeError>;
    /// Fetch the image by its platform manifest digest; the engine verifies the content.
    fn prepare_image(&self, image: &ImageSpec) -> Result<(), RuntimeError>;
    /// Bind a files volume to its folder inside the volume's mounted image.
    fn ensure_files_volume(
        &self,
        volume: &FilesVolumeName,
        installation: &InstallationId,
    ) -> Result<(), RuntimeError>;
    /// Create, not start. Fails with [`RuntimeError::Conflict`] if the name exists.
    fn create(&self, workload: &ResolvedWorkload) -> Result<String, RuntimeError>;
    fn start(&self, name: &WorkloadName) -> Result<(), RuntimeError>;
    fn stop(&self, name: &WorkloadName, grace_secs: u32) -> Result<(), RuntimeError>;
    fn inspect(&self, name: &WorkloadName) -> Result<Option<ObservedWorkload>, RuntimeError>;
    /// Every workload this platform may own: labelled ones and legacy `flagship-<id>` names.
    fn list(&self) -> Result<Vec<ObservedWorkload>, RuntimeError>;
    fn events(&self, since_unix: u64, until_unix: u64) -> Result<Vec<RuntimeEvent>, RuntimeError>;
    fn logs(&self, name: &WorkloadName, tail: u32) -> Result<String, RuntimeError>;
    fn delete(&self, name: &WorkloadName) -> Result<(), RuntimeError>;
}

//! The effect boundary. Every mutating call the controller makes goes through an [`EffectPort`];
//! each one is journalled as intent before it is made.

use flagship_runtime::plan::{ExecutionPlan, NetworkAttachment};
use flagship_runtime::{
    FilesVolumeName, InstallationId, ObservedWorkload, ResolvedNetwork, ResolvedWorkload, Runtime,
    RuntimeError, WorkloadName,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EffectError {
    /// The effect certainly did not happen (the engine answered with a refusal).
    Definite(String),
    /// Nobody knows whether it happened (a timeout, a lost connection).
    Unknown(String),
}

impl std::fmt::Display for EffectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Definite(m) => write!(f, "{m}"),
            Self::Unknown(m) => write!(f, "outcome unknown: {m}"),
        }
    }
}

pub trait EffectPort {
    fn observe(&self) -> Result<Vec<ObservedWorkload>, EffectError>;
    fn pull(&self, plan: &ExecutionPlan) -> Result<(), EffectError>;
    fn create(&self, plan: &ExecutionPlan) -> Result<String, EffectError>;
    fn start(&self, installation: &InstallationId) -> Result<(), EffectError>;
    fn stop(&self, installation: &InstallationId) -> Result<(), EffectError>;
    fn delete(&self, installation: &InstallationId) -> Result<(), EffectError>;
}

fn map(e: RuntimeError) -> EffectError {
    match e {
        RuntimeError::TimedOut { .. } | RuntimeError::Spawn(_) => {
            EffectError::Unknown(e.to_string())
        }
        _ => EffectError::Definite(e.to_string()),
    }
}

/// Drives an engine adapter directly. Used for tests and shadow comparisons; in production the
/// controller's effects go through the broker's typed socket, which resolves volumes, secrets
/// and the sandbox network itself. This port resolves only the installation's own files volume
/// and refuses plans with secret references.
#[derive(Debug)]
pub struct RuntimePort<R: Runtime> {
    pub runtime: R,
}

impl<R: Runtime> EffectPort for RuntimePort<R> {
    fn observe(&self) -> Result<Vec<ObservedWorkload>, EffectError> {
        self.runtime.list().map_err(map)
    }
    fn pull(&self, plan: &ExecutionPlan) -> Result<(), EffectError> {
        self.runtime.prepare_image(&plan.image).map_err(map)
    }
    fn create(&self, plan: &ExecutionPlan) -> Result<String, EffectError> {
        let volume = FilesVolumeName::for_installation(&plan.installation)
            .map_err(|e| EffectError::Definite(e.to_string()))?;
        let volumes: Vec<_> = plan
            .volumes
            .iter()
            .map(|v| (v.id.clone(), volume.clone()))
            .collect();
        let net = match plan.capabilities.network {
            NetworkAttachment::Apps => ResolvedNetwork::Apps { sandbox: None },
            NetworkAttachment::None => ResolvedNetwork::None,
        };
        let w = ResolvedWorkload::resolve(plan, net, &volumes, &[]).map_err(map)?;
        self.runtime.create(&w).map_err(map)
    }
    fn start(&self, i: &InstallationId) -> Result<(), EffectError> {
        self.runtime
            .start(&WorkloadName::for_installation(i))
            .map_err(map)
    }
    fn stop(&self, i: &InstallationId) -> Result<(), EffectError> {
        self.runtime
            .stop(&WorkloadName::for_installation(i), 10)
            .map_err(map)
    }
    fn delete(&self, i: &InstallationId) -> Result<(), EffectError> {
        self.runtime
            .delete(&WorkloadName::for_installation(i))
            .map_err(map)
    }
}

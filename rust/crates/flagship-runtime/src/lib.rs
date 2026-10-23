//! OCI runtime adapter: builds approved runtime requests from a broker-owned ExecutionPlan.
//!
//! The crate is a library the broker links. It never decides authority: the broker verifies the
//! capability that binds an [`ExecutionPlan`] digest, resolves every host object the plan refers
//! to, and only then hands this crate a [`ResolvedWorkload`]. An adapter turns that into one fixed
//! argv for one pinned engine binary; there is no generic passthrough.

pub mod containerd;
pub mod engine;
pub mod error;
pub mod exec;
pub mod hex;
pub mod ids;
pub mod oci_cli;
pub mod plan;
pub mod workload;

#[cfg(any(test, feature = "fake"))]
pub mod fake;

pub use engine::{EngineCapabilities, ObservedWorkload, Runtime, RuntimeEvent, WorkloadState};
pub use error::{PlanError, RuntimeError};
pub use exec::{Exec, ExecOutput, Executor, SystemExecutor};
pub use ids::{Digest, EnvName, InstallationId, Repository, SecretHandle, VolumeId, WorkloadName};
pub use oci_cli::{Engine, OciCli};
pub use plan::ExecutionPlan;
pub use workload::{
    FilesVolumeName, ResolvConf, ResolvedMount, ResolvedNetwork, ResolvedWorkload, SandboxDns,
};

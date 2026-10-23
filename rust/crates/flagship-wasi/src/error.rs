use std::fmt;

use crate::manifest::ManifestError;

/// Which hard limit stopped a run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitKind {
    /// Linear memory would have grown past the grant.
    Memory,
    /// A table would have grown past the grant.
    Table,
    /// More instances, memories or tables than the grant allows.
    Instances,
    /// The fuel budget ran out (CPU time measured in instructions).
    Fuel,
    /// The wall-clock deadline passed, in guest code or in a host call.
    WallTime,
}

impl fmt::Display for LimitKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Memory => "memory",
            Self::Table => "table",
            Self::Instances => "instances",
            Self::Fuel => "fuel",
            Self::WallTime => "wall-time",
        })
    }
}

/// Everything a run can refuse or fail with. Messages never carry host paths
/// beyond the guest path the app itself named, so they are safe to show to
/// the app's owner and, after `buildModelRedactor`, to a model.
#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error("refused: precompiled native artifacts are never loaded; send .wasm or WAT")]
    PrecompiledArtifactRefused,
    #[error("refused: input is neither a WebAssembly binary nor WAT text")]
    NotWasm,
    #[error("refused: module is {size} bytes, the limit is {limit}")]
    ModuleTooLarge { size: usize, limit: usize },
    #[error("refused: components are not supported by this worker; send a core module")]
    ComponentRefused,
    #[error("refused: module imports {module}.{name}, which this worker does not grant")]
    ImportNotGranted { module: String, name: String },
    #[error("refused: module has no _start export")]
    NoEntryPoint,
    #[error("compile failed: {0}")]
    Compile(String),
    #[error("refused: preopen {0} was not granted")]
    PreopenNotGranted(String),
    #[error("could not open the preopened directory for {0}")]
    PreopenUnavailable(String),
    #[error("worker busy: {0} runs already in progress")]
    Busy(usize),
    #[error("stopped: {0} limit reached")]
    LimitExceeded(LimitKind),
    #[error("trap: {0}")]
    Trap(String),
    #[error("worker internal error: {0}")]
    Internal(String),
    #[error(transparent)]
    Manifest(#[from] ManifestError),
}

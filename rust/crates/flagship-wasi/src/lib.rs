//! Confined WASI worker with brokered capabilities and hard resource limits.
//!
//! The worker compiles WebAssembly from `.wasm` or WAT bytes it was handed,
//! inside its own process, and never loads a precompiled native artifact:
//! `wasmtime::Module::deserialize` is `unsafe`, and this crate forbids
//! `unsafe`, so the only path to a `Module` is compilation. Every run is held
//! to the [`WasiGrant`] the broker derived from the app's
//! [`WasiCapabilityManifest`] and the owner's approval: preopened directories
//! only, no sockets, a memory and table ceiling, a fuel budget, a wall-clock
//! deadline that also cancels host calls blocked inside WASI, and a bound on
//! how many runs (and so host calls) the worker serves at once.

mod error;
mod limits;
mod manifest;
mod worker;

pub use error::{LimitKind, WorkerError};
pub use limits::{Ceilings, Limits};
pub use manifest::{
    DataSection, DataStores, EgressHost, FILES_GUEST_PATH, MANIFEST_SCHEMA, ManifestError,
    ModuleRef, NetworkSection, PostgresStores, Preopen, PreopenPerms, SCRATCH_GUEST_PATH,
    WasiCapabilityManifest, WasiGrant,
};
pub use worker::{Exit, ModuleSource, RunOutcome, Worker, WorkerConfig, sha256_digest};

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

mod cgi;
mod config;
mod error;
mod hostcalls;
mod limits;
mod manifest;
mod server;
mod worker;

pub use cgi::{CgiError, HttpRequest, HttpResponse, cgi_env, parse_cgi_output};
pub use config::{ConfigError, Prepared, UnixSocketBroker, WORKER_CONFIG_SCHEMA, WorkerFileConfig};
pub use hostcalls::{
    BrokerError, CapabilityBroker, MAX_CALLS_PER_RUN, MAX_HOST_REQUEST, MAX_HOST_RESPONSE,
    fetch_host, status,
};
pub use server::{AppServer, HttpError, ServerLimits, read_request, write_response};

pub use error::{LimitKind, WorkerError};
pub use limits::{Ceilings, Limits};
pub use manifest::{
    DataSection, DataStores, EgressHost, FILES_GUEST_PATH, HostCall, MANIFEST_SCHEMA,
    ManifestError, ModuleRef, NetworkSection, PostgresStores, Preopen, PreopenPerms,
    SCRATCH_GUEST_PATH, WasiCapabilityManifest, WasiGrant, WasiWorld,
};
pub use worker::{
    CompiledModule, Exit, ModuleSource, RunInput, RunOutcome, Worker, WorkerConfig, sha256_digest,
};

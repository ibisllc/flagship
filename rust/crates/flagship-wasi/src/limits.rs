use serde::{Deserialize, Serialize};
use wasmtime::ResourceLimiter;

use crate::error::LimitKind;

/// What one run may use. A manifest asks for these; the broker grants them
/// only within the platform's [`Ceilings`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    /// Total linear memory across the instance, in MiB.
    #[serde(rename = "memoryMiB")]
    pub memory_mib: u32,
    /// Elements in any one table.
    pub table_elements: u32,
    /// Instructions-ish budget (wasmtime fuel units).
    pub fuel: u64,
    /// Wall-clock deadline for the whole run, host calls included.
    pub wall_time_ms: u64,
    /// Bytes buffered from stdout; a write past this fails, nothing more is kept.
    pub stdout_bytes: u32,
    /// Bytes kept from stderr.
    pub stderr_bytes: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            memory_mib: 64,
            table_elements: 10_000,
            fuel: 1_000_000_000,
            wall_time_ms: 10_000,
            stdout_bytes: 64 * 1024,
            stderr_bytes: 64 * 1024,
        }
    }
}

/// The platform's maximum for each limit. A request above a ceiling is
/// refused, never silently lowered, so an app never runs with less than it
/// was approved for without the owner seeing why.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ceilings {
    pub max: Limits,
}

impl Default for Ceilings {
    fn default() -> Self {
        Self {
            max: Limits {
                memory_mib: 1024,
                table_elements: 100_000,
                fuel: 100_000_000_000,
                wall_time_ms: 15 * 60 * 1000,
                stdout_bytes: 1024 * 1024,
                stderr_bytes: 1024 * 1024,
            },
        }
    }
}

impl Ceilings {
    /// The first field of `want` above its ceiling, if any.
    pub fn exceeded_by(&self, want: &Limits) -> Option<&'static str> {
        let m = &self.max;
        if want.memory_mib > m.memory_mib {
            return Some("memoryMiB");
        }
        if want.table_elements > m.table_elements {
            return Some("tableElements");
        }
        if want.fuel > m.fuel {
            return Some("fuel");
        }
        if want.wall_time_ms > m.wall_time_ms {
            return Some("wallTimeMs");
        }
        if want.stdout_bytes > m.stdout_bytes {
            return Some("stdoutBytes");
        }
        if want.stderr_bytes > m.stderr_bytes {
            return Some("stderrBytes");
        }
        None
    }
}

/// Per-store limiter. It refuses growth by returning an error (a trap) and
/// remembers which limit did it, so the run reports `LimitExceeded(kind)`
/// rather than a generic trap the guest could have caused itself.
#[derive(Debug)]
pub(crate) struct StoreLimiter {
    memory_bytes: usize,
    table_elements: usize,
    pub(crate) denied: Option<LimitKind>,
}

impl StoreLimiter {
    pub(crate) fn new(limits: &Limits) -> Self {
        let mib = usize::try_from(limits.memory_mib).unwrap_or(usize::MAX);
        Self {
            memory_bytes: mib.saturating_mul(1024 * 1024),
            table_elements: usize::try_from(limits.table_elements).unwrap_or(usize::MAX),
            denied: None,
        }
    }
}

impl ResourceLimiter for StoreLimiter {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        if desired > self.memory_bytes {
            self.denied = Some(LimitKind::Memory);
            return Err(wasmtime::format_err!("memory limit reached"));
        }
        Ok(true)
    }

    fn table_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        if desired > self.table_elements {
            self.denied = Some(LimitKind::Table);
            return Err(wasmtime::format_err!("table limit reached"));
        }
        Ok(true)
    }

    fn instances(&self) -> usize {
        1
    }

    fn tables(&self) -> usize {
        4
    }

    fn memories(&self) -> usize {
        1
    }
}

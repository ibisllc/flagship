//! Cooperative sharing with limits (§9.5): owner-selected time slicing for
//! workloads of one trust domain. The driver time-slices contexts; the
//! broker holds each sharer to its admission budgets by watching what the
//! device reports (`nvidia-smi pmon` utilisation, `--query-compute-apps`
//! memory) and revoking a sharer that keeps exceeding them. These are
//! admission budgets enforced by revocation, not hardware partitions: the
//! owner is told so (`docs/architecture-v2/gpu-and-wasi.md`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::device::PciAddress;
use crate::policy::AllocationId;
use crate::provider::{ProviderError, parse_err};

const PMON: &str = "nvidia-smi pmon";
/// Strikes before a sharer is revoked.
pub const MEMORY_STRIKES: u32 = 2;
pub const TIME_STRIKES: u32 = 3;
/// A sharer may run this far over its compute share in one window.
pub const TIME_TOLERANCE_PERCENT: u64 = 125;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareLimits {
    /// Share of the device's compute time, 1 to 100.
    pub compute_percent: u8,
    pub memory_mib: u64,
}

impl ShareLimits {
    pub fn check(&self) -> Result<(), &'static str> {
        if self.compute_percent == 0 || self.compute_percent > 100 {
            return Err("a compute share is 1 to 100 percent");
        }
        if self.memory_mib == 0 {
            return Err("a sharer needs a memory budget");
        }
        Ok(())
    }
}

/// The shares on one device may not add up to more than the device.
pub fn shares_fit(shares: &[ShareLimits], device_memory_mib: u64) -> Result<(), &'static str> {
    let compute: u64 = shares.iter().map(|s| u64::from(s.compute_percent)).sum();
    let memory = shares
        .iter()
        .fold(0u64, |a, s| a.saturating_add(s.memory_mib));
    if compute > 100 {
        return Err("compute shares add up to more than the device");
    }
    if memory > device_memory_mib {
        return Err("memory budgets add up to more than the device");
    }
    Ok(())
}

/// One row of `nvidia-smi pmon -c 1 -s um`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PmonRow {
    pub gpu: u32,
    pub pid: u32,
    pub sm_percent: Option<u8>,
}

/// `#` lines are headers; `-` means no sample.
pub fn parse_pmon(text: &str) -> Result<Vec<PmonRow>, ProviderError> {
    let mut out = Vec::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let t: Vec<&str> = line.split_whitespace().collect();
        let (Some(gpu), Some(pid), Some(sm)) = (t.first(), t.get(1), t.get(3)) else {
            return Err(parse_err(PMON, "short row"));
        };
        if *pid == "-" {
            continue;
        }
        out.push(PmonRow {
            gpu: gpu.parse().map_err(|_| parse_err(PMON, "gpu index"))?,
            pid: pid.parse().map_err(|_| parse_err(PMON, "pid"))?,
            sm_percent: sm.parse::<u8>().ok().filter(|v| *v <= 100),
        });
    }
    Ok(out)
}

/// What one sharer was seen using during one sample.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Usage {
    pub used_mib: u64,
    pub sm_percent: u8,
}

/// Maps a GPU process to the allocation that owns it (from the process's
/// cgroup and the workload's allocation label).
pub trait PidOwner {
    fn allocation_of(&self, pid: u32) -> Option<AllocationId>;
}

/// Sum each allocation's processes on one device.
pub fn attribute(
    device: &PciAddress,
    device_index: u32,
    pmon: &[PmonRow],
    apps: &[crate::vendor::nvidia::ComputeApp],
    owner: &dyn PidOwner,
) -> (BTreeMap<AllocationId, Usage>, Vec<u32>) {
    let mut out: BTreeMap<AllocationId, Usage> = BTreeMap::new();
    let mut unowned = Vec::new();
    for a in apps.iter().filter(|a| a.bus == *device) {
        match owner.allocation_of(a.pid) {
            Some(id) => {
                let u = out.entry(id).or_insert(Usage {
                    used_mib: 0,
                    sm_percent: 0,
                });
                u.used_mib = u.used_mib.saturating_add(a.used_mib);
            }
            None => unowned.push(a.pid),
        }
    }
    for r in pmon.iter().filter(|r| r.gpu == device_index) {
        match owner.allocation_of(r.pid) {
            Some(id) => {
                let u = out.entry(id).or_insert(Usage {
                    used_mib: 0,
                    sm_percent: 0,
                });
                u.sm_percent = u
                    .sm_percent
                    .saturating_add(r.sm_percent.unwrap_or(0))
                    .min(100);
            }
            None => {
                if !unowned.contains(&r.pid) {
                    unowned.push(r.pid);
                }
            }
        }
    }
    (out, unowned)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoopDecision {
    Within,
    /// Over budget this sample; revoked if it keeps happening.
    Strike(String),
    /// Drain this sharer.
    Revoke(String),
}

#[derive(Clone, Debug, Default)]
struct Account {
    window_start_ms: u64,
    busy_ms: u64,
    memory_strikes: u32,
    time_strikes: u32,
}

/// Per-sharer accounting over fixed windows.
#[derive(Debug)]
pub struct CoopLedger {
    window_ms: u64,
    accounts: BTreeMap<AllocationId, Account>,
}

impl CoopLedger {
    pub fn new(window_ms: u64) -> Self {
        Self {
            window_ms: window_ms.max(1),
            accounts: BTreeMap::new(),
        }
    }

    pub fn forget(&mut self, id: &AllocationId) {
        self.accounts.remove(id);
    }

    /// Record one sample that covered `elapsed_ms`.
    pub fn record(
        &mut self,
        id: &AllocationId,
        limits: &ShareLimits,
        usage: Usage,
        now_ms: u64,
        elapsed_ms: u64,
    ) -> CoopDecision {
        let window = self.window_ms;
        let a = self.accounts.entry(id.clone()).or_insert_with(|| Account {
            window_start_ms: now_ms,
            ..Account::default()
        });
        if usage.used_mib > limits.memory_mib {
            a.memory_strikes = a.memory_strikes.saturating_add(1);
            let why = format!(
                "used {} MiB of its {} MiB share",
                usage.used_mib, limits.memory_mib
            );
            if a.memory_strikes >= MEMORY_STRIKES {
                return CoopDecision::Revoke(why);
            }
            return CoopDecision::Strike(why);
        }
        a.memory_strikes = 0;
        a.busy_ms = a
            .busy_ms
            .saturating_add(elapsed_ms.saturating_mul(u64::from(usage.sm_percent)) / 100);
        if now_ms.saturating_sub(a.window_start_ms) < window {
            return CoopDecision::Within;
        }
        let allowed = window
            .saturating_mul(u64::from(limits.compute_percent))
            .saturating_mul(TIME_TOLERANCE_PERCENT)
            / 10_000;
        let busy = a.busy_ms;
        a.busy_ms = 0;
        a.window_start_ms = now_ms;
        if busy > allowed {
            a.time_strikes = a.time_strikes.saturating_add(1);
            let why = format!(
                "used {busy} ms of GPU time in a {window} ms window; its share is {} percent",
                limits.compute_percent
            );
            if a.time_strikes >= TIME_STRIKES {
                return CoopDecision::Revoke(why);
            }
            return CoopDecision::Strike(why);
        }
        a.time_strikes = 0;
        CoopDecision::Within
    }
}

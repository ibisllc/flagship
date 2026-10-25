//! Residue between tenants (§9.2): a device that ran one security context
//! is handed to the next only after a qualified reset and/or scrub proves it
//! clean. The scrub image (pinned by the catalog, purpose `scrub`) reads
//! device memory for residue canaries, overwrites it with a pattern, reads
//! the pattern back and scans again, and prints a [`ScrubReport`]. Anything
//! short of full proof is `Unproven`, which quarantines the device.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::catalog::{CleanupKind, CleanupProcedure, ResetKind};
use crate::device::{DeviceRecord, PartitionId};
use crate::ids::LocalDeviceId;
use crate::provider::{CleanupOutcome, DeviceCleanup};

/// The scrub must cover at least this share of the memory it was given.
pub const MIN_COVERAGE_PERMILLE: u64 = 950;

/// What the scrub image reports, as JSON on stdout.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScrubReport {
    pub schema: String,
    /// Memory the scrub was given (the device, or the partition).
    pub bytes_total: u64,
    pub bytes_scrubbed: u64,
    /// Every scrubbed byte read back as the pattern.
    pub pattern_verified: bool,
    /// Residue canaries found before overwriting (informational: proves
    /// the scan sees a previous tenant's memory during qualification).
    pub canaries_before: u64,
    /// Residue canaries found after: must be zero.
    pub canaries_after: u64,
}

pub const SCRUB_SCHEMA: &str = "flagship/gpu-scrub-report/v1";

/// Runs the reset and the scrub image on one device or partition.
pub trait ScrubRunner: Send + Sync + std::fmt::Debug {
    fn reset(
        &self,
        device: &DeviceRecord,
        partition: Option<&PartitionId>,
        kind: ResetKind,
    ) -> Result<(), String>;
    fn scrub(
        &self,
        device: &DeviceRecord,
        partition: Option<&PartitionId>,
    ) -> Result<ScrubReport, String>;
    /// Told which catalog entry qualified a device, so the runner knows its
    /// scrub image and how to reach the device.
    fn configure(
        &self,
        _device: &DeviceRecord,
        _entry: &crate::catalog::CatalogEntry,
        _profile: crate::provider::IsolationProfile,
    ) {
    }
}

/// Judges a report: full coverage, the pattern read back, no residue.
pub fn judge(report: &ScrubReport, expected_bytes: u64) -> Result<(), String> {
    if report.schema != SCRUB_SCHEMA {
        return Err("scrub report has an unknown schema".into());
    }
    if expected_bytes == 0
        || report.bytes_total < expected_bytes.saturating_mul(MIN_COVERAGE_PERMILLE) / 1000
    {
        return Err("scrub was not given the device's memory".into());
    }
    if report.bytes_scrubbed.saturating_mul(1000)
        < report.bytes_total.saturating_mul(MIN_COVERAGE_PERMILLE)
    {
        return Err(format!(
            "scrub covered {} of {} bytes",
            report.bytes_scrubbed, report.bytes_total
        ));
    }
    if !report.pattern_verified {
        return Err("scrub pattern did not read back".into());
    }
    if report.canaries_after != 0 {
        return Err(format!(
            "{} residue canaries survived the scrub",
            report.canaries_after
        ));
    }
    Ok(())
}

/// The qualified cleanup: the catalog entry's procedure for each device.
/// A device whose entry names no procedure stays `Unproven`.
#[derive(Debug)]
pub struct ScrubCleanup {
    runner: Arc<dyn ScrubRunner>,
    procedures: Mutex<BTreeMap<LocalDeviceId, CleanupProcedure>>,
}

impl ScrubCleanup {
    pub fn new(runner: Arc<dyn ScrubRunner>) -> Self {
        Self {
            runner,
            procedures: Mutex::new(BTreeMap::new()),
        }
    }

    /// Set from each device's qualifying catalog entry after inventory.
    pub fn set_procedure(&self, device: &LocalDeviceId, p: CleanupProcedure) {
        if let Ok(mut m) = self.procedures.lock() {
            m.insert(device.clone(), p);
        }
    }

    fn procedure(&self, device: &LocalDeviceId) -> Option<CleanupProcedure> {
        self.procedures.lock().ok()?.get(device).copied()
    }
}

impl DeviceCleanup for ScrubCleanup {
    fn cleanup(&self, device: &DeviceRecord, partition: Option<&PartitionId>) -> CleanupOutcome {
        let Some(p) = self.procedure(&device.id) else {
            return CleanupOutcome::Unproven("no qualified cleanup for this device".into());
        };
        if p.procedure == CleanupKind::None {
            return CleanupOutcome::Unproven(
                "the catalog qualifies no cleanup for this device".into(),
            );
        }
        if p.reset != ResetKind::None
            && let Err(e) = self.runner.reset(device, partition, p.reset)
        {
            return CleanupOutcome::Unproven(format!("reset failed: {e}"));
        }
        let expected = match partition {
            Some(id) => device.partition(id).map_or(0, |x| x.memory_mib),
            None => device.memory_mib,
        }
        .saturating_mul(1024 * 1024);
        match self
            .runner
            .scrub(device, partition)
            .and_then(|r| judge(&r, expected))
        {
            Ok(()) => CleanupOutcome::Proven,
            Err(e) => CleanupOutcome::Unproven(e),
        }
    }
}

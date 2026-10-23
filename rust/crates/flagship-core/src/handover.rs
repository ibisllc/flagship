//! Taking over from the TS controller (IMPLEMENTATION-PLAN.md §4.3): the TS controller pauses and
//! writes a checkpoint of what it runs; the Rust controller, holding the lock, records the
//! checkpoint, adopts the existing workloads, compares the engine and its desired state against
//! the checkpoint, and enables effects only if everything agrees. On any mismatch effects stay
//! off and the caller returns to the TS controller or restricted management: never two writers.

use crate::controller::{Controller, CoreError, now};
use crate::journal::Adopted;
use crate::port::EffectPort;
use flagship_runtime::{InstallationId, WorkloadState};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TsCheckpoint {
    pub taken_at: u64,
    /// The TS controller attests it has stopped making changes.
    pub ts_controller_paused: bool,
    pub workloads: Vec<CheckpointWorkload>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointWorkload {
    pub installation: InstallationId,
    pub generation: u64,
    pub image: String,
    pub running: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HandoverReport {
    pub adopted: Vec<InstallationId>,
    pub mismatches: Vec<String>,
    pub effects_enabled: bool,
}

impl<P: EffectPort> Controller<P> {
    pub fn handover(&mut self, cp: &TsCheckpoint) -> Result<HandoverReport, CoreError> {
        let mut report = HandoverReport::default();
        self.journal().set_effects_enabled(false)?;
        if !cp.ts_controller_paused {
            report
                .mismatches
                .push("the TS controller has not paused".into());
            return Ok(report);
        }
        let body = serde_json::to_string(cp)
            .map_err(|e| crate::journal::JournalError::Corrupt(e.to_string()))?;
        self.journal().save_checkpoint(&body, now())?;
        let seen = self.observe()?;
        let desired = self.journal().desired()?;
        let mut listed = BTreeSet::new();
        let mut adoptions = Vec::new();
        for w in &cp.workloads {
            listed.insert(w.installation.clone());
            let Some(o) = seen.get(&w.installation) else {
                report.mismatches.push(format!(
                    "{} is in the checkpoint but not in the engine",
                    w.installation
                ));
                continue;
            };
            if (o.state == WorkloadState::Running) != w.running {
                report.mismatches.push(format!(
                    "{} is {} but the checkpoint says running={}",
                    w.installation,
                    o.state.as_str(),
                    w.running
                ));
            }
            if o.image != w.image {
                report.mismatches.push(format!(
                    "{} runs another image than the checkpoint names",
                    w.installation
                ));
            }
            match desired
                .iter()
                .find(|d| d.plan.installation == w.installation)
            {
                Some(d) if d.plan.generation == w.generation => {}
                Some(d) => report.mismatches.push(format!(
                    "{} is desired at generation {} but runs {}",
                    w.installation, d.plan.generation, w.generation
                )),
                None => report
                    .mismatches
                    .push(format!("{} runs but is not desired", w.installation)),
            }
            if o.legacy() {
                adoptions.push(Adopted {
                    installation: w.installation.clone(),
                    generation: w.generation,
                    runtime_id: o.runtime_id.clone(),
                    image: o.image.clone(),
                });
            } else if o.generation != Some(w.generation) {
                report.mismatches.push(format!(
                    "{} is labelled with another generation",
                    w.installation
                ));
            }
        }
        for inst in seen.keys() {
            if !listed.contains(inst) {
                report
                    .mismatches
                    .push(format!("{inst} runs but the checkpoint does not list it"));
            }
        }
        if !report.mismatches.is_empty() {
            return Ok(report);
        }
        for a in adoptions {
            report.adopted.push(a.installation.clone());
            self.journal().adopt(&a)?;
        }
        self.journal().set_effects_enabled(true)?;
        report.effects_enabled = true;
        Ok(report)
    }
}

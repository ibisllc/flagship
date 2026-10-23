//! Reconciliation: compare desired plans with what the engine reports (by the deterministic
//! `flagship.*` labels and generation, or by an adoption record for a legacy workload) and close
//! the gap one journalled effect at a time.
//!
//! Crash rules (IMPLEMENTATION-PLAN.md §4.3): intent is durable before an effect; after a crash a
//! pending intent is settled from what the engine shows. A non-destructive effect whose result is
//! not visible is abandoned and decided again (create is name-unique, so this never makes a second
//! copy). A destructive effect whose result inspection cannot establish blocks its installation
//! for review; it is never retried on its own.

use crate::journal::{Desired, Journal, JournalError, Op, OpKind, OpState};
use crate::lock::ControllerLock;
use crate::port::{EffectError, EffectPort};
use flagship_runtime::{InstallationId, ObservedWorkload, WorkloadState};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error(transparent)]
    Journal(#[from] JournalError),
    #[error("observing the engine failed: {0}")]
    Observe(EffectError),
    #[error("controller lock: {0}")]
    Lock(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Decide and record decisions; never call a mutating effect.
    Shadow,
    /// Perform effects, once the journal says effects are enabled (after handover).
    Effects,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub installation: InstallationId,
    pub generation: u64,
    pub kind: OpKind,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    /// Effects performed (or, without effects, the ones that would have been).
    pub decisions: Vec<Decision>,
    pub performed: bool,
    /// Installations held for review of a destructive effect with an unknown outcome.
    pub blocked: Vec<InstallationId>,
    /// Effects that failed this pass (they are decided again next pass).
    pub failures: Vec<String>,
    /// Workloads that look like the platform's but are neither desired nor labelled.
    pub unmanaged: Vec<String>,
}

impl Report {
    pub fn converged(&self) -> bool {
        self.decisions.is_empty() && self.blocked.is_empty() && self.failures.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Review {
    /// The operator checked and the effect did happen.
    AlreadyDone,
    /// Decide again from what the engine shows now.
    Redo,
}

#[derive(Debug)]
pub struct Controller<P: EffectPort> {
    journal: Journal,
    port: P,
    mode: Mode,
    _lock: ControllerLock,
}

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn plan_matches(
    d: &Desired,
    o: &ObservedWorkload,
    adopted: Option<&crate::journal::Adopted>,
) -> bool {
    if o.plan_digest == Some(d.digest) {
        return true;
    }
    o.legacy()
        && adopted
            .is_some_and(|a| a.generation == d.plan.generation && a.runtime_id == o.runtime_id)
}

impl<P: EffectPort> Controller<P> {
    /// Take the controller lock in `dir`, then open the journal under a new term.
    pub fn open(dir: &Path, port: P, mode: Mode) -> Result<Self, CoreError> {
        let lock = ControllerLock::acquire(&dir.join("controller.lock"))?;
        let journal = Journal::open(&dir.join("journal.db"))?;
        Ok(Self {
            journal,
            port,
            mode,
            _lock: lock,
        })
    }

    pub fn journal(&mut self) -> &mut Journal {
        &mut self.journal
    }

    pub fn port(&self) -> &P {
        &self.port
    }

    pub fn effects_active(&self) -> Result<bool, CoreError> {
        Ok(self.mode == Mode::Effects && self.journal.effects_enabled()?)
    }

    pub fn resolve_review(&mut self, op: i64, review: Review) -> Result<(), CoreError> {
        let state = match review {
            Review::AlreadyDone => OpState::Done,
            Review::Redo => OpState::Abandoned,
        };
        self.journal
            .settle(op, state, None, Some("resolved by review"), now())?;
        Ok(())
    }

    pub(crate) fn observe(&self) -> Result<BTreeMap<InstallationId, ObservedWorkload>, CoreError> {
        let list = self.port.observe().map_err(CoreError::Observe)?;
        Ok(list
            .into_iter()
            .map(|o| (o.installation.clone(), o))
            .collect())
    }

    /// Settle intents left by an earlier life from what the engine shows now.
    fn recover(
        &mut self,
        seen: &BTreeMap<InstallationId, ObservedWorkload>,
    ) -> Result<(), CoreError> {
        for op in self.journal.pending()? {
            let obs = seen.get(&op.installation);
            let (state, rid, why) = settle_from_observation(&op, obs);
            self.journal
                .settle(op.id, state, rid.as_deref(), Some(why), now())?;
        }
        Ok(())
    }

    fn plan_for(
        d: &Desired,
        obs: Option<&ObservedWorkload>,
        adopted: Option<&crate::journal::Adopted>,
    ) -> Vec<OpKind> {
        match obs {
            None => vec![OpKind::Pull, OpKind::Create, OpKind::Start],
            Some(o) if plan_matches(d, o, adopted) => {
                if o.state == WorkloadState::Running {
                    vec![]
                } else {
                    vec![OpKind::Start]
                }
            }
            Some(o) => {
                let mut v = Vec::new();
                if matches!(
                    o.state,
                    WorkloadState::Running | WorkloadState::Restarting | WorkloadState::Paused
                ) {
                    v.push(OpKind::Stop);
                }
                v.extend([OpKind::Delete, OpKind::Pull, OpKind::Create, OpKind::Start]);
                v
            }
        }
    }

    /// One pass. Without effects it only records what it would do.
    pub fn reconcile(&mut self) -> Result<Report, CoreError> {
        let effects = self.effects_active()?;
        let mut report = Report {
            performed: effects,
            ..Report::default()
        };
        let mut seen = self.observe()?;
        if effects {
            self.recover(&seen)?;
        }
        let blocked: BTreeSet<InstallationId> = self
            .journal
            .needs_review()?
            .into_iter()
            .map(|o| o.installation)
            .collect();
        let desired = self.journal.desired()?;
        let wanted: BTreeSet<InstallationId> = desired
            .iter()
            .map(|d| d.plan.installation.clone())
            .collect();
        for d in &desired {
            let inst = &d.plan.installation;
            if blocked.contains(inst) {
                report.blocked.push(inst.clone());
                continue;
            }
            let adopted = self.journal.adopted(inst)?;
            let steps = Self::plan_for(d, seen.get(inst), adopted.as_ref());
            for kind in steps {
                let target_generation = match kind {
                    OpKind::Stop | OpKind::Delete => seen
                        .get(inst)
                        .and_then(|o| o.generation)
                        .or(adopted.as_ref().map(|a| a.generation))
                        .unwrap_or(0),
                    _ => d.plan.generation,
                };
                report.decisions.push(Decision {
                    installation: inst.clone(),
                    generation: target_generation,
                    kind,
                });
                if !effects {
                    self.journal.record_shadow(
                        inst,
                        &format!("{} generation {target_generation}", kind.as_str()),
                        now(),
                    )?;
                    continue;
                }
                match self.perform(d, kind, target_generation)? {
                    Ok(()) => {
                        if kind == OpKind::Delete {
                            seen.remove(inst);
                            if adopted.is_some() {
                                self.journal.forget_adopted(inst)?;
                            }
                        }
                    }
                    Err(e) => {
                        report
                            .failures
                            .push(format!("{inst} {}: {e}", kind.as_str()));
                        if matches!(e, EffectError::Unknown(_)) && kind.destructive() {
                            report.blocked.push(inst.clone());
                        }
                        break;
                    }
                }
            }
        }
        for (inst, o) in &seen {
            if wanted.contains(inst) {
                continue;
            }
            if blocked.contains(inst) {
                report.blocked.push(inst.clone());
                continue;
            }
            if o.legacy() {
                report.unmanaged.push(o.name.to_string());
                continue;
            }
            // Ours (labelled) but no longer desired: the uninstall.
            let mut steps = Vec::new();
            if o.state == WorkloadState::Running {
                steps.push(OpKind::Stop);
            }
            steps.push(OpKind::Delete);
            for kind in steps {
                let generation = o.generation.unwrap_or(0);
                report.decisions.push(Decision {
                    installation: inst.clone(),
                    generation,
                    kind,
                });
                if !effects {
                    self.journal.record_shadow(
                        inst,
                        &format!("{} generation {generation}", kind.as_str()),
                        now(),
                    )?;
                    continue;
                }
                if let Err(e) = self.perform_removal(inst, generation, kind)? {
                    report
                        .failures
                        .push(format!("{inst} {}: {e}", kind.as_str()));
                    break;
                }
            }
        }
        Ok(report)
    }

    /// Journal the intent, make the call, journal what came back. The outer `Result` is the
    /// journal's; the inner one is the effect's.
    fn perform(
        &mut self,
        d: &Desired,
        kind: OpKind,
        generation: u64,
    ) -> Result<Result<(), EffectError>, CoreError> {
        let inst = &d.plan.installation;
        let digest =
            matches!(kind, OpKind::Create | OpKind::Pull | OpKind::Start).then_some(d.digest);
        let op = self.journal.intent(inst, generation, kind, digest, now())?;
        let r = match kind {
            OpKind::Pull => self.port.pull(&d.plan).map(|()| None),
            OpKind::Create => self.port.create(&d.plan).map(Some),
            OpKind::Start => self.port.start(inst).map(|()| None),
            OpKind::Stop => self.port.stop(inst).map(|()| None),
            OpKind::Delete => self.port.delete(inst).map(|()| None),
        };
        self.settle_effect(op, kind, r)
    }

    fn perform_removal(
        &mut self,
        inst: &InstallationId,
        generation: u64,
        kind: OpKind,
    ) -> Result<Result<(), EffectError>, CoreError> {
        let op = self.journal.intent(inst, generation, kind, None, now())?;
        let r = match kind {
            OpKind::Stop => self.port.stop(inst),
            _ => self.port.delete(inst),
        };
        self.settle_effect(op, kind, r.map(|()| None))
    }

    fn settle_effect(
        &mut self,
        op: i64,
        kind: OpKind,
        r: Result<Option<String>, EffectError>,
    ) -> Result<Result<(), EffectError>, CoreError> {
        match r {
            Ok(rid) => {
                self.journal
                    .settle(op, OpState::Done, rid.as_deref(), None, now())?;
                Ok(Ok(()))
            }
            Err(e) => {
                let state = match (&e, kind.destructive()) {
                    (EffectError::Definite(_), _) => OpState::Failed,
                    (EffectError::Unknown(_), true) => OpState::NeedsReview,
                    (EffectError::Unknown(_), false) => OpState::Abandoned,
                };
                self.journal
                    .settle(op, state, None, Some(&e.to_string()), now())?;
                Ok(Err(e))
            }
        }
    }
}

/// How a pending intent from an earlier life is settled.
fn settle_from_observation(
    op: &Op,
    obs: Option<&ObservedWorkload>,
) -> (OpState, Option<String>, &'static str) {
    match op.kind {
        OpKind::Pull | OpKind::Start => (
            OpState::Abandoned,
            None,
            "interrupted; decided again from observation",
        ),
        OpKind::Create => match obs {
            Some(o) if o.plan_digest.is_some() && o.plan_digest == op.plan_digest => (
                OpState::Done,
                Some(o.runtime_id.clone()),
                "adopted the workload it created",
            ),
            _ => (
                OpState::Abandoned,
                None,
                "interrupted before the engine created it",
            ),
        },
        OpKind::Stop => match obs {
            None => (OpState::Done, None, "inspection: the workload is gone"),
            Some(o)
                if !matches!(
                    o.state,
                    WorkloadState::Running | WorkloadState::Restarting | WorkloadState::Unknown
                ) =>
            {
                (
                    OpState::Done,
                    None,
                    "inspection: the workload is not running",
                )
            }
            Some(_) => (
                OpState::NeedsReview,
                None,
                "inspection: a stop with an unknown outcome and the workload still runs",
            ),
        },
        OpKind::Delete => match obs {
            None => (OpState::Done, None, "inspection: the workload is gone"),
            Some(_) => (
                OpState::NeedsReview,
                None,
                "inspection: a delete with an unknown outcome and the workload is still there",
            ),
        },
    }
}

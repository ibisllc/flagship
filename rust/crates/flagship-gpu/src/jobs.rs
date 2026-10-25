//! GPU jobs (§9.5, §10): inference, headless render, transcode and training
//! all go through the one allocator and the one fair queue. A job has a
//! maximum runtime and a disk budget, can be cancelled, and is revoked with
//! its app. Render and video jobs need their own approved capabilities;
//! compute never implies them. Jobs are not preempted or checkpointed by the
//! platform: a training job checkpoints itself (`training.rs`) and resumes
//! when it is submitted again.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::cdi::ValidatedCdi;
use crate::journal::{AllocationRecord, AllocationState, JournalStore};
use crate::manager::{
    AttachPlan, DeviceManager, ManagerError, ReserveOutcome, Settle, WorkloadRuntime,
};
use crate::media::{RenderSpec, TranscodeSpec};
use crate::policy::AllocationId;
use crate::request::{GpuApproval, GpuRequest};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum JobKind {
    Inference,
    Render(RenderSpec),
    Transcode(TranscodeSpec),
    #[serde(rename_all = "camelCase")]
    Train {
        steps: u64,
        checkpoint_every: u64,
        dataset_digest: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
    pub id: AllocationId,
    pub kind: JobKind,
    pub request: GpuRequest,
    pub max_runtime_ms: u64,
    pub disk_budget_mib: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum JobState {
    Queued,
    #[serde(rename_all = "camelCase")]
    Running {
        started_ms: u64,
    },
    Completed {
        detail: String,
    },
    Cancelled {
        reason: String,
    },
    Failed {
        reason: String,
    },
    Revoked {
        reason: String,
    },
}

impl JobState {
    pub fn is_final(&self) -> bool {
        !matches!(self, Self::Queued | Self::Running { .. })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExecStatus {
    Running { disk_used_mib: u64 },
    Exited { ok: bool, detail: String },
    Unknown,
}

/// Starts and watches job containers; also the [`WorkloadRuntime`] the
/// manager asks about presence.
pub trait JobExecutor: WorkloadRuntime {
    fn start(&self, job: &JobSpec, plan: &AttachPlan) -> Result<(), String>;
    fn poll(&self, id: &AllocationId) -> ExecStatus;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: String,
    pub app_id: String,
    pub kind: String,
    #[serde(flatten)]
    pub state: JobState,
    /// Where the job settled its devices (released, quarantined, held).
    pub settle: Option<String>,
}

#[derive(Debug, Default)]
pub struct JobBook {
    jobs: BTreeMap<AllocationId, (JobSpec, JobState, Option<String>)>,
}

fn kind_name(k: &JobKind) -> &'static str {
    match k {
        JobKind::Inference => "inference",
        JobKind::Render(_) => "render",
        JobKind::Transcode(_) => "transcode",
        JobKind::Train { .. } => "train",
    }
}

fn settle_text(s: &Settle) -> String {
    match s {
        Settle::Released => "released".into(),
        Settle::Quarantined(r) => format!("quarantined: {r}"),
        Settle::Held(r) => format!("held: {r}"),
    }
}

impl JobBook {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self, id: &AllocationId) -> Option<&JobState> {
        self.jobs.get(id).map(|(_, s, _)| s)
    }

    pub fn views(&self) -> Vec<JobView> {
        self.jobs
            .values()
            .map(|(spec, st, settle)| JobView {
                id: spec.id.to_string(),
                app_id: spec.request.app.app_id.clone(),
                kind: kind_name(&spec.kind).into(),
                state: st.clone(),
                settle: settle.clone(),
            })
            .collect()
    }

    /// Check the job's own permissions, then request, admit and queue it.
    pub fn submit<S: JournalStore>(
        &mut self,
        m: &mut DeviceManager<S>,
        spec: JobSpec,
        approval: Option<&GpuApproval>,
        secrecy: bool,
    ) -> Result<(), ManagerError> {
        let needed = match &spec.kind {
            JobKind::Render(r) => {
                r.check()
                    .map_err(|_| ManagerError::Request("invalid render job"))?;
                Some(r.required())
            }
            JobKind::Transcode(t) => {
                t.check()
                    .map_err(|_| ManagerError::Request("invalid transcode job"))?;
                Some(t.required())
            }
            JobKind::Train {
                steps,
                dataset_digest,
                ..
            } => {
                if *steps == 0 || !dataset_digest.starts_with("sha256:") {
                    return Err(ManagerError::Request(
                        "a training job names its steps and its dataset digest",
                    ));
                }
                None
            }
            JobKind::Inference => None,
        };
        if let Some(n) = needed
            && !n.is_subset(&spec.request.capabilities)
        {
            return Err(ManagerError::NotApproved(
                "the job needs a graphics or video capability it did not request".into(),
            ));
        }
        if spec.max_runtime_ms == 0 {
            return Err(ManagerError::Request("a job has a maximum runtime"));
        }
        m.request(spec.id.clone(), spec.request.clone(), secrecy)?;
        m.admit(&spec.id, approval)?;
        m.enqueue(&spec.id)?;
        self.jobs
            .insert(spec.id.clone(), (spec, JobState::Queued, None));
        Ok(())
    }

    fn finish<S: JournalStore, E: JobExecutor>(
        &mut self,
        m: &mut DeviceManager<S>,
        exec: &E,
        id: &AllocationId,
        state: JobState,
        stop: bool,
    ) -> Result<(), ManagerError> {
        let reason = match &state {
            JobState::Completed { .. } => "job finished".to_owned(),
            JobState::Cancelled { reason }
            | JobState::Failed { reason }
            | JobState::Revoked { reason } => reason.clone(),
            _ => String::new(),
        };
        let rec = m.cancel(id, exec, &reason)?;
        if stop {
            let _ = exec.stop(id);
        }
        let settle = if rec.state.is_terminal() {
            None
        } else {
            Some(settle_text(&m.settle(id, exec)?))
        };
        if let Some(j) = self.jobs.get_mut(id) {
            j.1 = state;
            j.2 = settle.or_else(|| Some("released".into()));
        }
        Ok(())
    }

    /// One scheduling pass: reserve in fair order, attach and start what was
    /// reserved, then check every running job.
    pub fn tick<S: JournalStore, E: JobExecutor>(
        &mut self,
        m: &mut DeviceManager<S>,
        exec: &E,
        cdi: &dyn Fn(&AllocationRecord) -> Option<ValidatedCdi>,
        now_ms: u64,
    ) -> Result<(), ManagerError> {
        m.pump()?;
        let ids: Vec<AllocationId> = self.jobs.keys().cloned().collect();
        for id in ids {
            let Some((spec, state, _)) = self.jobs.get(&id).cloned() else {
                continue;
            };
            match state {
                JobState::Queued => {
                    let Some(rec) = m.store().get(&id)? else {
                        continue;
                    };
                    match rec.state {
                        AllocationState::Reserved => {
                            let plan = match m.attach(&id, cdi(&rec).as_ref()) {
                                Ok(p) => p,
                                Err(e) => {
                                    self.finish(
                                        m,
                                        exec,
                                        &id,
                                        JobState::Failed {
                                            reason: e.to_string(),
                                        },
                                        false,
                                    )?;
                                    continue;
                                }
                            };
                            if let Err(e) = exec.start(&spec, &plan) {
                                self.finish(m, exec, &id, JobState::Failed { reason: e }, true)?;
                                continue;
                            }
                            m.started(&id)?;
                            if let Some(j) = self.jobs.get_mut(&id) {
                                j.1 = JobState::Running { started_ms: now_ms };
                            }
                        }
                        AllocationState::Admitted => {}
                        _ => {
                            if let Some(j) = self.jobs.get_mut(&id) {
                                j.1 = JobState::Failed {
                                    reason: rec.reason.unwrap_or_else(|| "closed".into()),
                                };
                            }
                        }
                    }
                }
                JobState::Running { started_ms } => {
                    if now_ms.saturating_sub(started_ms) > spec.max_runtime_ms {
                        self.finish(
                            m,
                            exec,
                            &id,
                            JobState::Cancelled {
                                reason: "the job ran past its maximum runtime".into(),
                            },
                            true,
                        )?;
                        continue;
                    }
                    match exec.poll(&id) {
                        ExecStatus::Running { disk_used_mib }
                            if disk_used_mib > spec.disk_budget_mib =>
                        {
                            self.finish(
                                m,
                                exec,
                                &id,
                                JobState::Failed {
                                    reason: format!(
                                        "the job used {disk_used_mib} MiB of disk; its budget is {} MiB",
                                        spec.disk_budget_mib
                                    ),
                                },
                                true,
                            )?;
                        }
                        ExecStatus::Running { .. } | ExecStatus::Unknown => {}
                        ExecStatus::Exited { ok: true, detail } => {
                            self.finish(m, exec, &id, JobState::Completed { detail }, false)?;
                        }
                        ExecStatus::Exited { ok: false, detail } => {
                            self.finish(m, exec, &id, JobState::Failed { reason: detail }, false)?;
                        }
                    }
                }
                _ => {
                    if let Some(rec) = m.store().get(&id)?
                        && matches!(
                            rec.state,
                            AllocationState::Draining | AllocationState::Failed
                        )
                        && let Some(j) = self.jobs.get_mut(&id)
                    {
                        j.2 = Some(settle_text(&m.settle(&id, exec)?));
                    }
                }
            }
        }
        Ok(())
    }

    pub fn cancel<S: JournalStore, E: JobExecutor>(
        &mut self,
        m: &mut DeviceManager<S>,
        exec: &E,
        id: &AllocationId,
        reason: &str,
    ) -> Result<(), ManagerError> {
        if self.state(id).is_none_or(JobState::is_final) {
            return Ok(());
        }
        self.finish(
            m,
            exec,
            id,
            JobState::Cancelled {
                reason: reason.into(),
            },
            true,
        )
    }

    /// The owner withdrew the app's GPU approval, or the app went away.
    pub fn revoke_app<S: JournalStore, E: JobExecutor>(
        &mut self,
        m: &mut DeviceManager<S>,
        exec: &E,
        app_id: &str,
    ) -> Result<Vec<AllocationId>, ManagerError> {
        let ids: Vec<AllocationId> = self
            .jobs
            .iter()
            .filter(|(_, (s, st, _))| s.request.app.app_id == app_id && !st.is_final())
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            self.finish(
                m,
                exec,
                id,
                JobState::Revoked {
                    reason: "approval revoked".into(),
                },
                true,
            )?;
        }
        Ok(ids)
    }

    /// Reserve state for callers that queue without ticking.
    pub fn try_reserve<S: JournalStore>(
        m: &mut DeviceManager<S>,
        id: &AllocationId,
    ) -> Result<ReserveOutcome, ManagerError> {
        m.reserve(id)
    }
}

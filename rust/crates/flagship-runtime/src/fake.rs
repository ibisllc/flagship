//! An in-memory engine for tests, with fault injection at every effect boundary. Not built into
//! production: it exists behind the `fake` feature.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use crate::engine::{EngineCapabilities, ObservedWorkload, Runtime, RuntimeEvent, WorkloadState};
use crate::error::RuntimeError;
use crate::ids::{InstallationId, WorkloadName};
use crate::oci_cli::create_argv;
use crate::plan::ImageSpec;
use crate::workload::{FilesVolumeName, ResolvedWorkload};
use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

/// Where an injected crash lands relative to the effect. The crash is a panic: the caller's
/// process "dies" there and gets no chance to record anything afterwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum When {
    /// The process dies before the engine saw the request: nothing happened.
    Before,
    /// The engine applied the request but the answer never came back.
    After,
}

#[derive(Debug, Default)]
pub struct FakeState {
    pub workloads: BTreeMap<String, ObservedWorkload>,
    pub volumes: BTreeMap<String, String>,
    pub images: Vec<String>,
    /// Every mutating call in order, e.g. "create flagship-a".
    pub mutations: Vec<String>,
    pub create_argv: Vec<Vec<String>>,
    /// Creates refused because the name existed: a controller should never cause one.
    pub conflicts: usize,
    /// Fail the n-th mutating call (0-based), before or after applying it.
    pub crash_at: Option<(usize, When)>,
    next_id: u64,
}

#[derive(Debug, Default)]
pub struct FakeRuntime {
    state: Mutex<FakeState>,
}

pub const CRASH: &str = "injected crash";

impl FakeRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> MutexGuard<'_, FakeState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn crash_at(&self, n: usize, when: When) {
        self.state().crash_at = Some((n, when));
    }

    /// A workload created outside the platform's knowledge (the TS controller's legacy ones).
    pub fn insert_legacy(&self, installation: &InstallationId, image: &str, running: bool) {
        let mut s = self.state();
        s.next_id = s.next_id.saturating_add(1);
        let name = WorkloadName::for_installation(installation);
        let id = format!("legacy{}", s.next_id);
        let state = if running {
            WorkloadState::Running
        } else {
            WorkloadState::Exited
        };
        s.workloads.insert(
            name.as_str().to_owned(),
            ObservedWorkload {
                runtime_id: id,
                name,
                installation: installation.clone(),
                generation: None,
                plan_digest: None,
                image: image.to_owned(),
                state,
            },
        );
    }

    fn mutate<T>(
        &self,
        what: String,
        apply: impl FnOnce(&mut FakeState) -> Result<T, RuntimeError>,
    ) -> Result<T, RuntimeError> {
        let mut s = self.state();
        let n = s.mutations.len();
        let crash = s.crash_at.filter(|(at, _)| *at == n).map(|(_, w)| w);
        if crash == Some(When::Before) {
            s.crash_at = None;
            drop(s);
            panic!("{CRASH}");
        }
        s.mutations.push(what);
        let r = apply(&mut s);
        if crash == Some(When::After) {
            s.crash_at = None;
            drop(s);
            panic!("{CRASH}");
        }
        r
    }
}

impl Runtime for FakeRuntime {
    fn inspect_capabilities(&self) -> Result<EngineCapabilities, RuntimeError> {
        Ok(EngineCapabilities {
            engine: "fake",
            version: "0".into(),
            runsc: true,
            rootless: false,
            cdi: false,
        })
    }

    fn prepare_image(&self, image: &ImageSpec) -> Result<(), RuntimeError> {
        let r = format!("{}@{}", image.repository, image.platform_manifest_digest);
        self.mutate(format!("pull {r}"), |s| {
            if !s.images.contains(&r) {
                s.images.push(r);
            }
            Ok(())
        })
    }

    fn ensure_files_volume(
        &self,
        volume: &FilesVolumeName,
        installation: &InstallationId,
    ) -> Result<(), RuntimeError> {
        self.mutate(format!("volume {}", volume.as_str()), |s| {
            s.volumes
                .insert(volume.as_str().to_owned(), installation.to_string());
            Ok(())
        })
    }

    fn create(&self, w: &ResolvedWorkload) -> Result<String, RuntimeError> {
        self.mutate(format!("create {}", w.name()), |s| {
            if s.workloads.contains_key(w.name().as_str()) {
                s.conflicts = s.conflicts.saturating_add(1);
                return Err(RuntimeError::Conflict);
            }
            s.next_id = s.next_id.saturating_add(1);
            let id = format!("c{}", s.next_id);
            s.create_argv.push(create_argv(w));
            s.workloads.insert(
                w.name().as_str().to_owned(),
                ObservedWorkload {
                    runtime_id: id.clone(),
                    name: w.name().clone(),
                    installation: w.installation().clone(),
                    generation: Some(w.generation()),
                    plan_digest: Some(w.plan_digest()),
                    image: w.image_reference().to_owned(),
                    state: WorkloadState::Created,
                },
            );
            Ok(id)
        })
    }

    fn start(&self, name: &WorkloadName) -> Result<(), RuntimeError> {
        self.mutate(format!("start {name}"), |s| {
            let w = s
                .workloads
                .get_mut(name.as_str())
                .ok_or(RuntimeError::NotFound)?;
            w.state = WorkloadState::Running;
            Ok(())
        })
    }

    fn stop(&self, name: &WorkloadName, _: u32) -> Result<(), RuntimeError> {
        self.mutate(format!("stop {name}"), |s| {
            let w = s
                .workloads
                .get_mut(name.as_str())
                .ok_or(RuntimeError::NotFound)?;
            w.state = WorkloadState::Exited;
            Ok(())
        })
    }

    fn inspect(&self, name: &WorkloadName) -> Result<Option<ObservedWorkload>, RuntimeError> {
        Ok(self.state().workloads.get(name.as_str()).cloned())
    }

    fn list(&self) -> Result<Vec<ObservedWorkload>, RuntimeError> {
        Ok(self.state().workloads.values().cloned().collect())
    }

    fn events(&self, _: u64, _: u64) -> Result<Vec<RuntimeEvent>, RuntimeError> {
        Ok(Vec::new())
    }

    fn logs(&self, _: &WorkloadName, _: u32) -> Result<String, RuntimeError> {
        Ok(String::new())
    }

    fn delete(&self, name: &WorkloadName) -> Result<(), RuntimeError> {
        self.mutate(format!("delete {name}"), |s| {
            s.workloads
                .remove(name.as_str())
                .map(|_| ())
                .ok_or(RuntimeError::NotFound)
        })
    }
}

impl Runtime for std::sync::Arc<FakeRuntime> {
    fn inspect_capabilities(&self) -> Result<EngineCapabilities, RuntimeError> {
        self.as_ref().inspect_capabilities()
    }
    fn prepare_image(&self, i: &ImageSpec) -> Result<(), RuntimeError> {
        self.as_ref().prepare_image(i)
    }
    fn ensure_files_volume(
        &self,
        v: &FilesVolumeName,
        i: &InstallationId,
    ) -> Result<(), RuntimeError> {
        self.as_ref().ensure_files_volume(v, i)
    }
    fn create(&self, w: &ResolvedWorkload) -> Result<String, RuntimeError> {
        self.as_ref().create(w)
    }
    fn start(&self, n: &WorkloadName) -> Result<(), RuntimeError> {
        self.as_ref().start(n)
    }
    fn stop(&self, n: &WorkloadName, g: u32) -> Result<(), RuntimeError> {
        self.as_ref().stop(n, g)
    }
    fn inspect(&self, n: &WorkloadName) -> Result<Option<ObservedWorkload>, RuntimeError> {
        self.as_ref().inspect(n)
    }
    fn list(&self) -> Result<Vec<ObservedWorkload>, RuntimeError> {
        self.as_ref().list()
    }
    fn events(&self, a: u64, b: u64) -> Result<Vec<RuntimeEvent>, RuntimeError> {
        self.as_ref().events(a, b)
    }
    fn logs(&self, n: &WorkloadName, t: u32) -> Result<String, RuntimeError> {
        self.as_ref().logs(n, t)
    }
    fn delete(&self, n: &WorkloadName) -> Result<(), RuntimeError> {
        self.as_ref().delete(n)
    }
}

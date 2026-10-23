//! containerd is a candidate engine for R03. Until that evaluation picks one, every operation
//! answers `Unsupported` rather than pretending.

use crate::engine::{EngineCapabilities, ObservedWorkload, Runtime, RuntimeEvent};
use crate::error::RuntimeError;
use crate::ids::{InstallationId, WorkloadName};
use crate::plan::ImageSpec;
use crate::workload::{FilesVolumeName, ResolvedWorkload};

#[derive(Debug, Clone, Copy, Default)]
pub struct Containerd;

fn no<T>() -> Result<T, RuntimeError> {
    Err(RuntimeError::Unsupported(
        "the containerd adapter waits on the R03 engine evaluation".to_owned(),
    ))
}

impl Runtime for Containerd {
    fn inspect_capabilities(&self) -> Result<EngineCapabilities, RuntimeError> {
        no()
    }
    fn prepare_image(&self, _: &ImageSpec) -> Result<(), RuntimeError> {
        no()
    }
    fn ensure_files_volume(
        &self,
        _: &FilesVolumeName,
        _: &InstallationId,
    ) -> Result<(), RuntimeError> {
        no()
    }
    fn create(&self, _: &ResolvedWorkload) -> Result<String, RuntimeError> {
        no()
    }
    fn start(&self, _: &WorkloadName) -> Result<(), RuntimeError> {
        no()
    }
    fn stop(&self, _: &WorkloadName, _: u32) -> Result<(), RuntimeError> {
        no()
    }
    fn inspect(&self, _: &WorkloadName) -> Result<Option<ObservedWorkload>, RuntimeError> {
        no()
    }
    fn list(&self) -> Result<Vec<ObservedWorkload>, RuntimeError> {
        no()
    }
    fn events(&self, _: u64, _: u64) -> Result<Vec<RuntimeEvent>, RuntimeError> {
        no()
    }
    fn logs(&self, _: &WorkloadName, _: u32) -> Result<String, RuntimeError> {
        no()
    }
    fn delete(&self, _: &WorkloadName) -> Result<(), RuntimeError> {
        no()
    }
}

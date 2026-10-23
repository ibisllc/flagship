//! Vendor providers. Each parses its own pinned tool's output and reports
//! only its own backend: nothing here can label an AMD or Intel device CUDA.

pub mod amd;
pub mod intel;
pub mod nvidia;

//! Accelerator inventory, the signed compatibility catalog, CDI validation,
//! the device allocation journal and the GPU service.
//!
//! Nothing here touches hardware directly: inventory reads a configurable
//! sysfs root and pinned vendor tools through [`provider::ToolRunner`], and
//! every lifecycle step goes through the [`journal::JournalStore`]. The
//! privileged `flagship-gpud` owns the [`manager::DeviceManager`]; apps
//! never see this crate. [`sim`] is a simulated host (sysfs, device nodes,
//! vendor tool output) that drives the whole software path without a GPU.

pub mod attach;
pub mod catalog;
pub mod catalog_trust;
pub mod cdi;
pub mod cdi_gen;
pub mod coop;
pub mod device;
pub mod host;
pub mod ids;
pub mod jobs;
pub mod journal;
pub mod maintenance;
pub mod manager;
pub mod media;
pub mod mig;
pub mod numerics;
pub mod observe;
pub mod owner_approval;
pub mod podman_check;
pub mod policy;
pub mod provider;
pub mod queue;
pub mod request;
pub mod safetensors;
pub mod scrub;
pub mod selftest;
pub mod service;
pub mod sim;
pub mod sqlite;
pub mod sysfs;
pub mod testkit;
pub mod topology;
pub mod training;
pub mod vendor;
pub mod vfio;

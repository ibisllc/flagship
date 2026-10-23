//! Accelerator inventory, CDI validation and the device allocation journal.
//!
//! Nothing here touches hardware directly: inventory reads a configurable
//! sysfs root and pinned vendor tools through [`provider::ToolRunner`], and
//! every lifecycle step goes through the [`journal::JournalStore`]. The
//! broker owns the [`manager::DeviceManager`]; apps never see this crate.

pub mod catalog;
pub mod cdi;
pub mod device;
pub mod ids;
pub mod journal;
pub mod manager;
pub mod policy;
pub mod provider;
pub mod queue;
pub mod request;
pub mod sqlite;
pub mod sysfs;
pub mod topology;
pub mod vendor;

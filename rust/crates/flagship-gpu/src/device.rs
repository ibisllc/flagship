use std::collections::BTreeSet;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::ids::LocalDeviceId;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Vendor {
    Nvidia,
    Amd,
    Intel,
}

impl Vendor {
    pub fn from_pci_id(id: u16) -> Option<Self> {
        match id {
            0x10de => Some(Self::Nvidia),
            0x1002 => Some(Self::Amd),
            0x8086 => Some(Self::Intel),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Nvidia => "nvidia",
            Self::Amd => "amd",
            Self::Intel => "intel",
        }
    }
}

/// A compute API. Each backend belongs to exactly one vendor: an AMD or
/// Intel device is never reported, selected or approved as CUDA.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Backend {
    NvidiaCuda,
    AmdRocm,
    IntelLevelZero,
}

impl Backend {
    pub fn vendor(self) -> Vendor {
        match self {
            Self::NvidiaCuda => Vendor::Nvidia,
            Self::AmdRocm => Vendor::Amd,
            Self::IntelLevelZero => Vendor::Intel,
        }
    }

    pub fn for_vendor(v: Vendor) -> Self {
        match v {
            Vendor::Nvidia => Self::NvidiaCuda,
            Vendor::Amd => Self::AmdRocm,
            Vendor::Intel => Self::IntelLevelZero,
        }
    }

    /// The CDI `kind` the host tooling publishes for this backend.
    pub fn cdi_kind(self) -> &'static str {
        match self {
            Self::NvidiaCuda => "nvidia.com/gpu",
            Self::AmdRocm => "amd.com/gpu",
            Self::IntelLevelZero => "intel.com/gpu",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NvidiaCuda => "nvidia-cuda",
            Self::AmdRocm => "amd-rocm",
            Self::IntelLevelZero => "intel-level-zero",
        }
    }
}

impl fmt::Display for Backend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What a workload may use a device for. Each is a separate permission:
/// compute approval never implies graphics or video.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Capability {
    Compute,
    Graphics,
    VideoEncode,
    VideoDecode,
}

/// `dddd:bb:dd.f`, lowercase hex.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PciAddress(String);

impl PciAddress {
    /// Accepts the sysfs form and nvidia-smi's 8-digit domain form
    /// (`00000000:01:00.0`).
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim().to_ascii_lowercase();
        let (domain, rest) = s.split_once(':')?;
        let (bus, rest) = rest.split_once(':')?;
        let (dev, func) = rest.split_once('.')?;
        let hex = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_hexdigit());
        if !(hex(domain) && hex(bus) && hex(dev) && hex(func)) {
            return None;
        }
        if bus.len() != 2 || dev.len() != 2 || func.len() != 1 {
            return None;
        }
        let domain = u32::from_str_radix(domain, 16).ok()?;
        if domain > 0xffff {
            return None;
        }
        Some(Self(format!("{domain:04x}:{bus}:{dev}.{func}")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `dddd:bb:dd`, shared by all functions of one physical card.
    pub fn slot(&self) -> &str {
        self.0
            .rsplit_once('.')
            .map_or(self.0.as_str(), |(slot, _)| slot)
    }
}

/// A hardware partition (an NVIDIA MIG GPU instance + compute instance).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionId {
    pub gpu_instance: u32,
    pub compute_instance: u32,
}

impl fmt::Display for PartitionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "mig-{}.{}", self.gpu_instance, self.compute_instance)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionRecord {
    pub id: PartitionId,
    pub memory_mib: u64,
    /// CDI device name the tooling publishes for this partition (`0:1`).
    pub cdi_name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PartitionMode {
    Unsupported,
    Disabled,
    Enabled,
}

/// One accelerator as this box sees it. No vendor UUID or serial is kept.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: LocalDeviceId,
    pub vendor: Vendor,
    pub backend: Backend,
    pub model: String,
    pub pci: PciAddress,
    pub pci_device_id: Option<u16>,
    pub memory_mib: u64,
    pub driver_version: String,
    /// CUDA, ROCm or Level Zero version the host userspace reports.
    pub toolkit_version: Option<String>,
    /// What the driver exposes. Whether a use is qualified on this exact
    /// stack is the compatibility catalog's call, not the inventory's.
    pub capabilities: BTreeSet<Capability>,
    /// Drives a display (boot VGA or an active display). Such a device is
    /// never reset or handed to a workload.
    pub display_owned: bool,
    pub iommu_group: Option<u32>,
    /// Every PCI function in the same IOMMU group, for passthrough checks.
    pub iommu_group_members: Vec<PciAddress>,
    pub numa_node: Option<i32>,
    pub kernel_driver: Option<String>,
    pub partition_mode: PartitionMode,
    pub partitions: Vec<PartitionRecord>,
    /// CDI device name for the whole device (`0`).
    pub cdi_name: String,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum DeviceError {
    #[error("backend {backend} does not belong to vendor {vendor:?}")]
    BackendVendorMismatch { backend: Backend, vendor: Vendor },
}

impl DeviceRecord {
    /// Refuses a record whose backend isn't its vendor's: the one place a
    /// provider bug could otherwise call an AMD card CUDA.
    pub fn check(&self) -> Result<(), DeviceError> {
        if self.backend.vendor() != self.vendor {
            return Err(DeviceError::BackendVendorMismatch {
                backend: self.backend,
                vendor: self.vendor,
            });
        }
        Ok(())
    }

    pub fn partition(&self, id: &PartitionId) -> Option<&PartitionRecord> {
        self.partitions.iter().find(|p| p.id == *id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pci_addresses_normalise() {
        let a = PciAddress::parse("00000000:01:00.0");
        assert_eq!(a.as_ref().map(PciAddress::as_str), Some("0000:01:00.0"));
        assert_eq!(a.as_ref().map(PciAddress::slot), Some("0000:01:00"));
        assert!(PciAddress::parse("0000:01:00").is_none());
        assert!(PciAddress::parse("../../etc").is_none());
        assert!(PciAddress::parse("100000000:01:00.0").is_none());
    }

    #[test]
    fn backends_belong_to_one_vendor() {
        for v in [Vendor::Nvidia, Vendor::Amd, Vendor::Intel] {
            assert_eq!(Backend::for_vendor(v).vendor(), v);
        }
        assert_ne!(Backend::for_vendor(Vendor::Amd), Backend::NvidiaCuda);
        assert_ne!(Backend::for_vendor(Vendor::Intel), Backend::NvidiaCuda);
    }
}

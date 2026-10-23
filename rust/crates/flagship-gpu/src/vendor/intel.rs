use std::collections::BTreeSet;
use std::sync::Arc;

use serde::Deserialize;

use crate::device::{Backend, Capability, DeviceRecord, PartitionMode, PciAddress, Vendor};
use crate::ids::{LocalDeviceId, LocalIdKey};
use crate::provider::{
    CleanupOutcome, DeviceActivity, DeviceCleanup, DeviceProvider, IsolationProfile,
    NoQualifiedCleanup, ProviderError, Tool, ToolRunner, enrich, parse_err, parse_hex_u16,
};
use crate::sysfs::PciDevice;

const TOOL: &str = "xpu-smi";

#[derive(Clone, Debug, Deserialize)]
pub struct XpuDiscovery {
    pub device_list: Vec<XpuDevice>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct XpuDevice {
    pub device_id: u32,
    pub device_name: String,
    #[serde(default)]
    pub device_type: String,
    pub pci_bdf_address: String,
    #[serde(default)]
    pub pci_device_id: Option<String>,
    #[serde(default)]
    pub uuid: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct XpuDeviceDetail {
    #[serde(default)]
    pub driver_version: Option<String>,
    #[serde(default)]
    pub memory_physical_size_byte: Option<String>,
}

pub fn parse_xpu_discovery(json: &str) -> Result<XpuDiscovery, ProviderError> {
    serde_json::from_str(json).map_err(|e| parse_err(TOOL, e.to_string()))
}

pub fn parse_xpu_detail(json: &str) -> Result<XpuDeviceDetail, ProviderError> {
    serde_json::from_str(json).map_err(|e| parse_err(TOOL, e.to_string()))
}

/// Intel Level Zero / oneAPI. With xpu-smi it reports model and memory;
/// without it, it falls back to sysfs (`i915`/`xe`-bound PCI functions)
/// and says less rather than guessing. Never CUDA; VM passthrough only.
#[derive(Debug)]
pub struct IntelProvider {
    tools: Arc<dyn ToolRunner>,
    level_zero_version: Option<String>,
    cleanup: Arc<dyn DeviceCleanup>,
}

impl IntelProvider {
    pub fn new(tools: Arc<dyn ToolRunner>, level_zero_version: Option<String>) -> Self {
        Self {
            tools,
            level_zero_version,
            cleanup: Arc::new(NoQualifiedCleanup),
        }
    }

    #[must_use]
    pub fn with_cleanup(mut self, cleanup: Arc<dyn DeviceCleanup>) -> Self {
        self.cleanup = cleanup;
        self
    }

    fn record(
        &self,
        key: &LocalIdKey,
        index: usize,
        pci: PciAddress,
        stable: &str,
    ) -> DeviceRecord {
        DeviceRecord {
            id: LocalDeviceId::derive(key, Vendor::Intel, stable),
            vendor: Vendor::Intel,
            backend: Backend::IntelLevelZero,
            model: String::new(),
            pci,
            pci_device_id: None,
            memory_mib: 0,
            driver_version: String::new(),
            toolkit_version: self.level_zero_version.clone(),
            capabilities: BTreeSet::from([
                Capability::Compute,
                Capability::Graphics,
                Capability::VideoEncode,
                Capability::VideoDecode,
            ]),
            display_owned: false,
            iommu_group: None,
            iommu_group_members: Vec::new(),
            numa_node: None,
            kernel_driver: None,
            partition_mode: PartitionMode::Unsupported,
            partitions: Vec::new(),
            cdi_name: index.to_string(),
        }
    }
}

impl DeviceProvider for IntelProvider {
    fn backend(&self) -> Backend {
        Backend::IntelLevelZero
    }

    fn enumerate(
        &self,
        key: &LocalIdKey,
        pci: &[PciDevice],
    ) -> Result<Vec<DeviceRecord>, ProviderError> {
        let mut out = Vec::new();
        match self.tools.output(&Tool::XpuSmiDiscovery) {
            Ok(json) => {
                let d = parse_xpu_discovery(&json)?;
                for (index, dev) in d.device_list.iter().enumerate() {
                    if !dev.device_type.is_empty() && dev.device_type != "GPU" {
                        continue;
                    }
                    let bus = PciAddress::parse(&dev.pci_bdf_address)
                        .ok_or_else(|| parse_err(TOOL, "device without a PCI address"))?;
                    let stable = dev
                        .uuid
                        .clone()
                        .unwrap_or_else(|| format!("pci:{}", bus.as_str()));
                    let detail = match self.tools.output(&Tool::XpuSmiDevice(dev.device_id)) {
                        Ok(j) => parse_xpu_detail(&j)?,
                        Err(_) => XpuDeviceDetail::default(),
                    };
                    let mut rec = self.record(key, index, bus, &stable);
                    rec.model.clone_from(&dev.device_name);
                    rec.pci_device_id = dev.pci_device_id.as_deref().and_then(parse_hex_u16);
                    rec.driver_version = detail.driver_version.unwrap_or_default();
                    rec.memory_mib = detail
                        .memory_physical_size_byte
                        .as_deref()
                        .and_then(|s| s.trim().parse::<u64>().ok())
                        .map_or(0, |b| b / (1024 * 1024));
                    enrich(&mut rec, pci);
                    rec.check()?;
                    out.push(rec);
                }
            }
            Err(ProviderError::ToolUnavailable(_)) => {
                let intel = pci.iter().filter(|p| {
                    p.vendor() == Some(Vendor::Intel)
                        && p.is_accelerator()
                        && matches!(p.kernel_driver.as_deref(), Some("i915" | "xe"))
                });
                for (index, p) in intel.enumerate() {
                    let stable = format!("pci:{}", p.address.as_str());
                    let mut rec = self.record(key, index, p.address.clone(), &stable);
                    rec.model = format!("Intel GPU {:#06x}", p.device_id);
                    enrich(&mut rec, pci);
                    rec.check()?;
                    out.push(rec);
                }
            }
            Err(e) => return Err(e),
        }
        Ok(out)
    }

    fn observe(
        &self,
        _device: &DeviceRecord,
        _partition: Option<&crate::device::PartitionId>,
    ) -> DeviceActivity {
        DeviceActivity::Unknown
    }

    fn cleanup(
        &self,
        device: &DeviceRecord,
        partition: Option<&crate::device::PartitionId>,
    ) -> CleanupOutcome {
        self.cleanup.cleanup(device, partition)
    }

    fn isolation_profiles(&self) -> &'static [IsolationProfile] {
        &[IsolationProfile::VmPassthrough]
    }
}

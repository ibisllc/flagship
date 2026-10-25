use std::collections::BTreeSet;
use std::sync::Arc;

use serde::Deserialize;

use crate::device::{
    Backend, Capability, DeviceRecord, PartitionId, PartitionMode, PciAddress, Vendor,
};
use crate::ids::{LocalDeviceId, LocalIdKey};
use crate::observe::{ObserverRoots, observe_device};
use crate::provider::{
    CleanupOutcome, DeviceActivity, DeviceCleanup, DeviceProvider, IsolationProfile,
    NoQualifiedCleanup, ProviderError, Tool, ToolRunner, enrich, parse_err, parse_hex_u16,
};
use crate::sysfs::PciDevice;
use crate::topology::{Link, Topology};

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

#[derive(Clone, Debug, Deserialize)]
struct XpuPs {
    #[serde(default)]
    device_util_by_proc_list: Vec<XpuProc>,
}

#[derive(Clone, Debug, Deserialize)]
struct XpuProc {
    #[serde(default)]
    process_id: Option<u32>,
    #[serde(default)]
    pid: Option<u32>,
}

pub fn parse_xpu_discovery(json: &str) -> Result<XpuDiscovery, ProviderError> {
    serde_json::from_str(json).map_err(|e| parse_err(TOOL, e.to_string()))
}

pub fn parse_xpu_detail(json: &str) -> Result<XpuDeviceDetail, ProviderError> {
    serde_json::from_str(json).map_err(|e| parse_err(TOOL, e.to_string()))
}

/// Distinct processes in `xpu-smi ps -d <id> -j`.
pub fn parse_xpu_ps(json: &str) -> Result<u32, ProviderError> {
    let ps: XpuPs = serde_json::from_str(json).map_err(|e| parse_err(TOOL, e.to_string()))?;
    let pids: BTreeSet<u32> = ps
        .device_util_by_proc_list
        .iter()
        .filter_map(|p| p.process_id.or(p.pid))
        .collect();
    Ok(u32::try_from(pids.len()).unwrap_or(u32::MAX))
}

/// `xpu-smi topology -m`: columns and rows are `GPU <device>/<tile>`; `XL*`
/// is Xe Link, `MDF` two tiles of one device (ignored), `S` self.
pub fn parse_xpu_topology(text: &str, devices: &[DeviceRecord]) -> Topology {
    let mut t = Topology::new();
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let Some(header) = lines.next() else {
        return t;
    };
    let toks: Vec<&str> = header.split_whitespace().collect();
    let mut cols: Vec<Option<&str>> = Vec::new();
    let mut i = 0usize;
    while let Some(tok) = toks.get(i) {
        if *tok == "GPU" {
            cols.push(
                toks.get(i.saturating_add(1))
                    .and_then(|s| s.split('/').next()),
            );
            i = i.saturating_add(2);
        } else {
            break;
        }
    }
    let by_index = |i: &str| {
        devices
            .iter()
            .find(|d| d.cdi_name == i)
            .map(|d| d.id.clone())
    };
    for line in lines {
        let mut cells = line.split_whitespace();
        if cells.next() != Some("GPU") {
            continue;
        }
        let Some(row) = cells
            .next()
            .and_then(|s| s.split('/').next())
            .and_then(by_index)
        else {
            continue;
        };
        for (col, cell) in cols.iter().zip(cells) {
            let Some(other) = col.and_then(by_index) else {
                continue;
            };
            if other == row {
                continue;
            }
            let link = match cell {
                c if c.starts_with("XL") => Link::PeerFabric,
                "PIX" | "PXB" => Link::PcieSwitch,
                "PHB" | "NODE" => Link::PcieHostBridge,
                "SYS" => Link::PcieCrossNuma,
                _ => continue,
            };
            if t.link(&row, &other).is_none_or(|l| link < l) {
                t.set(&row, &other, link);
            }
        }
    }
    t
}

/// Intel Level Zero / oneAPI. With xpu-smi it reports model and memory;
/// without it, it falls back to sysfs (`i915`/`xe`-bound PCI functions)
/// and says less rather than guessing. Never CUDA; VM passthrough only.
#[derive(Debug)]
pub struct IntelProvider {
    tools: Arc<dyn ToolRunner>,
    level_zero_version: Option<String>,
    cleanup: Arc<dyn DeviceCleanup>,
    roots: Option<ObserverRoots>,
}

impl IntelProvider {
    pub fn new(tools: Arc<dyn ToolRunner>, level_zero_version: Option<String>) -> Self {
        Self {
            tools,
            level_zero_version,
            cleanup: Arc::new(NoQualifiedCleanup),
            roots: None,
        }
    }

    #[must_use]
    pub fn with_cleanup(mut self, cleanup: Arc<dyn DeviceCleanup>) -> Self {
        self.cleanup = cleanup;
        self
    }

    /// Observe through DRM fdinfo when xpu-smi can't answer.
    #[must_use]
    pub fn with_observer_roots(mut self, roots: ObserverRoots) -> Self {
        self.roots = Some(roots);
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
                let gpus = d
                    .device_list
                    .iter()
                    .filter(|dev| dev.device_type.is_empty() || dev.device_type == "GPU");
                for (index, dev) in gpus.enumerate() {
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

    /// xpu-smi's process list when it answers, else DRM fdinfo; `Unknown`
    /// when nothing can be read.
    fn observe(&self, device: &DeviceRecord, _partition: Option<&PartitionId>) -> DeviceActivity {
        if let Ok(json) = self.tools.output(&Tool::XpuSmiDiscovery)
            && let Ok(d) = parse_xpu_discovery(&json)
            && let Some(dev) = d
                .device_list
                .iter()
                .find(|x| PciAddress::parse(&x.pci_bdf_address).as_ref() == Some(&device.pci))
            && let Ok(ps) = self.tools.output(&Tool::XpuSmiPs(dev.device_id))
            && let Ok(n) = parse_xpu_ps(&ps)
        {
            return if n == 0 {
                DeviceActivity::Idle
            } else {
                DeviceActivity::Busy { processes: n }
            };
        }
        match &self.roots {
            Some(r) => observe_device(r, &device.pci, &["i915", "xe"], false),
            None => DeviceActivity::Unknown,
        }
    }

    fn cleanup(&self, device: &DeviceRecord, partition: Option<&PartitionId>) -> CleanupOutcome {
        self.cleanup.cleanup(device, partition)
    }

    /// Topology from `xpu-smi topology -m`; empty when unavailable.
    fn topology(&self, devices: &[DeviceRecord]) -> Topology {
        self.tools
            .output(&Tool::XpuSmiTopology)
            .map(|t| parse_xpu_topology(&t, devices))
            .unwrap_or_default()
    }

    fn isolation_profiles(&self) -> &'static [IsolationProfile] {
        &[IsolationProfile::VmPassthrough]
    }
}

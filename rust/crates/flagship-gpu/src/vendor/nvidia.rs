use std::collections::BTreeSet;
use std::sync::Arc;

use roxmltree::{Document, Node, ParsingOptions};

use crate::device::{
    Backend, Capability, DeviceRecord, PartitionId, PartitionMode, PartitionRecord, PciAddress,
    Vendor,
};
use crate::ids::{LocalDeviceId, LocalIdKey};
use crate::provider::{
    CleanupOutcome, DeviceActivity, DeviceCleanup, DeviceProvider, IsolationProfile,
    NoQualifiedCleanup, ProviderError, Tool, ToolRunner, enrich, leading_u64, parse_err,
};
use crate::sysfs::PciDevice;

const TOOL: &str = "nvidia-smi";
const MAX_XML: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NvidiaSmiReport {
    pub driver_version: String,
    pub cuda_version: Option<String>,
    pub gpus: Vec<NvidiaGpu>,
}

/// One `<gpu>` element. `uuid` is held only until the local ID is derived.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NvidiaGpu {
    pub bus_id: PciAddress,
    pub product_name: String,
    pub uuid: String,
    pub pci_device_id: Option<u16>,
    pub memory_total_mib: u64,
    pub mig_mode: PartitionMode,
    pub display_active: bool,
    pub mig_devices: Vec<NvidiaMig>,
    /// `None` when the report has no process list (unsupported or hidden).
    pub processes: Option<Vec<NvidiaProcess>>,
}

/// A process on the GPU; MIG ids are set when it runs in a partition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NvidiaProcess {
    pub gpu_instance: Option<u32>,
    pub compute_instance: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NvidiaMig {
    pub index: u32,
    pub gpu_instance: u32,
    pub compute_instance: u32,
    pub memory_total_mib: u64,
}

fn child<'a, 'i>(n: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    n.children().find(|c| c.has_tag_name(name))
}

fn text<'a>(n: Node<'a, '_>, path: &[&str]) -> Option<&'a str> {
    let mut cur = n;
    for p in path {
        cur = child(cur, p)?;
    }
    cur.text()
        .map(str::trim)
        .filter(|t| !t.is_empty() && *t != "N/A")
}

/// Parse `nvidia-smi -q -x`. The DTD reference is allowed but never fetched.
pub fn parse_nvidia_smi_xml(xml: &str) -> Result<NvidiaSmiReport, ProviderError> {
    if xml.len() > MAX_XML {
        return Err(parse_err(TOOL, "output too large"));
    }
    let opts = ParsingOptions {
        allow_dtd: true,
        nodes_limit: 200_000,
        ..ParsingOptions::default()
    };
    let doc =
        Document::parse_with_options(xml, opts).map_err(|e| parse_err(TOOL, e.to_string()))?;
    let root = doc.root_element();
    if !root.has_tag_name("nvidia_smi_log") {
        return Err(parse_err(TOOL, "not an nvidia_smi_log"));
    }
    let driver_version = text(root, &["driver_version"])
        .ok_or_else(|| parse_err(TOOL, "no driver_version"))?
        .to_owned();
    let cuda_version = text(root, &["cuda_version"]).map(str::to_owned);
    let mut gpus = Vec::new();
    for g in root.children().filter(|c| c.has_tag_name("gpu")) {
        let bus = g
            .attribute("id")
            .or_else(|| text(g, &["pci", "pci_bus_id"]))
            .and_then(PciAddress::parse)
            .ok_or_else(|| parse_err(TOOL, "gpu without a PCI bus id"))?;
        let uuid = text(g, &["uuid"])
            .ok_or_else(|| parse_err(TOOL, "gpu without a uuid"))?
            .to_owned();
        let pci_device_id = text(g, &["pci", "pci_device_id"]).and_then(|s| {
            let v = u32::from_str_radix(s.trim_start_matches("0x"), 16).ok()?;
            let (device, vendor) = (v >> 16, v & 0xffff);
            (vendor == 0x10de)
                .then(|| u16::try_from(device).ok())
                .flatten()
        });
        let mig_mode = match text(g, &["mig_mode", "current_mig"]) {
            Some("Enabled") => PartitionMode::Enabled,
            Some("Disabled") => PartitionMode::Disabled,
            _ => PartitionMode::Unsupported,
        };
        let mut mig_devices = Vec::new();
        if let Some(md) = child(g, "mig_devices") {
            for m in md.children().filter(|c| c.has_tag_name("mig_device")) {
                let num = |p: &[&str]| text(m, p).and_then(|s| s.parse::<u32>().ok());
                let (Some(index), Some(gi), Some(ci)) = (
                    num(&["index"]),
                    num(&["gpu_instance_id"]),
                    num(&["compute_instance_id"]),
                ) else {
                    return Err(parse_err(TOOL, "mig_device without ids"));
                };
                mig_devices.push(NvidiaMig {
                    index,
                    gpu_instance: gi,
                    compute_instance: ci,
                    memory_total_mib: text(m, &["fb_memory_usage", "total"])
                        .and_then(leading_u64)
                        .unwrap_or(0),
                });
            }
        }
        let processes = child(g, "processes").map(|p| {
            p.children()
                .filter(|c| c.has_tag_name("process_info"))
                .map(|pi| NvidiaProcess {
                    gpu_instance: text(pi, &["gpu_instance_id"]).and_then(|s| s.parse().ok()),
                    compute_instance: text(pi, &["compute_instance_id"])
                        .and_then(|s| s.parse().ok()),
                })
                .collect()
        });
        gpus.push(NvidiaGpu {
            bus_id: bus,
            product_name: text(g, &["product_name"])
                .unwrap_or("NVIDIA GPU")
                .to_owned(),
            uuid,
            pci_device_id,
            memory_total_mib: text(g, &["fb_memory_usage", "total"])
                .and_then(leading_u64)
                .unwrap_or(0),
            mig_mode,
            display_active: text(g, &["display_active"]) == Some("Enabled")
                || text(g, &["display_mode"]) == Some("Enabled"),
            mig_devices,
            processes,
        });
    }
    Ok(NvidiaSmiReport {
        driver_version,
        cuda_version,
        gpus,
    })
}

#[derive(Debug)]
pub struct NvidiaProvider {
    tools: Arc<dyn ToolRunner>,
    cleanup: Arc<dyn DeviceCleanup>,
}

impl NvidiaProvider {
    pub fn new(tools: Arc<dyn ToolRunner>) -> Self {
        Self {
            tools,
            cleanup: Arc::new(NoQualifiedCleanup),
        }
    }

    #[must_use]
    pub fn with_cleanup(mut self, cleanup: Arc<dyn DeviceCleanup>) -> Self {
        self.cleanup = cleanup;
        self
    }

    fn report(&self) -> Result<NvidiaSmiReport, ProviderError> {
        parse_nvidia_smi_xml(&self.tools.output(&Tool::NvidiaSmiQueryXml)?)
    }
}

impl DeviceProvider for NvidiaProvider {
    fn backend(&self) -> Backend {
        Backend::NvidiaCuda
    }

    fn enumerate(
        &self,
        key: &LocalIdKey,
        pci: &[PciDevice],
    ) -> Result<Vec<DeviceRecord>, ProviderError> {
        let report = self.report()?;
        let mut out = Vec::new();
        for (index, g) in report.gpus.iter().enumerate() {
            let partitions = g
                .mig_devices
                .iter()
                .map(|m| PartitionRecord {
                    id: PartitionId {
                        gpu_instance: m.gpu_instance,
                        compute_instance: m.compute_instance,
                    },
                    memory_mib: m.memory_total_mib,
                    cdi_name: format!("{index}:{}", m.index),
                })
                .collect();
            let mut rec = DeviceRecord {
                id: LocalDeviceId::derive(key, Vendor::Nvidia, &g.uuid),
                vendor: Vendor::Nvidia,
                backend: Backend::NvidiaCuda,
                model: g.product_name.clone(),
                pci: g.bus_id.clone(),
                pci_device_id: g.pci_device_id,
                memory_mib: g.memory_total_mib,
                driver_version: report.driver_version.clone(),
                toolkit_version: report.cuda_version.clone(),
                capabilities: BTreeSet::from([
                    Capability::Compute,
                    Capability::Graphics,
                    Capability::VideoEncode,
                    Capability::VideoDecode,
                ]),
                display_owned: g.display_active,
                iommu_group: None,
                iommu_group_members: Vec::new(),
                numa_node: None,
                kernel_driver: None,
                partition_mode: g.mig_mode,
                partitions,
                cdi_name: index.to_string(),
            };
            enrich(&mut rec, pci);
            rec.check()?;
            out.push(rec);
        }
        Ok(out)
    }

    fn observe(&self, device: &DeviceRecord, partition: Option<&PartitionId>) -> DeviceActivity {
        let Ok(report) = self.report() else {
            return DeviceActivity::Unknown;
        };
        let Some(procs) = report
            .gpus
            .iter()
            .find(|g| g.bus_id == device.pci)
            .and_then(|g| g.processes.as_ref())
        else {
            return DeviceActivity::Unknown;
        };
        let n = procs
            .iter()
            .filter(|p| match partition {
                None => true,
                // A process without MIG ids on a partitioned GPU can't be
                // placed, so it counts against every partition.
                Some(id) => match (p.gpu_instance, p.compute_instance) {
                    (Some(gi), Some(ci)) => gi == id.gpu_instance && ci == id.compute_instance,
                    _ => true,
                },
            })
            .count();
        match u32::try_from(n) {
            Ok(0) => DeviceActivity::Idle,
            Ok(processes) => DeviceActivity::Busy { processes },
            Err(_) => DeviceActivity::Busy {
                processes: u32::MAX,
            },
        }
    }

    fn cleanup(&self, device: &DeviceRecord, partition: Option<&PartitionId>) -> CleanupOutcome {
        self.cleanup.cleanup(device, partition)
    }

    fn isolation_profiles(&self) -> &'static [IsolationProfile] {
        &[
            IsolationProfile::GvisorNvproxy,
            IsolationProfile::VmPassthrough,
        ]
    }
}

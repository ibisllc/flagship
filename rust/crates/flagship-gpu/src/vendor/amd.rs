use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::device::{
    Backend, Capability, DeviceRecord, PartitionId, PartitionMode, PciAddress, Vendor,
};
use crate::ids::{LocalDeviceId, LocalIdKey};
use crate::observe::{ObserverRoots, observe_device};
use crate::provider::{
    CleanupOutcome, DeviceActivity, DeviceCleanup, DeviceProvider, IsolationProfile,
    NoQualifiedCleanup, ProviderError, Tool, ToolRunner, enrich, leading_u64, parse_err,
    parse_hex_u16,
};
use crate::sysfs::PciDevice;
use crate::topology::{Link, Topology};

const TOOL: &str = "rocm-smi";
const AMD_SMI: &str = "amd-smi";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RocmCard {
    pub card: String,
    pub series: String,
    pub device_id: Option<u16>,
    pub bus: PciAddress,
    /// The card's unique id; `None` on parts that report `N/A`.
    pub unique_id: Option<String>,
    pub vram_total_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RocmReport {
    pub driver_version: String,
    pub cards: Vec<RocmCard>,
}

/// rocm-smi's key spelling has changed between releases ("Card series" /
/// "Card Series"); match case-insensitively on a few known names.
fn field<'a>(m: &'a Map<String, Value>, names: &[&str]) -> Option<&'a str> {
    m.iter()
        .find(|(k, _)| names.iter().any(|n| k.eq_ignore_ascii_case(n)))
        .and_then(|(_, v)| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "N/A")
}

/// Parse `rocm-smi --showproductname --showbus --showuniqueid --showmeminfo vram --showdriverversion --json`.
pub fn parse_rocm_smi_json(json: &str) -> Result<RocmReport, ProviderError> {
    let v: Value = serde_json::from_str(json).map_err(|e| parse_err(TOOL, e.to_string()))?;
    let top = v
        .as_object()
        .ok_or_else(|| parse_err(TOOL, "not an object"))?;
    let driver_version = top
        .get("system")
        .and_then(Value::as_object)
        .and_then(|s| field(s, &["Driver version"]))
        .ok_or_else(|| parse_err(TOOL, "no driver version"))?
        .to_owned();
    let mut cards = Vec::new();
    for (name, card) in top {
        if !name.starts_with("card") {
            continue;
        }
        let m = card
            .as_object()
            .ok_or_else(|| parse_err(TOOL, "card is not an object"))?;
        let bus = field(m, &["PCI Bus"])
            .and_then(PciAddress::parse)
            .ok_or_else(|| parse_err(TOOL, "card without a PCI bus"))?;
        cards.push(RocmCard {
            card: name.clone(),
            series: field(m, &["Card series", "Card Series", "Device Name"])
                .unwrap_or("AMD GPU")
                .to_owned(),
            device_id: field(m, &["Card model", "Card Model", "Device ID"]).and_then(parse_hex_u16),
            bus,
            unique_id: field(m, &["Unique ID"]).map(str::to_owned),
            vram_total_bytes: field(m, &["VRAM Total Memory (B)"])
                .and_then(leading_u64)
                .unwrap_or(0),
        });
    }
    cards.sort_by(|a, b| a.bus.cmp(&b.bus));
    Ok(RocmReport {
        driver_version,
        cards,
    })
}

/// amd-smi prints either a top-level array or an object holding one.
fn amd_array(json: &str) -> Result<Vec<Value>, ProviderError> {
    let v: Value = serde_json::from_str(json).map_err(|e| parse_err(AMD_SMI, e.to_string()))?;
    match v {
        Value::Array(a) => Ok(a),
        Value::Object(o) => o
            .into_iter()
            .find_map(|(_, v)| match v {
                Value::Array(a) => Some(a),
                _ => None,
            })
            .ok_or_else(|| parse_err(AMD_SMI, "no device list")),
        _ => Err(parse_err(AMD_SMI, "not a list")),
    }
}

fn gpu_index(v: &Value) -> Option<u32> {
    v.get("gpu")
        .and_then(Value::as_u64)
        .and_then(|g| u32::try_from(g).ok())
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for p in path {
        cur = cur.get(p)?;
    }
    cur.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "N/A")
}

/// One GPU from `amd-smi list --json` joined with `amd-smi static ... --json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AmdSmiGpu {
    pub index: u32,
    pub bus: PciAddress,
    pub uuid: Option<String>,
    pub market_name: String,
    pub device_id: Option<u16>,
    pub vram_mib: u64,
    pub driver_version: Option<String>,
}

/// Parse the two amd-smi outputs (ROCm 6.x JSON).
pub fn parse_amd_smi(list: &str, statics: &str) -> Result<Vec<AmdSmiGpu>, ProviderError> {
    let list = amd_array(list)?;
    let statics = amd_array(statics)?;
    let mut out = Vec::new();
    for l in &list {
        let index = gpu_index(l).ok_or_else(|| parse_err(AMD_SMI, "list entry without gpu"))?;
        let bus = str_at(l, &["bdf"])
            .and_then(PciAddress::parse)
            .ok_or_else(|| parse_err(AMD_SMI, "list entry without bdf"))?;
        let s = statics.iter().find(|s| gpu_index(s) == Some(index));
        let vram_mib = s
            .and_then(|s| s.get("vram")?.get("size"))
            .and_then(|size| {
                let value = size.get("value")?.as_u64()?;
                match size.get("unit")?.as_str()? {
                    "MB" | "MiB" => Some(value),
                    "GB" | "GiB" => Some(value.saturating_mul(1024)),
                    "B" => Some(value / (1024 * 1024)),
                    _ => None,
                }
            })
            .unwrap_or(0);
        out.push(AmdSmiGpu {
            index,
            bus,
            uuid: str_at(l, &["uuid"]).map(str::to_owned),
            market_name: s
                .and_then(|s| str_at(s, &["asic", "market_name"]))
                .unwrap_or("AMD GPU")
                .to_owned(),
            device_id: s
                .and_then(|s| str_at(s, &["asic", "device_id"]))
                .and_then(parse_hex_u16),
            vram_mib,
            driver_version: s
                .and_then(|s| str_at(s, &["driver", "version"]))
                .map(str::to_owned),
        });
    }
    out.sort_by(|a, b| a.bus.cmp(&b.bus));
    Ok(out)
}

/// Processes per amd-smi GPU index from `amd-smi process --json`. A
/// `process_info` that is a string ("No running processes detected") counts
/// as none.
pub fn parse_amd_smi_process(json: &str) -> Result<Vec<(u32, u32)>, ProviderError> {
    let mut out = Vec::new();
    for g in amd_array(json)? {
        let index = gpu_index(&g).ok_or_else(|| parse_err(AMD_SMI, "process entry without gpu"))?;
        let n = g
            .get("process_list")
            .and_then(Value::as_array)
            .map_or(0, |l| {
                l.iter()
                    .filter(|p| p.get("process_info").is_some_and(Value::is_object))
                    .count()
            });
        out.push((index, u32::try_from(n).unwrap_or(u32::MAX)));
    }
    Ok(out)
}

/// `rocm-smi --showtopo --json`: "(Topology) Link type between DRM devices
/// A and B" is `XGMI` (peer fabric) or `PCIE`. DRM indices are the CDI
/// indices this provider assigns (card order).
pub fn parse_rocm_topology(json: &str, devices: &[DeviceRecord]) -> Topology {
    let mut t = Topology::new();
    let Ok(Value::Object(top)) = serde_json::from_str::<Value>(json) else {
        return t;
    };
    let by_index = |i: &str| {
        devices
            .iter()
            .find(|d| d.cdi_name == i)
            .map(|d| d.id.clone())
    };
    for obj in top.values().filter_map(Value::as_object) {
        for (k, v) in obj {
            let Some(rest) = k.strip_prefix("(Topology) Link type between DRM devices ") else {
                continue;
            };
            let Some((a, b)) = rest.split_once(" and ") else {
                continue;
            };
            let (Some(a), Some(b)) = (by_index(a.trim()), by_index(b.trim())) else {
                continue;
            };
            let link = match v.as_str().map(str::trim) {
                Some("XGMI") => Link::PeerFabric,
                Some("PCIE") => Link::PcieHostBridge,
                _ => continue,
            };
            t.set(&a, &b, link);
        }
    }
    t
}

/// AMD ROCm/HIP. It reports compute as ROCm, never CUDA, and offers only
/// VM passthrough: gVisor has no documented mediation for `/dev/kfd`.
#[derive(Debug)]
pub struct AmdProvider {
    tools: Arc<dyn ToolRunner>,
    rocm_version: Option<String>,
    cleanup: Arc<dyn DeviceCleanup>,
    roots: Option<ObserverRoots>,
}

impl AmdProvider {
    /// `rocm_version` comes from the pinned host install (`/opt/rocm/.info/version`).
    pub fn new(tools: Arc<dyn ToolRunner>, rocm_version: Option<String>) -> Self {
        Self {
            tools,
            rocm_version,
            cleanup: Arc::new(NoQualifiedCleanup),
            roots: None,
        }
    }

    #[must_use]
    pub fn with_cleanup(mut self, cleanup: Arc<dyn DeviceCleanup>) -> Self {
        self.cleanup = cleanup;
        self
    }

    /// Observe through KFD and DRM fdinfo when amd-smi can't answer.
    #[must_use]
    pub fn with_observer_roots(mut self, roots: ObserverRoots) -> Self {
        self.roots = Some(roots);
        self
    }

    fn base_record(
        &self,
        key: &LocalIdKey,
        index: usize,
        stable: &str,
        bus: PciAddress,
    ) -> DeviceRecord {
        DeviceRecord {
            id: LocalDeviceId::derive(key, Vendor::Amd, stable),
            vendor: Vendor::Amd,
            backend: Backend::AmdRocm,
            model: String::new(),
            pci: bus,
            pci_device_id: None,
            memory_mib: 0,
            driver_version: String::new(),
            toolkit_version: self.rocm_version.clone(),
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

    fn enumerate_amd_smi(
        &self,
        key: &LocalIdKey,
        pci: &[PciDevice],
        list: &str,
    ) -> Result<Vec<DeviceRecord>, ProviderError> {
        let statics = self.tools.output(&Tool::AmdSmiStatic)?;
        let mut out = Vec::new();
        for (index, g) in parse_amd_smi(list, &statics)?.iter().enumerate() {
            let stable = g
                .uuid
                .clone()
                .unwrap_or_else(|| format!("pci:{}", g.bus.as_str()));
            let mut rec = self.base_record(key, index, &stable, g.bus.clone());
            rec.model.clone_from(&g.market_name);
            rec.pci_device_id = g.device_id;
            rec.memory_mib = g.vram_mib;
            rec.driver_version = g.driver_version.clone().unwrap_or_default();
            enrich(&mut rec, pci);
            rec.check()?;
            out.push(rec);
        }
        Ok(out)
    }
}

impl DeviceProvider for AmdProvider {
    fn backend(&self) -> Backend {
        Backend::AmdRocm
    }

    fn enumerate(
        &self,
        key: &LocalIdKey,
        pci: &[PciDevice],
    ) -> Result<Vec<DeviceRecord>, ProviderError> {
        if let Ok(list) = self.tools.output(&Tool::AmdSmiList) {
            return self.enumerate_amd_smi(key, pci, &list);
        }
        let report = parse_rocm_smi_json(&self.tools.output(&Tool::RocmSmiJson)?)?;
        let mut out = Vec::new();
        for (index, c) in report.cards.iter().enumerate() {
            let stable = c
                .unique_id
                .clone()
                .unwrap_or_else(|| format!("pci:{}", c.bus.as_str()));
            let mut rec = self.base_record(key, index, &stable, c.bus.clone());
            rec.model.clone_from(&c.series);
            rec.pci_device_id = c.device_id;
            rec.memory_mib = c.vram_total_bytes / (1024 * 1024);
            rec.driver_version.clone_from(&report.driver_version);
            enrich(&mut rec, pci);
            rec.check()?;
            out.push(rec);
        }
        Ok(out)
    }

    /// amd-smi's process list when it answers, else KFD and DRM fdinfo;
    /// `Unknown` when nothing can be read, which keeps the device held.
    fn observe(&self, device: &DeviceRecord, _partition: Option<&PartitionId>) -> DeviceActivity {
        if let (Ok(list), Ok(procs)) = (
            self.tools.output(&Tool::AmdSmiList),
            self.tools.output(&Tool::AmdSmiProcess),
        ) && let Ok(list) = amd_array(&list)
            && let Ok(procs) = parse_amd_smi_process(&procs)
        {
            let index = list.iter().find_map(|l| {
                (str_at(l, &["bdf"]).and_then(PciAddress::parse).as_ref() == Some(&device.pci))
                    .then(|| gpu_index(l))
                    .flatten()
            });
            if let Some(n) =
                index.and_then(|i| procs.iter().find(|(g, _)| *g == i).map(|(_, n)| *n))
            {
                return if n == 0 {
                    DeviceActivity::Idle
                } else {
                    DeviceActivity::Busy { processes: n }
                };
            }
        }
        match &self.roots {
            Some(r) => observe_device(r, &device.pci, &["amdgpu"], true),
            None => DeviceActivity::Unknown,
        }
    }

    fn cleanup(&self, device: &DeviceRecord, partition: Option<&PartitionId>) -> CleanupOutcome {
        self.cleanup.cleanup(device, partition)
    }

    /// Topology from `rocm-smi --showtopo --json`; empty when unavailable.
    fn topology(&self, devices: &[DeviceRecord]) -> Topology {
        self.tools
            .output(&Tool::RocmSmiTopo)
            .map(|j| parse_rocm_topology(&j, devices))
            .unwrap_or_default()
    }

    fn isolation_profiles(&self) -> &'static [IsolationProfile] {
        &[IsolationProfile::VmPassthrough]
    }
}

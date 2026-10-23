use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::device::{Backend, Capability, DeviceRecord, PartitionMode, PciAddress, Vendor};
use crate::ids::{LocalDeviceId, LocalIdKey};
use crate::provider::{
    CleanupOutcome, DeviceActivity, DeviceCleanup, DeviceProvider, IsolationProfile,
    NoQualifiedCleanup, ProviderError, Tool, ToolRunner, enrich, leading_u64, parse_err,
    parse_hex_u16,
};
use crate::sysfs::PciDevice;

const TOOL: &str = "rocm-smi";

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

/// AMD ROCm/HIP. It reports compute as ROCm, never CUDA, and offers only
/// VM passthrough: gVisor has no documented mediation for `/dev/kfd`.
#[derive(Debug)]
pub struct AmdProvider {
    tools: Arc<dyn ToolRunner>,
    rocm_version: Option<String>,
    cleanup: Arc<dyn DeviceCleanup>,
}

impl AmdProvider {
    /// `rocm_version` comes from the pinned host install (`/opt/rocm/.info/version`).
    pub fn new(tools: Arc<dyn ToolRunner>, rocm_version: Option<String>) -> Self {
        Self {
            tools,
            rocm_version,
            cleanup: Arc::new(NoQualifiedCleanup),
        }
    }

    #[must_use]
    pub fn with_cleanup(mut self, cleanup: Arc<dyn DeviceCleanup>) -> Self {
        self.cleanup = cleanup;
        self
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
        let report = parse_rocm_smi_json(&self.tools.output(&Tool::RocmSmiJson)?)?;
        let mut out = Vec::new();
        for (index, c) in report.cards.iter().enumerate() {
            let stable = c
                .unique_id
                .clone()
                .unwrap_or_else(|| format!("pci:{}", c.bus.as_str()));
            let mut rec = DeviceRecord {
                id: LocalDeviceId::derive(key, Vendor::Amd, &stable),
                vendor: Vendor::Amd,
                backend: Backend::AmdRocm,
                model: c.series.clone(),
                pci: c.bus.clone(),
                pci_device_id: c.device_id,
                memory_mib: c.vram_total_bytes / (1024 * 1024),
                driver_version: report.driver_version.clone(),
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
            };
            enrich(&mut rec, pci);
            rec.check()?;
            out.push(rec);
        }
        Ok(out)
    }

    /// rocm-smi's process view needs extra flags and root; until a pinned
    /// observer is qualified the answer is unknown, which keeps devices held.
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

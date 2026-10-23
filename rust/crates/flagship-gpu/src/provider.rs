//! The vendor half of the device-provider interface (§9.5) and the pinned
//! tool runner it reads from. The lifecycle half (reserve, attach, drain,
//! release/quarantine) is `DeviceManager`, which drives these.

use std::collections::BTreeMap;
use std::fmt;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::catalog::{CatalogEntry, HostFacts, Unqualified, VerifiedCatalog};
use crate::device::{Backend, Capability, DeviceError, DeviceRecord, PartitionId};
use crate::ids::LocalIdKey;
use crate::sysfs::PciDevice;

const MAX_TOOL_OUTPUT: u64 = 16 * 1024 * 1024;

/// How a device reaches a workload. There is deliberately no runc or
/// raw-device variant: a host that can't do one of these refuses the claim.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IsolationProfile {
    /// gVisor with nvproxy and CDI injection (NVIDIA only, per gVisor's
    /// documented driver support).
    GvisorNvproxy,
    /// A dedicated VM with the device assigned through VFIO/IOMMU.
    VmPassthrough,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Tool {
    /// `nvidia-smi -q -x`
    NvidiaSmiQueryXml,
    /// `rocm-smi --showproductname --showbus --showuniqueid --showmeminfo vram --showdriverversion --json`
    RocmSmiJson,
    /// `xpu-smi discovery -j`
    XpuSmiDiscovery,
    /// `xpu-smi discovery -d <id> -j`
    XpuSmiDevice(u32),
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProviderError {
    #[error("{0} is not installed or not pinned on this host")]
    ToolUnavailable(String),
    #[error("{0} failed")]
    ToolFailed(String),
    #[error("could not parse {tool} output: {why}")]
    Parse { tool: &'static str, why: String },
    #[error(transparent)]
    Device(#[from] DeviceError),
    #[error("{backend} does not support isolation profile {profile:?}")]
    IsolationUnsupported {
        backend: Backend,
        profile: IsolationProfile,
    },
}

/// Where vendor tool output comes from. The broker uses [`PinnedTools`];
/// tests use [`FixtureTools`].
pub trait ToolRunner: Send + Sync + fmt::Debug {
    fn output(&self, tool: &Tool) -> Result<String, ProviderError>;
}

#[derive(Clone, Debug, Default)]
pub struct FixtureTools(BTreeMap<Tool, String>);

impl FixtureTools {
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with(mut self, tool: Tool, output: impl Into<String>) -> Self {
        self.0.insert(tool, output.into());
        self
    }
}

impl ToolRunner for FixtureTools {
    fn output(&self, tool: &Tool) -> Result<String, ProviderError> {
        self.0
            .get(tool)
            .cloned()
            .ok_or_else(|| ProviderError::ToolUnavailable(format!("{tool:?}")))
    }
}

/// Runs vendor tools by absolute path from the host's pinned tooling, with
/// an empty environment, fixed arguments, a size cap and a deadline.
#[derive(Clone, Debug)]
pub struct PinnedTools {
    pub nvidia_smi: Option<PathBuf>,
    pub rocm_smi: Option<PathBuf>,
    pub xpu_smi: Option<PathBuf>,
    pub timeout: Duration,
}

impl PinnedTools {
    fn command(&self, tool: &Tool) -> Option<(PathBuf, Vec<String>)> {
        let args = |a: &[&str]| a.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        match tool {
            Tool::NvidiaSmiQueryXml => self.nvidia_smi.clone().map(|p| (p, args(&["-q", "-x"]))),
            Tool::RocmSmiJson => self.rocm_smi.clone().map(|p| {
                (
                    p,
                    args(&[
                        "--showproductname",
                        "--showbus",
                        "--showuniqueid",
                        "--showmeminfo",
                        "vram",
                        "--showdriverversion",
                        "--json",
                    ]),
                )
            }),
            Tool::XpuSmiDiscovery => self
                .xpu_smi
                .clone()
                .map(|p| (p, args(&["discovery", "-j"]))),
            Tool::XpuSmiDevice(id) => self.xpu_smi.clone().map(|p| {
                let mut a = args(&["discovery", "-d"]);
                a.push(id.to_string());
                a.push("-j".to_owned());
                (p, a)
            }),
        }
    }
}

impl ToolRunner for PinnedTools {
    fn output(&self, tool: &Tool) -> Result<String, ProviderError> {
        let name = format!("{tool:?}");
        let (path, args) = self
            .command(tool)
            .ok_or_else(|| ProviderError::ToolUnavailable(name.clone()))?;
        if !path.is_absolute() {
            return Err(ProviderError::ToolUnavailable(name));
        }
        let mut child = Command::new(&path)
            .args(&args)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| ProviderError::ToolUnavailable(name.clone()))?;
        let stdout = child.stdout.take();
        let reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(out) = stdout {
                let _ = out.take(MAX_TOOL_OUTPUT).read_to_end(&mut buf);
            }
            buf
        });
        let deadline = Instant::now()
            .checked_add(self.timeout)
            .unwrap_or_else(Instant::now);
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(ProviderError::ToolFailed(name));
                }
            }
        };
        let buf = reader
            .join()
            .map_err(|_| ProviderError::ToolFailed(name.clone()))?;
        if !status.success() {
            return Err(ProviderError::ToolFailed(name));
        }
        String::from_utf8(buf).map_err(|_| ProviderError::ToolFailed(name))
    }
}

/// What the device itself says about who is using it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceActivity {
    Idle,
    Busy {
        processes: u32,
    },
    /// The tool failed or can't see processes. Never treated as idle.
    Unknown,
}

/// Whether a device was proven clean (reset or scrubbed by a qualified
/// procedure) after a workload. Anything short of proof quarantines it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CleanupOutcome {
    Proven,
    Unproven(String),
}

/// The host maintenance layer's reset/scrub procedure for one backend. It
/// must be qualified on real hardware before it may return `Proven`.
pub trait DeviceCleanup: Send + Sync + fmt::Debug {
    fn cleanup(&self, device: &DeviceRecord, partition: Option<&PartitionId>) -> CleanupOutcome;
}

/// The default until a reset procedure has a hardware receipt: nothing is
/// ever proven clean, so a device used once is quarantined for maintenance.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoQualifiedCleanup;

impl DeviceCleanup for NoQualifiedCleanup {
    fn cleanup(&self, _: &DeviceRecord, _: Option<&PartitionId>) -> CleanupOutcome {
        CleanupOutcome::Unproven("no qualified reset or scrub procedure for this device".into())
    }
}

/// One vendor backend.
pub trait DeviceProvider: Send + Sync + fmt::Debug {
    fn backend(&self) -> Backend;

    /// Devices this backend's pinned tooling reports, joined with sysfs.
    fn enumerate(
        &self,
        key: &LocalIdKey,
        pci: &[PciDevice],
    ) -> Result<Vec<DeviceRecord>, ProviderError>;

    /// What the device reports about current users of the whole device,
    /// or of one partition.
    fn observe(&self, device: &DeviceRecord, partition: Option<&PartitionId>) -> DeviceActivity;

    /// Reset or scrub after a workload, with proof or not.
    fn cleanup(&self, device: &DeviceRecord, partition: Option<&PartitionId>) -> CleanupOutcome;

    /// Isolation profiles this backend can be qualified for at all.
    fn isolation_profiles(&self) -> &'static [IsolationProfile];

    /// The signed catalog's verdict for this device on this host.
    fn validate_compatibility<'c>(
        &self,
        device: &DeviceRecord,
        host: &HostFacts,
        catalog: &'c VerifiedCatalog,
        profile: IsolationProfile,
        capabilities: &std::collections::BTreeSet<Capability>,
    ) -> Result<&'c CatalogEntry, Unqualified> {
        if device.backend != self.backend() || !self.isolation_profiles().contains(&profile) {
            return Err(Unqualified(vec![format!(
                "{} cannot run under {profile:?}",
                self.backend()
            )]));
        }
        catalog.qualify(device, host, profile, capabilities)
    }
}

/// Fill in what only sysfs knows: IOMMU group, NUMA node, boot-VGA display
/// ownership, the bound kernel driver.
pub(crate) fn enrich(rec: &mut DeviceRecord, pci: &[PciDevice]) {
    if let Some(p) = pci.iter().find(|p| p.address == rec.pci) {
        rec.iommu_group = p.iommu_group;
        rec.iommu_group_members.clone_from(&p.iommu_group_members);
        rec.numa_node = p.numa_node;
        rec.kernel_driver.clone_from(&p.kernel_driver);
        rec.display_owned |= p.boot_vga;
        if rec.pci_device_id.is_none() {
            rec.pci_device_id = Some(p.device_id);
        }
    }
}

pub(crate) fn parse_err(tool: &'static str, why: impl Into<String>) -> ProviderError {
    ProviderError::Parse {
        tool,
        why: why.into(),
    }
}

/// Leading integer of strings like `24564 MiB`.
pub(crate) fn leading_u64(s: &str) -> Option<u64> {
    let digits: String = s.trim().chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

pub(crate) fn parse_hex_u16(s: &str) -> Option<u16> {
    let s = s.trim();
    let s = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    u16::from_str_radix(s, 16).ok()
}

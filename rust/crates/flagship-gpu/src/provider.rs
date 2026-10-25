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
use crate::device::{Backend, Capability, DeviceError, DeviceRecord, PartitionId, PciAddress};
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

/// Every vendor tool invocation the broker may make, each with fixed
/// arguments. Nothing an app sends ends up in an argv except validated
/// integers (device index, MIG profile ids) and a parsed PCI address.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Tool {
    /// `nvidia-smi -q -x`
    NvidiaSmiQueryXml,
    /// `nvidia-smi topo -m`
    NvidiaSmiTopo,
    /// `nvidia-smi --query-compute-apps=pid,gpu_bus_id,used_memory --format=csv,noheader,nounits`
    NvidiaSmiComputeApps,
    /// `nvidia-smi pmon -c 1 -s um`
    NvidiaSmiPmon,
    /// `nvidia-smi mig -i <index> -lgip`
    NvidiaSmiMigProfiles(u32),
    /// `nvidia-smi -i <index> -mig <0|1>`
    NvidiaSmiMigMode { index: u32, enabled: bool },
    /// `nvidia-smi mig -i <index> -cgi <profile ids> -C`
    NvidiaSmiMigCreate { index: u32, profiles: Vec<u32> },
    /// `nvidia-smi mig -i <index> -dci`
    NvidiaSmiMigDestroyCompute(u32),
    /// `nvidia-smi mig -i <index> -dgi`
    NvidiaSmiMigDestroyGpu(u32),
    /// `nvidia-smi --gpu-reset -i <pci address>`
    NvidiaSmiReset(PciAddress),
    /// `nvidia-ctk cdi generate --format=json`
    NvidiaCtkCdiGenerate,
    /// `rocm-smi --showproductname --showbus --showuniqueid --showmeminfo vram --showdriverversion --json`
    RocmSmiJson,
    /// `rocm-smi --showtopo --json`
    RocmSmiTopo,
    /// `amd-smi list --json`
    AmdSmiList,
    /// `amd-smi static --asic --bus --vram --driver --json`
    AmdSmiStatic,
    /// `amd-smi process --json`
    AmdSmiProcess,
    /// `xpu-smi discovery -j`
    XpuSmiDiscovery,
    /// `xpu-smi discovery -d <id> -j`
    XpuSmiDevice(u32),
    /// `xpu-smi topology -m`
    XpuSmiTopology,
    /// `xpu-smi ps -d <id> -j`
    XpuSmiPs(u32),
}

impl Tool {
    /// The program this invocation runs.
    pub fn program(&self) -> ToolProgram {
        match self {
            Self::NvidiaSmiQueryXml
            | Self::NvidiaSmiTopo
            | Self::NvidiaSmiComputeApps
            | Self::NvidiaSmiPmon
            | Self::NvidiaSmiMigProfiles(_)
            | Self::NvidiaSmiMigMode { .. }
            | Self::NvidiaSmiMigCreate { .. }
            | Self::NvidiaSmiMigDestroyCompute(_)
            | Self::NvidiaSmiMigDestroyGpu(_)
            | Self::NvidiaSmiReset(_) => ToolProgram::NvidiaSmi,
            Self::NvidiaCtkCdiGenerate => ToolProgram::NvidiaCtk,
            Self::RocmSmiJson | Self::RocmSmiTopo => ToolProgram::RocmSmi,
            Self::AmdSmiList | Self::AmdSmiStatic | Self::AmdSmiProcess => ToolProgram::AmdSmi,
            Self::XpuSmiDiscovery
            | Self::XpuSmiDevice(_)
            | Self::XpuSmiTopology
            | Self::XpuSmiPs(_) => ToolProgram::XpuSmi,
        }
    }

    /// The fixed argument list.
    pub fn args(&self) -> Vec<String> {
        let s = |a: &[&str]| a.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
        match self {
            Self::NvidiaSmiQueryXml => s(&["-q", "-x"]),
            Self::NvidiaSmiTopo => s(&["topo", "-m"]),
            Self::NvidiaSmiComputeApps => s(&[
                "--query-compute-apps=pid,gpu_bus_id,used_memory",
                "--format=csv,noheader,nounits",
            ]),
            Self::NvidiaSmiPmon => s(&["pmon", "-c", "1", "-s", "um"]),
            Self::NvidiaSmiMigProfiles(i) => {
                let mut a = s(&["mig", "-i"]);
                a.push(i.to_string());
                a.push("-lgip".into());
                a
            }
            Self::NvidiaSmiMigMode { index, enabled } => {
                let mut a = s(&["-i"]);
                a.push(index.to_string());
                a.push("-mig".into());
                a.push(if *enabled { "1" } else { "0" }.into());
                a
            }
            Self::NvidiaSmiMigCreate { index, profiles } => {
                let mut a = s(&["mig", "-i"]);
                a.push(index.to_string());
                a.push("-cgi".into());
                a.push(
                    profiles
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join(","),
                );
                a.push("-C".into());
                a
            }
            Self::NvidiaSmiMigDestroyCompute(i) => {
                let mut a = s(&["mig", "-i"]);
                a.push(i.to_string());
                a.push("-dci".into());
                a
            }
            Self::NvidiaSmiMigDestroyGpu(i) => {
                let mut a = s(&["mig", "-i"]);
                a.push(i.to_string());
                a.push("-dgi".into());
                a
            }
            Self::NvidiaSmiReset(pci) => {
                let mut a = s(&["--gpu-reset", "-i"]);
                a.push(pci.as_str().to_owned());
                a
            }
            Self::NvidiaCtkCdiGenerate => s(&["cdi", "generate", "--format=json"]),
            Self::RocmSmiJson => s(&[
                "--showproductname",
                "--showbus",
                "--showuniqueid",
                "--showmeminfo",
                "vram",
                "--showdriverversion",
                "--json",
            ]),
            Self::RocmSmiTopo => s(&["--showtopo", "--json"]),
            Self::AmdSmiList => s(&["list", "--json"]),
            Self::AmdSmiStatic => s(&["static", "--asic", "--bus", "--vram", "--driver", "--json"]),
            Self::AmdSmiProcess => s(&["process", "--json"]),
            Self::XpuSmiDiscovery => s(&["discovery", "-j"]),
            Self::XpuSmiDevice(id) => {
                let mut a = s(&["discovery", "-d"]);
                a.push(id.to_string());
                a.push("-j".into());
                a
            }
            Self::XpuSmiTopology => s(&["topology", "-m"]),
            Self::XpuSmiPs(id) => {
                let mut a = s(&["ps", "-d"]);
                a.push(id.to_string());
                a.push("-j".into());
                a
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolProgram {
    NvidiaSmi,
    NvidiaCtk,
    RocmSmi,
    AmdSmi,
    XpuSmi,
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
    pub nvidia_ctk: Option<PathBuf>,
    pub rocm_smi: Option<PathBuf>,
    pub amd_smi: Option<PathBuf>,
    pub xpu_smi: Option<PathBuf>,
    pub timeout: Duration,
}

impl Default for PinnedTools {
    fn default() -> Self {
        Self {
            nvidia_smi: None,
            nvidia_ctk: None,
            rocm_smi: None,
            amd_smi: None,
            xpu_smi: None,
            timeout: Duration::from_secs(30),
        }
    }
}

impl PinnedTools {
    fn command(&self, tool: &Tool) -> Option<(PathBuf, Vec<String>)> {
        let path = match tool.program() {
            ToolProgram::NvidiaSmi => self.nvidia_smi.clone(),
            ToolProgram::NvidiaCtk => self.nvidia_ctk.clone(),
            ToolProgram::RocmSmi => self.rocm_smi.clone(),
            ToolProgram::AmdSmi => self.amd_smi.clone(),
            ToolProgram::XpuSmi => self.xpu_smi.clone(),
        }?;
        Some((path, tool.args()))
    }

    /// The pinned path for one program, if this host has it.
    pub fn path(&self, program: ToolProgram) -> Option<&PathBuf> {
        match program {
            ToolProgram::NvidiaSmi => self.nvidia_smi.as_ref(),
            ToolProgram::NvidiaCtk => self.nvidia_ctk.as_ref(),
            ToolProgram::RocmSmi => self.rocm_smi.as_ref(),
            ToolProgram::AmdSmi => self.amd_smi.as_ref(),
            ToolProgram::XpuSmi => self.xpu_smi.as_ref(),
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
        match run_fixed(&path, &args, self.timeout) {
            Ok((true, out)) => Ok(out),
            Ok((false, _)) | Err(RunError::Failed) => Err(ProviderError::ToolFailed(name)),
            Err(RunError::NotFound) => Err(ProviderError::ToolUnavailable(name)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunError {
    NotFound,
    Failed,
}

/// Run an absolute path with fixed arguments, an empty environment, no
/// stdin, stdout capped at 16 MiB and a deadline. Returns whether it exited
/// 0 and its stdout.
pub fn run_fixed(
    path: &std::path::Path,
    args: &[String],
    timeout: Duration,
) -> Result<(bool, String), RunError> {
    if !path.is_absolute() {
        return Err(RunError::NotFound);
    }
    let mut child = Command::new(path)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| RunError::NotFound)?;
    let stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(out) = stdout {
            let _ = out.take(MAX_TOOL_OUTPUT).read_to_end(&mut buf);
        }
        buf
    });
    let deadline = Instant::now()
        .checked_add(timeout)
        .unwrap_or_else(Instant::now);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::Failed);
            }
        }
    };
    let buf = reader.join().map_err(|_| RunError::Failed)?;
    let text = String::from_utf8(buf).map_err(|_| RunError::Failed)?;
    Ok((status.success(), text))
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

    /// Links between this backend's devices, from its pinned tool; empty
    /// (every link unknown) when the tool can't say.
    fn topology(&self, _devices: &[DeviceRecord]) -> crate::topology::Topology {
        crate::topology::Topology::new()
    }

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

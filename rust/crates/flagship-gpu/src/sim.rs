//! A simulated accelerator host. It renders a sysfs tree, `/proc` entries,
//! `/dev` nodes and every pinned vendor tool's output (nvidia-smi XML, topo
//! matrix, compute-apps CSV, pmon, MIG profile table and actions, the
//! nvidia-ctk CDI spec; rocm-smi and amd-smi JSON; xpu-smi JSON and topology)
//! from one mutable state, in the vendors' documented formats, so the whole
//! software path (inventory, catalog, CDI, claims, attach, observation,
//! residue scrub, MIG, VFIO, jobs, driver maintenance) runs on a machine
//! with no GPU. Nothing here is ever a qualification: §9.4 needs hardware
//! receipts, and the catalog refuses an entry without one.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::catalog::{DriverPackage, ResetKind};
use crate::coop::PidOwner;
use crate::device::{DeviceRecord, PartitionId, PciAddress, Vendor};
use crate::jobs::{ExecStatus, JobExecutor, JobKind, JobSpec};
use crate::maintenance::HostPackages;
use crate::manager::{AttachPlan, Presence, WorkloadRuntime};
use crate::media::{encode_ppm, reference_clip, reference_scene};
use crate::policy::AllocationId;
use crate::provider::{ProviderError, Tool, ToolProgram, ToolRunner};
use crate::scrub::{SCRUB_SCHEMA, ScrubReport, ScrubRunner};
use crate::vfio::SysfsWrite;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimMigInstance {
    pub gi: u32,
    pub ci: u32,
    pub profile_id: u32,
    pub memory_mib: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimMig {
    pub enabled: bool,
    pub instances: Vec<SimMigInstance>,
}

/// A100-40GB MIG profiles (MIG user guide): id, name, count, memory MiB.
pub const A100_PROFILES: &[(u32, &str, u32, u64)] = &[
    (19, "1g.5gb", 7, 4864),
    (14, "2g.10gb", 3, 9984),
    (9, "3g.20gb", 2, 20096),
    (5, "4g.20gb", 1, 20096),
    (0, "7g.40gb", 1, 40320),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimGpu {
    pub vendor: Vendor,
    pub model: String,
    pub pci_device_id: u16,
    pub pci: PciAddress,
    pub class: u32,
    pub memory_mib: u64,
    pub uuid: String,
    pub numa: i32,
    pub iommu_group: u32,
    /// Other functions of the same card (audio), same IOMMU group.
    pub extra_functions: Vec<PciAddress>,
    /// Another device in the same IOMMU group (unsafe for passthrough).
    pub shares_group_with: Option<PciAddress>,
    pub boot_vga: bool,
    pub display_active: bool,
    pub mig: Option<SimMig>,
    pub reset_method: String,
    pub host_driver: String,
    pub render_minor: u32,
    pub kfd_gpu_id: u64,
    /// Peer-fabric group (NVLink, xGMI, Xe Link); same label = linked.
    pub fabric: Option<String>,
    pub present: bool,
    /// The scrub image cannot clear this device (residue survives).
    pub scrub_broken: bool,
}

fn addr(bus: u8, func: u8) -> PciAddress {
    PciAddress::parse(&format!("0000:{bus:02x}:00.{func}")).unwrap_or_else(unreachable_addr)
}

fn unreachable_addr() -> PciAddress {
    match PciAddress::parse("0000:00:00.0") {
        Some(a) => a,
        None => unreachable!("a literal PCI address parses"),
    }
}

impl SimGpu {
    fn base(vendor: Vendor, model: &str, id: u16, bus: u8, mem: u64, driver: &str) -> Self {
        Self {
            vendor,
            model: model.into(),
            pci_device_id: id,
            pci: addr(bus, 0),
            class: 0x030200,
            memory_mib: mem,
            uuid: format!("sim-{}-{bus:02x}-{id:04x}", vendor.as_str()),
            numa: 0,
            iommu_group: u32::from(bus),
            extra_functions: Vec::new(),
            shares_group_with: None,
            boot_vga: false,
            display_active: false,
            mig: None,
            reset_method: "flr bus".into(),
            host_driver: driver.into(),
            render_minor: 128u32.saturating_add(u32::from(bus)),
            kfd_gpu_id: 0,
            fabric: None,
            present: true,
            scrub_broken: false,
        }
    }

    pub fn rtx4090(bus: u8) -> Self {
        let mut g = Self::base(
            Vendor::Nvidia,
            "NVIDIA GeForce RTX 4090",
            0x2684,
            bus,
            24564,
            "nvidia",
        );
        g.class = 0x030000;
        g.extra_functions.push(addr(bus, 1));
        g
    }

    pub fn h100(bus: u8, fabric: &str, numa: i32) -> Self {
        let mut g = Self::base(
            Vendor::Nvidia,
            "NVIDIA H100 80GB HBM3",
            0x2330,
            bus,
            81559,
            "nvidia",
        );
        g.mig = Some(SimMig {
            enabled: false,
            instances: Vec::new(),
        });
        g.fabric = Some(fabric.into());
        g.numa = numa;
        g
    }

    pub fn a100_mig(bus: u8, layout: &[u32]) -> Self {
        let mut g = Self::base(
            Vendor::Nvidia,
            "NVIDIA A100-SXM4-40GB",
            0x20b0,
            bus,
            40960,
            "nvidia",
        );
        let instances = layout
            .iter()
            .enumerate()
            .map(|(i, p)| SimMigInstance {
                gi: u32::try_from(i).unwrap_or(0).saturating_add(1),
                ci: 0,
                profile_id: *p,
                memory_mib: A100_PROFILES.iter().find(|x| x.0 == *p).map_or(0, |x| x.3),
            })
            .collect();
        g.mig = Some(SimMig {
            enabled: true,
            instances,
        });
        g
    }

    pub fn mi210(bus: u8, kfd_gpu_id: u64, fabric: Option<&str>) -> Self {
        let mut g = Self::base(
            Vendor::Amd,
            "AMD Instinct MI210",
            0x740f,
            bus,
            65536,
            "amdgpu",
        );
        g.kfd_gpu_id = kfd_gpu_id;
        g.fabric = fabric.map(str::to_owned);
        g
    }

    pub fn rx7900_display(bus: u8, kfd_gpu_id: u64) -> Self {
        let mut g = Self::base(
            Vendor::Amd,
            "AMD Radeon RX 7900 XTX",
            0x744c,
            bus,
            24560,
            "amdgpu",
        );
        g.class = 0x030000;
        g.boot_vga = true;
        g.kfd_gpu_id = kfd_gpu_id;
        g
    }

    pub fn flex170(bus: u8) -> Self {
        Self::base(
            Vendor::Intel,
            "Intel(R) Data Center GPU Flex 170",
            0x56c0,
            bus,
            16384,
            "i915",
        )
    }

    pub fn arc_a770(bus: u8, fabric: Option<&str>) -> Self {
        let mut g = Self::base(
            Vendor::Intel,
            "Intel(R) Arc(TM) A770 Graphics",
            0x56a0,
            bus,
            16256,
            "xe",
        );
        g.class = 0x030000;
        g.fabric = fabric.map(str::to_owned);
        g
    }

    fn functions(&self) -> Vec<PciAddress> {
        let mut v = vec![self.pci.clone()];
        v.extend(self.extra_functions.iter().cloned());
        v
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimProc {
    pub pid: u32,
    pub pci: PciAddress,
    pub partition: Option<(u32, u32)>,
    pub used_mib: u64,
    pub sm_percent: u8,
    pub owner: Option<AllocationId>,
}

#[derive(Clone, Debug, Default)]
struct SimJob {
    polls: u32,
    needed: u32,
    disk_mib: u64,
    output_ok: Option<Result<String, String>>,
}

#[derive(Clone, Debug)]
pub struct SimDrivers {
    pub kernel: String,
    pub nvidia: String,
    pub cuda: String,
    pub amd: String,
    pub rocm: String,
    pub intel: String,
    pub level_zero: String,
}

impl Default for SimDrivers {
    fn default() -> Self {
        Self {
            kernel: "6.12.48+deb13-amd64".into(),
            nvidia: "580.95.05".into(),
            cuda: "13.0".into(),
            amd: "6.12.48+deb13-amd64".into(),
            rocm: "6.4.3".into(),
            intel: "I915_24.3.23_PSB_240103.21".into(),
            level_zero: "1.21.9".into(),
        }
    }
}

#[derive(Debug)]
struct SimState {
    gpus: Vec<SimGpu>,
    procs: Vec<SimProc>,
    residue: BTreeMap<(String, Option<(u32, u32)>), u64>,
    drivers: SimDrivers,
    next_pid: u32,
    failing: BTreeSet<ToolProgram>,
    overrides: BTreeMap<String, String>,
    bound: BTreeMap<String, String>,
    workloads: BTreeMap<AllocationId, bool>,
    unknown_runtime: bool,
    jobs: BTreeMap<AllocationId, SimJob>,
    resets: u32,
    installed: BTreeMap<String, String>,
    pending: Option<BTreeMap<String, String>>,
    module_signer: Option<String>,
    reboots: u32,
    fail_install: bool,
}

/// The simulated host. Clones share state.
#[derive(Clone, Debug)]
pub struct SimHost {
    root: PathBuf,
    state: Arc<Mutex<SimState>>,
}

fn w(p: &Path, s: &str) -> io::Result<()> {
    if let Some(d) = p.parent() {
        fs::create_dir_all(d)?;
    }
    fs::write(p, s)
}

#[cfg(unix)]
fn symlink(target: &str, link: &Path) -> io::Result<()> {
    if let Some(d) = link.parent() {
        fs::create_dir_all(d)?;
    }
    let _ = fs::remove_file(link);
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn symlink(_target: &str, link: &Path) -> io::Result<()> {
    w(link, "")
}

fn err(tool: &Tool) -> ProviderError {
    ProviderError::ToolFailed(format!("{tool:?}"))
}

impl SimHost {
    /// Lay out a host under `root` (which must be empty or absent).
    pub fn new(root: impl Into<PathBuf>, gpus: Vec<SimGpu>) -> io::Result<Self> {
        let mut bound = BTreeMap::new();
        for g in &gpus {
            for f in g.functions() {
                let drv = if f == g.pci {
                    g.host_driver.clone()
                } else {
                    "snd_hda_intel".into()
                };
                bound.insert(f.as_str().to_owned(), drv);
            }
            if let Some(o) = &g.shares_group_with {
                bound.insert(o.as_str().to_owned(), "i801_smbus".into());
            }
        }
        let h = Self {
            root: root.into(),
            state: Arc::new(Mutex::new(SimState {
                gpus,
                procs: Vec::new(),
                residue: BTreeMap::new(),
                drivers: SimDrivers::default(),
                next_pid: 41_000,
                failing: BTreeSet::new(),
                overrides: BTreeMap::new(),
                bound,
                workloads: BTreeMap::new(),
                unknown_runtime: false,
                jobs: BTreeMap::new(),
                resets: 0,
                installed: BTreeMap::new(),
                pending: None,
                module_signer: Some("Flagship box MOK".into()),
                reboots: 0,
                fail_install: false,
            })),
        };
        h.sync()?;
        Ok(h)
    }

    fn lock(&self) -> MutexGuard<'_, SimState> {
        match self.state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    pub fn sys_root(&self) -> PathBuf {
        self.root.join("sys")
    }

    pub fn proc_root(&self) -> PathBuf {
        self.root.join("proc")
    }

    pub fn dev_root(&self) -> PathBuf {
        self.root.join("dev")
    }

    pub fn cdi_dir(&self) -> PathBuf {
        self.root.join("cdi")
    }

    pub fn drivers(&self) -> SimDrivers {
        self.lock().drivers.clone()
    }

    pub fn set_drivers(&self, d: SimDrivers) {
        self.lock().drivers = d;
    }

    pub fn gpus(&self) -> Vec<SimGpu> {
        self.lock().gpus.clone()
    }

    /// Change one GPU (unplug, mark display, break its scrub) and re-render.
    pub fn edit_gpu(&self, pci: &PciAddress, f: impl FnOnce(&mut SimGpu)) -> io::Result<()> {
        {
            let mut s = self.lock();
            if let Some(g) = s.gpus.iter_mut().find(|g| g.pci == *pci) {
                f(g);
            }
        }
        self.sync()
    }

    /// Make a program fail (a crashed driver, a missing tool).
    pub fn fail_tool(&self, p: ToolProgram, failing: bool) {
        let mut s = self.lock();
        if failing {
            s.failing.insert(p);
        } else {
            s.failing.remove(&p);
        }
    }

    pub fn set_runtime_unknown(&self, unknown: bool) {
        self.lock().unknown_runtime = unknown;
    }

    pub fn resets(&self) -> u32 {
        self.lock().resets
    }

    /// Residue canaries left on one device or partition.
    pub fn residue(&self, pci: &PciAddress, partition: Option<&PartitionId>) -> u64 {
        let key = (
            pci.as_str().to_owned(),
            partition.map(|p| (p.gpu_instance, p.compute_instance)),
        );
        self.lock().residue.get(&key).copied().unwrap_or(0)
    }

    /// A process nobody launched (another tenant, a leftover).
    pub fn spawn_foreign(
        &self,
        pci: &PciAddress,
        partition: Option<(u32, u32)>,
    ) -> io::Result<u32> {
        let pid = {
            let mut s = self.lock();
            let pid = s.next_pid;
            s.next_pid = s.next_pid.saturating_add(1);
            s.procs.push(SimProc {
                pid,
                pci: pci.clone(),
                partition,
                used_mib: 512,
                sm_percent: 10,
                owner: None,
            });
            pid
        };
        self.sync()?;
        Ok(pid)
    }

    pub fn kill(&self, pid: u32) -> io::Result<()> {
        self.lock().procs.retain(|p| p.pid != pid);
        self.sync()
    }

    /// Start a workload's processes on these devices, each leaving a residue
    /// canary in the memory it touched.
    pub fn launch(
        &self,
        alloc: &AllocationId,
        targets: &[(PciAddress, Option<PartitionId>)],
        used_mib: u64,
        sm_percent: u8,
    ) -> io::Result<Vec<u32>> {
        let pids = {
            let mut s = self.lock();
            let mut pids = Vec::new();
            for (pci, part) in targets {
                let pid = s.next_pid;
                s.next_pid = s.next_pid.saturating_add(1);
                let part = part.as_ref().map(|p| (p.gpu_instance, p.compute_instance));
                s.procs.push(SimProc {
                    pid,
                    pci: pci.clone(),
                    partition: part,
                    used_mib,
                    sm_percent,
                    owner: Some(alloc.clone()),
                });
                let r = s
                    .residue
                    .entry((pci.as_str().to_owned(), part))
                    .or_insert(0);
                *r = r.saturating_add(1);
                pids.push(pid);
            }
            s.workloads.insert(alloc.clone(), true);
            pids
        };
        self.sync()?;
        Ok(pids)
    }

    /// The workload is gone as far as the runtime knows, but its processes
    /// still hold the device (a crash the driver hasn't cleaned up).
    pub fn crash(&self, alloc: &AllocationId) {
        self.lock().workloads.insert(alloc.clone(), false);
    }

    /// The driver finally reaps a crashed workload's processes.
    pub fn reap(&self, alloc: &AllocationId) -> io::Result<()> {
        self.lock()
            .procs
            .retain(|p| p.owner.as_ref() != Some(alloc));
        self.sync()
    }

    pub fn set_usage(&self, alloc: &AllocationId, used_mib: u64, sm_percent: u8) {
        for p in self
            .lock()
            .procs
            .iter_mut()
            .filter(|p| p.owner.as_ref() == Some(alloc))
        {
            p.used_mib = used_mib;
            p.sm_percent = sm_percent;
        }
    }

    pub fn targets_for(
        &self,
        plan: &AttachPlan,
        inventory: &[DeviceRecord],
    ) -> Vec<(PciAddress, Option<PartitionId>)> {
        let mut out = Vec::new();
        for c in &plan.cdi_devices {
            let Some((_, name)) = c.split_once('=') else {
                continue;
            };
            let (dev, part) = match name.split_once(':') {
                Some((d, _)) => (d, Some(name)),
                None => (name, None),
            };
            if let Some(d) = inventory.iter().find(|d| d.cdi_name == dev) {
                let p = part.and_then(|n| {
                    d.partitions
                        .iter()
                        .find(|p| p.cdi_name == n)
                        .map(|p| p.id.clone())
                });
                out.push((d.pci.clone(), p));
            }
        }
        for f in &plan.vfio_functions {
            if inventory.iter().any(|d| d.pci == *f) {
                out.push((f.clone(), None));
            }
        }
        out
    }

    /// The installed driver packages a test starts from.
    pub fn set_installed(&self, pkgs: &[(&str, &str)]) {
        self.lock().installed = pkgs
            .iter()
            .map(|(n, v)| ((*n).to_owned(), (*v).to_owned()))
            .collect();
    }

    pub fn set_fail_install(&self, f: bool) {
        self.lock().fail_install = f;
    }

    pub fn set_module_signer(&self, s: Option<&str>) {
        self.lock().module_signer = s.map(str::to_owned);
    }

    pub fn reboots(&self) -> u32 {
        self.lock().reboots
    }

    /// Apply what was installed (packages named `*driver*` set the vendor
    /// driver version) and clear every process, as a reboot does.
    pub fn reboot(&self, vendor: Vendor) -> io::Result<()> {
        {
            let mut s = self.lock();
            if let Some(p) = s.pending.take() {
                if let Some(v) = p
                    .iter()
                    .find(|(n, _)| n.contains("driver"))
                    .map(|(_, v)| v.clone())
                {
                    match vendor {
                        Vendor::Nvidia => s.drivers.nvidia = v,
                        Vendor::Amd => s.drivers.amd = v,
                        Vendor::Intel => s.drivers.intel = v,
                    }
                }
                s.installed = p;
            }
            s.procs.clear();
            s.workloads.clear();
        }
        self.sync()
    }

    /// Re-render the trees from the state.
    pub fn sync(&self) -> io::Result<()> {
        let s = self.lock();
        let sys = self.sys_root();
        let proc_ = self.proc_root();
        let dev = self.dev_root();
        for d in [&sys, &proc_, &dev] {
            if d.exists() {
                fs::remove_dir_all(d)?;
            }
        }
        fs::create_dir_all(sys.join("bus/pci/devices"))?;
        fs::create_dir_all(sys.join("kernel/iommu_groups"))?;
        fs::create_dir_all(&proc_)?;
        fs::create_dir_all(dev.join("vfio"))?;
        fs::create_dir_all(self.cdi_dir())?;
        let mut nv_index = 0u32;
        let mut mig_minors = String::new();
        for (gi_node, g) in s.gpus.iter().filter(|g| g.present).enumerate() {
            let mut fns = g.functions();
            if let Some(o) = &g.shares_group_with {
                fns.push(o.clone());
            }
            let grp = sys.join(format!("kernel/iommu_groups/{}", g.iommu_group));
            w(&grp.join("type"), "DMA-FQ\n")?;
            for f in &fns {
                let d = sys.join("bus/pci/devices").join(f.as_str());
                let vendor_id = match g.vendor {
                    Vendor::Nvidia => 0x10de,
                    Vendor::Amd => 0x1002,
                    Vendor::Intel => 0x8086,
                };
                let primary = *f == g.pci;
                let foreign = g.shares_group_with.as_ref() == Some(f);
                let (vid, did, class) = if foreign {
                    (0x8086u32, 0xa323u32, 0x0c0500u32)
                } else if primary {
                    (vendor_id, u32::from(g.pci_device_id), g.class)
                } else {
                    (vendor_id, 0x22bau32, 0x040300u32)
                };
                w(&d.join("vendor"), &format!("0x{vid:04x}\n"))?;
                w(&d.join("device"), &format!("0x{did:04x}\n"))?;
                w(&d.join("class"), &format!("0x{class:06x}\n"))?;
                w(&d.join("numa_node"), &format!("{}\n", g.numa))?;
                w(&d.join("reset_method"), &format!("{}\n", g.reset_method))?;
                w(&d.join("reset"), "")?;
                w(
                    &d.join("driver_override"),
                    &format!(
                        "{}\n",
                        s.overrides.get(f.as_str()).map_or("(null)", String::as_str)
                    ),
                )?;
                if primary {
                    w(&d.join("boot_vga"), if g.boot_vga { "1\n" } else { "0\n" })?;
                    fs::create_dir_all(d.join(format!("drm/renderD{}", g.render_minor)))?;
                }
                symlink(
                    &format!("../../../kernel/iommu_groups/{}", g.iommu_group),
                    &d.join("iommu_group"),
                )?;
                if let Some(drv) = s.bound.get(f.as_str()) {
                    symlink(
                        &format!("../../../bus/pci/drivers/{drv}"),
                        &d.join("driver"),
                    )?;
                }
                w(&grp.join("devices").join(f.as_str()), "")?;
            }
            let all_vfio = fns
                .iter()
                .all(|f| s.bound.get(f.as_str()).map(String::as_str) == Some("vfio-pci"));
            if all_vfio {
                w(&dev.join(format!("vfio/{}", g.iommu_group)), "")?;
            }
            match g.vendor {
                Vendor::Nvidia => {
                    w(&dev.join(format!("nvidia{nv_index}")), "")?;
                    if let Some(m) = g.mig.as_ref().filter(|m| m.enabled) {
                        for inst in &m.instances {
                            let gm = 100u32
                                .saturating_add(nv_index.saturating_mul(50))
                                .saturating_add(inst.gi.saturating_mul(5));
                            let _ = writeln!(mig_minors, "gpu{nv_index}/gi{}/access {gm}", inst.gi);
                            let _ = writeln!(
                                mig_minors,
                                "gpu{nv_index}/gi{}/ci{}/access {}",
                                inst.gi,
                                inst.ci,
                                gm.saturating_add(1).saturating_add(inst.ci)
                            );
                        }
                    }
                    nv_index = nv_index.saturating_add(1);
                }
                Vendor::Amd => {
                    let node = sys.join(format!(
                        "class/kfd/kfd/topology/nodes/{}",
                        gi_node.saturating_add(1)
                    ));
                    w(&node.join("gpu_id"), &format!("{}\n", g.kfd_gpu_id))?;
                    let pci = g.pci.as_str();
                    let bus = u32::from_str_radix(pci.get(5..7).unwrap_or("0"), 16).unwrap_or(0);
                    w(
                        &node.join("properties"),
                        &format!(
                            "cpu_cores_count 0\nsimd_count 416\nlocation_id {}\ndomain 0\n",
                            bus << 8
                        ),
                    )?;
                }
                Vendor::Intel => {}
            }
        }
        w(&sys.join("class/kfd/kfd/topology/nodes/0/gpu_id"), "0\n")?;
        fs::create_dir_all(sys.join("class/kfd/kfd/proc"))?;
        w(&proc_.join("driver/nvidia-caps/mig-minors"), &mig_minors)?;
        w(&dev.join("nvidiactl"), "")?;
        w(&dev.join("nvidia-uvm"), "")?;
        for p in &s.procs {
            let Some(g) = s.gpus.iter().find(|g| g.pci == p.pci) else {
                continue;
            };
            match g.vendor {
                Vendor::Amd => {
                    w(
                        &proc_.join(format!("{}/fdinfo/5", p.pid)),
                        &format!(
                            "pos:\t0\nflags:\t02100002\ndrm-driver:\tamdgpu\ndrm-pdev:\t{}\ndrm-client-id:\t{}\n",
                            g.pci.as_str(),
                            p.pid
                        ),
                    )?;
                    w(
                        &sys.join(format!(
                            "class/kfd/kfd/proc/{}/vram_{}",
                            p.pid, g.kfd_gpu_id
                        )),
                        &format!("{}\n", p.used_mib.saturating_mul(1024 * 1024)),
                    )?;
                }
                Vendor::Intel => {
                    w(
                        &proc_.join(format!("{}/fdinfo/7", p.pid)),
                        &format!(
                            "drm-driver:\t{}\ndrm-pdev:\t{}\ndrm-client-id:\t{}\n",
                            g.host_driver,
                            g.pci.as_str(),
                            p.pid
                        ),
                    )?;
                }
                Vendor::Nvidia => {
                    w(&proc_.join(format!("{}/status", p.pid)), "Name:\tpython3\n")?;
                }
            }
        }
        Ok(())
    }

    pub fn tools(&self) -> Arc<SimTools> {
        Arc::new(SimTools { host: self.clone() })
    }

    pub fn runtime(&self) -> Arc<SimRuntime> {
        Arc::new(SimRuntime { host: self.clone() })
    }

    pub fn sysfs_writer(&self) -> Arc<SimSysfs> {
        Arc::new(SimSysfs { host: self.clone() })
    }

    pub fn scrubber(&self) -> Arc<SimScrub> {
        Arc::new(SimScrub { host: self.clone() })
    }

    pub fn packages(&self, catalog_packages: &[DriverPackage]) -> SimPackages {
        SimPackages {
            host: self.clone(),
            repo: catalog_packages
                .iter()
                .map(|p| {
                    (
                        format!("{}_{}_{}.deb", p.name, p.version, p.arch),
                        sim_deb(p),
                    )
                })
                .collect(),
        }
    }
}

/// The bytes a simulated `.deb` holds; its digest is what a catalog pins.
pub fn sim_deb(p: &DriverPackage) -> Vec<u8> {
    format!("simulated package {} {} {}", p.name, p.version, p.arch).into_bytes()
}

// ── vendor tool output ──

fn nvidia_gpus(s: &SimState) -> Vec<&SimGpu> {
    s.gpus
        .iter()
        .filter(|g| g.present && g.vendor == Vendor::Nvidia)
        .collect()
}

fn mig_state(g: &SimGpu) -> &'static str {
    match &g.mig {
        None => "N/A",
        Some(m) if m.enabled => "Enabled",
        Some(_) => "Disabled",
    }
}

fn nvidia_xml(s: &SimState) -> String {
    let gpus = nvidia_gpus(s);
    let mut x = String::from(
        "<?xml version=\"1.0\" ?>\n<!DOCTYPE nvidia_smi_log SYSTEM \"nvsmi_device_v12.dtd\">\n<nvidia_smi_log>\n",
    );
    let _ = writeln!(x, "\t<driver_version>{}</driver_version>", s.drivers.nvidia);
    let _ = writeln!(x, "\t<cuda_version>{}</cuda_version>", s.drivers.cuda);
    let _ = writeln!(x, "\t<attached_gpus>{}</attached_gpus>", gpus.len());
    for (i, g) in gpus.iter().enumerate() {
        let bus = format!("0000{}", g.pci.as_str()).to_ascii_uppercase();
        let _ = writeln!(x, "\t<gpu id=\"{bus}\">");
        let _ = writeln!(x, "\t\t<product_name>{}</product_name>", g.model);
        let disp = if g.display_active {
            "Enabled"
        } else {
            "Disabled"
        };
        let _ = writeln!(
            x,
            "\t\t<display_mode>{disp}</display_mode>\n\t\t<display_active>{disp}</display_active>"
        );
        let m = mig_state(g);
        let _ = writeln!(
            x,
            "\t\t<mig_mode>\n\t\t\t<current_mig>{m}</current_mig>\n\t\t\t<pending_mig>{m}</pending_mig>\n\t\t</mig_mode>"
        );
        match g.mig.as_ref().filter(|m| m.enabled) {
            Some(mig) if !mig.instances.is_empty() => {
                x.push_str("\t\t<mig_devices>\n");
                for (k, inst) in mig.instances.iter().enumerate() {
                    let _ = writeln!(
                        x,
                        "\t\t\t<mig_device>\n\t\t\t\t<index>{k}</index>\n\t\t\t\t<gpu_instance_id>{}</gpu_instance_id>\n\t\t\t\t<compute_instance_id>{}</compute_instance_id>\n\t\t\t\t<fb_memory_usage>\n\t\t\t\t\t<total>{} MiB</total>\n\t\t\t\t</fb_memory_usage>\n\t\t\t</mig_device>",
                        inst.gi, inst.ci, inst.memory_mib
                    );
                }
                x.push_str("\t\t</mig_devices>\n");
            }
            _ => x.push_str("\t\t<mig_devices>\n\t\t\tNone\n\t\t</mig_devices>\n"),
        }
        let _ = writeln!(
            x,
            "\t\t<uuid>GPU-{}</uuid>\n\t\t<minor_number>{i}</minor_number>",
            g.uuid
        );
        let _ = writeln!(
            x,
            "\t\t<pci>\n\t\t\t<pci_device_id>{:04X}10DE</pci_device_id>\n\t\t\t<pci_bus_id>{bus}</pci_bus_id>\n\t\t</pci>",
            g.pci_device_id
        );
        let used: u64 = s
            .procs
            .iter()
            .filter(|p| p.pci == g.pci)
            .map(|p| p.used_mib)
            .sum();
        let _ = writeln!(
            x,
            "\t\t<fb_memory_usage>\n\t\t\t<total>{} MiB</total>\n\t\t\t<used>{used} MiB</used>\n\t\t</fb_memory_usage>",
            g.memory_mib
        );
        x.push_str("\t\t<processes>\n");
        for p in s.procs.iter().filter(|p| p.pci == g.pci) {
            let (gi, ci) = match p.partition {
                Some((a, b)) => (a.to_string(), b.to_string()),
                None => ("N/A".into(), "N/A".into()),
            };
            let _ = writeln!(
                x,
                "\t\t\t<process_info>\n\t\t\t\t<gpu_instance_id>{gi}</gpu_instance_id>\n\t\t\t\t<compute_instance_id>{ci}</compute_instance_id>\n\t\t\t\t<pid>{}</pid>\n\t\t\t\t<type>C</type>\n\t\t\t\t<process_name>python3</process_name>\n\t\t\t\t<used_memory>{} MiB</used_memory>\n\t\t\t</process_info>",
                p.pid, p.used_mib
            );
        }
        x.push_str("\t\t</processes>\n\t</gpu>\n");
    }
    x.push_str("</nvidia_smi_log>\n");
    x
}

fn link_code(a: &SimGpu, b: &SimGpu, fabric: &str, other: &str) -> String {
    if a.fabric.is_some() && a.fabric == b.fabric {
        return fabric.into();
    }
    if a.numa != b.numa {
        return "SYS".into();
    }
    other.into()
}

fn nvidia_topo(s: &SimState) -> String {
    let gpus = nvidia_gpus(s);
    let mut t = String::new();
    for i in 0..gpus.len() {
        let _ = write!(t, "\tGPU{i}");
    }
    t.push_str("\tCPU Affinity\tNUMA Affinity\n");
    for (i, a) in gpus.iter().enumerate() {
        let _ = write!(t, "GPU{i}");
        for (j, b) in gpus.iter().enumerate() {
            if i == j {
                t.push_str("\t X ");
            } else {
                let _ = write!(t, "\t{}", link_code(a, b, "NV18", "PHB"));
            }
        }
        let _ = writeln!(t, "\t0-31\t{}", a.numa);
    }
    t
}

fn compute_apps(s: &SimState) -> String {
    let mut out = String::new();
    for p in &s.procs {
        if nvidia_gpus(s).iter().any(|g| g.pci == p.pci) {
            let _ = writeln!(
                out,
                "{}, 0000{}, {}",
                p.pid,
                p.pci.as_str().to_ascii_uppercase(),
                p.used_mib
            );
        }
    }
    out
}

fn pmon(s: &SimState) -> String {
    let mut out = String::from(
        "# gpu         pid   type     sm    mem    enc    dec    command\n# Idx           #    C/G      %      %      %      %    name\n",
    );
    for (i, g) in nvidia_gpus(s).iter().enumerate() {
        let procs: Vec<&SimProc> = s.procs.iter().filter(|p| p.pci == g.pci).collect();
        if procs.is_empty() {
            let _ = writeln!(
                out,
                "    {i}          -      -      -      -      -      -    -"
            );
        }
        for p in procs {
            let _ = writeln!(
                out,
                "    {i}      {}      C     {}      5      -      -    python3",
                p.pid, p.sm_percent
            );
        }
    }
    out
}

fn lgip(g: &SimGpu) -> String {
    let mut out = String::from(
        "+-----------------------------------------------------------------------------+\n| GPU instance profiles:                                                      |\n| GPU   Name             ID    Instances   Memory     P2P    SM    DEC   ENC  |\n|                              Free/Total   GiB              CE    JPEG  OFA  |\n|=============================================================================|\n",
    );
    let used = |id: u32| {
        g.mig.as_ref().map_or(0, |m| {
            m.instances.iter().filter(|i| i.profile_id == id).count()
        })
    };
    for (id, name, total, mem) in A100_PROFILES {
        let free = (*total as usize).saturating_sub(used(*id));
        let _ = writeln!(
            out,
            "|   0  MIG {name:<13} {id:>3}     {free}/{total}        {:.2}      No     14     0     0   |\n|                                                             1     0     0   |\n+-----------------------------------------------------------------------------+",
            *mem as f64 / 1024.0
        );
    }
    out
}

fn cdi_spec(s: &SimState) -> String {
    let mut devices = Vec::new();
    let mut all_nodes = Vec::new();
    for (i, g) in nvidia_gpus(s).iter().enumerate() {
        let render = format!("/dev/dri/renderD{}", g.render_minor);
        let card = format!("/dev/dri/card{}", i.saturating_add(1));
        let link = |n: &str, kind: &str| {
            serde_json::json!({
                "hookName": "createContainer",
                "path": "/usr/bin/nvidia-cdi-hook",
                "args": ["nvidia-cdi-hook", "create-symlinks", "--link",
                    format!("../{n}::/dev/dri/by-path/pci-{}-{kind}", g.pci.as_str())],
            })
        };
        let base_nodes = vec![
            serde_json::json!({"path": format!("/dev/nvidia{i}")}),
            serde_json::json!({"path": card.clone()}),
            serde_json::json!({"path": render.clone()}),
        ];
        all_nodes.extend(base_nodes.clone());
        devices.push(serde_json::json!({
            "name": i.to_string(),
            "containerEdits": {
                "deviceNodes": base_nodes,
                "hooks": [link(card.trim_start_matches("/dev/dri/"), "card"), link(render.trim_start_matches("/dev/dri/"), "render")],
            }
        }));
        if let Some(m) = g.mig.as_ref().filter(|m| m.enabled) {
            for (k, inst) in m.instances.iter().enumerate() {
                let gm = 100usize
                    .saturating_add(i.saturating_mul(50))
                    .saturating_add(usize::try_from(inst.gi).unwrap_or(0).saturating_mul(5));
                devices.push(serde_json::json!({
                    "name": format!("{i}:{k}"),
                    "containerEdits": {
                        "deviceNodes": [
                            {"path": format!("/dev/nvidia{i}")},
                            {"path": format!("/dev/nvidia-caps/nvidia-cap{gm}")},
                            {"path": format!("/dev/nvidia-caps/nvidia-cap{}", gm.saturating_add(1).saturating_add(usize::try_from(inst.ci).unwrap_or(0)))},
                        ]
                    }
                }));
            }
        }
    }
    devices.push(serde_json::json!({"name": "all", "containerEdits": {"deviceNodes": all_nodes}}));
    let lib = if cfg!(target_arch = "aarch64") {
        "/usr/lib/aarch64-linux-gnu"
    } else {
        "/usr/lib/x86_64-linux-gnu"
    };
    serde_json::json!({
        "cdiVersion": "0.5.0",
        "kind": "nvidia.com/gpu",
        "devices": devices,
        "containerEdits": {
            "env": ["NVIDIA_VISIBLE_DEVICES=void"],
            "deviceNodes": [
                {"path": "/dev/nvidiactl"}, {"path": "/dev/nvidia-uvm"},
                {"path": "/dev/nvidia-uvm-tools"}, {"path": "/dev/nvidia-modeset"}
            ],
            "hooks": [{"hookName": "createContainer", "path": "/usr/bin/nvidia-cdi-hook",
                "args": ["nvidia-cdi-hook", "update-ldcache", "--folder", lib]}],
            "mounts": [
                {"hostPath": format!("{lib}/libcuda.so.{}", s.drivers.nvidia),
                 "containerPath": format!("{lib}/libcuda.so.{}", s.drivers.nvidia),
                 "options": ["ro", "nosuid", "nodev", "bind"]},
                {"hostPath": "/usr/bin/nvidia-smi", "containerPath": "/usr/bin/nvidia-smi",
                 "options": ["ro", "nosuid", "nodev", "bind"]}
            ]
        }
    })
    .to_string()
}

fn amd_gpus(s: &SimState) -> Vec<&SimGpu> {
    s.gpus
        .iter()
        .filter(|g| g.present && g.vendor == Vendor::Amd)
        .collect()
}

fn rocm_smi(s: &SimState) -> String {
    let mut top = serde_json::Map::new();
    for (i, g) in amd_gpus(s).iter().enumerate() {
        top.insert(
            format!("card{i}"),
            serde_json::json!({
                "Card Series": g.model,
                "Card Model": format!("0x{:04x}", g.pci_device_id),
                "PCI Bus": g.pci.as_str(),
                "Unique ID": format!("0x{}", g.uuid.bytes().fold(0u64, |a, b| a.wrapping_mul(31).wrapping_add(u64::from(b))) ),
                "VRAM Total Memory (B)": g.memory_mib.saturating_mul(1024 * 1024).to_string(),
            }),
        );
    }
    top.insert(
        "system".into(),
        serde_json::json!({"Driver version": s.drivers.amd}),
    );
    serde_json::Value::Object(top).to_string()
}

fn rocm_topo(s: &SimState) -> String {
    let gpus = amd_gpus(s);
    let mut sys = serde_json::Map::new();
    for (i, a) in gpus.iter().enumerate() {
        for (j, b) in gpus.iter().enumerate().skip(i.saturating_add(1)) {
            sys.insert(
                format!("(Topology) Link type between DRM devices {i} and {j}"),
                serde_json::Value::String(link_code(a, b, "XGMI", "PCIE").replace("SYS", "PCIE")),
            );
        }
    }
    serde_json::json!({ "system": sys }).to_string()
}

fn amd_list(s: &SimState) -> String {
    serde_json::Value::Array(
        amd_gpus(s)
            .iter()
            .enumerate()
            .map(|(i, g)| serde_json::json!({"gpu": i, "bdf": g.pci.as_str(), "uuid": g.uuid, "kfd_id": g.kfd_gpu_id, "node_id": i.saturating_add(1), "partition_id": 0}))
            .collect(),
    )
    .to_string()
}

fn amd_static(s: &SimState) -> String {
    serde_json::Value::Array(
        amd_gpus(s)
            .iter()
            .enumerate()
            .map(|(i, g)| {
                serde_json::json!({
                    "gpu": i,
                    "asic": {"market_name": g.model, "vendor_id": "0x1002", "device_id": format!("0x{:04x}", g.pci_device_id)},
                    "bus": {"bdf": g.pci.as_str()},
                    "vram": {"type": "HBM", "size": {"value": g.memory_mib, "unit": "MB"}},
                    "driver": {"name": "amdgpu", "version": s.drivers.amd},
                })
            })
            .collect(),
    )
    .to_string()
}

fn amd_process(s: &SimState) -> String {
    serde_json::Value::Array(
        amd_gpus(s)
            .iter()
            .enumerate()
            .map(|(i, g)| {
                let list: Vec<serde_json::Value> = s
                    .procs
                    .iter()
                    .filter(|p| p.pci == g.pci)
                    .map(|p| serde_json::json!({"process_info": {"name": "python3", "pid": p.pid, "mem_usage": {"value": p.used_mib, "unit": "MiB"}}}))
                    .collect();
                if list.is_empty() {
                    serde_json::json!({"gpu": i, "process_list": [{"process_info": "No running processes detected"}]})
                } else {
                    serde_json::json!({"gpu": i, "process_list": list})
                }
            })
            .collect(),
    )
    .to_string()
}

fn intel_gpus(s: &SimState) -> Vec<&SimGpu> {
    s.gpus
        .iter()
        .filter(|g| g.present && g.vendor == Vendor::Intel)
        .collect()
}

fn xpu_discovery(s: &SimState) -> String {
    serde_json::json!({
        "device_list": intel_gpus(s).iter().enumerate().map(|(i, g)| serde_json::json!({
            "device_function_type": "physical",
            "device_id": i,
            "device_name": g.model,
            "device_type": "GPU",
            "drm_device": format!("/dev/dri/card{}", i.saturating_add(1)),
            "pci_bdf_address": g.pci.as_str(),
            "pci_device_id": format!("0x{:04x}", g.pci_device_id),
            "uuid": g.uuid,
            "vendor_name": "Intel(R) Corporation",
        })).collect::<Vec<_>>()
    })
    .to_string()
}

fn xpu_detail(s: &SimState, id: u32) -> Option<String> {
    let g = intel_gpus(s).into_iter().nth(usize::try_from(id).ok()?)?;
    Some(
        serde_json::json!({
            "device_id": id,
            "device_name": g.model,
            "driver_version": s.drivers.intel,
            "kernel_version": s.drivers.kernel,
            "memory_physical_size_byte": g.memory_mib.saturating_mul(1024 * 1024).to_string(),
            "pci_bdf_address": g.pci.as_str(),
            "uuid": g.uuid,
        })
        .to_string(),
    )
}

fn xpu_topology(s: &SimState) -> String {
    let gpus = intel_gpus(s);
    let mut t = String::from("                ");
    for i in 0..gpus.len() {
        let _ = write!(t, "GPU {i}/0        ");
    }
    t.push_str("CPU Affinity\n");
    for (i, a) in gpus.iter().enumerate() {
        let _ = write!(t, "GPU {i}/0         ");
        for (j, b) in gpus.iter().enumerate() {
            let c = if i == j {
                "S".to_owned()
            } else {
                link_code(a, b, "XL24", "NODE")
            };
            let _ = write!(t, "{c:<15}");
        }
        t.push_str("0-23\n");
    }
    t
}

fn xpu_ps(s: &SimState, id: u32) -> Option<String> {
    let g = intel_gpus(s).into_iter().nth(usize::try_from(id).ok()?)?;
    Some(
        serde_json::json!({
            "device_util_by_proc_list": s.procs.iter().filter(|p| p.pci == g.pci).map(|p| serde_json::json!({
                "device_id": id, "mem_size": p.used_mib.saturating_mul(1024), "process_id": p.pid, "process_name": "python3", "shared_mem_size": 0
            })).collect::<Vec<_>>()
        })
        .to_string(),
    )
}

/// The vendor tools, answered from the simulated state. MIG and reset
/// actions change the state, as the real tools change the device.
#[derive(Debug)]
pub struct SimTools {
    host: SimHost,
}

impl SimTools {
    fn nvidia_by_index(s: &mut SimState, index: u32) -> Option<&mut SimGpu> {
        s.gpus
            .iter_mut()
            .filter(|g| g.present && g.vendor == Vendor::Nvidia)
            .nth(usize::try_from(index).ok()?)
    }

    fn action(&self, tool: &Tool) -> Result<String, ProviderError> {
        let mut s = self.host.lock();
        let busy = |s: &SimState, pci: &PciAddress| s.procs.iter().any(|p| p.pci == *pci);
        match tool {
            Tool::NvidiaSmiMigMode { index, enabled } => {
                let pci = Self::nvidia_by_index(&mut s, *index)
                    .map(|g| g.pci.clone())
                    .ok_or_else(|| err(tool))?;
                if busy(&s, &pci) {
                    return Err(err(tool));
                }
                let g = Self::nvidia_by_index(&mut s, *index).ok_or_else(|| err(tool))?;
                let m = g.mig.as_mut().ok_or_else(|| err(tool))?;
                m.enabled = *enabled;
                if !enabled {
                    m.instances.clear();
                }
            }
            Tool::NvidiaSmiMigDestroyCompute(index) | Tool::NvidiaSmiMigDestroyGpu(index) => {
                let pci = Self::nvidia_by_index(&mut s, *index)
                    .map(|g| g.pci.clone())
                    .ok_or_else(|| err(tool))?;
                if busy(&s, &pci) {
                    return Err(err(tool));
                }
                let g = Self::nvidia_by_index(&mut s, *index).ok_or_else(|| err(tool))?;
                if let Some(m) = g.mig.as_mut() {
                    m.instances.clear();
                }
            }
            Tool::NvidiaSmiMigCreate { index, profiles } => {
                let g = Self::nvidia_by_index(&mut s, *index).ok_or_else(|| err(tool))?;
                let mem = g.memory_mib;
                let m = g
                    .mig
                    .as_mut()
                    .filter(|m| m.enabled)
                    .ok_or_else(|| err(tool))?;
                let mut used: u64 = m.instances.iter().map(|i| i.memory_mib).sum();
                for p in profiles {
                    let prof = A100_PROFILES
                        .iter()
                        .find(|x| x.0 == *p)
                        .ok_or_else(|| err(tool))?;
                    used = used.saturating_add(prof.3);
                    if used > mem {
                        return Err(err(tool));
                    }
                    let gi = m
                        .instances
                        .iter()
                        .map(|i| i.gi)
                        .max()
                        .unwrap_or(0)
                        .saturating_add(1);
                    m.instances.push(SimMigInstance {
                        gi,
                        ci: 0,
                        profile_id: *p,
                        memory_mib: prof.3,
                    });
                }
            }
            Tool::NvidiaSmiReset(pci) => {
                if busy(&s, pci) {
                    return Err(err(tool));
                }
                s.resets = s.resets.saturating_add(1);
            }
            _ => return Err(err(tool)),
        }
        drop(s);
        self.host.sync().map_err(|_| err(tool))?;
        Ok(String::new())
    }
}

impl ToolRunner for SimTools {
    fn output(&self, tool: &Tool) -> Result<String, ProviderError> {
        {
            let s = self.host.lock();
            if s.failing.contains(&tool.program()) {
                return Err(err(tool));
            }
            let has = |v: Vendor| s.gpus.iter().any(|g| g.vendor == v);
            let missing = match tool.program() {
                ToolProgram::NvidiaSmi | ToolProgram::NvidiaCtk => !has(Vendor::Nvidia),
                ToolProgram::RocmSmi | ToolProgram::AmdSmi => !has(Vendor::Amd),
                ToolProgram::XpuSmi => !has(Vendor::Intel),
            };
            if missing {
                return Err(ProviderError::ToolUnavailable(format!("{tool:?}")));
            }
            let out = match tool {
                Tool::NvidiaSmiQueryXml => Some(nvidia_xml(&s)),
                Tool::NvidiaSmiTopo => Some(nvidia_topo(&s)),
                Tool::NvidiaSmiComputeApps => Some(compute_apps(&s)),
                Tool::NvidiaSmiPmon => Some(pmon(&s)),
                Tool::NvidiaSmiMigProfiles(i) => nvidia_gpus(&s)
                    .get(usize::try_from(*i).unwrap_or(usize::MAX))
                    .filter(|g| g.mig.is_some())
                    .map(|g| lgip(g)),
                Tool::NvidiaCtkCdiGenerate => Some(cdi_spec(&s)),
                Tool::RocmSmiJson => Some(rocm_smi(&s)),
                Tool::RocmSmiTopo => Some(rocm_topo(&s)),
                Tool::AmdSmiList => Some(amd_list(&s)),
                Tool::AmdSmiStatic => Some(amd_static(&s)),
                Tool::AmdSmiProcess => Some(amd_process(&s)),
                Tool::XpuSmiDiscovery => Some(xpu_discovery(&s)),
                Tool::XpuSmiDevice(i) => xpu_detail(&s, *i),
                Tool::XpuSmiTopology => Some(xpu_topology(&s)),
                Tool::XpuSmiPs(i) => xpu_ps(&s, *i),
                _ => None,
            };
            if let Some(o) = out {
                return Ok(o);
            }
            if !matches!(
                tool,
                Tool::NvidiaSmiMigMode { .. }
                    | Tool::NvidiaSmiMigCreate { .. }
                    | Tool::NvidiaSmiMigDestroyCompute(_)
                    | Tool::NvidiaSmiMigDestroyGpu(_)
                    | Tool::NvidiaSmiReset(_)
            ) {
                return Err(err(tool));
            }
        }
        self.action(tool)
    }
}

/// The runtime, the job executor and the pid owner of the simulated host.
#[derive(Debug)]
pub struct SimRuntime {
    host: SimHost,
}

impl SimRuntime {
    /// Configure how a job behaves: polls before it exits, its disk use,
    /// and whether its output verifies.
    pub fn script_job(&self, id: &AllocationId, polls: u32, disk_mib: u64, broken_output: bool) {
        self.host.lock().jobs.insert(
            id.clone(),
            SimJob {
                polls: 0,
                needed: polls,
                disk_mib,
                output_ok: broken_output.then(|| Err("garbage".into())),
            },
        );
    }

    pub fn host(&self) -> &SimHost {
        &self.host
    }
}

impl WorkloadRuntime for SimRuntime {
    fn presence(&self, allocation: &AllocationId) -> Presence {
        let s = self.host.lock();
        if s.unknown_runtime {
            return Presence::Unknown;
        }
        match s.workloads.get(allocation) {
            Some(true) => Presence::Present,
            _ => Presence::Absent,
        }
    }

    fn stop(&self, allocation: &AllocationId) -> Result<(), String> {
        {
            let mut s = self.host.lock();
            if s.workloads.get(allocation) == Some(&true) {
                s.workloads.insert(allocation.clone(), false);
                s.procs.retain(|p| p.owner.as_ref() != Some(allocation));
            }
        }
        self.host.sync().map_err(|e| e.to_string())
    }
}

fn sim_output(kind: &JobKind) -> Result<String, String> {
    match kind {
        JobKind::Render(r) => {
            let out = encode_ppm(r.width, r.height, &reference_scene(r.width, r.height));
            crate::media::verify_render(r, &out)
                .map(|v| format!("render verified (mean error {:.2})", v.mean_abs_error))
                .map_err(|e| e.to_string())
        }
        JobKind::Transcode(t) => {
            let decoded: Vec<u8> = reference_clip(t.width, t.height, t.frames)
                .iter()
                .enumerate()
                .map(|(i, b)| if i % 97 == 0 { b.saturating_add(3) } else { *b })
                .collect();
            crate::media::verify_transcode(t, &decoded)
                .map(|p| format!("transcode verified ({p:.1} dB)"))
                .map_err(|e| e.to_string())
        }
        JobKind::Train { steps, .. } => Ok(format!("trained {steps} steps")),
        JobKind::Inference => Ok("inference finished".into()),
    }
}

impl JobExecutor for SimRuntime {
    fn start(&self, job: &JobSpec, plan: &AttachPlan) -> Result<(), String> {
        let targets = {
            let s = self.host.lock();
            let mut out = Vec::new();
            let nv: Vec<&SimGpu> = nvidia_gpus(&s);
            for c in &plan.cdi_devices {
                let Some((_, name)) = c.split_once('=') else {
                    continue;
                };
                let (dev, part) = name
                    .split_once(':')
                    .map_or((name, None), |(d, k)| (d, Some(k)));
                let Some(g) = dev.parse::<usize>().ok().and_then(|i| nv.get(i)) else {
                    continue;
                };
                let p = part.and_then(|k| {
                    let k: usize = k.parse().ok()?;
                    let inst = g.mig.as_ref()?.instances.get(k)?;
                    Some(PartitionId {
                        gpu_instance: inst.gi,
                        compute_instance: inst.ci,
                    })
                });
                out.push((g.pci.clone(), p));
            }
            for f in &plan.vfio_functions {
                if s.gpus.iter().any(|g| g.pci == *f) {
                    out.push((f.clone(), None));
                }
            }
            out
        };
        if targets.is_empty() {
            return Err("the plan names no simulated device".into());
        }
        self.host
            .launch(&job.id, &targets, 1024, 60)
            .map_err(|e| e.to_string())?;
        let mut s = self.host.lock();
        let j = s.jobs.entry(job.id.clone()).or_insert_with(|| SimJob {
            needed: 2,
            ..SimJob::default()
        });
        if j.output_ok.is_none() {
            j.output_ok = Some(sim_output(&job.kind));
        }
        Ok(())
    }

    fn poll(&self, id: &AllocationId) -> ExecStatus {
        let done = {
            let mut s = self.host.lock();
            let Some(j) = s.jobs.get_mut(id) else {
                return ExecStatus::Unknown;
            };
            j.polls = j.polls.saturating_add(1);
            if j.polls < j.needed {
                return ExecStatus::Running {
                    disk_used_mib: j.disk_mib,
                };
            }
            j.output_ok
                .clone()
                .unwrap_or_else(|| Err("no output".into()))
        };
        let _ = self.stop(id);
        match done {
            Ok(detail) => ExecStatus::Exited { ok: true, detail },
            Err(detail) => ExecStatus::Exited {
                ok: false,
                detail: format!("output did not verify: {detail}"),
            },
        }
    }
}

impl PidOwner for SimRuntime {
    fn allocation_of(&self, pid: u32) -> Option<AllocationId> {
        self.host
            .lock()
            .procs
            .iter()
            .find(|p| p.pid == pid)
            .and_then(|p| p.owner.clone())
    }
}

/// sysfs writes, interpreted the way the kernel does for the files VFIO
/// binding touches.
#[derive(Debug)]
pub struct SimSysfs {
    host: SimHost,
}

impl SysfsWrite for SimSysfs {
    fn write(&self, path: &Path, value: &str) -> io::Result<()> {
        let rel = path
            .strip_prefix(self.host.sys_root())
            .map_err(|_| io::Error::new(io::ErrorKind::PermissionDenied, "outside sysfs"))?;
        let parts: Vec<&str> = rel.iter().filter_map(|c| c.to_str()).collect();
        {
            let mut s = self.host.lock();
            match parts.as_slice() {
                ["bus", "pci", "devices", f, "driver_override"] => {
                    let v = value.trim();
                    if v.is_empty() {
                        s.overrides.remove(*f);
                    } else {
                        s.overrides.insert((*f).to_owned(), v.to_owned());
                    }
                }
                ["bus", "pci", "devices", f, "driver", "unbind"] => {
                    if value.trim() != *f || s.bound.remove(*f).is_none() {
                        return Err(io::Error::new(io::ErrorKind::NotFound, "not bound"));
                    }
                }
                ["bus", "pci", "drivers_probe"] => {
                    let f = value.trim().to_owned();
                    let default = s.gpus.iter().find_map(|g| {
                        if g.pci.as_str() == f {
                            Some(g.host_driver.clone())
                        } else if g.extra_functions.iter().any(|x| x.as_str() == f) {
                            Some("snd_hda_intel".to_owned())
                        } else {
                            None
                        }
                    });
                    let drv = s.overrides.get(&f).cloned().or(default);
                    if let Some(d) = drv {
                        s.bound.insert(f, d);
                    }
                }
                ["bus", "pci", "devices", f, "reset"] => {
                    if s.procs.iter().any(|p| p.pci.as_str() == *f) {
                        return Err(io::Error::new(io::ErrorKind::ResourceBusy, "busy"));
                    }
                    s.resets = s.resets.saturating_add(1);
                }
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "not a VFIO file",
                    ));
                }
            }
        }
        self.host.sync()
    }
}

/// The scrub image and the reset, against the simulated memory model.
#[derive(Debug)]
pub struct SimScrub {
    host: SimHost,
}

impl ScrubRunner for SimScrub {
    fn reset(
        &self,
        device: &DeviceRecord,
        _p: Option<&PartitionId>,
        kind: ResetKind,
    ) -> Result<(), String> {
        let mut s = self.host.lock();
        if s.procs.iter().any(|p| p.pci == device.pci) && kind == ResetKind::Flr {
            return Err("the device is busy".into());
        }
        s.resets = s.resets.saturating_add(1);
        Ok(())
    }

    fn scrub(
        &self,
        device: &DeviceRecord,
        partition: Option<&PartitionId>,
    ) -> Result<ScrubReport, String> {
        let mut s = self.host.lock();
        let broken = s
            .gpus
            .iter()
            .find(|g| g.pci == device.pci)
            .ok_or("no such device")?
            .scrub_broken;
        let key = (
            device.pci.as_str().to_owned(),
            partition.map(|p| (p.gpu_instance, p.compute_instance)),
        );
        let before = s.residue.get(&key).copied().unwrap_or(0);
        let mib = match partition {
            Some(p) => device.partition(p).map_or(0, |x| x.memory_mib),
            None => device.memory_mib,
        };
        let total = mib.saturating_mul(1024 * 1024);
        if !broken {
            s.residue.remove(&key);
        }
        Ok(ScrubReport {
            schema: SCRUB_SCHEMA.into(),
            bytes_total: total,
            bytes_scrubbed: total.saturating_mul(97) / 100,
            pattern_verified: !broken,
            canaries_before: before,
            canaries_after: if broken { before.max(1) } else { 0 },
        })
    }
}

/// apt/dpkg, mokutil and reboot on the simulated host.
#[derive(Debug)]
pub struct SimPackages {
    host: SimHost,
    repo: BTreeMap<String, Vec<u8>>,
}

impl SimPackages {
    /// Serve different bytes for one package (a tampered mirror).
    pub fn tamper(&mut self, name: &str) {
        for (k, v) in &mut self.repo {
            if k.starts_with(name) {
                v.extend_from_slice(b" tampered");
            }
        }
    }
}

impl HostPackages for SimPackages {
    fn installed(&self, names: &[String]) -> Result<Vec<(String, String)>, String> {
        let s = self.host.lock();
        Ok(names
            .iter()
            .filter_map(|n| s.installed.get(n).map(|v| (n.clone(), v.clone())))
            .collect())
    }

    fn fetch(&self, pkg: &DriverPackage, dir: &Path) -> Result<PathBuf, String> {
        let file = format!("{}_{}_{}.deb", pkg.name, pkg.version, pkg.arch);
        let bytes = self
            .repo
            .get(&file)
            .ok_or("no such package in the mirror")?;
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let p = dir.join(&file);
        fs::write(&p, bytes).map_err(|e| e.to_string())?;
        Ok(p)
    }

    fn sha256(&self, path: &Path) -> Result<String, String> {
        Ok(crate::catalog::sha256_hex(
            &fs::read(path).map_err(|e| e.to_string())?,
        ))
    }

    fn install_files(&self, files: &[PathBuf]) -> Result<(), String> {
        let mut s = self.host.lock();
        if s.fail_install {
            return Err("dpkg: error processing package (simulated)".into());
        }
        let mut next = s.installed.clone();
        for f in files {
            let name = f.file_name().and_then(|n| n.to_str()).ok_or("bad file")?;
            let mut it = name.trim_end_matches(".deb").splitn(3, '_');
            let (Some(n), Some(v)) = (it.next(), it.next()) else {
                return Err("bad package file name".into());
            };
            next.insert(n.to_owned(), v.to_owned());
        }
        s.pending = Some(next);
        Ok(())
    }

    fn install_versions(&self, pkgs: &[(String, String)]) -> Result<(), String> {
        let mut s = self.host.lock();
        let mut next = s.installed.clone();
        for (n, v) in pkgs {
            next.insert(n.clone(), v.clone());
        }
        s.pending = Some(next);
        Ok(())
    }

    fn request_reboot(&self) -> Result<(), String> {
        let mut s = self.host.lock();
        s.reboots = s.reboots.saturating_add(1);
        Ok(())
    }

    fn module_signer(&self, _module: &str) -> Option<String> {
        self.host.lock().module_signer.clone()
    }
}

impl SimHost {
    /// `modinfo -F signer` of the vendor module.
    pub fn module_signer(&self) -> Option<String> {
        self.lock().module_signer.clone()
    }
}

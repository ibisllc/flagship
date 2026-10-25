//! Vendor-neutral process observers for AMD and Intel devices, from kernel
//! interfaces with documented formats:
//!
//! - DRM client usage in `/proc/<pid>/fdinfo/<fd>` (`drm-driver`,
//!   `drm-pdev`, `drm-client-id`; Linux `Documentation/gpu/drm-usage-stats.rst`),
//!   which `amdgpu`, `i915` and `xe` all publish;
//! - AMD KFD compute processes in `/sys/class/kfd/kfd/proc/<pid>/vram_<gpu_id>`,
//!   with `gpu_id` mapped to a PCI address through the KFD topology nodes'
//!   `gpu_id` and `properties` (`domain`, `location_id`).
//!
//! An interface that can't be read gives no answer, and no answer at all is
//! `Unknown`, which keeps a device held.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::device::PciAddress;
use crate::provider::DeviceActivity;

/// Most `/proc` entries and fds read in one observation.
const MAX_PIDS: usize = 32_768;
const MAX_FDS_PER_PID: usize = 4_096;
const MAX_FDINFO_BYTES: u64 = 16 * 1024;

#[derive(Clone, Debug)]
pub struct ObserverRoots {
    pub sys: PathBuf,
    pub proc: PathBuf,
}

impl ObserverRoots {
    pub fn system() -> Self {
        Self {
            sys: PathBuf::from("/sys"),
            proc: PathBuf::from("/proc"),
        }
    }
}

fn read_small(p: &Path) -> Option<String> {
    use std::io::Read;
    let f = fs::File::open(p).ok()?;
    let mut s = String::new();
    f.take(MAX_FDINFO_BYTES).read_to_string(&mut s).ok()?;
    Some(s)
}

/// One DRM fdinfo record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrmClient {
    pub driver: String,
    pub pdev: PciAddress,
    pub client_id: u64,
}

pub fn parse_fdinfo(text: &str) -> Option<DrmClient> {
    let mut driver = None;
    let mut pdev = None;
    let mut client = None;
    for line in text.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let v = v.trim();
        match k.trim() {
            "drm-driver" => driver = Some(v.to_owned()),
            "drm-pdev" => pdev = PciAddress::parse(v),
            "drm-client-id" => client = v.parse().ok(),
            _ => {}
        }
    }
    Some(DrmClient {
        driver: driver?,
        pdev: pdev?,
        client_id: client?,
    })
}

/// Processes holding a DRM client on `pci` through one of `drivers`, or
/// `None` when `/proc` can't be read.
pub fn drm_clients(proc_root: &Path, pci: &PciAddress, drivers: &[&str]) -> Option<BTreeSet<u32>> {
    let rd = fs::read_dir(proc_root).ok()?;
    let mut pids = BTreeSet::new();
    for entry in rd.filter_map(Result::ok).take(MAX_PIDS) {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(fds) = fs::read_dir(entry.path().join("fdinfo")) else {
            continue;
        };
        for fd in fds.filter_map(Result::ok).take(MAX_FDS_PER_PID) {
            let Some(c) = read_small(&fd.path()).as_deref().and_then(parse_fdinfo) else {
                continue;
            };
            if c.pdev == *pci && drivers.contains(&c.driver.as_str()) {
                pids.insert(pid);
                break;
            }
        }
    }
    Some(pids)
}

/// `location_id` in KFD topology: `bus << 8 | device << 3 | function`.
fn kfd_location(pci: &PciAddress) -> Option<(u32, u32)> {
    let s = pci.as_str();
    let (domain, rest) = s.split_once(':')?;
    let (bus, rest) = rest.split_once(':')?;
    let (dev, func) = rest.split_once('.')?;
    let d = u32::from_str_radix(domain, 16).ok()?;
    let b = u32::from_str_radix(bus, 16).ok()?;
    let v = u32::from_str_radix(dev, 16).ok()?;
    let f = u32::from_str_radix(func, 16).ok()?;
    Some((d, (b << 8) | (v << 3) | f))
}

/// The KFD `gpu_id` of the device at `pci`.
pub fn kfd_gpu_id(sys_root: &Path, pci: &PciAddress) -> Option<u64> {
    let (domain, location) = kfd_location(pci)?;
    let nodes = fs::read_dir(sys_root.join("class/kfd/kfd/topology/nodes")).ok()?;
    for n in nodes.filter_map(Result::ok) {
        let gpu_id: u64 = read_small(&n.path().join("gpu_id"))?.trim().parse().ok()?;
        if gpu_id == 0 {
            continue;
        }
        let props = read_small(&n.path().join("properties")).unwrap_or_default();
        let prop = |name: &str| {
            props.lines().find_map(|l| {
                let (k, v) = l.split_once(' ')?;
                (k == name).then(|| v.trim().parse::<u32>().ok()).flatten()
            })
        };
        if prop("location_id") == Some(location) && prop("domain").unwrap_or(0) == domain {
            return Some(gpu_id);
        }
    }
    None
}

/// Compute processes KFD reports on `gpu_id`, or `None` when KFD's process
/// directory can't be read.
pub fn kfd_processes(sys_root: &Path, gpu_id: u64) -> Option<BTreeSet<u32>> {
    let rd = fs::read_dir(sys_root.join("class/kfd/kfd/proc")).ok()?;
    let file = format!("vram_{gpu_id}");
    let mut pids = BTreeSet::new();
    for e in rd.filter_map(Result::ok).take(MAX_PIDS) {
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        if e.path().join(&file).exists() {
            pids.insert(pid);
        }
    }
    Some(pids)
}

/// The union of every readable interface; `Unknown` when none was.
pub fn observe_device(
    roots: &ObserverRoots,
    pci: &PciAddress,
    drm_drivers: &[&str],
    use_kfd: bool,
) -> DeviceActivity {
    let mut seen = false;
    let mut pids = BTreeSet::new();
    if let Some(p) = drm_clients(&roots.proc, pci, drm_drivers) {
        seen = true;
        pids.extend(p);
    }
    if use_kfd
        && let Some(id) = kfd_gpu_id(&roots.sys, pci)
        && let Some(p) = kfd_processes(&roots.sys, id)
    {
        seen = true;
        pids.extend(p);
    }
    if !seen {
        return DeviceActivity::Unknown;
    }
    match u32::try_from(pids.len()) {
        Ok(0) => DeviceActivity::Idle,
        Ok(processes) => DeviceActivity::Busy { processes },
        Err(_) => DeviceActivity::Busy {
            processes: u32::MAX,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fdinfo_needs_driver_pdev_and_client() {
        let t = "pos:\t0\nflags:\t02100002\ndrm-driver:\tamdgpu\ndrm-pdev:\t0000:03:00.0\ndrm-client-id:\t42\ndrm-memory-vram:\t1024 KiB\n";
        let c = parse_fdinfo(t);
        assert_eq!(c.as_ref().map(|c| c.client_id), Some(42));
        assert!(parse_fdinfo("drm-driver:\ti915\n").is_none());
    }

    #[test]
    fn kfd_location_encoding() {
        let p = PciAddress::parse("0000:03:00.0");
        assert_eq!(p.as_ref().and_then(kfd_location), Some((0, 0x300)));
        let p = PciAddress::parse("0001:c1:1f.7");
        assert_eq!(p.as_ref().and_then(kfd_location), Some((1, 0xc1ff)));
    }
}

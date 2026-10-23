//! PCI inventory from sysfs. The root is configurable so tests (and a
//! broker that bind-mounts a read-only `/sys`) read a tree they control.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::device::{PciAddress, Vendor};

/// PCI base class 0x03: display controllers (VGA 0x0300, 3D 0x0302, other 0x0380).
const CLASS_DISPLAY: u32 = 0x03;
/// PCI base class 0x12: processing accelerators (some data-center parts).
const CLASS_ACCELERATOR: u32 = 0x12;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PciDevice {
    pub address: PciAddress,
    pub vendor_id: u16,
    pub device_id: u16,
    pub class: u32,
    pub kernel_driver: Option<String>,
    pub iommu_group: Option<u32>,
    pub iommu_group_members: Vec<PciAddress>,
    pub numa_node: Option<i32>,
    pub boot_vga: bool,
}

impl PciDevice {
    pub fn vendor(&self) -> Option<Vendor> {
        Vendor::from_pci_id(self.vendor_id)
    }

    /// A GPU or accelerator from a vendor we have a backend for.
    pub fn is_accelerator(&self) -> bool {
        let base = self.class >> 16;
        (base == CLASS_DISPLAY || base == CLASS_ACCELERATOR) && self.vendor().is_some()
    }
}

#[derive(Clone, Debug)]
pub struct SysfsRoot(PathBuf);

impl SysfsRoot {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self(root.into())
    }

    pub fn system() -> Self {
        Self::new("/sys")
    }

    /// Every PCI function under `bus/pci/devices`. Entries whose name isn't a
    /// PCI address, or whose ids don't parse, are skipped, not guessed at.
    pub fn scan_pci(&self) -> io::Result<Vec<PciDevice>> {
        let dir = self.0.join("bus/pci/devices");
        let mut out = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(address) = name.to_str().and_then(PciAddress::parse) else {
                continue;
            };
            let path = entry.path();
            let (Some(vendor_id), Some(device_id), Some(class)) = (
                read_hex(&path.join("vendor")).and_then(|v| u16::try_from(v).ok()),
                read_hex(&path.join("device")).and_then(|v| u16::try_from(v).ok()),
                read_hex(&path.join("class")),
            ) else {
                continue;
            };
            let iommu_group = link_name(&path.join("iommu_group")).and_then(|n| n.parse().ok());
            let iommu_group_members = match iommu_group {
                Some(g) => self.group_members(g),
                None => Vec::new(),
            };
            out.push(PciDevice {
                address,
                vendor_id,
                device_id,
                class,
                kernel_driver: link_name(&path.join("driver")),
                iommu_group,
                iommu_group_members,
                numa_node: read_trimmed(&path.join("numa_node"))
                    .and_then(|s| s.parse::<i32>().ok())
                    .filter(|n| *n >= 0),
                boot_vga: read_trimmed(&path.join("boot_vga")).as_deref() == Some("1"),
            });
        }
        out.sort_by(|a, b| a.address.cmp(&b.address));
        Ok(out)
    }

    pub fn accelerators(&self) -> io::Result<Vec<PciDevice>> {
        Ok(self
            .scan_pci()?
            .into_iter()
            .filter(PciDevice::is_accelerator)
            .collect())
    }

    fn group_members(&self, group: u32) -> Vec<PciAddress> {
        let dir = self.0.join(format!("kernel/iommu_groups/{group}/devices"));
        let Ok(rd) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut m: Vec<PciAddress> = rd
            .filter_map(Result::ok)
            .filter_map(|e| e.file_name().to_str().and_then(PciAddress::parse))
            .collect();
        m.sort();
        m
    }
}

fn read_trimmed(p: &Path) -> Option<String> {
    fs::read_to_string(p).ok().map(|s| s.trim().to_owned())
}

fn read_hex(p: &Path) -> Option<u32> {
    let s = read_trimmed(p)?;
    u32::from_str_radix(s.strip_prefix("0x").unwrap_or(&s), 16).ok()
}

fn link_name(p: &Path) -> Option<String> {
    let target = fs::read_link(p).ok()?;
    target.file_name()?.to_str().map(str::to_owned)
}

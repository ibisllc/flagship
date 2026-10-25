//! Dedicated-VM device assignment (§9.5 "VM/device passthrough"): the
//! isolation checks a device must pass, and binding its IOMMU group to
//! `vfio-pci` and back through sysfs. AMD and Intel run only this way (gVisor
//! documents no mediation for their devices); NVIDIA may.
//!
//! Qualification refuses: an IOMMU that is off, a group in identity
//! (passthrough-DMA) mode, a group shared with another device, any function
//! without a function-level or power-management reset, and a device that
//! drives a display. A failure never falls back to handing a raw device node
//! to a container.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::device::{DeviceRecord, PciAddress};

/// Writes to sysfs. The broker uses [`RealSysfs`]; tests and the self-test
/// use the simulated host.
pub trait SysfsWrite: Send + Sync + std::fmt::Debug {
    fn write(&self, path: &Path, value: &str) -> io::Result<()>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct RealSysfs;

impl SysfsWrite for RealSysfs {
    fn write(&self, path: &Path, value: &str) -> io::Result<()> {
        fs::write(path, value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassthroughQualification {
    pub group: u32,
    pub functions: Vec<PciAddress>,
    /// Each function's reset methods as sysfs lists them.
    pub reset_methods: Vec<(PciAddress, String)>,
    /// `DMA` or `DMA-FQ`.
    pub dma_type: String,
}

/// What `bind` changed, so `release` can put it back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VfioBinding {
    pub group: u32,
    pub functions: Vec<(PciAddress, Option<String>)>,
}

impl VfioBinding {
    /// The device node a VM runtime opens for this group.
    pub fn device_node(&self) -> String {
        format!("/dev/vfio/{}", self.group)
    }

    /// The group as the CDI device gpud's VFIO spec names.
    pub fn cdi_name(&self) -> String {
        format!("{}={}", crate::attach::VFIO_CDI_KIND, self.group)
    }
}

/// The CDI spec for the groups gpud has bound (kind `flagship.vfio/group`):
/// each device is the group's `/dev/vfio/<n>` node and nothing else.
pub fn vfio_cdi_spec(groups: &[u32]) -> serde_json::Value {
    serde_json::json!({
        "cdiVersion": "0.6.0",
        "kind": crate::attach::VFIO_CDI_KIND,
        "devices": groups.iter().map(|g| serde_json::json!({
            "name": g.to_string(),
            "containerEdits": {"deviceNodes": [{"path": format!("/dev/vfio/{g}")}]},
        })).collect::<Vec<_>>(),
        "containerEdits": {},
    })
}

#[derive(Clone, Debug)]
pub struct VfioHost {
    sys: PathBuf,
    dev: PathBuf,
    writer: Arc<dyn SysfsWrite>,
}

fn read_trim(p: &Path) -> Option<String> {
    fs::read_to_string(p).ok().map(|s| s.trim().to_owned())
}

fn link_name(p: &Path) -> Option<String> {
    fs::read_link(p)
        .ok()?
        .file_name()?
        .to_str()
        .map(str::to_owned)
}

impl VfioHost {
    pub fn new(
        sys: impl Into<PathBuf>,
        dev: impl Into<PathBuf>,
        writer: Arc<dyn SysfsWrite>,
    ) -> Self {
        Self {
            sys: sys.into(),
            dev: dev.into(),
            writer,
        }
    }

    pub fn system() -> Self {
        Self::new("/sys", "/dev", Arc::new(RealSysfs))
    }

    fn function_dir(&self, f: &PciAddress) -> PathBuf {
        self.sys.join("bus/pci/devices").join(f.as_str())
    }

    pub fn iommu_enabled(&self) -> bool {
        fs::read_dir(self.sys.join("kernel/iommu_groups"))
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
    }

    /// Every reason the device can't be given to a VM, or what binding it takes.
    pub fn qualify(&self, d: &DeviceRecord) -> Result<PassthroughQualification, Vec<String>> {
        let mut why = Vec::new();
        if d.display_owned {
            why.push("drives a display".to_owned());
        }
        if !self.iommu_enabled() {
            why.push("the IOMMU is off or unsupported".to_owned());
            return Err(why);
        }
        let Some(group) = d.iommu_group else {
            why.push("no IOMMU group".to_owned());
            return Err(why);
        };
        let dma_type = read_trim(&self.sys.join(format!("kernel/iommu_groups/{group}/type")))
            .unwrap_or_default();
        if !matches!(dma_type.as_str(), "DMA" | "DMA-FQ") {
            why.push(format!(
                "IOMMU group is in {} mode, not DMA translation",
                if dma_type.is_empty() {
                    "unknown"
                } else {
                    &dma_type
                }
            ));
        }
        if d.iommu_group_members.is_empty() {
            why.push("IOMMU group lists no devices".to_owned());
        }
        if d.iommu_group_members
            .iter()
            .any(|m| m.slot() != d.pci.slot())
        {
            why.push("IOMMU group is shared with another device".to_owned());
        }
        let mut reset_methods = Vec::new();
        for f in &d.iommu_group_members {
            let methods = read_trim(&self.function_dir(f).join("reset_method")).unwrap_or_default();
            let ok = methods
                .split_whitespace()
                .any(|m| matches!(m, "flr" | "pm"));
            if !ok {
                why.push(format!(
                    "{} has no function-level reset ({})",
                    f.as_str(),
                    if methods.is_empty() { "none" } else { &methods }
                ));
            }
            if read_trim(&self.function_dir(f).join("boot_vga")).as_deref() == Some("1") {
                why.push(format!("{} drives a display", f.as_str()));
            }
            reset_methods.push((f.clone(), methods));
        }
        if !why.is_empty() {
            return Err(why);
        }
        Ok(PassthroughQualification {
            group,
            functions: d.iommu_group_members.clone(),
            reset_methods,
            dma_type,
        })
    }

    fn driver_of(&self, f: &PciAddress) -> Option<String> {
        link_name(&self.function_dir(f).join("driver"))
    }

    fn io(e: io::Error, what: &str) -> String {
        format!("{what}: {}", e.kind())
    }

    /// Hand every function of the group to `vfio-pci`, then check the
    /// group's device node exists.
    pub fn bind(&self, q: &PassthroughQualification) -> Result<VfioBinding, String> {
        let mut functions = Vec::new();
        for f in &q.functions {
            let prev = self.driver_of(f);
            let dir = self.function_dir(f);
            self.writer
                .write(&dir.join("driver_override"), "vfio-pci")
                .map_err(|e| Self::io(e, "driver_override"))?;
            if prev.as_deref().is_some_and(|p| p != "vfio-pci") {
                self.writer
                    .write(&dir.join("driver/unbind"), f.as_str())
                    .map_err(|e| Self::io(e, "unbind"))?;
            }
            if prev.as_deref() != Some("vfio-pci") {
                self.writer
                    .write(&self.sys.join("bus/pci/drivers_probe"), f.as_str())
                    .map_err(|e| Self::io(e, "drivers_probe"))?;
            }
            if self.driver_of(f).as_deref() != Some("vfio-pci") {
                return Err(format!("{} did not bind to vfio-pci", f.as_str()));
            }
            functions.push((f.clone(), prev.filter(|p| p != "vfio-pci")));
        }
        let b = VfioBinding {
            group: q.group,
            functions,
        };
        if !self.dev.join(format!("vfio/{}", q.group)).exists() {
            return Err(format!("{} did not appear", b.device_node()));
        }
        Ok(b)
    }

    /// Reset every function and give it back to its host driver.
    pub fn release(&self, b: &VfioBinding) -> Result<(), String> {
        for (f, prev) in &b.functions {
            let dir = self.function_dir(f);
            if dir.join("reset").exists() {
                self.writer
                    .write(&dir.join("reset"), "1")
                    .map_err(|e| Self::io(e, "reset"))?;
            }
            if self.driver_of(f).is_some() {
                self.writer
                    .write(&dir.join("driver/unbind"), f.as_str())
                    .map_err(|e| Self::io(e, "unbind"))?;
            }
            self.writer
                .write(&dir.join("driver_override"), "\n")
                .map_err(|e| Self::io(e, "driver_override"))?;
            self.writer
                .write(&self.sys.join("bus/pci/drivers_probe"), f.as_str())
                .map_err(|e| Self::io(e, "drivers_probe"))?;
            if let Some(p) = prev
                && self.driver_of(f).as_deref() != Some(p.as_str())
            {
                return Err(format!("{} did not return to {p}", f.as_str()));
            }
        }
        Ok(())
    }
}

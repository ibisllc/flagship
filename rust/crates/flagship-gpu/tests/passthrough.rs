//! G03: VM passthrough qualification and VFIO binding on a simulated host.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::fs;

use flagship_gpu::device::{DeviceRecord, PciAddress};
use flagship_gpu::ids::LocalIdKey;
use flagship_gpu::provider::{DeviceProvider, FixtureTools};
use flagship_gpu::sim::{SimGpu, SimHost};
use flagship_gpu::sysfs::SysfsRoot;
use flagship_gpu::vendor::amd::AmdProvider;
use flagship_gpu::vfio::VfioHost;
use std::sync::Arc;

fn amd(host: &SimHost) -> Vec<DeviceRecord> {
    let pci = SysfsRoot::new(host.sys_root()).accelerators().unwrap();
    AmdProvider::new(host.tools(), None)
        .enumerate(&LocalIdKey::new([2; 32]), &pci)
        .unwrap()
}

fn driver(host: &SimHost, f: &str) -> Option<String> {
    fs::read_link(
        host.sys_root()
            .join("bus/pci/devices")
            .join(f)
            .join("driver"),
    )
    .ok()
    .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
}

#[test]
fn bind_and_release_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let mut g = SimGpu::mi210(0x03, 1, None);
    g.extra_functions
        .push(PciAddress::parse("0000:03:00.1").unwrap());
    let host = SimHost::new(dir.path().join("h"), vec![g]).unwrap();
    let d = amd(&host).remove(0);
    let v = VfioHost::new(host.sys_root(), host.dev_root(), host.sysfs_writer());
    let q = v.qualify(&d).unwrap();
    assert_eq!(q.functions.len(), 2, "every function of the card's group");
    let b = v.bind(&q).unwrap();
    assert_eq!(driver(&host, "0000:03:00.0").as_deref(), Some("vfio-pci"));
    assert_eq!(driver(&host, "0000:03:00.1").as_deref(), Some("vfio-pci"));
    assert!(host.dev_root().join("vfio/3").exists());
    let resets = host.resets();
    v.release(&b).unwrap();
    assert_eq!(driver(&host, "0000:03:00.0").as_deref(), Some("amdgpu"));
    assert_eq!(
        driver(&host, "0000:03:00.1").as_deref(),
        Some("snd_hda_intel")
    );
    assert_eq!(
        host.resets(),
        resets + 2,
        "each function is reset on the way back"
    );
    assert!(!host.dev_root().join("vfio/3").exists());
}

#[test]
fn unsafe_hosts_and_devices_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mut shared = SimGpu::mi210(0x03, 1, None);
    shared.shares_group_with = PciAddress::parse("0000:00:1f.3");
    let mut no_flr = SimGpu::mi210(0x05, 2, None);
    no_flr.reset_method = "bus".into();
    let host = SimHost::new(
        dir.path().join("h"),
        vec![shared, no_flr, SimGpu::rx7900_display(0x0c, 3)],
    )
    .unwrap();
    let v = VfioHost::new(host.sys_root(), host.dev_root(), host.sysfs_writer());
    let devs = amd(&host);
    let why = |pci: &str| {
        let d = devs.iter().find(|d| d.pci.as_str() == pci).unwrap();
        v.qualify(d).unwrap_err().join("; ")
    };
    assert!(why("0000:03:00.0").contains("shared with another device"));
    assert!(why("0000:05:00.0").contains("no function-level reset"));
    assert!(why("0000:0c:00.0").contains("drives a display"));
    let d = devs
        .iter()
        .find(|d| d.pci.as_str() == "0000:05:00.0")
        .unwrap();
    fs::write(
        host.sys_root().join(format!(
            "kernel/iommu_groups/{}/type",
            d.iommu_group.unwrap()
        )),
        "identity\n",
    )
    .unwrap();
    assert!(v.qualify(d).unwrap_err().join(";").contains("identity"));
    for e in fs::read_dir(host.sys_root().join("kernel/iommu_groups")).unwrap() {
        fs::remove_dir_all(e.unwrap().path()).unwrap();
    }
    assert!(v.qualify(d).unwrap_err().join(";").contains("IOMMU is off"));
}

#[test]
fn honest_unavailability_without_hardware() {
    let dir = tempfile::tempdir().unwrap();
    let host = SimHost::new(dir.path().join("h"), Vec::new()).unwrap();
    let pci = SysfsRoot::new(host.sys_root()).accelerators().unwrap();
    assert!(pci.is_empty());
    let p = AmdProvider::new(Arc::new(FixtureTools::new()), None);
    assert!(
        p.enumerate(&LocalIdKey::new([1; 32]), &pci).is_err(),
        "no tool: unavailable, not empty success"
    );
}

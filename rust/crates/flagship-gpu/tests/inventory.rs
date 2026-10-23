//! Vendor tool fixtures, the fake sysfs tree and local device IDs.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod common;

use std::path::Path;
use std::sync::Arc;

use common::{fixture, key};
use flagship_gpu::device::{Backend, PartitionMode, PciAddress, Vendor};
use flagship_gpu::provider::{
    DeviceActivity, DeviceProvider, FixtureTools, PinnedTools, Tool, ToolRunner,
};
use flagship_gpu::sysfs::SysfsRoot;
use flagship_gpu::topology::{Link, Topology};
use flagship_gpu::vendor::amd::{AmdProvider, parse_rocm_smi_json};
use flagship_gpu::vendor::intel::IntelProvider;
use flagship_gpu::vendor::nvidia::{NvidiaProvider, parse_nvidia_smi_xml};

fn pci_dev(
    root: &Path,
    addr: &str,
    vendor: &str,
    device: &str,
    class: &str,
    group: Option<u32>,
    driver: Option<&str>,
) {
    let d = root.join("bus/pci/devices").join(addr);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("vendor"), format!("{vendor}\n")).unwrap();
    std::fs::write(d.join("device"), format!("{device}\n")).unwrap();
    std::fs::write(d.join("class"), format!("{class}\n")).unwrap();
    std::fs::write(d.join("numa_node"), "0\n").unwrap();
    if let Some(g) = group {
        let gdir = root.join(format!("kernel/iommu_groups/{g}/devices"));
        std::fs::create_dir_all(&gdir).unwrap();
        std::fs::create_dir_all(gdir.join(addr)).unwrap();
        std::os::unix::fs::symlink(
            format!("../../../kernel/iommu_groups/{g}"),
            d.join("iommu_group"),
        )
        .unwrap();
    }
    if let Some(drv) = driver {
        std::os::unix::fs::symlink(format!("../../../bus/pci/drivers/{drv}"), d.join("driver"))
            .unwrap();
    }
}

fn fake_sysfs() -> tempfile::TempDir {
    let t = tempfile::tempdir().unwrap();
    let r = t.path();
    // RTX 4090 plus its HDMI audio function, alone in group 12, and boot VGA.
    pci_dev(
        r,
        "0000:01:00.0",
        "0x10de",
        "0x2684",
        "0x030000",
        Some(12),
        Some("nvidia"),
    );
    pci_dev(
        r,
        "0000:01:00.1",
        "0x10de",
        "0x22ba",
        "0x040300",
        Some(12),
        Some("snd_hda_intel"),
    );
    std::fs::write(r.join("bus/pci/devices/0000:01:00.0/boot_vga"), "1\n").unwrap();
    // A100 sharing group 30 with an unrelated NIC (no ACS).
    pci_dev(
        r,
        "0000:41:00.0",
        "0x10de",
        "0x20b0",
        "0x030200",
        Some(30),
        Some("nvidia"),
    );
    pci_dev(
        r,
        "0000:42:00.0",
        "0x15b3",
        "0x101b",
        "0x020700",
        Some(30),
        Some("mlx5_core"),
    );
    // MI210, Intel Flex 170, an Intel Arc with no xpu-smi, and a non-GPU.
    pci_dev(
        r,
        "0000:03:00.0",
        "0x1002",
        "0x740f",
        "0x038000",
        Some(5),
        Some("amdgpu"),
    );
    pci_dev(
        r,
        "0000:4d:00.0",
        "0x8086",
        "0x56c0",
        "0x038000",
        Some(40),
        Some("i915"),
    );
    pci_dev(
        r,
        "0000:4e:00.0",
        "0x8086",
        "0x56a0",
        "0x030000",
        Some(41),
        Some("xe"),
    );
    pci_dev(
        r,
        "0000:00:1f.3",
        "0x8086",
        "0x7a50",
        "0x040380",
        None,
        None,
    );
    std::fs::create_dir_all(r.join("bus/pci/devices/not-a-device")).unwrap();
    t
}

#[test]
fn sysfs_inventory_reads_a_fake_tree() {
    let t = fake_sysfs();
    let all = SysfsRoot::new(t.path()).scan_pci().unwrap();
    assert_eq!(all.len(), 8);
    let acc = SysfsRoot::new(t.path()).accelerators().unwrap();
    let addrs: Vec<&str> = acc.iter().map(|p| p.address.as_str()).collect();
    assert_eq!(
        addrs,
        [
            "0000:01:00.0",
            "0000:03:00.0",
            "0000:41:00.0",
            "0000:4d:00.0",
            "0000:4e:00.0"
        ]
    );
    let rtx = &acc[0];
    assert!(rtx.boot_vga);
    assert_eq!(rtx.iommu_group, Some(12));
    assert_eq!(rtx.kernel_driver.as_deref(), Some("nvidia"));
    assert_eq!(rtx.iommu_group_members.len(), 2);
    assert_eq!(rtx.numa_node, Some(0));
}

#[test]
fn nvidia_fixture_parses_with_mig_and_processes() {
    let r = parse_nvidia_smi_xml(&fixture("nvidia-smi-q-x.xml")).unwrap();
    assert_eq!(r.driver_version, "580.95.05");
    assert_eq!(r.cuda_version.as_deref(), Some("13.0"));
    assert_eq!(r.gpus.len(), 2);
    let rtx = &r.gpus[0];
    assert_eq!(rtx.bus_id.as_str(), "0000:01:00.0");
    assert_eq!(rtx.pci_device_id, Some(0x2684));
    assert_eq!(rtx.memory_total_mib, 24564);
    assert_eq!(rtx.mig_mode, PartitionMode::Unsupported);
    assert_eq!(rtx.processes.as_ref().map(Vec::len), Some(1));
    let a100 = &r.gpus[1];
    assert_eq!(a100.mig_mode, PartitionMode::Enabled);
    assert_eq!(a100.mig_devices.len(), 2);
    assert_eq!(a100.mig_devices[1].gpu_instance, 2);
    assert_eq!(a100.mig_devices[0].memory_total_mib, 19968);
}

#[test]
fn nvidia_provider_joins_sysfs_and_hides_uuids() {
    let t = fake_sysfs();
    let pci = SysfsRoot::new(t.path()).accelerators().unwrap();
    let tools =
        Arc::new(FixtureTools::new().with(Tool::NvidiaSmiQueryXml, fixture("nvidia-smi-q-x.xml")));
    let p = NvidiaProvider::new(tools);
    let devs = p.enumerate(&key(), &pci).unwrap();
    assert_eq!(devs.len(), 2);
    let rtx = &devs[0];
    assert_eq!(rtx.backend, Backend::NvidiaCuda);
    assert!(
        rtx.display_owned,
        "boot VGA from sysfs marks it display-owned"
    );
    assert_eq!(rtx.iommu_group, Some(12));
    assert_eq!(devs[1].partitions.len(), 2);
    assert_eq!(devs[1].partitions[0].cdi_name, "1:0");
    let json = serde_json::to_string(&devs).unwrap();
    assert!(!json.contains("3b5c1e2a"), "vendor UUID leaked: {json}");
    assert!(!json.contains("GPU-"));
    // Per-partition observation: the A100 process runs in MIG 1.0 only.
    let a100 = &devs[1];
    assert_eq!(
        p.observe(a100, Some(&a100.partitions[0].id)),
        DeviceActivity::Busy { processes: 1 }
    );
    assert_eq!(
        p.observe(a100, Some(&a100.partitions[1].id)),
        DeviceActivity::Idle
    );
    assert_eq!(p.observe(rtx, None), DeviceActivity::Busy { processes: 1 });
}

#[test]
fn nvidia_failing_tool_observes_unknown_not_idle() {
    let t = fake_sysfs();
    let pci = SysfsRoot::new(t.path()).accelerators().unwrap();
    let good = NvidiaProvider::new(Arc::new(
        FixtureTools::new().with(Tool::NvidiaSmiQueryXml, fixture("nvidia-smi-q-x.xml")),
    ));
    let dev = good.enumerate(&key(), &pci).unwrap().remove(0);
    let broken = NvidiaProvider::new(Arc::new(FixtureTools::new()));
    assert_eq!(broken.observe(&dev, None), DeviceActivity::Unknown);
}

#[test]
fn amd_fixture_is_rocm_never_cuda() {
    let r = parse_rocm_smi_json(&fixture("rocm-smi.json")).unwrap();
    assert_eq!(r.cards.len(), 2);
    assert_eq!(r.cards[1].unique_id, None, "N/A is not an id");
    let t = fake_sysfs();
    let pci = SysfsRoot::new(t.path()).accelerators().unwrap();
    let p = AmdProvider::new(
        Arc::new(FixtureTools::new().with(Tool::RocmSmiJson, fixture("rocm-smi.json"))),
        Some("6.4.3".into()),
    );
    let devs = p.enumerate(&key(), &pci).unwrap();
    assert_eq!(devs.len(), 2);
    for d in &devs {
        assert_eq!(d.vendor, Vendor::Amd);
        assert_eq!(d.backend, Backend::AmdRocm);
        assert_ne!(d.backend, Backend::NvidiaCuda);
        assert_eq!(d.toolkit_version.as_deref(), Some("6.4.3"));
    }
    assert_eq!(devs[0].pci_device_id, Some(0x740f));
    assert_eq!(devs[0].memory_mib, 65520);
    assert_eq!(devs[0].iommu_group, Some(5));
    assert!(!serde_json::to_string(&devs).unwrap().contains("1f2e3d4c"));
    assert_eq!(p.observe(&devs[0], None), DeviceActivity::Unknown);
}

#[test]
fn intel_fixture_and_sysfs_fallback_are_level_zero() {
    let t = fake_sysfs();
    let pci = SysfsRoot::new(t.path()).accelerators().unwrap();
    let with_tool = IntelProvider::new(
        Arc::new(
            FixtureTools::new()
                .with(Tool::XpuSmiDiscovery, fixture("xpu-smi-discovery.json"))
                .with(Tool::XpuSmiDevice(0), fixture("xpu-smi-device0.json")),
        ),
        Some("1.21.9".into()),
    );
    let devs = with_tool.enumerate(&key(), &pci).unwrap();
    assert_eq!(devs.len(), 1);
    assert_eq!(devs[0].backend, Backend::IntelLevelZero);
    assert_eq!(devs[0].memory_mib, 16384);
    assert_eq!(devs[0].pci_device_id, Some(0x56c0));
    assert!(
        !serde_json::to_string(&devs)
            .unwrap()
            .contains("00004d000000")
    );

    let no_tool = IntelProvider::new(Arc::new(FixtureTools::new()), None);
    let devs = no_tool.enumerate(&key(), &pci).unwrap();
    let addrs: Vec<&str> = devs.iter().map(|d| d.pci.as_str()).collect();
    assert_eq!(addrs, ["0000:4d:00.0", "0000:4e:00.0"]);
    assert!(devs.iter().all(|d| d.backend == Backend::IntelLevelZero));
}

#[test]
fn malformed_tool_output_is_an_error_not_a_guess() {
    assert!(parse_nvidia_smi_xml("<nvidia_smi_log><gpu/></nvidia_smi_log>").is_err());
    assert!(parse_nvidia_smi_xml("<html/>").is_err());
    assert!(
        parse_rocm_smi_json(
            r#"{"card0": {"Card Series": "x"}, "system": {"Driver version": "1"}}"#
        )
        .is_err()
    );
}

#[test]
fn pinned_tools_refuse_relative_paths_and_missing_tools() {
    let t = PinnedTools {
        nvidia_smi: Some("nvidia-smi".into()),
        rocm_smi: None,
        xpu_smi: None,
        timeout: std::time::Duration::from_secs(1),
    };
    assert!(t.output(&Tool::NvidiaSmiQueryXml).is_err());
    assert!(t.output(&Tool::RocmSmiJson).is_err());
}

#[test]
fn nvidia_topology_matrix_parses() {
    let devs: Vec<_> = (0..4).map(common::h100).collect();
    let t = Topology::from_nvidia_topo(&fixture("nvidia-topo-m.txt"), &devs);
    assert_eq!(t.link(&devs[0].id, &devs[1].id), Some(Link::PeerFabric));
    assert_eq!(t.link(&devs[2].id, &devs[0].id), Some(Link::PeerFabric));
    assert_eq!(t.link(&devs[0].id, &devs[3].id), Some(Link::PcieCrossNuma));
}

#[test]
fn pci_address_from_sysfs_entry_names_only() {
    assert!(PciAddress::parse("0000:01:00.0").is_some());
    assert!(PciAddress::parse("not-a-device").is_none());
}

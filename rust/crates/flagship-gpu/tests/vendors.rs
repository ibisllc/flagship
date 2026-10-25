//! G03/G04 vendor adapters against tool output in the vendors' documented
//! formats: amd-smi, rocm-smi topology, xpu-smi ps and topology, the KFD
//! and DRM fdinfo observers, nvidia-smi compute-apps, pmon and MIG profiles.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod common;

use std::sync::Arc;

use common::{fixture, key};
use flagship_gpu::coop::{CoopDecision, CoopLedger, ShareLimits, Usage, parse_pmon, shares_fit};
use flagship_gpu::device::{Backend, PartitionMode, PciAddress, Vendor};
use flagship_gpu::mig::{parse_lgip, plan};
use flagship_gpu::observe::{ObserverRoots, drm_clients, kfd_gpu_id, kfd_processes};
use flagship_gpu::policy::AllocationId;
use flagship_gpu::provider::{DeviceActivity, DeviceProvider, FixtureTools, Tool};
use flagship_gpu::sim::{SimGpu, SimHost};
use flagship_gpu::topology::Link;
use flagship_gpu::vendor::amd::{AmdProvider, parse_amd_smi, parse_amd_smi_process};
use flagship_gpu::vendor::intel::{IntelProvider, parse_xpu_ps, parse_xpu_topology};
use flagship_gpu::vendor::nvidia::parse_compute_apps;

fn amd_tools() -> FixtureTools {
    FixtureTools::new()
        .with(Tool::AmdSmiList, fixture("amd-smi-list.json"))
        .with(Tool::AmdSmiStatic, fixture("amd-smi-static.json"))
        .with(Tool::AmdSmiProcess, fixture("amd-smi-process.json"))
        .with(Tool::RocmSmiTopo, fixture("rocm-smi-topo.json"))
}

#[test]
fn amd_smi_is_preferred_and_reports_rocm() {
    let gpus = parse_amd_smi(
        &fixture("amd-smi-list.json"),
        &fixture("amd-smi-static.json"),
    )
    .unwrap();
    assert_eq!(gpus.len(), 2);
    assert_eq!(gpus[0].vram_mib, 65536);
    assert_eq!(gpus[1].vram_mib, 65536, "GB is converted");
    assert_eq!(gpus[0].device_id, Some(0x740f));
    let p = AmdProvider::new(Arc::new(amd_tools()), Some("6.4.3".into()));
    let devs = p.enumerate(&key(), &[]).unwrap();
    assert_eq!(devs.len(), 2);
    assert!(
        devs.iter()
            .all(|d| d.backend == Backend::AmdRocm && d.vendor == Vendor::Amd)
    );
    assert_eq!(devs[0].model, "AMD Instinct MI210");
    let text = serde_json::to_string(&devs).unwrap();
    assert!(!text.contains("a7ff740f"), "uuids never leave");
    assert!(matches!(
        p.observe(&devs[0], None),
        DeviceActivity::Busy { processes: 1 }
    ));
    assert_eq!(p.observe(&devs[1], None), DeviceActivity::Idle);
    let t = p.topology(&devs);
    assert_eq!(
        t.link(&devs[0].id, &devs[1].id),
        Some(Link::PeerFabric),
        "XGMI"
    );
}

#[test]
fn amd_smi_process_strings_mean_none() {
    let p = parse_amd_smi_process(&fixture("amd-smi-process.json")).unwrap();
    assert_eq!(p, vec![(0, 1), (1, 0)]);
    assert!(parse_amd_smi_process("{\"x\": 1}").is_err());
}

#[test]
fn amd_falls_back_to_rocm_smi_and_then_kernel_observers() {
    let rocm = FixtureTools::new().with(Tool::RocmSmiJson, fixture("rocm-smi.json"));
    let p = AmdProvider::new(Arc::new(rocm), None);
    let devs = p.enumerate(&key(), &[]).unwrap();
    assert_eq!(devs.len(), 2, "rocm-smi when amd-smi is absent");
    assert_eq!(
        p.observe(&devs[0], None),
        DeviceActivity::Unknown,
        "nothing to observe with"
    );
}

#[test]
fn kfd_and_drm_observers_read_the_kernel_formats() {
    let dir = tempfile::tempdir().unwrap();
    let host = SimHost::new(
        dir.path().join("h"),
        vec![
            SimGpu::mi210(0x03, 61748, None),
            SimGpu::arc_a770(0x05, None),
        ],
    )
    .unwrap();
    let mi = PciAddress::parse("0000:03:00.0").unwrap();
    let arc = PciAddress::parse("0000:05:00.0").unwrap();
    assert_eq!(kfd_gpu_id(&host.sys_root(), &mi), Some(61748));
    let a = AllocationId::new("w").unwrap();
    host.launch(&a, &[(mi.clone(), None), (arc.clone(), None)], 10, 1)
        .unwrap();
    assert_eq!(kfd_processes(&host.sys_root(), 61748).unwrap().len(), 1);
    assert_eq!(
        drm_clients(&host.proc_root(), &arc, &["xe"]).unwrap().len(),
        1
    );
    assert_eq!(
        drm_clients(&host.proc_root(), &arc, &["amdgpu"])
            .unwrap()
            .len(),
        0,
        "driver must match"
    );
    let roots = ObserverRoots {
        sys: host.sys_root(),
        proc: host.proc_root(),
    };
    let intel = IntelProvider::new(Arc::new(FixtureTools::new()), None).with_observer_roots(roots);
    let mut rec = common::device("arc", Backend::IntelLevelZero, 0x56a0, 0x05, 16256, 0);
    rec.pci = arc.clone();
    assert!(matches!(
        intel.observe(&rec, None),
        DeviceActivity::Busy { processes: 1 }
    ));
    host.reap(&a).unwrap();
    assert_eq!(intel.observe(&rec, None), DeviceActivity::Idle);
}

#[test]
fn xpu_smi_ps_and_topology() {
    assert_eq!(
        parse_xpu_ps(&fixture("xpu-smi-ps.json")).unwrap(),
        2,
        "distinct pids"
    );
    let mut a = common::device("pvc0", Backend::IntelLevelZero, 0x0bd5, 0x4d, 65536, 0);
    let mut b = common::device("pvc1", Backend::IntelLevelZero, 0x0bd5, 0x4e, 65536, 1);
    a.vendor = Vendor::Intel;
    b.vendor = Vendor::Intel;
    let t = parse_xpu_topology(&fixture("xpu-smi-topology.txt"), &[a.clone(), b.clone()]);
    assert_eq!(t.link(&a.id, &b.id), Some(Link::PeerFabric), "Xe Link");
}

#[test]
fn nvidia_compute_apps_and_pmon() {
    let apps = parse_compute_apps(&fixture("nvidia-smi-compute-apps.csv")).unwrap();
    assert_eq!(apps.len(), 3);
    assert_eq!(apps[1].used_mib, 6012);
    assert_eq!(apps[2].used_mib, 0, "[N/A] under MIG");
    let pmon = parse_pmon(&fixture("nvidia-smi-pmon.txt")).unwrap();
    assert_eq!(pmon.len(), 2, "idle rows are skipped");
    assert_eq!(pmon[1].sm_percent, Some(51));
    assert!(parse_compute_apps("12, not-a-bus, 3").is_err());
}

#[test]
fn mig_profiles_and_layout_plans() {
    let p = parse_lgip(&fixture("nvidia-smi-mig-lgip.txt")).unwrap();
    assert_eq!(p.len(), 6);
    let g3 = p.iter().find(|x| x.name == "3g.20gb").unwrap();
    assert_eq!((g3.id, g3.free, g3.total, g3.memory_mib), (9, 2, 2, 20091));
    let mut d = common::a100_mig(&[(1, 0, 19968)]);
    d.cdi_name = "0".into();
    let ok = plan(
        &d,
        &p,
        &["3g.20gb".into(), "2g.10gb".into(), "1g.5gb".into()],
        false,
    )
    .unwrap();
    assert_eq!(ok.profile_ids, vec![9, 14, 19]);
    assert!(ok.destroy_existing);
    assert!(
        plan(&d, &p, &["3g.20gb".into()], true).is_err(),
        "held devices are not re-partitioned"
    );
    assert!(
        plan(&d, &p, &["7g.40gb".into(), "1g.5gb".into()], false).is_err(),
        "over memory"
    );
    assert!(
        plan(&d, &p, &["4g.20gb".into(), "4g.20gb".into()], false).is_err(),
        "over count"
    );
    assert!(
        plan(&d, &p, &["9g.99gb".into()], false).is_err(),
        "unknown profile"
    );
    let mut consumer = common::h100(0);
    consumer.partition_mode = PartitionMode::Unsupported;
    assert!(plan(&consumer, &p, &["1g.5gb".into()], false).is_err());
    assert!(parse_lgip("garbage").is_err());
}

#[test]
fn cooperative_budgets_are_enforced_by_revocation() {
    let limits = ShareLimits {
        compute_percent: 25,
        memory_mib: 4096,
    };
    assert!(limits.check().is_ok());
    assert!(
        ShareLimits {
            compute_percent: 0,
            memory_mib: 1
        }
        .check()
        .is_err()
    );
    assert!(shares_fit(&[limits, limits, limits, limits], 16384).is_ok());
    assert!(
        shares_fit(&[limits; 5], 1 << 20).is_err(),
        "over 100 percent"
    );
    let id = AllocationId::new("s").unwrap();
    let mut l = CoopLedger::new(1000);
    let within = Usage {
        used_mib: 1000,
        sm_percent: 20,
    };
    assert_eq!(l.record(&id, &limits, within, 0, 0), CoopDecision::Within);
    let mut t = 0;
    let mut last = CoopDecision::Within;
    for _ in 0..40 {
        t += 400;
        last = l.record(
            &id,
            &limits,
            Usage {
                used_mib: 1000,
                sm_percent: 100,
            },
            t,
            400,
        );
        if matches!(last, CoopDecision::Revoke(_)) {
            break;
        }
    }
    assert!(
        matches!(last, CoopDecision::Revoke(_)),
        "time over share three windows running"
    );
    let mut l = CoopLedger::new(1000);
    assert!(matches!(
        l.record(
            &id,
            &limits,
            Usage {
                used_mib: 5000,
                sm_percent: 1
            },
            0,
            0
        ),
        CoopDecision::Strike(_)
    ));
    assert!(matches!(
        l.record(
            &id,
            &limits,
            Usage {
                used_mib: 5000,
                sm_percent: 1
            },
            1,
            1
        ),
        CoopDecision::Revoke(_)
    ));
}

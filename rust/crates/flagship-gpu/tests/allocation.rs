//! The allocation journal and manager: exclusion, sharing policy, gangs,
//! revocation, crashes and topology changes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod common;

use std::sync::Arc;

use common::*;
use flagship_gpu::cdi::ValidatedCdi;
use flagship_gpu::device::Backend;
use flagship_gpu::journal::{AllocationState, DeviceClaim, JournalError, JournalStore};
use flagship_gpu::manager::{
    DeviceManager, ManagerError, Presence, ReconcileAction, ReserveOutcome, Settle,
};
use flagship_gpu::policy::{AllocationPolicy, Conflict};
use flagship_gpu::provider::{CleanupOutcome, DeviceActivity, DeviceProvider, IsolationProfile};
use flagship_gpu::sqlite::SqliteJournal;
use flagship_gpu::topology::{GangRequirement, Topology};

fn mem() -> SqliteJournal {
    SqliteJournal::open_in_memory().unwrap()
}

fn one_h100() -> (DeviceManager<SqliteJournal>, Arc<FakeProvider>) {
    let p = FakeProvider::new(Backend::NvidiaCuda, vec![h100(0)]);
    (
        manager(
            mem(),
            vec![p.clone() as Arc<dyn DeviceProvider>],
            Topology::new(),
        ),
        p,
    )
}

fn reserved(m: &mut DeviceManager<SqliteJournal>, id: &flagship_gpu::policy::AllocationId) -> bool {
    matches!(m.reserve(id).unwrap(), ReserveOutcome::Reserved(_))
}

fn state(
    m: &DeviceManager<SqliteJournal>,
    id: &flagship_gpu::policy::AllocationId,
) -> AllocationState {
    m.store().get(id).unwrap().unwrap().state
}

fn cdi_for(
    m: &DeviceManager<SqliteJournal>,
    id: &flagship_gpu::policy::AllocationId,
) -> ValidatedCdi {
    let rec = m.store().get(id).unwrap().unwrap();
    ValidatedCdi {
        devices: rec
            .claims
            .iter()
            .map(|c| format!("nvidia.com/gpu={}", c.cdi_name))
            .collect(),
        spec_digest: "sha256:00".into(),
    }
}

fn run(
    m: &mut DeviceManager<SqliteJournal>,
    rt: &FakeRuntime,
    id: &flagship_gpu::policy::AllocationId,
) {
    assert!(reserved(m, id));
    m.attach(id, Some(&cdi_for(m, id))).unwrap();
    rt.set(id, Presence::Present);
    m.started(id).unwrap();
}

#[test]
fn double_allocation_is_refused() {
    let (mut m, _) = one_h100();
    let a = admitted(&m, "a", "app-a", &Ask::default());
    let b = admitted(&m, "b", "app-b", &Ask::default());
    assert!(reserved(&mut m, &a));
    assert!(matches!(
        m.reserve(&b).unwrap(),
        ReserveOutcome::NoCapacity(_)
    ));
    // The journal refuses it too, even if a caller skips the manager.
    let d = h100(0);
    let claim = DeviceClaim {
        device: d.id.clone(),
        partition: None,
        memory_mib: d.memory_mib,
        cdi_name: "0".into(),
    };
    let topo_gen = m.store().topology().unwrap().generation;
    let e = m
        .store()
        .reserve(
            &b,
            std::slice::from_ref(&claim),
            &[(d.id.clone(), d.memory_mib)],
            topo_gen,
        )
        .unwrap_err();
    assert!(
        matches!(
            e,
            JournalError::Conflict {
                conflict: Conflict::Held(_),
                ..
            }
        ),
        "{e}"
    );
    // And the same allocation can't reserve twice.
    let e = m
        .store()
        .reserve(&a, &[claim], &[(d.id.clone(), d.memory_mib)], topo_gen)
        .unwrap_err();
    assert!(matches!(e, JournalError::StateConflict { .. }));
    assert_eq!(m.store().holdings(&d.id).unwrap().len(), 1);
}

#[test]
fn a_non_gpu_app_is_denied() {
    let (mut m, _) = one_h100();
    let req = gpu_request("notes", &Ask::default());
    let id = aid("notes-1");
    m.request(id.clone(), req.clone(), false).unwrap();
    let e = m.admit(&id, None).unwrap_err();
    assert!(matches!(e, ManagerError::NotApproved(_)));
    assert_eq!(state(&m, &id), AllocationState::Released);
    assert!(m.reserve(&id).is_err());
    assert!(m.store().holdings(&h100(0).id).unwrap().is_empty());

    // An approval for another generation, backend or isolation doesn't count.
    let mut wrong_gen = approval_for(&req, false);
    wrong_gen.app.generation = 2;
    let mut wrong_backend = approval_for(&req, false);
    wrong_backend.backend = Backend::AmdRocm;
    let mut wrong_iso = approval_for(&req, false);
    wrong_iso.isolation = IsolationProfile::VmPassthrough;
    for (i, ap) in [wrong_gen, wrong_backend, wrong_iso].iter().enumerate() {
        let id = aid(&format!("notes-x{i}"));
        m.request(id.clone(), req.clone(), false).unwrap();
        assert!(matches!(
            m.admit(&id, Some(ap)),
            Err(ManagerError::NotApproved(_))
        ));
    }
}

#[test]
fn cross_app_sharing_is_refused() {
    let (mut m, _) = one_h100();
    let coop = |domain: &str, secrecy: bool| Ask {
        policy: cooperative(domain),
        memory: 10_000,
        secrecy,
        ..Ask::default()
    };
    let a = admitted(&m, "a", "app-a", &coop("family", true));
    assert!(reserved(&mut m, &a));
    // Another app, same domain: refused because app-a requires secrecy.
    let b = admitted(&m, "b", "app-b", &coop("family", false));
    match m.reserve(&b).unwrap() {
        ReserveOutcome::NoCapacity(why) => {
            assert!(why.iter().any(|w| w.contains("secrecy")), "{why:?}")
        }
        ReserveOutcome::Reserved(_) => panic!("cross-app sharing with a secret app"),
    }
    // Another domain: refused.
    let c = admitted(&m, "c", "app-c", &coop("work", false));
    assert!(!reserved(&mut m, &c));
    // Exclusive alongside a cooperative holder: refused.
    let e = admitted(&m, "e", "app-e", &Ask::default());
    assert!(!reserved(&mut m, &e));
    // The secret app's own second job may share its device.
    let a2 = admitted(&m, "a2", "app-a", &coop("family", true));
    assert!(reserved(&mut m, &a2));

    // Without secrecy, two apps in one owner-chosen domain may share, up to
    // the device's memory.
    let (mut m, _) = one_h100();
    let x = admitted(&m, "x", "app-x", &coop("family", false));
    let y = admitted(&m, "y", "app-y", &coop("family", false));
    assert!(reserved(&mut m, &x));
    assert!(reserved(&mut m, &y));
    let big = admitted(
        &m,
        "big",
        "app-z",
        &Ask {
            memory: 70_000,
            ..coop("family", false)
        },
    );
    match m.reserve(&big).unwrap() {
        ReserveOutcome::NoCapacity(why) => {
            assert!(why.iter().any(|w| w.contains("oversubscribed")), "{why:?}")
        }
        ReserveOutcome::Reserved(_) => panic!("memory oversubscribed"),
    }
}

#[test]
fn cooperative_needs_the_owners_consent() {
    let (mut m, _) = one_h100();
    let ask = Ask {
        policy: AllocationPolicy::Cooperative {
            trust_domain: "family".into(),
            owner_consent: String::new(),
        },
        ..Ask::default()
    };
    let id = admitted(&m, "a", "app-a", &ask);
    assert!(!reserved(&mut m, &id));
}

fn four_h100() -> (DeviceManager<SqliteJournal>, Arc<FakeProvider>) {
    let devs: Vec<_> = (0..4).map(h100).collect();
    let topo = Topology::from_nvidia_topo(&fixture("nvidia-topo-m.txt"), &devs);
    let p = FakeProvider::new(Backend::NvidiaCuda, devs);
    (
        manager(mem(), vec![p.clone() as Arc<dyn DeviceProvider>], topo),
        p,
    )
}

#[test]
fn gang_reservation_is_all_or_nothing() {
    let (mut m, _) = four_h100();
    let rt = FakeRuntime::default();
    let x = admitted(&m, "x", "other", &Ask::default());
    run(&mut m, &rt, &x);
    let held = m.store().get(&x).unwrap().unwrap().claims[0].device.clone();
    assert_eq!(held, h100(0).id);

    // Three NVLinked GPUs: only GPU1, GPU2 are left on the fabric.
    let peer = |count| Ask {
        count,
        gang: GangRequirement::PeerFabric,
        ..Ask::default()
    };
    let g3 = admitted(&m, "g3", "trainer", &peer(3));
    assert!(matches!(
        m.reserve(&g3).unwrap(),
        ReserveOutcome::NoCapacity(_)
    ));
    for i in 1..4 {
        assert!(
            m.store().holdings(&h100(i).id).unwrap().is_empty(),
            "GPU{i} half-reserved"
        );
    }
    let g2 = admitted(&m, "g2", "trainer", &peer(2));
    let ReserveOutcome::Reserved(rec) = m.reserve(&g2).unwrap() else {
        panic!("two NVLinked GPUs are free");
    };
    let mut got: Vec<_> = rec.claims.iter().map(|c| c.device.clone()).collect();
    got.sort();
    let mut want = vec![h100(1).id, h100(2).id];
    want.sort();
    assert_eq!(got, want);
    assert!(rec.claims.iter().all(|_| rec.request.app.generation == 1));

    // At the journal: one free device plus one held device commits nothing.
    let g = admitted(
        &m,
        "g",
        "trainer",
        &Ask {
            count: 2,
            ..Ask::default()
        },
    );
    let claims: Vec<DeviceClaim> = [3u8, 0]
        .iter()
        .map(|i| DeviceClaim {
            device: h100(*i).id,
            partition: None,
            memory_mib: 81_559,
            cdi_name: i.to_string(),
        })
        .collect();
    let memory: Vec<_> = claims.iter().map(|c| (c.device.clone(), 81_559)).collect();
    let topo_gen = m.store().topology().unwrap().generation;
    assert!(m.store().reserve(&g, &claims, &memory, topo_gen).is_err());
    assert!(m.store().holdings(&h100(3).id).unwrap().is_empty());
    assert_eq!(state(&m, &g), AllocationState::Admitted);

    // A gang naming one device twice is refused.
    let twice = vec![claims[0].clone(), claims[0].clone()];
    assert!(m.store().reserve(&g, &twice, &memory, topo_gen).is_err());
    assert!(m.store().holdings(&h100(3).id).unwrap().is_empty());
}

#[test]
fn revocation_mid_job_holds_the_device_until_proven_free() {
    let (mut m, p) = one_h100();
    let rt = FakeRuntime::default();
    let a = admitted(&m, "a", "app-a", &Ask::default());
    run(&mut m, &rt, &a);
    assert_eq!(state(&m, &a), AllocationState::Running);

    *rt.sticky.lock().unwrap() = true;
    let revoked = m.revoke_app("app-a", &rt).unwrap();
    assert_eq!(revoked, vec![a.clone()]);
    assert_eq!(state(&m, &a), AllocationState::Draining);
    assert_eq!(*rt.stops.lock().unwrap(), vec![a.clone()]);

    let b = admitted(&m, "b", "app-b", &Ask::default());
    assert!(
        matches!(m.settle(&a, &rt).unwrap(), Settle::Held(_)),
        "still running"
    );
    assert!(!reserved(&mut m, &b));

    rt.set(&a, Presence::Absent);
    p.set_activity(&h100(0).id, None, DeviceActivity::Busy { processes: 1 });
    assert!(
        matches!(m.settle(&a, &rt).unwrap(), Settle::Held(_)),
        "device still busy"
    );
    p.set_activity(&h100(0).id, None, DeviceActivity::Unknown);
    assert!(
        matches!(m.settle(&a, &rt).unwrap(), Settle::Held(_)),
        "unknown is not idle"
    );
    assert!(!reserved(&mut m, &b));

    p.set_activity(&h100(0).id, None, DeviceActivity::Idle);
    assert_eq!(m.settle(&a, &rt).unwrap(), Settle::Released);
    assert!(reserved(&mut m, &b));
}

#[test]
fn unproven_cleanup_quarantines_until_maintenance() {
    let (mut m, p) = one_h100();
    let rt = FakeRuntime::default();
    *p.cleanup.lock().unwrap() = CleanupOutcome::Unproven("reset not qualified".into());
    let a = admitted(&m, "a", "app-a", &Ask::default());
    run(&mut m, &rt, &a);
    m.drain(&a, &rt, "done").unwrap();
    assert!(matches!(m.settle(&a, &rt).unwrap(), Settle::Quarantined(_)));
    assert_eq!(state(&m, &a), AllocationState::Quarantined);
    let b = admitted(&m, "b", "app-b", &Ask::default());
    assert!(!reserved(&mut m, &b));
    let d = h100(0).id;
    assert!(
        m.store().clear_quarantine(&d, "").is_err(),
        "needs a maintenance order"
    );
    m.store()
        .clear_quarantine(&d, "maint-2026-10-23-1")
        .unwrap();
    assert!(reserved(&mut m, &b));
}

/// The happy path, one durable step at a time.
const STEPS: usize = 9;

fn step(m: &mut DeviceManager<SqliteJournal>, rt: &FakeRuntime, k: usize) {
    let id = aid("job");
    let ask = Ask::default();
    match k {
        0 => {
            m.request(id, gpu_request("app-a", &ask), false).unwrap();
        }
        1 => {
            let req = gpu_request("app-a", &ask);
            m.admit(&id, Some(&approval_for(&req, false))).unwrap();
        }
        2 => assert!(reserved(m, &id)),
        3 => {
            m.attach(&id, Some(&cdi_for(m, &id))).unwrap();
        }
        // The runtime created the container; the journal hasn't heard yet.
        4 => rt.set(&id, Presence::Present),
        5 => {
            m.started(&id).unwrap();
        }
        6 => {
            m.drain(&id, rt, "job finished").unwrap();
        }
        7 => {
            assert_eq!(m.settle(&id, rt).unwrap(), Settle::Released);
        }
        _ => {}
    }
}

#[test]
fn crash_at_every_step_reconciles_without_freeing_a_busy_device() {
    for crash_after in 0..STEPS {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("gpu.sqlite");
        let rt = FakeRuntime::default();
        {
            let p = FakeProvider::new(Backend::NvidiaCuda, vec![h100(0)]);
            let mut m = manager(
                SqliteJournal::open(&db).unwrap(),
                vec![p as Arc<dyn DeviceProvider>],
                Topology::new(),
            );
            for k in 0..=crash_after {
                step(&mut m, &rt, k);
            }
        } // crash: the manager and its in-memory queue are gone.

        let p = FakeProvider::new(Backend::NvidiaCuda, vec![h100(0)]);
        let mut m = manager(
            SqliteJournal::open(&db).unwrap(),
            vec![p as Arc<dyn DeviceProvider>],
            Topology::new(),
        );
        let actions = m.reconcile(&rt).unwrap();
        let id = aid("job");
        let holdings = m.store().holdings(&h100(0).id).unwrap();
        let present = rt.presence.lock().unwrap().get(&id).copied() == Some(Presence::Present);
        let st = m.store().get(&id).unwrap().map(|r| r.state);
        // Never: a live workload on a device the journal calls free.
        assert!(
            !(present && holdings.is_empty()),
            "step {crash_after}: workload on a free device"
        );
        match st {
            None => assert!(holdings.is_empty()),
            Some(AllocationState::Running) => {
                assert!(present && actions.iter().any(|(_, a)| *a == ReconcileAction::Adopted));
            }
            Some(AllocationState::Admitted) => {
                assert!(
                    holdings.is_empty()
                        && actions.iter().any(|(_, a)| *a == ReconcileAction::Requeued)
                );
                // The re-queued job still gets the device.
                assert_eq!(m.pump().unwrap(), vec![id.clone()]);
            }
            Some(s) => {
                assert!(s.is_terminal(), "step {crash_after}: left in {s}");
                assert!(holdings.is_empty(), "step {crash_after}: terminal but held");
                assert!(!present);
            }
        }
    }
}

#[test]
fn a_stale_heartbeat_never_frees_a_device() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("gpu.sqlite");
    let rt = FakeRuntime::default();
    let a = aid("a");
    {
        let p = FakeProvider::new(Backend::NvidiaCuda, vec![h100(0)]);
        let mut m = manager(
            SqliteJournal::open(&db).unwrap(),
            vec![p as Arc<dyn DeviceProvider>],
            Topology::new(),
        );
        let id = admitted(&m, "a", "app-a", &Ask::default());
        run(&mut m, &rt, &id);
        m.heartbeat(&id, 1_000).unwrap();
    }
    let p = FakeProvider::new(Backend::NvidiaCuda, vec![h100(0)]);
    let mut m = manager(
        SqliteJournal::open(&db).unwrap(),
        vec![p.clone() as Arc<dyn DeviceProvider>],
        Topology::new(),
    );
    // Hours later, the runtime can't answer.
    rt.set(&a, Presence::Unknown);
    m.reconcile(&rt).unwrap();
    assert_eq!(state(&m, &a), AllocationState::Running);
    assert_eq!(m.store().holdings(&h100(0).id).unwrap().len(), 1);
    // The runtime says it's gone, but the device still shows a process.
    rt.set(&a, Presence::Absent);
    p.set_activity(&h100(0).id, None, DeviceActivity::Busy { processes: 1 });
    m.reconcile(&rt).unwrap();
    assert_eq!(state(&m, &a), AllocationState::Draining);
    assert_eq!(m.store().holdings(&h100(0).id).unwrap().len(), 1);
    p.set_activity(&h100(0).id, None, DeviceActivity::Idle);
    m.reconcile(&rt).unwrap();
    assert_eq!(state(&m, &a), AllocationState::Released);
}

#[test]
fn partition_topology_change_forces_reconciliation() {
    let parts = [(1, 0, 19_968), (2, 0, 9_856)];
    let p = FakeProvider::new(Backend::NvidiaCuda, vec![a100_mig(&parts), h100(0)]);
    let mut m = manager(
        mem(),
        vec![p.clone() as Arc<dyn DeviceProvider>],
        Topology::new(),
    );
    let rt = FakeRuntime::default();
    let part = Ask {
        policy: AllocationPolicy::Partition,
        ..Ask::default()
    };
    let a = admitted(&m, "a", "app-a", &part);
    let b = admitted(&m, "b", "app-b", &part);
    run(&mut m, &rt, &a);
    run(&mut m, &rt, &b);
    let pa = m.store().get(&a).unwrap().unwrap().claims[0]
        .partition
        .clone();
    let pb = m.store().get(&b).unwrap().unwrap().claims[0]
        .partition
        .clone();
    assert_ne!(pa, pb, "two partitions, two apps");
    // The whole MIG-enabled device can't be claimed exclusively.
    let whole = admitted(
        &m,
        "whole",
        "app-w",
        &Ask {
            memory: 30_000,
            ..Ask::default()
        },
    );
    let ReserveOutcome::Reserved(rec) = m.reserve(&whole).unwrap() else {
        panic!("the H100 is free");
    };
    assert_eq!(
        rec.claims[0].device,
        h100(0).id,
        "never the partitioned A100"
    );
    m.drain(&whole, &rt, "done").unwrap();
    assert_eq!(m.settle(&whole, &rt).unwrap(), Settle::Released);

    // Someone re-partitioned the A100: 1.0 is gone, 3.0 appeared.
    *p.devices.lock().unwrap() = vec![a100_mig(&[(3, 0, 19_968), (2, 0, 9_856)]), h100(0)];
    let report = m.refresh_inventory(&[], Topology::new()).unwrap();
    assert!(report.reconcile_required);
    let c = admitted(&m, "c", "app-c", &Ask::default());
    assert!(matches!(
        m.reserve(&c),
        Err(ManagerError::Journal(JournalError::ReconcileRequired))
    ));

    let actions = m.reconcile(&rt).unwrap();
    let action = |id: &flagship_gpu::policy::AllocationId| {
        actions
            .iter()
            .find(|(x, _)| x == id)
            .map(|(_, a)| a.clone())
    };
    assert!(matches!(
        action(&a),
        Some(ReconcileAction::Settled(Settle::Quarantined(_)))
    ));
    assert_eq!(state(&m, &a), AllocationState::Quarantined);
    assert_eq!(
        action(&b),
        Some(ReconcileAction::Adopted),
        "untouched partition keeps running"
    );
    assert!(rt.stops.lock().unwrap().contains(&a));
    // The re-partitioned card needs maintenance; other cards admit again.
    let quarantined: Vec<_> = m
        .store()
        .quarantined()
        .unwrap()
        .into_iter()
        .map(|(d, _)| d)
        .collect();
    assert_eq!(quarantined, vec![a100_mig(&parts).id]);
    assert!(reserved(&mut m, &c));
    let d = admitted(&m, "d", "app-d", &part);
    assert!(!reserved(&mut m, &d));
}

#[test]
fn queue_is_fair_across_apps() {
    let (mut m, _) = one_h100();
    let rt = FakeRuntime::default();
    let a1 = admitted(&m, "a1", "app-a", &Ask::default());
    let a2 = admitted(&m, "a2", "app-a", &Ask::default());
    let b1 = admitted(&m, "b1", "app-b", &Ask::default());
    for id in [&a1, &a2, &b1] {
        m.enqueue(id).unwrap();
    }
    let mut order = Vec::new();
    for _ in 0..3 {
        let got = m.pump().unwrap();
        assert_eq!(got.len(), 1, "one device, one job at a time");
        let id = got[0].clone();
        m.attach(&id, Some(&cdi_for(&m, &id))).unwrap();
        m.started(&id).unwrap();
        m.drain(&id, &rt, "done").unwrap();
        assert_eq!(m.settle(&id, &rt).unwrap(), Settle::Released);
        order.push(id);
    }
    assert_eq!(order, vec![a1, b1, a2]);
    assert!(m.pump().unwrap().is_empty());
}

#[test]
fn attach_injects_exactly_the_reservation() {
    let (mut m, _) = four_h100();
    let a = admitted(&m, "a", "app-a", &Ask::default());
    assert!(reserved(&mut m, &a));
    let broader = ValidatedCdi {
        devices: vec!["nvidia.com/gpu=0".into(), "nvidia.com/gpu=1".into()],
        spec_digest: "sha256:00".into(),
    };
    assert!(matches!(
        m.attach(&a, Some(&broader)),
        Err(ManagerError::Attach(_))
    ));
    assert!(matches!(m.attach(&a, None), Err(ManagerError::Attach(_))));
    let plan = m.attach(&a, Some(&cdi_for(&m, &a))).unwrap();
    assert_eq!(plan.cdi_devices, ["nvidia.com/gpu=0"]);
    assert_eq!(plan.isolation, IsolationProfile::GvisorNvproxy);
    assert!(plan.image.reference.contains("@sha256:"));
    assert_eq!(state(&m, &a), AllocationState::Attached);
}

#[test]
fn amd_and_intel_are_never_cuda_and_pass_through_only_when_safe() {
    let mut safe = device("mi210-a", Backend::AmdRocm, 0x740f, 0x03, 65_520, 0);
    safe.capabilities
        .insert(flagship_gpu::device::Capability::Compute);
    let mut shared = device("mi210-b", Backend::AmdRocm, 0x740f, 0x04, 65_520, 1);
    shared
        .iommu_group_members
        .push(flagship_gpu::device::PciAddress::parse("0000:05:00.0").unwrap());
    let p = FakeProvider::new(Backend::AmdRocm, vec![shared, safe.clone()]);
    let mut m = manager(mem(), vec![p as Arc<dyn DeviceProvider>], Topology::new());

    // Asking for CUDA finds no device on an AMD-only host.
    let cuda = admitted(&m, "cuda", "app-a", &Ask::default());
    assert!(!reserved(&mut m, &cuda));
    // ROCm under gVisor isn't a qualified profile.
    let gv = admitted(
        &m,
        "gv",
        "app-a",
        &Ask {
            backend: Backend::AmdRocm,
            ..Ask::default()
        },
    );
    assert!(!reserved(&mut m, &gv));
    // ROCm in a VM: only the device alone in its IOMMU group.
    let vm = admitted(
        &m,
        "vm",
        "app-a",
        &Ask {
            backend: Backend::AmdRocm,
            isolation: IsolationProfile::VmPassthrough,
            ..Ask::default()
        },
    );
    let ReserveOutcome::Reserved(rec) = m.reserve(&vm).unwrap() else {
        panic!("the safe MI210 is free");
    };
    assert_eq!(rec.claims[0].device, safe.id);
    assert!(
        m.attach(&vm, Some(&cdi_for(&m, &vm))).is_err(),
        "VM takes no CDI"
    );
    let plan = m.attach(&vm, None).unwrap();
    assert_eq!(plan.vfio_functions, safe.iommu_group_members);
    assert!(plan.cdi_devices.is_empty());
}

#[test]
fn display_owned_devices_are_never_handed_out() {
    let mut d = h100(0);
    d.display_owned = true;
    let p = FakeProvider::new(Backend::NvidiaCuda, vec![d]);
    let mut m = manager(mem(), vec![p as Arc<dyn DeviceProvider>], Topology::new());
    let a = admitted(&m, "a", "app-a", &Ask::default());
    match m.reserve(&a).unwrap() {
        ReserveOutcome::NoCapacity(why) => assert!(why.iter().any(|w| w.contains("display"))),
        ReserveOutcome::Reserved(_) => panic!("display GPU handed out"),
    }
}

#[test]
fn request_shapes_are_checked() {
    let (m, _) = one_h100();
    let bad = [
        Ask {
            count: 0,
            ..Ask::default()
        },
        Ask {
            count: 17,
            ..Ask::default()
        },
        Ask {
            count: 2,
            policy: cooperative("family"),
            ..Ask::default()
        },
        Ask {
            policy: AllocationPolicy::Partition,
            isolation: IsolationProfile::VmPassthrough,
            ..Ask::default()
        },
    ];
    for (i, ask) in bad.iter().enumerate() {
        let r = m.request(aid(&format!("bad{i}")), gpu_request("app", ask), false);
        assert!(matches!(r, Err(ManagerError::Request(_))), "case {i}");
    }
}

#[test]
fn real_nvidia_fixture_reserves_the_idle_mig_partition() {
    use flagship_gpu::provider::{FixtureTools, Tool};
    use flagship_gpu::vendor::nvidia::NvidiaProvider;
    let tools =
        Arc::new(FixtureTools::new().with(Tool::NvidiaSmiQueryXml, fixture("nvidia-smi-q-x.xml")));
    let p: Arc<dyn DeviceProvider> = Arc::new(NvidiaProvider::new(tools));
    let mut m = manager(mem(), vec![p], Topology::new());
    assert_eq!(m.inventory().len(), 2);
    let part = Ask {
        policy: AllocationPolicy::Partition,
        ..Ask::default()
    };
    let a = admitted(&m, "a", "app-a", &part);
    let ReserveOutcome::Reserved(rec) = m.reserve(&a).unwrap() else {
        panic!("MIG 2.0 is idle");
    };
    assert_eq!(
        rec.claims[0].cdi_name, "1:1",
        "1.0 has a process nobody accounts for"
    );
    // The RTX 4090 isn't in the catalog, and it's busy with a foreign process.
    let b = admitted(&m, "b", "app-b", &Ask::default());
    assert!(!reserved(&mut m, &b));
    // Release needs proof the default cleanup can't give: quarantine.
    let rt = FakeRuntime::default();
    m.attach(&a, Some(&cdi_for(&m, &a))).unwrap();
    m.drain(&a, &rt, "done").unwrap();
    assert!(matches!(m.settle(&a, &rt).unwrap(), Settle::Quarantined(_)));
}

//! The gpud JSON operations, job supervision and the driver pipeline's
//! edges, plus the whole simulated matrix (`selftest::run`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::sync::Arc;

use flagship_gpu::catalog::VerifiedCatalog;
use flagship_gpu::catalog_trust::{CatalogTrust, ReleaseKeyVerifier};
use flagship_gpu::device::{Backend, Capability};
use flagship_gpu::jobs::{JobBook, JobKind, JobSpec, JobState};
use flagship_gpu::maintenance::{
    DriverMaintenance, MaintError, MaintState, MaintenanceStore, PostBoot, Proposal,
};
use flagship_gpu::manager::{Presence, WorkloadRuntime};
use flagship_gpu::owner_approval::OwnerAnchorSource;
use flagship_gpu::policy::{AllocationId, AllocationPolicy};
use flagship_gpu::provider::IsolationProfile;
use flagship_gpu::request::GpuRequest;
use flagship_gpu::service::{CatalogSource, GpuService, ServiceConfig, ServiceParts};
use flagship_gpu::sim::{SimDrivers, SimGpu, SimHost, SimRuntime};
use flagship_gpu::testkit::{
    TestOwner, TestSigner, app, approval, envelope, sim_host_facts, sim_payload, trust_json,
};
use flagship_gpu::topology::GangRequirement;
use serde_json::json;

const NOW: u64 = 1_800_000_000_000;

fn catalog(d: &SimDrivers, extra: &[&str], advisories: bool) -> VerifiedCatalog {
    let s = TestSigner::new(5).unwrap();
    let mut p = sim_payload(2, d, extra);
    if advisories {
        p.advisories.push(flagship_gpu::catalog::DriverAdvisory {
            id: "FSA-2026-11".into(),
            backend: Backend::NvidiaCuda,
            drivers: vec![d.nvidia.clone()],
            reason: "driver escape".into(),
        });
    }
    let e = envelope(&p, &[&s], false, NOW).unwrap();
    let t = CatalogTrust::from_trust_json(&trust_json(&[&s], 1, false)).unwrap();
    VerifiedCatalog::open(&e, &ReleaseKeyVerifier::new(t, NOW), 0).unwrap()
}

fn svc(
    dir: &std::path::Path,
    gpus: Vec<SimGpu>,
    cat: CatalogSource,
) -> (SimHost, Arc<SimRuntime>, GpuService) {
    let host = SimHost::new(dir.join("h"), gpus).unwrap();
    let rt = host.runtime();
    let s = open_svc(dir, &host, cat).unwrap();
    (host, rt, s)
}

/// gpud (again) on a host whose devices and workloads carry on: what a restart looks like.
fn open_svc(
    dir: &std::path::Path,
    host: &SimHost,
    cat: CatalogSource,
) -> Result<GpuService, String> {
    let d = host.drivers();
    let parts = ServiceParts {
        tools: host.tools(),
        runtime: host.runtime(),
        scrub: host.scrubber(),
        sysfs_writer: host.sysfs_writer(),
        packages: None,
    };
    let mut c = ServiceConfig::system(dir.join("state"), cat, sim_host_facts(&d));
    c.sys_root = host.sys_root();
    c.proc_root = host.proc_root();
    c.dev_root = host.dev_root();
    c.cdi_dir = host.cdi_dir();
    c.enforce_root_owned_cdi = false;
    c.run_claims_path = dir.join("run-claims.json");
    c.rocm_version = Some(d.rocm.clone());
    c.owner_anchor = OwnerAnchorSource::Fixed(owner().anchor());
    GpuService::new(c, parts)
}

fn owner() -> TestOwner {
    TestOwner::new(0x0a)
}

/// An app's claim, its approval signed by the owner.
fn claim_args(id: &str, app_name: &str) -> serde_json::Value {
    owner().sign_claim(&json!({
        "allocationId": id,
        "app": app(app_name, 1),
        "operationId": "op",
        "container": format!("flagship-{app_name}"),
        "requirement": {"backend": "nvidia-cuda", "capabilities": ["compute"], "minimumMemoryMiB": 1024},
        "approval": approval(app(app_name, 1), Backend::NvidiaCuda, IsolationProfile::GvisorNvproxy, &[Capability::Compute], false, None),
    }))
}

#[test]
fn a_host_without_accelerators_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let (_h, _r, s) = svc(dir.path(), Vec::new(), CatalogSource::Missing);
    let inv = s.inventory();
    assert_eq!(inv["available"], false);
    assert_eq!(inv["reason"], "no-accelerators");
    assert_eq!(inv["catalog"]["status"], "missing");
    let un = inv["unavailable"].to_string();
    assert!(
        un.contains("nvidia-cuda") && un.contains("amd-rocm"),
        "tools that are missing are named: {un}"
    );
}

#[test]
fn without_a_catalog_nothing_qualifies() {
    let dir = tempfile::tempdir().unwrap();
    let (_h, _r, mut s) = svc(
        dir.path(),
        vec![SimGpu::rtx4090(1)],
        CatalogSource::Invalid("bad signature".into()),
    );
    let inv = s.inventory();
    assert_eq!(inv["catalog"]["status"], "refused");
    assert!(
        inv["devices"][0]["unqualifiedReasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r.as_str().unwrap().contains("no catalog entry"))
    );
    let r = s.handle("gpu.claim", &claim_args("a", "app")).unwrap();
    assert_eq!(
        r["state"], "admitted",
        "queued, never reserved on an unqualified device"
    );
}

#[test]
fn the_json_surface_is_strict() {
    let dir = tempfile::tempdir().unwrap();
    let (_h, _r, mut s) = svc(
        dir.path(),
        vec![SimGpu::rtx4090(1)],
        CatalogSource::Loaded(catalog(&SimDrivers::default(), &[], false)),
    );
    assert_eq!(
        s.handle("gpu.nope", &json!({})).unwrap_err().code,
        "unknown-op"
    );
    let mut extra = claim_args("a", "app");
    extra["sneaky"] = json!(true);
    assert_eq!(
        s.handle("gpu.claim", &extra).unwrap_err().code,
        "bad-request"
    );
    let mut bad_id = claim_args("../etc", "app");
    bad_id["allocationId"] = json!("../etc");
    assert_eq!(
        s.handle("gpu.claim", &bad_id).unwrap_err().code,
        "bad-request"
    );
    let mut other_app = claim_args("b", "app");
    other_app["approval"]["app"]["appId"] = json!("someone-else");
    let other_app = owner().sign_claim(&other_app);
    assert_eq!(
        s.handle("gpu.claim", &other_app).unwrap_err().code,
        "forbidden"
    );
    let mut coop = claim_args("c", "app");
    coop["requirement"]["sharing"] = json!("cooperative");
    assert_eq!(
        s.handle("gpu.claim", &coop).unwrap_err().code,
        "bad-request",
        "cooperative needs the owner's share limits"
    );
    assert_eq!(
        s.handle(
            "gpu.attach",
            &json!({"allocationId": "zzz", "engine": "podman"})
        )
        .unwrap_err()
        .code,
        "not-found"
    );
    assert!(s.handle("gpu.mig.apply", &json!({"device": "gpu-00000000000000000000000000000000", "profiles": [], "maintenanceRef": ""})).is_err());
}

#[test]
fn a_withdrawn_driver_pauses_gpu_admission() {
    let dir = tempfile::tempdir().unwrap();
    let d = SimDrivers::default();
    let (_h, _r, mut s) = svc(
        dir.path(),
        vec![SimGpu::rtx4090(1)],
        CatalogSource::Loaded(catalog(&d, &[], true)),
    );
    let inv = s.inventory();
    assert!(
        inv["devices"][0]["unqualifiedReasons"]
            .to_string()
            .contains("FSA-2026-11")
    );
    assert_eq!(
        s.handle("gpu.claim", &claim_args("a", "app")).unwrap()["state"],
        "admitted"
    );
}

#[test]
fn max_runtime_is_enforced_by_the_ticker() {
    let dir = tempfile::tempdir().unwrap();
    let (h, _r, mut s) = svc(
        dir.path(),
        vec![SimGpu::rtx4090(1)],
        CatalogSource::Loaded(catalog(&SimDrivers::default(), &[], false)),
    );
    let mut a = claim_args("a", "app");
    a["maxRuntimeMs"] = json!(1000);
    assert_eq!(s.handle("gpu.claim", &a).unwrap()["state"], "reserved");
    let att = s
        .handle(
            "gpu.attach",
            &json!({"allocationId": "a", "engine": "docker"}),
        )
        .unwrap();
    assert_eq!(att["args"][0], "--runtime=runsc-nvproxy");
    let id = AllocationId::new("a").unwrap();
    let pci = s.manager().inventory()[0].pci.clone();
    h.launch(&id, &[(pci.clone(), None)], 100, 10).unwrap();
    s.handle(
        "gpu.started",
        &json!({"allocationId": "a", "nowMs": 10_000}),
    )
    .unwrap();
    let t = s.tick(10_500).unwrap();
    assert!(t["stopped"].as_array().unwrap().is_empty());
    let t = s.tick(12_000).unwrap();
    assert_eq!(t["stopped"][0]["why"], "max-runtime");
    assert_eq!(h.residue(&pci, None), 0, "stopped, scrubbed, released");
    assert!(
        s.status().unwrap()["allocations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

fn job(id: &str, kind: JobKind, caps: &[Capability], max_ms: u64, disk: u64) -> JobSpec {
    JobSpec {
        id: AllocationId::new(id).unwrap(),
        kind,
        request: GpuRequest {
            app: app("jobs", 1),
            operation_id: id.into(),
            backend: Backend::NvidiaCuda,
            count: 1,
            minimum_memory_mib: 512,
            capabilities: caps.iter().copied().collect(),
            policy: AllocationPolicy::Exclusive,
            isolation: IsolationProfile::GvisorNvproxy,
            gang: GangRequirement::Any,
            userspace: None,
        },
        max_runtime_ms: max_ms,
        disk_budget_mib: disk,
    }
}

#[test]
fn jobs_runtime_disk_cancel_and_fair_competition() {
    let dir = tempfile::tempdir().unwrap();
    let (_h, rt, mut s) = svc(
        dir.path(),
        vec![SimGpu::rtx4090(1)],
        CatalogSource::Loaded(catalog(&SimDrivers::default(), &[], false)),
    );
    let a = approval(
        app("jobs", 1),
        Backend::NvidiaCuda,
        IsolationProfile::GvisorNvproxy,
        &[Capability::Compute],
        false,
        None,
    );
    let cdi = |rec: &flagship_gpu::journal::AllocationRecord| {
        Some(flagship_gpu::cdi::ValidatedCdi {
            devices: rec
                .claims
                .iter()
                .map(|c| format!("nvidia.com/gpu={}", c.cdi_name))
                .collect(),
            spec_digest: "sha256:t".into(),
        })
    };
    let mut book = JobBook::new();
    let train = JobKind::Train {
        steps: 10,
        checkpoint_every: 2,
        dataset_digest: "sha256:abc".into(),
    };
    book.submit(
        s.manager_mut(),
        job("long", JobKind::Inference, &[Capability::Compute], 50, 100),
        Some(&a),
        false,
    )
    .unwrap();
    book.submit(
        s.manager_mut(),
        job("disk", train.clone(), &[Capability::Compute], 10_000, 1),
        Some(&a),
        false,
    )
    .unwrap();
    book.submit(
        s.manager_mut(),
        job(
            "queued",
            JobKind::Inference,
            &[Capability::Compute],
            10_000,
            100,
        ),
        Some(&a),
        false,
    )
    .unwrap();
    rt.script_job(&AllocationId::new("long").unwrap(), 1000, 0, false);
    rt.script_job(&AllocationId::new("disk").unwrap(), 1000, 50, false);
    let st = |b: &JobBook, id: &str| b.state(&AllocationId::new(id).unwrap()).cloned().unwrap();
    book.tick(s.manager_mut(), rt.as_ref(), &cdi, 0).unwrap();
    assert!(matches!(st(&book, "long"), JobState::Running { .. }));
    assert_eq!(
        st(&book, "queued"),
        JobState::Queued,
        "one device: the others wait"
    );
    book.tick(s.manager_mut(), rt.as_ref(), &cdi, 100).unwrap();
    assert!(
        matches!(st(&book, "long"), JobState::Cancelled { .. }),
        "past its max runtime"
    );
    book.tick(s.manager_mut(), rt.as_ref(), &cdi, 110).unwrap();
    book.tick(s.manager_mut(), rt.as_ref(), &cdi, 120).unwrap();
    assert!(
        matches!(st(&book, "disk"), JobState::Failed { .. }),
        "{:?}",
        st(&book, "disk")
    );
    book.cancel(
        s.manager_mut(),
        rt.as_ref(),
        &AllocationId::new("queued").unwrap(),
        "owner stopped it",
    )
    .unwrap();
    assert!(matches!(
        st(&book, "queued"),
        JobState::Cancelled { .. } | JobState::Completed { .. }
    ));
    let bad = job("x", train, &[Capability::Compute], 0, 1);
    assert!(
        book.submit(s.manager_mut(), bad, Some(&a), false).is_err(),
        "no max runtime"
    );
}

#[test]
fn driver_pipeline_edges() {
    let dir = tempfile::tempdir().unwrap();
    let d = SimDrivers::default();
    let next = "580.105.08";
    let cat = catalog(&d, &[next], false);
    let (h, _r, s) = svc(
        dir.path(),
        vec![SimGpu::rtx4090(1)],
        CatalogSource::Loaded(cat.clone()),
    );
    h.set_installed(&[("nvidia-driver", &d.nvidia)]);
    let pkgs: Vec<_> = cat
        .entries()
        .iter()
        .flat_map(|e| e.driver_packages.clone())
        .collect();
    let m = DriverMaintenance::new(
        MaintenanceStore::open(&dir.path().join("m.db")).unwrap(),
        h.packages(&pkgs),
        dir.path().join("stage"),
        "amd64",
    );
    let p = Proposal {
        id: "m1".into(),
        order_ref: String::new(),
        backend: Backend::NvidiaCuda,
        driver: next.into(),
        current_driver: Some(d.nvidia.clone()),
    };
    assert!(
        matches!(
            m.propose(&p, &cat, s.manager().host()),
            Err(MaintError::Refused(_))
        ),
        "needs the owner's order"
    );
    let p = Proposal {
        order_ref: "order".into(),
        ..p
    };
    m.propose(&p, &cat, s.manager().host()).unwrap();
    assert!(
        m.propose(
            &Proposal {
                id: "m2".into(),
                ..p.clone()
            },
            &cat,
            s.manager().host()
        )
        .is_err(),
        "one at a time"
    );
    assert!(matches!(
        m.install(0),
        Err(MaintError::WrongState(MaintState::Proposed))
    ));
    m.stage().unwrap();
    m.begin_drain().unwrap();
    assert!(m.admission_pause().unwrap().is_some());
    assert!(m.install(1).is_err(), "never while an allocation is open");
    h.set_fail_install(true);
    let r = m.install(0).unwrap();
    assert_eq!(
        r.state,
        MaintState::RollingBack,
        "a failed install rolls back"
    );
    h.reboot(flagship_gpu::device::Vendor::Nvidia).unwrap();
    let facts = |drv: &str, ok: bool| PostBoot {
        host: s.manager().host().clone(),
        drivers: vec![drv.into()],
        module_signer: Some("Flagship box MOK".into()),
        qualified: Ok(()),
        smoke: if ok {
            Ok(())
        } else {
            Err("vector add mismatch".into())
        },
    };
    let r = m.after_boot(&facts(&d.nvidia, false), None).unwrap();
    assert_eq!(
        r.state,
        MaintState::Failed,
        "a rollback that doesn't verify stops with admission paused"
    );
    assert!(m.admission_pause().unwrap().unwrap().contains("failed"));
    let reopened = DriverMaintenance::new(
        MaintenanceStore::open(&dir.path().join("m.db")).unwrap(),
        h.packages(&pkgs),
        dir.path().join("stage"),
        "amd64",
    );
    assert_eq!(
        reopened.current().unwrap().unwrap().state,
        MaintState::Failed,
        "state survives a restart"
    );
}

#[test]
fn the_simulated_matrix_passes() {
    let r = flagship_gpu::selftest::run(None);
    let failed: Vec<_> = r
        .checks
        .iter()
        .filter(|c| !c.ok)
        .map(|c| format!("{} / {}: {}", c.group, c.name, c.detail))
        .collect();
    assert!(failed.is_empty(), "{failed:#?}");
    for g in [
        "catalog",
        "inventory",
        "exclusive",
        "residue",
        "crash",
        "mig",
        "cooperative",
        "passthrough",
        "media",
        "training",
        "driver-maintenance",
    ] {
        assert!(r.checks.iter().any(|c| c.group == g), "group {g} ran");
    }
    assert!(r.passed >= 80, "{} checks", r.passed);
}

#[test]
fn driver_maintenance_through_the_gpud_operations() {
    let dir = tempfile::tempdir().unwrap();
    let d = SimDrivers::default();
    let next = "580.105.08";
    let cat = catalog(&d, &[next], false);
    let host = SimHost::new(dir.path().join("h"), vec![SimGpu::rtx4090(1)]).unwrap();
    host.set_installed(&[("nvidia-driver", &d.nvidia)]);
    let pkgs: Vec<_> = cat
        .entries()
        .iter()
        .flat_map(|e| e.driver_packages.clone())
        .collect();
    let rt = host.runtime();
    let parts = ServiceParts {
        tools: host.tools(),
        runtime: rt.clone(),
        scrub: host.scrubber(),
        sysfs_writer: host.sysfs_writer(),
        packages: Some(Arc::new(host.packages(&pkgs))),
    };
    let mk = |parts: ServiceParts| {
        let mut c = ServiceConfig::system(
            dir.path().join("state"),
            CatalogSource::Loaded(cat.clone()),
            sim_host_facts(&d),
        );
        c.sys_root = host.sys_root();
        c.proc_root = host.proc_root();
        c.dev_root = host.dev_root();
        c.cdi_dir = host.cdi_dir();
        c.enforce_root_owned_cdi = false;
        c.run_claims_path = dir.path().join("run-claims.json");
        c.owner_anchor = OwnerAnchorSource::Fixed(owner().anchor());
        GpuService::new(c, parts).unwrap()
    };
    let mut s = mk(parts.clone());
    assert_eq!(
        s.handle("gpu.claim", &claim_args("busy", "app")).unwrap()["state"],
        "reserved"
    );
    let p =
        json!({"id": "m1", "maintenanceRef": "order-9", "backend": "nvidia-cuda", "driver": next});
    s.handle("gpu.maintenance.propose", &p).unwrap();
    assert_eq!(
        s.handle("gpu.maintenance.advance", &json!({})).unwrap()["maintenance"]["state"],
        "staged"
    );
    let drained = s.handle("gpu.maintenance.advance", &json!({})).unwrap();
    assert_eq!(drained["maintenance"]["state"], "draining");
    assert!(drained["admissionPaused"].is_string());
    assert_eq!(
        s.handle("gpu.claim", &claim_args("late", "app2")).unwrap()["state"],
        "admitted",
        "paused"
    );
    let _ = s.handle("gpu.release", &json!({"allocationId": "late"}));
    let installed = s.handle("gpu.maintenance.advance", &json!({})).unwrap();
    assert_eq!(installed["maintenance"]["state"], "installed");
    assert_eq!(host.reboots(), 1);
    host.reboot(flagship_gpu::device::Vendor::Nvidia).unwrap();
    drop(s);
    let mut s = mk(parts);
    assert!(
        s.manager().admission_paused().is_some(),
        "a restart keeps admission paused mid-maintenance"
    );
    let refused = s.handle("gpu.maintenance.advance", &json!({})).unwrap();
    assert_eq!(
        refused["maintenance"]["state"], "rolling-back",
        "no smoke report, no commit"
    );
    host.reboot(flagship_gpu::device::Vendor::Nvidia).unwrap();
    let n = flagship_gpu::numerics::VECTOR_ADD_N;
    let report = json!({
        "schema": flagship_gpu::numerics::VECTOR_ADD_SCHEMA, "api": "cuda", "n": n,
        "checksum": flagship_gpu::numerics::vector_add_checksum(n),
        "samples": flagship_gpu::numerics::vector_add_sample_indices(n).into_iter().map(|i| json!([i, flagship_gpu::numerics::vector_add_value(n, i)])).collect::<Vec<_>>(),
    });
    let back = s
        .handle("gpu.maintenance.advance", &json!({"smokeReport": report}))
        .unwrap();
    assert_eq!(back["maintenance"]["state"], "rolled-back");
    assert!(
        back["admissionPaused"].is_null(),
        "the old driver verified: admission resumes"
    );
}

/// What privd and the Rust broker read (their `GpuRunClaim`): only attached allocations, with
/// the exact container, runtime and CDI devices; VFIO groups as CDI devices, never `/dev` paths.
#[test]
fn attached_claims_are_published_for_the_brokers() {
    let dir = tempfile::tempdir().unwrap();
    let (_h, _r, mut s) = svc(
        dir.path(),
        vec![SimGpu::rtx4090(1), SimGpu::mi210(3, 7, None)],
        CatalogSource::Loaded(catalog(&SimDrivers::default(), &[], false)),
    );
    let read = || -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("run-claims.json")).unwrap())
            .unwrap()
    };
    assert_eq!(read()["claims"], json!([]));
    s.handle("gpu.claim", &claim_args("a", "app")).unwrap();
    assert_eq!(read()["claims"], json!([]), "reserved is not attached");
    s.handle(
        "gpu.attach",
        &json!({"allocationId": "a", "engine": "podman"}),
    )
    .unwrap();
    let c = read();
    assert_eq!(c["schema"], "flagship/gpu-run-claims/v1");
    assert_eq!(
        c["claims"][0],
        json!({"allocationId": "a", "appId": "app", "container": "flagship-app", "runtime": "runsc-nvproxy", "devices": ["nvidia.com/gpu=0"]})
    );
    let mut vm = claim_args("v", "vmapp");
    vm["requirement"]["backend"] = json!("amd-rocm");
    vm["approval"] = serde_json::to_value(approval(
        app("vmapp", 1),
        Backend::AmdRocm,
        IsolationProfile::VmPassthrough,
        &[Capability::Compute],
        false,
        None,
    ))
    .unwrap();
    let vm = owner().sign_claim(&vm);
    assert_eq!(s.handle("gpu.claim", &vm).unwrap()["state"], "reserved");
    let att = s
        .handle(
            "gpu.attach",
            &json!({"allocationId": "v", "engine": "docker"}),
        )
        .unwrap();
    assert!(!att.to_string().contains("/dev/"), "{att}");
    let c = read();
    let v = c["claims"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["allocationId"] == "v")
        .unwrap()
        .clone();
    assert_eq!(v["runtime"], "kata-vfio");
    assert_eq!(v["devices"], json!(["flagship.vfio/group=3"]));
    let spec: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(_h.cdi_dir().join("flagship_vfio_group.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        spec["devices"][0]["containerEdits"]["deviceNodes"][0]["path"],
        "/dev/vfio/3"
    );
    s.handle("gpu.release", &json!({"allocationId": "v"}))
        .unwrap();
    s.handle("gpu.release", &json!({"allocationId": "a"}))
        .unwrap();
    assert_eq!(read()["claims"], json!([]));
    let mut bad = claim_args("b", "app");
    bad["container"] = json!("../etc");
    assert_eq!(s.handle("gpu.claim", &bad).unwrap_err().code, "bad-request");
}

/// The exact claim the daemon's local AI sends (packages/server-daemon/src/localAi/devices.ts): the
/// box's own app, exclusive and secret, with a CPU fallback. It shares the one fair queue with apps.
fn local_ai_claim(id: &str, container: &str) -> serde_json::Value {
    let app = json!({"appId": "flagship-local-ai", "installationId": "box", "generation": 1});
    json!({
        "allocationId": id,
        "container": container,
        "app": app,
        "operationId": id,
        "requirement": {"backend": "nvidia-cuda", "count": 1, "minimumMemoryMiB": 900, "capabilities": ["compute"], "sharing": "exclusive", "fallback": "cpu-if-supported"},
        "approval": {"app": app, "backend": "nvidia-cuda", "maxCount": 1, "capabilities": ["compute"], "policies": ["exclusive"], "isolation": "gvisor-nvproxy", "secrecy": true, "trustDomain": null, "ownerConsent": null},
    })
}

#[test]
fn local_ai_claims_share_the_one_fair_queue_with_apps() {
    let dir = tempfile::tempdir().unwrap();
    let (_h, _r, mut s) = svc(
        dir.path(),
        vec![SimGpu::rtx4090(1)],
        CatalogSource::Loaded(catalog(&SimDrivers::default(), &[], false)),
    );
    let serve = "localai-0123456789abcdef";
    let r = s
        .handle(
            "gpu.claim",
            &local_ai_claim(serve, "flagship-localai-0123456789abcdef"),
        )
        .unwrap();
    assert_eq!(r["state"], "reserved");
    let att = s
        .handle(
            "gpu.attach",
            &json!({"allocationId": serve, "engine": "docker"}),
        )
        .unwrap();
    assert_eq!(att["args"][0], "--runtime=runsc-nvproxy");
    let claims: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("run-claims.json")).unwrap())
            .unwrap();
    assert_eq!(
        claims["claims"][0]["container"],
        "flagship-localai-0123456789abcdef"
    );
    // An app asks while the model server holds the only GPU: it waits, it is not given a shared device.
    let app_claim = s.handle("gpu.claim", &claim_args("a", "app")).unwrap();
    assert_eq!(app_claim["state"], "admitted");
    // A fine-tuning job of the box's own queues too, behind the app (fair, in order).
    let train = s
        .handle(
            "gpu.claim",
            &local_ai_claim(
                "aitrain-1111111111111111",
                "flagship-aitrain-1111111111111111",
            ),
        )
        .unwrap();
    assert_eq!(train["state"], "admitted");
    let st = s.status().unwrap();
    assert!(st["queue"].to_string().contains("\"a\""), "{st}");
    // The idle model server releases the GPU: the app is served next.
    s.handle(
        "gpu.release",
        &json!({"allocationId": serve, "reason": "idle"}),
    )
    .unwrap();
    let _ = s.tick(NOW);
    let st = s.status().unwrap();
    let state_of = |id: &str| {
        st["allocations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["allocationId"] == id)
            .map(|x| x["state"].as_str().unwrap_or_default().to_owned())
    };
    assert_eq!(state_of("a").as_deref(), Some("reserved"), "{st}");
    assert_eq!(
        state_of("aitrain-1111111111111111").as_deref(),
        Some("admitted"),
        "{st}"
    );
}

fn coop_args(id: &str, app_name: &str, pct: u8, mem: u64) -> serde_json::Value {
    let mut a = claim_args(id, app_name);
    a["requirement"]["sharing"] = json!("cooperative");
    a["approval"] = serde_json::to_value(approval(
        app(app_name, 1),
        Backend::NvidiaCuda,
        IsolationProfile::GvisorNvproxy,
        &[Capability::Compute],
        false,
        Some("family"),
    ))
    .unwrap();
    a["share"] = json!({"computePercent": pct, "memoryMib": mem});
    owner().sign_claim(&a)
}

fn run(s: &mut GpuService, h: &SimHost, id: &str, now: u64) {
    s.handle(
        "gpu.attach",
        &json!({"allocationId": id, "engine": "podman"}),
    )
    .unwrap();
    let pci = s.manager().inventory()[0].pci.clone();
    h.launch(&AllocationId::new(id).unwrap(), &[(pci, None)], 2048, 10)
        .unwrap();
    s.handle("gpu.started", &json!({"allocationId": id, "nowMs": now}))
        .unwrap();
}

fn open_ids(s: &GpuService) -> Vec<String> {
    s.status().unwrap()["allocations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["allocationId"].as_str().unwrap().to_owned())
        .collect()
}

fn set_terms(dir: &std::path::Path, id: &str, text: Option<&str>) {
    let c = rusqlite::Connection::open(dir.join("state/journal.db")).unwrap();
    match text {
        Some(t) => c
            .execute(
                "UPDATE allocation_terms SET terms = ?2 WHERE allocation_id = ?1",
                rusqlite::params![id, t],
            )
            .unwrap(),
        None => c
            .execute(
                "DELETE FROM allocation_terms WHERE allocation_id = ?1",
                [id],
            )
            .unwrap(),
    };
}

#[test]
fn a_restarted_gpud_still_holds_sharers_to_their_budgets() {
    let dir = tempfile::tempdir().unwrap();
    let cat = || CatalogSource::Loaded(catalog(&SimDrivers::default(), &[], false));
    let (h, _r, mut s) = svc(dir.path(), vec![SimGpu::rtx4090(1)], cat());
    for (id, app_name, pct) in [("c1", "app-a", 50), ("c2", "app-b", 40)] {
        let r = s
            .handle("gpu.claim", &coop_args(id, app_name, pct, 8000))
            .unwrap();
        assert_eq!(r["state"], "reserved");
        run(&mut s, &h, id, NOW);
    }
    let c1 = AllocationId::new("c1").unwrap();
    h.set_usage(&c1, 12_000, 50);
    let t = s.tick(NOW).unwrap();
    assert!(
        t["stopped"].as_array().unwrap().is_empty(),
        "one strike: {t}"
    );
    drop(s);

    let mut s = open_svc(dir.path(), &h, cat()).unwrap();
    assert_eq!(open_ids(&s), ["c1", "c2"], "both sharers were adopted");
    assert_eq!(
        s.status().unwrap()["stoppedAtStart"],
        json!([]),
        "nothing lost"
    );
    let r = s.handle("gpu.claim", &coop_args("c3", "app-c", 30, 2000));
    assert_eq!(
        r.unwrap_err().code,
        "conflict",
        "the kept shares still fill the device's compute"
    );
    let t = s.tick(NOW + 100).unwrap();
    assert_eq!(
        t["stopped"][0]["allocationId"], "c1",
        "the strike from before the restart counts: {t}"
    );
    assert_eq!(open_ids(&s), ["c2"]);
}

#[test]
fn a_restarted_gpud_still_ends_a_job_at_its_maximum_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let cat = || CatalogSource::Loaded(catalog(&SimDrivers::default(), &[], false));
    let (h, _r, mut s) = svc(dir.path(), vec![SimGpu::rtx4090(1)], cat());
    let mut a = claim_args("a", "app");
    a["maxRuntimeMs"] = json!(1000);
    s.handle("gpu.claim", &a).unwrap();
    run(&mut s, &h, "a", 10_000);
    drop(s);
    let mut s = open_svc(dir.path(), &h, cat()).unwrap();
    assert_eq!(open_ids(&s), ["a"]);
    assert!(
        s.tick(10_500).unwrap()["stopped"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(s.tick(12_000).unwrap()["stopped"][0]["why"], "max-runtime");
    assert!(open_ids(&s).is_empty());
}

#[test]
fn lost_or_tampered_terms_stop_the_allocation_instead_of_freeing_it() {
    let hostile: [(&str, Option<&str>); 6] = [
        ("corrupt", Some("{\"v\":1,\"share\":")),
        ("deleted", None),
        (
            "unknown field",
            Some(
                r#"{"v":1,"share":{"computePercent":50,"memoryMib":8000},"maxRuntimeMs":null,"startedMs":1,"vfio":[],"container":"flagship-app-a","coop":null,"approved":true}"#,
            ),
        ),
        (
            "no share",
            Some(
                r#"{"v":1,"share":null,"maxRuntimeMs":null,"startedMs":1,"vfio":[],"container":"flagship-app-a","coop":null}"#,
            ),
        ),
        (
            "a share past the device",
            Some(
                r#"{"v":1,"share":{"computePercent":0,"memoryMib":8000},"maxRuntimeMs":null,"startedMs":1,"vfio":[],"container":"flagship-app-a","coop":null}"#,
            ),
        ),
        (
            "a forged VFIO function",
            Some(
                r#"{"v":1,"share":{"computePercent":50,"memoryMib":8000},"maxRuntimeMs":null,"startedMs":1,"vfio":[{"group":3,"functions":[["../../../../etc","nvidia"]]}],"container":"flagship-app-a","coop":null}"#,
            ),
        ),
    ];
    for (what, text) in hostile {
        let dir = tempfile::tempdir().unwrap();
        let cat = || CatalogSource::Loaded(catalog(&SimDrivers::default(), &[], false));
        let (h, _r, mut s) = svc(dir.path(), vec![SimGpu::rtx4090(1)], cat());
        s.handle("gpu.claim", &coop_args("c1", "app-a", 50, 8000))
            .unwrap();
        run(&mut s, &h, "c1", NOW);
        drop(s);
        set_terms(dir.path(), "c1", text);
        let mut s = open_svc(dir.path(), &h, cat()).unwrap();
        let st = s.status().unwrap();
        assert_eq!(
            st["stoppedAtStart"][0]["allocationId"], "c1",
            "{what}: {st}"
        );
        assert!(
            !open_ids(&s).contains(&"c1".to_owned()) || st["allocations"][0]["state"] != "running",
            "{what}: never left running without its limits: {st}"
        );
        assert_ne!(
            h.runtime().presence(&AllocationId::new("c1").unwrap()),
            Presence::Present,
            "{what}: the workload was stopped"
        );
        let _ = s.tick(NOW + 1);
        assert!(!open_ids(&s).contains(&"c1".to_owned()), "{what}: settled");
    }
}

#[test]
fn a_queued_sharer_reserved_later_still_has_to_fit() {
    let dir = tempfile::tempdir().unwrap();
    let (_h, _r, mut s) = svc(
        dir.path(),
        vec![SimGpu::rtx4090(1)],
        CatalogSource::Loaded(catalog(&SimDrivers::default(), &[], false)),
    );
    assert_eq!(
        s.handle("gpu.claim", &claim_args("x", "app-x")).unwrap()["state"],
        "reserved"
    );
    for (id, app_name, pct) in [("c1", "app-a", 50), ("c2", "app-b", 60)] {
        let r = s
            .handle("gpu.claim", &coop_args(id, app_name, pct, 4000))
            .unwrap();
        assert_eq!(r["state"], "admitted", "queued behind the exclusive holder");
    }
    s.handle("gpu.release", &json!({"allocationId": "x"}))
        .unwrap();
    let t = s.tick(NOW).unwrap();
    let ids = open_ids(&s);
    assert!(
        !(ids.contains(&"c1".to_owned()) && ids.contains(&"c2".to_owned())),
        "110 percent of the device's compute is never handed out: {t} {ids:?}"
    );
}

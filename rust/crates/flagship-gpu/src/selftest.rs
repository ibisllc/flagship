//! The simulated-device matrix: `flagship-gpud self-test` (and the
//! `gpu.selftest` op the live gym's `gpu-sim` group calls) runs the whole
//! accelerator software path against [`crate::sim`] hosts in a scratch
//! directory, through the same JSON operations the box's runtime layer
//! uses. It proves the software, never the hardware: every check is about
//! what Flagship's code does with what the vendors' tools report.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Value, json};

use crate::attach::RuntimeNames;
use crate::catalog::{CatalogEnvelope, CatalogPayload, VerifiedCatalog};
use crate::catalog_trust::{CatalogTrust, ReleaseKeyVerifier};
use crate::device::{Backend, Capability, DeviceRecord, PciAddress, Vendor};
use crate::jobs::{JobBook, JobKind, JobSpec, JobState};
use crate::maintenance::{
    DriverMaintenance, HostPackages, MaintState, MaintenanceStore, PostBoot, Proposal,
};
use crate::media::{Codec, GraphicsApi, RenderSpec, TranscodeSpec, VideoOp};
use crate::policy::{AllocationId, AllocationPolicy};
use crate::provider::{DeviceProvider, IsolationProfile, ToolProgram};
use crate::request::{GpuApproval, GpuRequest};
use crate::safetensors::FormatError;
use crate::service::{CatalogSource, GpuService, ServiceConfig, ServiceParts};
use crate::sim::{SimDrivers, SimGpu, SimHost, SimRuntime};
use crate::testkit::{
    TestSigner, app, approval, envelope, sim_host_facts, sim_payload, trust_json,
};
use crate::topology::GangRequirement;
use crate::training::{
    CheckpointKey, CheckpointStore, JobBinding, SyntheticDataset, SyntheticTrainer, TrainError,
    TrainOutcome, dataset_digest,
};

type Group = fn(&mut T, &Path) -> Result<(), String>;

pub const SELFTEST_SCHEMA: &str = "flagship/gpu-selftest/v1";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub group: String,
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfTestReport {
    pub schema: String,
    pub passed: usize,
    pub failed: usize,
    pub checks: Vec<Check>,
}

#[derive(Default)]
struct T {
    checks: Vec<Check>,
}

impl T {
    fn ok(&mut self, group: &str, name: &str, ok: bool, detail: impl Into<String>) {
        self.checks.push(Check {
            group: group.into(),
            name: name.into(),
            ok,
            detail: detail.into(),
        });
    }

    fn res<V, E: std::fmt::Display>(&mut self, group: &str, name: &str, r: &Result<V, E>) -> bool {
        let (ok, d) = match r {
            Ok(_) => (true, String::new()),
            Err(e) => (false, e.to_string()),
        };
        self.ok(group, name, ok, d);
        ok
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn scratch() -> PathBuf {
    let n = now_ms();
    std::env::temp_dir().join(format!("flagship-gpu-selftest-{}-{n}", std::process::id()))
}

struct Rig {
    host: SimHost,
    rt: Arc<SimRuntime>,
    svc: GpuService,
}

fn catalog_for(d: &SimDrivers, extra: &[&str]) -> Result<VerifiedCatalog, String> {
    let signer = TestSigner::new(7)?;
    let trust = CatalogTrust::from_trust_json(&trust_json(&[&signer], 1, true))?;
    let env = envelope(&sim_payload(5, d, extra), &[&signer], true, now_ms())?;
    VerifiedCatalog::open(&env, &ReleaseKeyVerifier::new(trust, now_ms()), 0)
        .map_err(|e| e.to_string())
}

fn rig(dir: &Path, gpus: Vec<SimGpu>, catalog: Option<VerifiedCatalog>) -> Result<Rig, String> {
    let host = SimHost::new(dir.join("host"), gpus).map_err(|e| e.to_string())?;
    let d = host.drivers();
    let catalog = match catalog {
        Some(c) => c,
        None => catalog_for(&d, &[])?,
    };
    let rt = host.runtime();
    let parts = ServiceParts {
        tools: host.tools(),
        runtime: rt.clone(),
        scrub: host.scrubber(),
        sysfs_writer: host.sysfs_writer(),
        packages: None,
    };
    let mut cfg = ServiceConfig::system(
        dir.join("state"),
        CatalogSource::Loaded(catalog),
        sim_host_facts(&d),
    );
    cfg.sys_root = host.sys_root();
    cfg.proc_root = host.proc_root();
    cfg.dev_root = host.dev_root();
    cfg.cdi_dir = host.cdi_dir();
    cfg.enforce_root_owned_cdi = false;
    cfg.run_claims_path = dir.join("run-claims.json");
    cfg.rocm_version = Some(d.rocm.clone());
    cfg.level_zero_version = Some(d.level_zero.clone());
    cfg.coop_window_ms = 1_000;
    let svc = GpuService::new(cfg, parts)?;
    Ok(Rig { host, rt, svc })
}

fn reopen(dir: &Path, r: Rig) -> Result<Rig, String> {
    let host = r.host.clone();
    drop(r);
    let d = host.drivers();
    let rt = host.runtime();
    let parts = ServiceParts {
        tools: host.tools(),
        runtime: rt.clone(),
        scrub: host.scrubber(),
        sysfs_writer: host.sysfs_writer(),
        packages: None,
    };
    let mut cfg = ServiceConfig::system(
        dir.join("state"),
        CatalogSource::Loaded(catalog_for(&d, &[])?),
        sim_host_facts(&d),
    );
    cfg.sys_root = host.sys_root();
    cfg.proc_root = host.proc_root();
    cfg.dev_root = host.dev_root();
    cfg.cdi_dir = host.cdi_dir();
    cfg.enforce_root_owned_cdi = false;
    cfg.run_claims_path = dir.join("run-claims.json");
    cfg.rocm_version = Some(d.rocm.clone());
    cfg.level_zero_version = Some(d.level_zero.clone());
    let svc = GpuService::new(cfg, parts)?;
    Ok(Rig { host, rt, svc })
}

fn requirement(
    backend: Backend,
    count: u32,
    mem: u64,
    caps: &[&str],
    sharing: &str,
    topology: &str,
) -> Value {
    json!({
        "backend": backend,
        "count": count,
        "minimumMemoryMiB": mem,
        "capabilities": caps,
        "sharing": sharing,
        "topology": topology,
    })
}

struct ClaimOpts<'a> {
    id: &'a str,
    app: &'a str,
    backend: Backend,
    isolation: IsolationProfile,
    count: u32,
    mem: u64,
    sharing: &'a str,
    domain: Option<&'a str>,
    secrecy: bool,
    topology: &'a str,
    share: Option<Value>,
}

impl<'a> ClaimOpts<'a> {
    fn new(id: &'a str, app: &'a str) -> Self {
        Self {
            id,
            app,
            backend: Backend::NvidiaCuda,
            isolation: IsolationProfile::GvisorNvproxy,
            count: 1,
            mem: 1024,
            sharing: "exclusive",
            domain: None,
            secrecy: false,
            topology: "any",
            share: None,
        }
    }
}

fn claim(svc: &mut GpuService, o: &ClaimOpts<'_>) -> Result<Value, String> {
    let a = approval(
        app(o.app, 1),
        o.backend,
        o.isolation,
        &[Capability::Compute],
        o.secrecy,
        o.domain,
    );
    let mut args = json!({
        "allocationId": o.id,
        "app": app(o.app, 1),
        "operationId": format!("op-{}", o.id),
        "container": format!("flagship-{}", o.app),
        "requirement": requirement(o.backend, o.count, o.mem, &["compute"], o.sharing, o.topology),
        "approval": a,
    });
    if let (Some(s), Some(m)) = (&o.share, args.as_object_mut()) {
        m.insert("share".into(), s.clone());
    }
    svc.handle("gpu.claim", &args)
        .map_err(|e| format!("{}: {}", e.code, e.message))
}

fn state(v: &Result<Value, String>) -> String {
    v.as_ref()
        .ok()
        .and_then(|v| v.get("state"))
        .and_then(Value::as_str)
        .unwrap_or("error")
        .to_owned()
}

/// Attach, then start the simulated workload on what the arguments name.
fn attach_and_run(r: &mut Rig, id: &str) -> Result<Value, String> {
    let att = r
        .svc
        .handle(
            "gpu.attach",
            &json!({"allocationId": id, "engine": "podman"}),
        )
        .map_err(|e| format!("{}: {}", e.code, e.message))?;
    let inv: Vec<DeviceRecord> = r.svc.manager().inventory().to_vec();
    let args: Vec<String> = att
        .get("args")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let mut targets = Vec::new();
    for (i, a) in args.iter().enumerate() {
        if a != "--device" {
            continue;
        }
        let Some(v) = args.get(i.saturating_add(1)) else {
            continue;
        };
        if let Some(g) = v.strip_prefix("flagship.vfio/group=") {
            if let Some(d) = inv
                .iter()
                .find(|d| d.iommu_group.map(|x| x.to_string()).as_deref() == Some(g))
            {
                targets.push((d.pci.clone(), None));
            }
        } else if let Some((_, name)) = v.split_once('=') {
            let (dev, part) = name
                .split_once(':')
                .map_or((name, None), |(d, _)| (d, Some(name)));
            if let Some(d) = inv.iter().find(|d| d.cdi_name == dev) {
                let p = part.and_then(|n| {
                    d.partitions
                        .iter()
                        .find(|p| p.cdi_name == n)
                        .map(|p| p.id.clone())
                });
                targets.push((d.pci.clone(), p));
            }
        }
    }
    let aid = AllocationId::new(id).ok_or("bad id")?;
    r.host
        .launch(&aid, &targets, 2048, 50)
        .map_err(|e| e.to_string())?;
    r.svc
        .handle(
            "gpu.started",
            &json!({"allocationId": id, "nowMs": now_ms()}),
        )
        .map_err(|e| e.message)?;
    Ok(att)
}

fn release(svc: &mut GpuService, id: &str) -> String {
    svc.handle("gpu.release", &json!({"allocationId": id}))
        .ok()
        .and_then(|v| v.get("settle").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| "error".into())
}

fn catalog_checks(t: &mut T) -> Result<(), String> {
    let g = "catalog";
    let a = TestSigner::new(1)?;
    let b = TestSigner::new(2)?;
    let stranger = TestSigner::new(3)?;
    let d = SimDrivers::default();
    let payload = sim_payload(9, &d, &[]);
    let now = now_ms();
    let classical = CatalogTrust::from_trust_json(&trust_json(&[&a, &b], 2, false))?;
    let pinned = CatalogTrust::from_trust_json(&trust_json(&[&a, &b], 2, true))?;
    let open = |e: &CatalogEnvelope, tr: &CatalogTrust, min: u64| {
        VerifiedCatalog::open(e, &ReleaseKeyVerifier::new(tr.clone(), now), min)
    };
    let both = envelope(&payload, &[&a, &b], false, now)?;
    t.res(
        g,
        "2-of-2 release signers verify (classical pin)",
        &open(&both, &classical, 0),
    );
    let one = envelope(&payload, &[&a], false, now)?;
    t.ok(
        g,
        "one signer is under the threshold",
        open(&one, &classical, 0).is_err(),
        "",
    );
    let foreign = envelope(&payload, &[&a, &stranger], false, now)?;
    t.ok(
        g,
        "a key outside the trust file does not count",
        open(&foreign, &classical, 0).is_err(),
        "",
    );
    let mut tampered = both.clone();
    tampered.payload = tampered.payload.replacen("580.95.05", "580.95.06", 1);
    t.ok(
        g,
        "a changed payload is refused",
        open(&tampered, &classical, 0).is_err(),
        "",
    );
    t.ok(
        g,
        "an older serial is refused (rollback)",
        open(&both, &classical, 10).is_err(),
        "",
    );
    let hybrid = envelope(&payload, &[&a, &b], true, now)?;
    t.res(
        g,
        "PQ-pinned: hybrid companions verify",
        &open(&hybrid, &pinned, 0),
    );
    t.ok(
        g,
        "PQ-pinned: a classical-only catalog is refused",
        open(&both, &pinned, 0).is_err(),
        "",
    );
    let mut stripped = hybrid.clone();
    stripped.pq_bindings.clear();
    t.ok(
        g,
        "PQ-pinned: companions without their binding are refused",
        open(&stripped, &pinned, 0).is_err(),
        "",
    );
    let mut no_receipt = payload.clone();
    if let Some(e) = no_receipt.entries.first_mut() {
        e.receipts.clear();
    }
    let e = envelope(&no_receipt, &[&a, &b], false, now)?;
    t.ok(
        g,
        "an entry without a hardware receipt is refused",
        open(&e, &classical, 0).is_err(),
        "",
    );
    let mut tag = payload;
    if let Some(i) = tag.entries.first_mut().and_then(|e| e.images.first_mut()) {
        i.reference = "registry.flagship.test/cuda:latest".into();
    }
    let e = envelope(&tag, &[&a, &b], false, now)?;
    t.ok(
        g,
        "a mutable image tag is refused",
        open(&e, &classical, 0).is_err(),
        "",
    );
    Ok(())
}

fn inventory_checks(t: &mut T, dir: &Path) -> Result<(), String> {
    let g = "inventory";
    let r = rig(
        dir,
        vec![
            SimGpu::rtx4090(0x01),
            SimGpu::a100_mig(0x41, &[9, 14]),
            SimGpu::mi210(0x03, 61748, None),
            SimGpu::rx7900_display(0x0c, 51000),
            SimGpu::flex170(0x4d),
        ],
        None,
    )?;
    let inv = r.svc.inventory();
    let devs = inv
        .get("devices")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    t.ok(
        g,
        "every vendor's devices are enumerated",
        devs.len() == 5,
        format!("{} devices", devs.len()),
    );
    let text = inv.to_string();
    t.ok(
        g,
        "no vendor UUID leaves the box",
        !text.contains("sim-nvidia") && !text.contains("sim-amd"),
        "",
    );
    let amd_cuda = devs.iter().any(|d| {
        d.get("vendor") == Some(&json!("amd")) && d.get("backend") == Some(&json!("nvidia-cuda"))
    });
    t.ok(g, "an AMD device is never CUDA", !amd_cuda, "");
    let display = devs
        .iter()
        .filter(|d| d.get("displayOwned") == Some(&json!(true)))
        .count();
    t.ok(
        g,
        "the display card is marked display-owned",
        display == 1,
        format!("{display}"),
    );
    let mig = devs
        .iter()
        .find(|d| d.get("partitionMode") == Some(&json!("enabled")));
    t.ok(
        g,
        "MIG partitions are reported",
        mig.and_then(|m| m.get("partitions"))
            .and_then(Value::as_array)
            .is_some_and(|p| p.len() == 2),
        "",
    );
    let qualified = devs
        .iter()
        .filter(|d| {
            d.get("qualified")
                .and_then(Value::as_array)
                .is_some_and(|q| !q.is_empty())
        })
        .count();
    t.ok(
        g,
        "every simulated model qualifies against the matching catalog",
        qualified == 5,
        format!("{qualified}"),
    );
    t.ok(
        g,
        "the CDI spec was generated and written",
        inv.pointer("/cdi/status") == Some(&json!("written")),
        inv.pointer("/cdi")
            .map(Value::to_string)
            .unwrap_or_default(),
    );
    let amd = r
        .svc
        .manager()
        .inventory()
        .iter()
        .find(|d| d.vendor == Vendor::Amd && !d.display_owned)
        .cloned()
        .ok_or("no amd")?;
    r.host.fail_tool(ToolProgram::AmdSmi, true);
    let prov = crate::vendor::amd::AmdProvider::new(r.host.tools(), None).with_observer_roots(
        crate::observe::ObserverRoots {
            sys: r.host.sys_root(),
            proc: r.host.proc_root(),
        },
    );
    let idle = prov.observe(&amd, None);
    let aid = AllocationId::new("observe-probe").ok_or("id")?;
    r.host
        .launch(&aid, &[(amd.pci.clone(), None)], 100, 10)
        .map_err(|e| e.to_string())?;
    let busy = prov.observe(&amd, None);
    t.ok(
        g,
        "AMD: with amd-smi down, KFD and DRM fdinfo still see processes",
        idle == crate::provider::DeviceActivity::Idle
            && matches!(busy, crate::provider::DeviceActivity::Busy { .. }),
        format!("{idle:?} then {busy:?}"),
    );
    let none = crate::vendor::amd::AmdProvider::new(r.host.tools(), None).observe(&amd, None);
    t.ok(
        g,
        "AMD: with nothing readable the answer is unknown, never idle",
        none == crate::provider::DeviceActivity::Unknown,
        format!("{none:?}"),
    );
    Ok(())
}

fn lifecycle_checks(t: &mut T, dir: &Path) -> Result<(), String> {
    let g = "exclusive";
    let mut r = rig(dir, vec![SimGpu::rtx4090(0x01)], None)?;
    let a = claim(&mut r.svc, &ClaimOpts::new("a1", "app-a"));
    t.ok(
        g,
        "a claim on a free qualified device is reserved",
        state(&a) == "reserved",
        format!("{a:?}"),
    );
    let b = claim(&mut r.svc, &ClaimOpts::new("b1", "app-b"));
    t.ok(
        g,
        "a second app's claim waits in the queue (no double allocation)",
        state(&b) == "admitted",
        format!("{b:?}"),
    );
    let a2 = claim(&mut r.svc, &ClaimOpts::new("a2", "app-a"));
    t.ok(
        g,
        "the first app's second job queues behind the other app",
        state(&a2) == "admitted",
        "",
    );
    let mut na = ClaimOpts::new("x1", "app-x");
    na.backend = Backend::AmdRocm;
    na.isolation = IsolationProfile::VmPassthrough;
    let x = claim(&mut r.svc, &na);
    t.ok(
        g,
        "a backend the host lacks never becomes CUDA",
        state(&x) != "reserved",
        format!("{x:?}"),
    );
    let unapproved = r.svc.handle("gpu.claim", &json!({
        "allocationId": "u1", "app": app("app-u", 1), "operationId": "op", "container": "flagship-app-u",
        "requirement": requirement(Backend::NvidiaCuda, 1, 1024, &["compute", "graphics"], "exclusive", "any"),
        "approval": approval(app("app-u", 1), Backend::NvidiaCuda, IsolationProfile::GvisorNvproxy, &[Capability::Compute], false, None),
    }));
    t.ok(
        g,
        "graphics without a graphics approval is refused",
        unapproved
            .as_ref()
            .err()
            .is_some_and(|e| e.code == "forbidden"),
        "",
    );
    let att = attach_and_run(&mut r, "a1");
    let args = att.as_ref().map(|v| v.to_string()).unwrap_or_default();
    t.ok(
        g,
        "attach gives runsc-nvproxy and exactly the reserved CDI device",
        args.contains("--runtime=runsc-nvproxy")
            && args.contains("nvidia.com/gpu=0")
            && !args.contains("=all"),
        args.clone(),
    );
    let pid = r
        .host
        .spawn_foreign(
            &r.svc
                .manager()
                .inventory()
                .first()
                .map(|d| d.pci.clone())
                .ok_or("dev")?,
            None,
        )
        .map_err(|e| e.to_string())?;
    let s = release(&mut r.svc, "a1");
    t.ok(
        g,
        "release is held while a process is still on the device",
        s.starts_with("held"),
        s.clone(),
    );
    r.host.kill(pid).map_err(|e| e.to_string())?;
    let s = r
        .svc
        .handle("gpu.settle", &json!({"allocationId": "a1"}))
        .map(|v| v.to_string())
        .unwrap_or_default();
    t.ok(
        g,
        "release is proven once the device is idle and scrubbed",
        s.contains("released"),
        s.clone(),
    );
    let pci = r
        .svc
        .manager()
        .inventory()
        .first()
        .map(|d| d.pci.clone())
        .ok_or("dev")?;
    t.ok(
        g,
        "no residue canary survives between tenants",
        r.host.residue(&pci, None) == 0,
        "",
    );
    let tick = r
        .svc
        .tick(now_ms())
        .map(|v| v.to_string())
        .unwrap_or_default();
    t.ok(
        g,
        "the fair queue serves the other app next",
        tick.contains("b1") && !tick.contains("a2"),
        tick,
    );
    Ok(())
}

fn residue_checks(t: &mut T, dir: &Path) -> Result<(), String> {
    let g = "residue";
    let mut r = rig(dir, vec![SimGpu::rtx4090(0x01)], None)?;
    let pci = r
        .svc
        .manager()
        .inventory()
        .first()
        .map(|d| d.pci.clone())
        .ok_or("dev")?;
    r.host
        .edit_gpu(&pci, |g| g.scrub_broken = true)
        .map_err(|e| e.to_string())?;
    claim(&mut r.svc, &ClaimOpts::new("a1", "app-a"))?;
    attach_and_run(&mut r, "a1")?;
    let s = release(&mut r.svc, "a1");
    t.ok(
        g,
        "an unproven scrub quarantines the device",
        s.starts_with("quarantined"),
        s,
    );
    let b = claim(&mut r.svc, &ClaimOpts::new("b1", "app-b"));
    t.ok(
        g,
        "a quarantined device is not handed to the next tenant",
        state(&b) == "admitted",
        format!("{b:?}"),
    );
    let dev = r
        .svc
        .manager()
        .inventory()
        .first()
        .map(|d| d.id.to_string())
        .ok_or("dev")?;
    let no_ref = r.svc.handle(
        "gpu.quarantine.clear",
        &json!({"device": dev, "maintenanceRef": ""}),
    );
    t.ok(
        g,
        "clearing a quarantine needs a maintenance order",
        no_ref.is_err(),
        "",
    );
    r.host
        .edit_gpu(&pci, |g| g.scrub_broken = false)
        .map_err(|e| e.to_string())?;
    let ok = r.svc.handle(
        "gpu.quarantine.clear",
        &json!({"device": dev, "maintenanceRef": "order-1"}),
    );
    let _ = r.svc.tick(now_ms());
    let st = r
        .svc
        .handle("gpu.status", &json!({}))
        .map(|v| v.to_string())
        .unwrap_or_default();
    t.ok(
        g,
        "after maintenance the queued tenant gets the device",
        ok.is_ok() && st.contains("\"reserved\""),
        st,
    );
    Ok(())
}

fn crash_checks(t: &mut T, dir: &Path) -> Result<(), String> {
    let g = "crash";
    let mut r = rig(dir, vec![SimGpu::rtx4090(0x01)], None)?;
    claim(&mut r.svc, &ClaimOpts::new("a1", "app-a"))?;
    attach_and_run(&mut r, "a1")?;
    let aid = AllocationId::new("a1").ok_or("id")?;
    r.host.crash(&aid);
    let r = reopen(dir, r)?;
    let st = r.svc.status().map(|v| v.to_string()).unwrap_or_default();
    t.ok(
        g,
        "after a broker restart a crashed workload's device stays held",
        st.contains("a1"),
        st,
    );
    let mut r = r;
    r.host.reap(&aid).map_err(|e| e.to_string())?;
    let s = r
        .svc
        .handle("gpu.settle", &json!({"allocationId": "a1"}))
        .map(|v| v.to_string())
        .unwrap_or_default();
    t.ok(
        g,
        "once the driver reaps it, the settle proves and releases",
        s.contains("released"),
        s,
    );
    claim(&mut r.svc, &ClaimOpts::new("b1", "app-b"))?;
    attach_and_run(&mut r, "b1")?;
    r.host.set_runtime_unknown(true);
    let s = release(&mut r.svc, "b1");
    t.ok(
        g,
        "an unknown runtime answer never frees a device",
        s.starts_with("held"),
        s,
    );
    r.host.set_runtime_unknown(false);
    let rev = r
        .svc
        .handle("gpu.revokeApp", &json!({"appId": "app-b"}))
        .map(|v| v.to_string())
        .unwrap_or_default();
    t.ok(
        g,
        "revoking the app drains and settles its allocation",
        rev.contains("released"),
        rev,
    );
    Ok(())
}

fn mig_checks(t: &mut T, dir: &Path) -> Result<(), String> {
    let g = "mig";
    let mut r = rig(dir, vec![SimGpu::a100_mig(0x41, &[9, 9])], None)?;
    let mut o = ClaimOpts::new("p1", "app-a");
    o.sharing = "partition";
    let a = claim(&mut r.svc, &o);
    let mut o2 = ClaimOpts::new("p2", "app-b");
    o2.sharing = "partition";
    let b = claim(&mut r.svc, &o2);
    t.ok(
        g,
        "two apps hold separate partitions at once",
        state(&a) == "reserved" && state(&b) == "reserved",
        format!("{a:?} {b:?}"),
    );
    let mut o3 = ClaimOpts::new("p3", "app-c");
    o3.sharing = "partition";
    t.ok(
        g,
        "a third claim waits: no partition is shared",
        state(&claim(&mut r.svc, &o3)) == "admitted",
        "",
    );
    let whole = claim(&mut r.svc, &ClaimOpts::new("w1", "app-d"));
    t.ok(
        g,
        "a MIG-enabled device is never claimed whole",
        state(&whole) == "admitted",
        "",
    );
    let att = attach_and_run(&mut r, "p1")
        .map(|v| v.to_string())
        .unwrap_or_default();
    t.ok(
        g,
        "attach names one partition's CDI device",
        att.contains("nvidia.com/gpu=0:"),
        att,
    );
    let dev = r
        .svc
        .manager()
        .inventory()
        .first()
        .map(|d| d.id.to_string())
        .ok_or("dev")?;
    let busy = r.svc.handle(
        "gpu.mig.apply",
        &json!({"device": dev, "profiles": ["7g.40gb"], "maintenanceRef": "m1"}),
    );
    t.ok(
        g,
        "re-partitioning a held device is refused",
        busy.is_err(),
        "",
    );
    for id in ["p1", "p2", "p3", "w1"] {
        let _ = release(&mut r.svc, id);
    }
    let gen_before = r.svc.manager().generation();
    let ok = r.svc.handle("gpu.mig.apply", &json!({"device": dev, "profiles": ["3g.20gb", "2g.10gb", "1g.5gb"], "maintenanceRef": "m1"}));
    t.ok(
        g,
        "a free device takes a new layout (broker-only, with an order)",
        ok.is_ok(),
        format!("{ok:?}"),
    );
    t.ok(
        g,
        "the layout change moves the topology generation",
        r.svc.manager().generation() > gen_before,
        "",
    );
    let parts = r
        .svc
        .manager()
        .inventory()
        .first()
        .map_or(0, |d| d.partitions.len());
    t.ok(
        g,
        "the new partitions are in the inventory",
        parts == 3,
        format!("{parts}"),
    );
    Ok(())
}

fn coop_checks(t: &mut T, dir: &Path) -> Result<(), String> {
    let g = "cooperative";
    let mut r = rig(dir, vec![SimGpu::rtx4090(0x01)], None)?;
    let mk = |id: &'static str, app: &'static str, pct: u8, mem: u64, domain: &'static str| {
        let mut o = ClaimOpts::new(id, app);
        o.sharing = "cooperative";
        o.domain = Some(domain);
        o.share = Some(json!({"computePercent": pct, "memoryMib": mem}));
        o
    };
    let a = claim(&mut r.svc, &mk("c1", "app-a", 50, 8000, "family"));
    let b = claim(&mut r.svc, &mk("c2", "app-b", 40, 8000, "family"));
    t.ok(
        g,
        "two sharers of one trust domain share the device",
        state(&a) == "reserved" && state(&b) == "reserved",
        format!("{a:?} {b:?}"),
    );
    let c = claim(&mut r.svc, &mk("c3", "app-c", 30, 2000, "family"));
    t.ok(
        g,
        "compute shares may not add up past the device",
        c.is_err(),
        format!("{c:?}"),
    );
    let d = claim(&mut r.svc, &mk("c4", "app-d", 5, 1000, "work"));
    t.ok(
        g,
        "another trust domain never joins",
        state(&d) != "reserved",
        format!("{d:?}"),
    );
    let mut sec = mk("c5", "app-e", 5, 1000, "family");
    sec.secrecy = true;
    t.ok(
        g,
        "an app that needs secrecy never shares",
        state(&claim(&mut r.svc, &sec)) != "reserved",
        "",
    );
    attach_and_run(&mut r, "c1")?;
    attach_and_run(&mut r, "c2")?;
    let c1 = AllocationId::new("c1").ok_or("id")?;
    r.host.set_usage(&c1, 12_000, 50);
    let t0 = now_ms();
    let _ = r.svc.tick(t0);
    let _ = r.svc.tick(t0.saturating_add(100));
    let tick = r
        .svc
        .tick(t0.saturating_add(200))
        .map(|v| v.to_string())
        .unwrap_or_default();
    let st = r.svc.status().map(|v| v.to_string()).unwrap_or_default();
    t.ok(
        g,
        "a sharer over its memory budget is revoked; the other keeps running",
        !st.contains("\"c1\"") && st.contains("\"c2\""),
        format!("{tick} {st}"),
    );
    Ok(())
}

fn passthrough_checks(t: &mut T, dir: &Path) -> Result<(), String> {
    let g = "passthrough";
    let mut shared = SimGpu::flex170(0x4d);
    shared.shares_group_with = PciAddress::parse("0000:00:1f.3");
    let mut r = rig(
        dir,
        vec![
            SimGpu::mi210(0x03, 61748, None),
            shared,
            SimGpu::rx7900_display(0x0c, 51000),
        ],
        None,
    )?;
    let mut o = ClaimOpts::new("v1", "app-a");
    o.backend = Backend::AmdRocm;
    o.isolation = IsolationProfile::VmPassthrough;
    let a = claim(&mut r.svc, &o);
    t.ok(
        g,
        "AMD is claimed for a dedicated VM, never a container",
        state(&a) == "reserved",
        format!("{a:?}"),
    );
    let att = attach_and_run(&mut r, "v1")
        .map(|v| v.to_string())
        .unwrap_or_default();
    t.ok(
        g,
        "attach binds the IOMMU group to vfio-pci and runs Kata",
        att.contains("--runtime=kata-vfio") && att.contains("flagship.vfio/group=3"),
        att,
    );
    let drv = std::fs::read_link(
        r.host
            .sys_root()
            .join("bus/pci/devices/0000:03:00.0/driver"),
    )
    .ok()
    .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()));
    t.ok(
        g,
        "every function of the group is on vfio-pci while the VM runs",
        drv.as_deref() == Some("vfio-pci"),
        format!("{drv:?}"),
    );
    let s = release(&mut r.svc, "v1");
    let drv = std::fs::read_link(
        r.host
            .sys_root()
            .join("bus/pci/devices/0000:03:00.0/driver"),
    )
    .ok()
    .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()));
    t.ok(
        g,
        "release resets the device and gives it back to amdgpu",
        s == "released" && drv.as_deref() == Some("amdgpu"),
        format!("{s} {drv:?}"),
    );
    let mut o = ClaimOpts::new("v2", "app-b");
    o.backend = Backend::IntelLevelZero;
    o.isolation = IsolationProfile::VmPassthrough;
    let b = claim(&mut r.svc, &o);
    t.ok(
        g,
        "a device whose IOMMU group is shared is refused",
        state(&b) != "reserved",
        format!("{b:?}"),
    );
    let inv = r.svc.inventory().to_string();
    t.ok(
        g,
        "the display-owned card is never offered for passthrough",
        inv.contains("drives a display"),
        "",
    );
    Ok(())
}

fn media_checks(t: &mut T, dir: &Path) -> Result<(), String> {
    let g = "media";
    let r = rig(dir, vec![SimGpu::rtx4090(0x01)], None)?;
    let Rig { host, rt, mut svc } = r;
    let mut book = JobBook::new();
    let job =
        |id: &str, kind: JobKind, caps: &[Capability]| -> Result<(JobSpec, GpuApproval), String> {
            let a = approval(
                app("media-app", 1),
                Backend::NvidiaCuda,
                IsolationProfile::GvisorNvproxy,
                caps,
                false,
                None,
            );
            let req = GpuRequest {
                app: app("media-app", 1),
                operation_id: id.into(),
                backend: Backend::NvidiaCuda,
                count: 1,
                minimum_memory_mib: 1024,
                capabilities: caps.iter().copied().collect(),
                policy: AllocationPolicy::Exclusive,
                isolation: IsolationProfile::GvisorNvproxy,
                gang: GangRequirement::Any,
                userspace: None,
            };
            Ok((
                JobSpec {
                    id: AllocationId::new(id).ok_or("id")?,
                    kind,
                    request: req,
                    max_runtime_ms: 60_000,
                    disk_budget_mib: 512,
                },
                a,
            ))
        };
    let render = JobKind::Render(RenderSpec {
        api: GraphicsApi::Egl,
        width: 64,
        height: 48,
    });
    let (s, a) = job("r0", render.clone(), &[Capability::Compute])?;
    let refused = book.submit(svc.manager_mut(), s, Some(&a), false);
    t.ok(
        g,
        "a render job is refused without the graphics capability",
        refused.is_err(),
        "",
    );
    let (s, a) = job("r1", render, &[Capability::Graphics])?;
    t.res(
        g,
        "a render job with graphics approved is queued",
        &book.submit(svc.manager_mut(), s, Some(&a), false),
    );
    let tc = JobKind::Transcode(TranscodeSpec {
        codec: Codec::H264,
        op: VideoOp::RoundTrip,
        width: 32,
        height: 16,
        frames: 4,
    });
    let (s, a) = job("v1", tc.clone(), &[Capability::VideoDecode])?;
    t.ok(
        g,
        "encode needs its own permission (decode alone is not enough)",
        book.submit(svc.manager_mut(), s, Some(&a), false).is_err(),
        "",
    );
    let (s, a) = job(
        "v2",
        tc,
        &[Capability::VideoEncode, Capability::VideoDecode],
    )?;
    t.res(
        g,
        "a round-trip transcode with both video permissions is queued",
        &book.submit(svc.manager_mut(), s, Some(&a), false),
    );
    let cdi = |rec: &crate::journal::AllocationRecord| -> Option<crate::cdi::ValidatedCdi> {
        Some(crate::cdi::ValidatedCdi {
            devices: rec
                .claims
                .iter()
                .map(|c| format!("nvidia.com/gpu={}", c.cdi_name))
                .collect(),
            spec_digest: "sha256:selftest".into(),
        })
    };
    let mut now = now_ms();
    for _ in 0..12 {
        now = now.saturating_add(10);
        book.tick(svc.manager_mut(), rt.as_ref(), &cdi, now)
            .map_err(|e| e.to_string())?;
    }
    let st = |id: &str| AllocationId::new(id).and_then(|i| book.state(&i).cloned());
    t.ok(
        g,
        "the rendered frame matches the reference scene",
        matches!(st("r1"), Some(JobState::Completed { .. })),
        format!("{:?}", st("r1")),
    );
    t.ok(
        g,
        "the decoded clip is within the PSNR floor",
        matches!(st("v2"), Some(JobState::Completed { .. })),
        format!("{:?}", st("v2")),
    );
    let (s, a) = job(
        "r2",
        JobKind::Render(RenderSpec {
            api: GraphicsApi::Vulkan,
            width: 64,
            height: 48,
        }),
        &[Capability::Graphics],
    )?;
    let r2 = s.id.clone();
    book.submit(svc.manager_mut(), s, Some(&a), false)
        .map_err(|e| e.to_string())?;
    rt.script_job(&r2, 2, 0, true);
    for _ in 0..6 {
        now = now.saturating_add(10);
        book.tick(svc.manager_mut(), rt.as_ref(), &cdi, now)
            .map_err(|e| e.to_string())?;
    }
    t.ok(
        g,
        "output that does not match the fixture fails the job",
        matches!(book.state(&r2), Some(JobState::Failed { .. })),
        format!("{:?}", book.state(&r2)),
    );
    let (s, a) = job("r3", JobKind::Inference, &[Capability::Compute])?;
    let r3 = s.id.clone();
    book.submit(svc.manager_mut(), s, Some(&a), false)
        .map_err(|e| e.to_string())?;
    rt.script_job(&r3, 100, 0, false);
    now = now.saturating_add(10);
    book.tick(svc.manager_mut(), rt.as_ref(), &cdi, now)
        .map_err(|e| e.to_string())?;
    book.revoke_app(svc.manager_mut(), rt.as_ref(), "media-app")
        .map_err(|e| e.to_string())?;
    t.ok(
        g,
        "a job is revoked with its app's approval",
        matches!(book.state(&r3), Some(JobState::Revoked { .. })),
        format!("{:?}", book.state(&r3)),
    );
    drop(host);
    Ok(())
}

fn training_checks(t: &mut T, dir: &Path) -> Result<(), String> {
    let g = "training";
    let mut r = rig(
        dir,
        vec![
            SimGpu::h100(0x10, "nvl0", 0),
            SimGpu::h100(0x11, "nvl0", 0),
            SimGpu::h100(0x12, "nvl0", 0),
            SimGpu::h100(0x13, "nvl1", 1),
        ],
        None,
    )?;
    let mut o = ClaimOpts::new("t1", "trainer");
    o.count = 3;
    o.topology = "peer-fabric";
    o.mem = 40_000;
    let a = claim(&mut r.svc, &o);
    let held: usize = r
        .svc
        .status()
        .ok()
        .and_then(|v| {
            v.pointer("/allocations/0/devices")
                .and_then(Value::as_array)
                .map(Vec::len)
        })
        .unwrap_or(0);
    t.ok(
        g,
        "a 3-GPU gang on one NVLink island is admitted atomically",
        state(&a) == "reserved" && held == 3,
        format!("{a:?}"),
    );
    let mut o2 = ClaimOpts::new("t2", "trainer2");
    o2.count = 2;
    o2.topology = "peer-fabric";
    let b = claim(&mut r.svc, &o2);
    let partial = r.svc.status().map(|v| v.to_string()).unwrap_or_default();
    t.ok(
        g,
        "a gang that cannot fit holds nothing (no partial reservation)",
        state(&b) == "admitted"
            && !partial
                .contains("\"t2\",\"appId\":\"trainer2\",\"generation\":1,\"state\":\"reserved\""),
        "",
    );
    let mut o3 = ClaimOpts::new("t3", "big");
    o3.mem = 200_000;
    let c = claim(&mut r.svc, &o3);
    t.ok(
        g,
        "a job asking for more VRAM than any device has never reserves",
        state(&c) != "reserved",
        format!("{c:?}"),
    );
    let att = attach_and_run(&mut r, "t1")
        .map(|v| v.to_string())
        .unwrap_or_default();
    t.ok(
        g,
        "the gang attaches all three devices",
        ["gpu=0", "gpu=1", "gpu=2"].iter().all(|d| att.contains(d)),
        att,
    );
    let s = release(&mut r.svc, "t1");
    t.ok(
        g,
        "cancelling the training job releases every gang member",
        s == "released",
        s,
    );

    let data = SyntheticDataset::generate(42, 256, 4);
    let file = data.to_file();
    let digest = dataset_digest(&[("train.safetensors".into(), file.clone())]);
    let loaded = SyntheticDataset::from_file(&file).map_err(|e| e.to_string())?;
    t.ok(
        g,
        "the synthetic dataset round-trips as safetensors",
        loaded == data,
        "",
    );
    let binding = JobBinding {
        job_id: "train-1".into(),
        app: app("trainer", 1),
        dataset_digest: digest.clone(),
    };
    let key = CheckpointKey::new([9; 32]);
    let trainer = SyntheticTrainer {
        ranks: 3,
        batch: 24,
        lr: 0.01,
    };
    let full_store = CheckpointStore::new(dir.join("ckpt-full"), key.clone(), 3, 64 * 1024 * 1024);
    let full = trainer
        .train(&loaded, &full_store, &binding, 60, 10, &|_| false)
        .map_err(|e| e.to_string())?;
    let store = CheckpointStore::new(dir.join("ckpt"), key.clone(), 3, 64 * 1024 * 1024);
    let cut = trainer
        .train(&loaded, &store, &binding, 60, 10, &|s| s == 35)
        .map_err(|e| e.to_string())?;
    t.ok(
        g,
        "cancellation stops the job before the next step",
        cut == TrainOutcome::Cancelled { at_step: 35 },
        format!("{cut:?}"),
    );
    let resumed = trainer
        .train(&loaded, &store, &binding, 60, 10, &|_| false)
        .map_err(|e| e.to_string())?;
    let same = match (&full, &resumed) {
        (
            TrainOutcome::Completed { weights: a, .. },
            TrainOutcome::Completed {
                weights: b,
                resumed_from,
                ..
            },
        ) => a == b && *resumed_from == Some(30),
        _ => false,
    };
    t.ok(
        g,
        "resume from the step-30 checkpoint ends bit-identical to an uninterrupted run",
        same,
        format!("{resumed:?}"),
    );
    let loss_ok = matches!(&full, TrainOutcome::Completed { loss, .. } if *loss < 1.0);
    t.ok(
        g,
        "the synthetic job converges",
        loss_ok,
        format!("{full:?}"),
    );
    let other = JobBinding {
        app: app("trainer", 2),
        ..binding.clone()
    };
    let (none, skipped) = store.latest(&other);
    t.ok(
        g,
        "a checkpoint is never resumed by another app generation",
        none.is_none() && !skipped.is_empty(),
        "",
    );
    let newest = std::fs::read_dir(dir.join("ckpt"))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .max()
        .ok_or("no checkpoint")?;
    std::fs::write(newest.join("weights.safetensors"), b"\x80\x04\x95 pickle")
        .map_err(|e| e.to_string())?;
    let (fallback, skipped) = store.latest(&binding);
    t.ok(
        g,
        "a tampered checkpoint is skipped for the previous good one",
        fallback.is_some() && !skipped.is_empty(),
        format!("{skipped:?}"),
    );
    let pickle = store.save(
        &binding,
        99,
        &[("weights.safetensors".into(), b"\x80\x04\x95".to_vec())],
    );
    t.ok(
        g,
        "a pickle checkpoint is refused before it is written",
        matches!(pickle, Err(TrainError::Format(FormatError::Pickle))),
        "",
    );
    let tiny = CheckpointStore::new(dir.join("ckpt-tiny"), key, 3, 100);
    let w = crate::training::Weights::zero(4).to_file(1);
    let over = tiny.save(&binding, 1, &[("weights.safetensors".into(), w)]);
    t.ok(
        g,
        "a checkpoint over the disk budget fails and leaves the store as it was",
        matches!(over, Err(TrainError::DiskBudget { .. })),
        format!("{over:?}"),
    );
    Ok(())
}

fn maintenance_checks(t: &mut T, dir: &Path) -> Result<(), String> {
    let g = "driver-maintenance";
    let d = SimDrivers::default();
    let next = "580.105.08";
    let cat = catalog_for(&d, &[next])?;
    let mut r = rig(dir, vec![SimGpu::rtx4090(0x01)], Some(cat.clone()))?;
    let pkgs: Vec<_> = cat
        .entries()
        .iter()
        .flat_map(|e| e.driver_packages.clone())
        .collect();
    r.host.set_installed(&[("nvidia-driver", &d.nvidia)]);
    let m = DriverMaintenance::new(
        MaintenanceStore::open_in_memory().map_err(|e| e.to_string())?,
        r.host.packages(&pkgs),
        dir.join("staging"),
        if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "amd64"
        },
    );
    let p = Proposal {
        id: "m1".into(),
        order_ref: "order-7".into(),
        backend: Backend::NvidiaCuda,
        driver: next.into(),
        current_driver: Some(d.nvidia.clone()),
    };
    let bogus = Proposal {
        driver: "999.0".into(),
        id: "m0".into(),
        ..p.clone()
    };
    t.ok(
        g,
        "a driver the catalog does not list is refused",
        m.propose(&bogus, &cat, r.svc.manager().host()).is_err(),
        "",
    );
    t.res(
        g,
        "the owner's order proposes a catalog driver",
        &m.propose(&p, &cat, r.svc.manager().host()),
    );
    let staged = m.stage().map_err(|e| e.to_string())?;
    t.ok(
        g,
        "every package matches its pinned digest",
        staged.state == MaintState::Staged,
        format!("{:?}", staged.reason),
    );
    m.begin_drain().map_err(|e| e.to_string())?;
    claim(&mut r.svc, &ClaimOpts::new("a1", "app-a"))?;
    let pause = m.admission_pause().map_err(|e| e.to_string())?;
    r.svc.manager_mut().set_admission_paused(pause.clone());
    let rt = r.rt.clone();
    r.svc
        .manager_mut()
        .drain_all(rt.as_ref(), "driver maintenance")
        .map_err(|e| e.to_string())?;
    let _ = r.svc.tick(now_ms());
    let q = claim(&mut r.svc, &ClaimOpts::new("b1", "app-b"));
    t.ok(
        g,
        "admission pauses while the driver changes",
        pause.is_some() && state(&q) == "admitted",
        format!("{q:?}"),
    );
    let open = r
        .svc
        .manager()
        .open_allocations()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|a| a.state != crate::journal::AllocationState::Admitted)
        .count();
    let _ = r.svc.manager_mut().cancel(
        &AllocationId::new("b1").ok_or("id")?,
        rt.as_ref(),
        "maintenance",
    );
    let inst = m.install(open).map_err(|e| e.to_string())?;
    t.ok(
        g,
        "install records the rollback set and asks for a reboot",
        inst.state == MaintState::Installed && r.host.reboots() == 1 && !inst.previous.is_empty(),
        "",
    );
    r.host.reboot(Vendor::Nvidia).map_err(|e| e.to_string())?;
    let r2 = reopen(dir, r)?;
    let drivers: Vec<String> = r2
        .svc
        .manager()
        .inventory()
        .iter()
        .map(|x| x.driver_version.clone())
        .collect();
    let facts = PostBoot {
        host: r2.svc.manager().host().clone(),
        drivers,
        module_signer: r2.host.module_signer(),
        qualified: Ok(()),
        smoke: Ok(()),
    };
    let done = m
        .after_boot(&facts, Some("Flagship box MOK"))
        .map_err(|e| e.to_string())?;
    t.ok(
        g,
        "after the reboot the new driver verifies and commits",
        done.state == MaintState::Committed,
        format!("{:?} {:?}", done.state, done.reason),
    );
    let p2 = Proposal {
        id: "m2".into(),
        driver: d.nvidia.clone(),
        current_driver: Some(next.into()),
        ..p.clone()
    };
    m.propose(&p2, &cat, r2.svc.manager().host())
        .map_err(|e| e.to_string())?;
    m.stage().map_err(|e| e.to_string())?;
    m.begin_drain().map_err(|e| e.to_string())?;
    m.install(0).map_err(|e| e.to_string())?;
    r2.host.set_module_signer(None);
    r2.host.reboot(Vendor::Nvidia).map_err(|e| e.to_string())?;
    let facts = PostBoot {
        host: r2.svc.manager().host().clone(),
        drivers: vec![d.nvidia.clone()],
        module_signer: None,
        qualified: Ok(()),
        smoke: Ok(()),
    };
    let rb = m
        .after_boot(&facts, Some("Flagship box MOK"))
        .map_err(|e| e.to_string())?;
    t.ok(
        g,
        "an unsigned module under Secure Boot rolls back",
        rb.state == MaintState::RollingBack,
        format!("{:?}", rb.reason),
    );
    r2.host.set_module_signer(Some("Flagship box MOK"));
    r2.host.reboot(Vendor::Nvidia).map_err(|e| e.to_string())?;
    let facts = PostBoot {
        host: r2.svc.manager().host().clone(),
        drivers: vec![next.into()],
        module_signer: Some("Flagship box MOK".into()),
        qualified: Ok(()),
        smoke: Ok(()),
    };
    let back = m
        .after_boot(&facts, Some("Flagship box MOK"))
        .map_err(|e| e.to_string())?;
    t.ok(
        g,
        "the rollback verifies on the previous driver",
        back.state == MaintState::RolledBack,
        format!("{:?}", back.reason),
    );
    let mut bad = r2.host.packages(&pkgs);
    bad.tamper("nvidia-driver");
    let m2 = DriverMaintenance::new(
        MaintenanceStore::open_in_memory().map_err(|e| e.to_string())?,
        bad,
        dir.join("staging2"),
        if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "amd64"
        },
    );
    m2.propose(
        &Proposal {
            id: "m3".into(),
            ..p
        },
        &cat,
        r2.svc.manager().host(),
    )
    .map_err(|e| e.to_string())?;
    let s = m2.stage().map_err(|e| e.to_string())?;
    t.ok(
        g,
        "a package that does not match its digest stops the maintenance before install",
        s.state == MaintState::RolledBack
            && m2.packages().installed(&["nvidia-driver".into()]).is_ok(),
        format!("{:?}", s.reason),
    );
    Ok(())
}

/// Run the matrix. With `podman`, also inject a simulated CDI device into a
/// real container (the gym's on-box check).
pub fn run(podman: Option<&Path>) -> SelfTestReport {
    let root = scratch();
    let mut t = T::default();
    let groups: [(&str, Group); 10] = [
        ("inventory", inventory_checks),
        ("exclusive", lifecycle_checks),
        ("residue", residue_checks),
        ("crash", crash_checks),
        ("mig", mig_checks),
        ("cooperative", coop_checks),
        ("passthrough", passthrough_checks),
        ("media", media_checks),
        ("training", training_checks),
        ("driver-maintenance", maintenance_checks),
    ];
    if let Err(e) = catalog_checks(&mut t) {
        t.ok("catalog", "setup", false, e);
    }
    for (name, f) in groups {
        let dir = root.join(name);
        if let Err(e) = std::fs::create_dir_all(&dir)
            .map_err(|e| e.to_string())
            .and_then(|()| f(&mut t, &dir))
        {
            t.ok(name, "setup", false, e);
        }
    }
    if let Some(p) = podman {
        let dir = root.join("podman");
        match crate::podman_check::run(p, &dir, &RuntimeNames::default()) {
            Ok(checks) => {
                for (name, ok, d) in checks {
                    t.ok("podman-cdi", &name, ok, d);
                }
            }
            Err(e) => t.ok("podman-cdi", "setup", false, e),
        }
    }
    let _ = std::fs::remove_dir_all(&root);
    let failed = t.checks.iter().filter(|c| !c.ok).count();
    SelfTestReport {
        schema: SELFTEST_SCHEMA.into(),
        passed: t.checks.len().saturating_sub(failed),
        failed,
        checks: t.checks,
    }
}

/// The payload a test catalog carries, for callers that sign their own.
pub fn sim_catalog_payload(serial: u64) -> CatalogPayload {
    sim_payload(serial, &SimDrivers::default(), &[])
}

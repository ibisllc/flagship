//! G01/G02: the CDI write path (generate, sanitise, write, re-read and
//! validate) and the engine arguments a reservation turns into.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::collections::BTreeSet;

use flagship_gpu::attach::{
    RuntimeNames, ShareEnv, check_gpu_args, docker_daemon_json, engine_args,
    podman_containers_conf, runsc_nvproxy_wrapper,
};
use flagship_gpu::catalog::ApprovedImage;
use flagship_gpu::cdi::{ApprovedClaim, CdiSpec, CdiViolation, SpecOrigin, validate};
use flagship_gpu::cdi_gen::{generate_and_write, nvidia_policy, render_nodes, validate_written};
use flagship_gpu::device::{Capability, PciAddress};
use flagship_gpu::manager::AttachPlan;
use flagship_gpu::policy::AllocationId;
use flagship_gpu::provider::IsolationProfile;
use flagship_gpu::sim::{SimGpu, SimHost};
use flagship_gpu::vfio::VfioBinding;

const LIB: &str = if cfg!(target_arch = "aarch64") {
    "/usr/lib/aarch64-linux-gnu"
} else {
    "/usr/lib/x86_64-linux-gnu"
};

fn sim() -> (tempfile::TempDir, SimHost) {
    let dir = tempfile::tempdir().unwrap();
    let h = SimHost::new(
        dir.path().join("h"),
        vec![SimGpu::rtx4090(0x01), SimGpu::a100_mig(0x41, &[9, 14])],
    )
    .unwrap();
    (dir, h)
}

fn records(h: &SimHost) -> Vec<flagship_gpu::device::DeviceRecord> {
    use flagship_gpu::provider::DeviceProvider;
    let pci = flagship_gpu::sysfs::SysfsRoot::new(h.sys_root())
        .accelerators()
        .unwrap();
    flagship_gpu::vendor::nvidia::NvidiaProvider::new(h.tools())
        .enumerate(&flagship_gpu::ids::LocalIdKey::new([1; 32]), &pci)
        .unwrap()
}

fn claim(names: &[&str], nodes: &[&str], caps: &[Capability]) -> ApprovedClaim {
    ApprovedClaim {
        device_names: names.iter().map(|s| (*s).to_owned()).collect(),
        device_nodes: nodes.iter().map(|s| (*s).to_owned()).collect(),
        capabilities: caps.iter().copied().collect::<BTreeSet<_>>(),
    }
}

#[test]
fn generated_spec_is_sanitised_written_and_validated() {
    let (_d, h) = sim();
    let recs = records(&h);
    let nv: Vec<_> = recs
        .iter()
        .map(|d| (d, render_nodes(&h.sys_root(), &d.pci)))
        .collect();
    assert_eq!(nv[0].1, vec!["renderD129".to_owned()]);
    let policy = nvidia_policy("nvidia-ctk 1.18.0", "/usr/bin/nvidia-cdi-hook", LIB, &nv);
    let w = generate_and_write(
        h.tools().as_ref(),
        "nvidia-ctk 1.18.0",
        &policy,
        &h.cdi_dir(),
        false,
    )
    .unwrap();
    let text = std::fs::read_to_string(&w.path).unwrap();
    assert!(!text.contains("\"all\""), "the all device is never written");
    assert!(
        !text.contains("/dev/dri/card"),
        "display nodes are stripped"
    );
    assert!(!text.contains("nvidia-modeset") && !text.contains("nvidia-uvm-tools"));
    let whole = claim(
        &["0"],
        &["/dev/nvidia0", "/dev/dri/renderD129"],
        &[Capability::Compute],
    );
    let v = validate_written(&w, &policy, &whole).unwrap();
    assert_eq!(v.devices, vec!["nvidia.com/gpu=0".to_owned()]);
    let other = claim(&["0"], &["/dev/nvidia1"], &[Capability::Compute]);
    assert!(
        validate_written(&w, &policy, &other).is_err(),
        "nodes of another device are refused"
    );
    let all = claim(&["all"], &[], &[Capability::Compute]);
    assert!(validate_written(&w, &policy, &all).is_err());
    let untrusted = flagship_gpu::cdi_gen::WrittenSpec {
        generator: "nvidia-ctk 9.9".into(),
        ..w.clone()
    };
    assert!(
        validate_written(&untrusted, &policy, &whole).is_err(),
        "an unpinned generator"
    );
    let mut spec: CdiSpec = serde_json::from_str(&text).unwrap();
    spec.container_edits.hooks[0].args.push("--extra".into());
    std::fs::write(&w.path, serde_json::to_string(&spec).unwrap()).unwrap();
    let r = validate_written(&w, &policy, &whole).unwrap_err();
    assert!(
        matches!(r[0], CdiViolation::UntrustedGenerator(_)),
        "a changed file is refused: {r:?}"
    );
}

#[test]
fn injected_hooks_mounts_and_env_are_refused() {
    let (_d, h) = sim();
    let recs = records(&h);
    let nv: Vec<_> = recs
        .iter()
        .map(|d| (d, render_nodes(&h.sys_root(), &d.pci)))
        .collect();
    let policy = nvidia_policy("g", "/usr/bin/nvidia-cdi-hook", LIB, &nv);
    let base: CdiSpec = serde_json::from_str(
        &std::fs::read_to_string(
            generate_and_write(h.tools().as_ref(), "g", &policy, &h.cdi_dir(), false)
                .unwrap()
                .path,
        )
        .unwrap(),
    )
    .unwrap();
    let origin = SpecOrigin::HostTooling {
        generator: "g".into(),
    };
    let c = claim(
        &["0"],
        &["/dev/nvidia0", "/dev/dri/renderD129"],
        &[Capability::Compute],
    );
    assert!(validate(&base, &origin, &policy, &c).is_ok());
    let mut hook = base.clone();
    hook.container_edits.hooks.push(serde_json::from_value(serde_json::json!({"hookName": "createContainer", "path": "/bin/sh", "args": ["sh", "-c", "id"]})).unwrap());
    assert!(validate(&hook, &origin, &policy, &c).is_err());
    let mut mount = base.clone();
    mount.container_edits.mounts.push(serde_json::from_value(serde_json::json!({"hostPath": "/etc", "containerPath": "/host-etc", "options": ["ro", "bind"]})).unwrap());
    assert!(validate(&mount, &origin, &policy, &c).is_err());
    let mut env = base.clone();
    env.container_edits.env.push("LD_PRELOAD=/tmp/x.so".into());
    assert!(validate(&env, &origin, &policy, &c).is_err());
    let mut caps = base.clone();
    caps.container_edits
        .env
        .push("NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics".into());
    assert!(
        validate(&caps, &origin, &policy, &c).is_err(),
        "graphics needs its own approval"
    );
    assert_eq!(
        validate(&base, &SpecOrigin::AppSupplied, &policy, &c),
        Err(vec![CdiViolation::AppSupplied])
    );
}

#[test]
fn mig_partition_claims_use_mig_minors() {
    let (_d, h) = sim();
    let minors =
        std::fs::read_to_string(h.proc_root().join("driver/nvidia-caps/mig-minors")).unwrap();
    assert!(minors.contains("gpu1/gi1/access"));
    assert!(minors.contains("gpu1/gi2/ci0/access"));
}

fn plan(iso: IsolationProfile, cdi: &[&str], digest: Option<&str>) -> AttachPlan {
    AttachPlan {
        allocation: AllocationId::new("alloc-1").unwrap(),
        isolation: iso,
        cdi_devices: cdi.iter().map(|s| (*s).to_owned()).collect(),
        cdi_spec_digest: digest.map(str::to_owned),
        vfio_functions: Vec::new(),
        image: ApprovedImage {
            purpose: "x".into(),
            reference: format!("r/x@sha256:{}", "a".repeat(64)),
        },
        catalog_entry: "e".into(),
    }
}

#[test]
fn engine_arguments_for_both_profiles() {
    let n = RuntimeNames::default();
    let g = engine_args(
        &plan(
            IsolationProfile::GvisorNvproxy,
            &["nvidia.com/gpu=0", "nvidia.com/gpu=1"],
            Some("sha256:x"),
        ),
        &n,
        &[],
        None,
    )
    .unwrap();
    assert_eq!(
        g.args,
        vec![
            "--runtime=runsc-nvproxy",
            "--device",
            "nvidia.com/gpu=0",
            "--device",
            "nvidia.com/gpu=1",
            "--label",
            "flagship.gpu.allocation=alloc-1"
        ]
    );
    assert!(
        engine_args(
            &plan(IsolationProfile::GvisorNvproxy, &[], None),
            &n,
            &[],
            None
        )
        .is_err()
    );
    let b = VfioBinding {
        group: 12,
        functions: vec![(
            PciAddress::parse("0000:03:00.0").unwrap(),
            Some("amdgpu".into()),
        )],
    };
    let v = engine_args(
        &plan(IsolationProfile::VmPassthrough, &[], None),
        &n,
        std::slice::from_ref(&b),
        Some(ShareEnv {
            memory_mib: 4096,
            compute_percent: 25,
        }),
    )
    .unwrap();
    assert!(
        v.args.contains(&"flagship.vfio/group=12".to_owned())
            && v.args.contains(&"--runtime=kata-vfio".to_owned())
    );
    assert!(
        v.args
            .contains(&"FLAGSHIP_GPU_MEMORY_BUDGET_MIB=4096".to_owned())
    );
    assert!(
        engine_args(
            &plan(IsolationProfile::VmPassthrough, &["nvidia.com/gpu=0"], None),
            &n,
            &[b],
            None
        )
        .is_err()
    );
}

#[test]
fn the_argument_shape_is_closed() {
    let n = RuntimeNames::default();
    let s = |v: &[&str]| v.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
    assert!(
        check_gpu_args(
            &s(&["--runtime=runsc-nvproxy", "--device", "nvidia.com/gpu=0:1"]),
            &n
        )
        .is_ok()
    );
    for bad in [
        s(&["--device", "nvidia.com/gpu=0"]),
        s(&["--runtime=runc", "--device", "nvidia.com/gpu=0"]),
        s(&["--runtime=runsc-nvproxy", "--device", "nvidia.com/gpu=all"]),
        s(&["--runtime=runsc-nvproxy", "--device", "/dev/nvidia0"]),
        s(&["--runtime=runsc-nvproxy", "--gpus", "all"]),
        s(&["--runtime=runsc-nvproxy", "--privileged"]),
        s(&["--runtime=runsc-nvproxy", "-v", "/:/host"]),
        s(&["--runtime=runsc-nvproxy", "--runtime=kata-vfio"]),
        s(&["--runtime=runsc-nvproxy", "-e", "LD_PRELOAD=/x"]),
        s(&["--runtime=runsc-nvproxy", "--label", "flagship.owner=me"]),
        s(&["--runtime=kata-vfio", "--device", "/dev/vfio/12"]),
        s(&["--runtime=kata-vfio", "--device", "/dev/vfio/vfio"]),
        s(&["--runtime=kata-vfio", "--device", "example.com/gpu=0"]),
    ] {
        assert!(check_gpu_args(&bad, &n).is_err(), "{bad:?}");
    }
}

#[test]
fn runtime_registrations() {
    let n = RuntimeNames::default();
    let d = docker_daemon_json(
        &n,
        "/usr/local/bin/runsc",
        "/opt/kata/bin/containerd-shim-kata-v2",
        "/var/run/cdi",
    );
    let v: serde_json::Value = serde_json::from_str(&d).unwrap();
    assert_eq!(v["features"]["cdi"], true);
    assert_eq!(
        v["runtimes"]["runsc-nvproxy"]["runtimeArgs"][0],
        "--nvproxy"
    );
    let p = podman_containers_conf(
        &n,
        "/usr/local/lib/flagship-gpu/runsc-nvproxy",
        "/opt/kata/bin/kata-runtime",
        "/var/run/cdi",
    );
    assert!(p.contains("runsc-nvproxy = [\"/usr/local/lib/flagship-gpu/runsc-nvproxy\"]"));
    assert!(
        runsc_nvproxy_wrapper("/usr/local/bin/runsc")
            .contains("exec /usr/local/bin/runsc --nvproxy \"$@\"")
    );
}

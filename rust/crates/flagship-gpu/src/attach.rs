//! Runtime attachment (§9.3, G02): the exact container-engine arguments an
//! [`AttachPlan`] turns into, for Docker and Podman alike, and the runtime
//! registrations they need. CDI devices go in by qualified name only
//! (`--device nvidia.com/gpu=0`; Docker 25+ with its CDI feature on, or
//! Podman), never `--gpus`, `--privileged`, a raw `/dev` path or a host
//! mount. VM passthrough goes through Kata Containers with the bound group as a
//! CDI device too (`flagship.vfio/group=<n>`, a spec gpud writes for the groups
//! it bound), so no `/dev` path ever appears in an argv. [`check_gpu_args`] is
//! the shape every caller re-checks; the privileged brokers (privd, the Rust
//! broker) hold the same run to the exact claim gpud published.

use serde::{Deserialize, Serialize};

use crate::manager::AttachPlan;
use crate::policy::AllocationId;
use crate::provider::IsolationProfile;
use crate::vfio::VfioBinding;

/// The CDI kind of the VFIO groups gpud binds, `flagship.vfio/group=<n>`.
pub const VFIO_CDI_KIND: &str = "flagship.vfio/group";

/// The label every GPU workload carries, read back by the runtime's
/// presence check.
pub const ALLOCATION_LABEL: &str = "flagship.gpu.allocation";
/// Env a cooperative sharer may read to size itself (admission budgets).
pub const ENV_MEMORY_BUDGET: &str = "FLAGSHIP_GPU_MEMORY_BUDGET_MIB";
pub const ENV_COMPUTE_SHARE: &str = "FLAGSHIP_GPU_COMPUTE_PERCENT";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Engine {
    Docker,
    Podman,
}

/// Names the GPU runtimes are registered under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeNames {
    /// runsc with `--nvproxy`.
    pub gvisor_gpu: String,
    /// Kata Containers (QEMU) for VFIO groups.
    pub vm: String,
}

impl Default for RuntimeNames {
    fn default() -> Self {
        Self {
            gvisor_gpu: "runsc-nvproxy".into(),
            vm: "kata-vfio".into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineAttachment {
    pub allocation: String,
    /// Arguments for `docker run` / `podman run`, in order.
    pub args: Vec<String>,
    pub cdi_spec_digest: Option<String>,
    pub image: String,
}

/// Admission budgets a cooperative sharer is told about. They are
/// enforced by observation and revocation (`coop.rs`), not by the device.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareEnv {
    pub memory_mib: u64,
    pub compute_percent: u8,
}

pub fn engine_args(
    plan: &AttachPlan,
    names: &RuntimeNames,
    vfio: &[VfioBinding],
    share: Option<ShareEnv>,
) -> Result<EngineAttachment, String> {
    let mut args = Vec::new();
    match plan.isolation {
        IsolationProfile::GvisorNvproxy => {
            if plan.cdi_devices.is_empty() || plan.cdi_spec_digest.is_none() {
                return Err("a gVisor GPU workload needs validated CDI devices".into());
            }
            if !vfio.is_empty() {
                return Err("a gVisor GPU workload takes no VFIO group".into());
            }
            args.push(format!("--runtime={}", names.gvisor_gpu));
            for d in &plan.cdi_devices {
                args.push("--device".into());
                args.push(d.clone());
            }
        }
        IsolationProfile::VmPassthrough => {
            if vfio.is_empty() {
                return Err("VM passthrough needs a bound VFIO group".into());
            }
            if !plan.cdi_devices.is_empty() {
                return Err("VM passthrough takes no CDI devices".into());
            }
            args.push(format!("--runtime={}", names.vm));
            for b in vfio {
                args.push("--device".into());
                args.push(b.cdi_name());
            }
        }
    }
    args.push("--label".into());
    args.push(format!("{ALLOCATION_LABEL}={}", plan.allocation));
    if let Some(s) = share {
        args.push("-e".into());
        args.push(format!("{ENV_MEMORY_BUDGET}={}", s.memory_mib));
        args.push("-e".into());
        args.push(format!("{ENV_COMPUTE_SHARE}={}", s.compute_percent));
    }
    check_gpu_args(&args, names)?;
    Ok(EngineAttachment {
        allocation: plan.allocation.to_string(),
        args,
        cdi_spec_digest: plan.cdi_spec_digest.clone(),
        image: plan.image.reference.clone(),
    })
}

fn cdi_name_ok(s: &str) -> bool {
    let Some((kind, name)) = s.split_once('=') else {
        return false;
    };
    let Some((vendor, class)) = kind.split_once('/') else {
        return false;
    };
    let part = |p: &str, extra: &[u8]| {
        !p.is_empty()
            && p.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || extra.contains(&b))
    };
    part(vendor, b".-")
        && part(class, b"-")
        && name != "all"
        && !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b":-_.".contains(&b))
}

/// The only shapes a GPU attachment may add to a `run`.
pub fn check_gpu_args(args: &[String], names: &RuntimeNames) -> Result<(), String> {
    let mut i = 0usize;
    let mut runtime = false;
    while let Some(a) = args.get(i) {
        let next = args.get(i.saturating_add(1));
        match a.as_str() {
            "--device" => {
                let v = next.ok_or("--device needs a value")?;
                let kind_ok = v.starts_with("nvidia.com/gpu=") || v.starts_with(VFIO_CDI_KIND);
                if !(cdi_name_ok(v) && kind_ok) {
                    return Err(format!("device {v} is not a GPU or VFIO group CDI name"));
                }
                i = i.saturating_add(2);
            }
            "--label" => {
                let v = next.ok_or("--label needs a value")?;
                let ok = v
                    .strip_prefix(ALLOCATION_LABEL)
                    .and_then(|r| r.strip_prefix('='))
                    .and_then(AllocationId::new)
                    .is_some();
                if !ok {
                    return Err("only the allocation label may be set".into());
                }
                i = i.saturating_add(2);
            }
            "-e" => {
                let v = next.ok_or("-e needs a value")?;
                let ok = [ENV_MEMORY_BUDGET, ENV_COMPUTE_SHARE].iter().any(|k| {
                    v.strip_prefix(k)
                        .and_then(|r| r.strip_prefix('='))
                        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
                });
                if !ok {
                    return Err("only the GPU budget variables may be set".into());
                }
                i = i.saturating_add(2);
            }
            r if r.starts_with("--runtime=") => {
                let name = r.trim_start_matches("--runtime=");
                if runtime || (name != names.gvisor_gpu && name != names.vm) {
                    return Err(format!("runtime {name} is not a GPU runtime"));
                }
                runtime = true;
                i = i.saturating_add(1);
            }
            other => return Err(format!("{other} is not a GPU attachment argument")),
        }
    }
    if !runtime {
        return Err("a GPU attachment names its runtime".into());
    }
    Ok(())
}

/// Docker `daemon.json` entries: the two runtimes and the CDI feature.
pub fn docker_daemon_json(names: &RuntimeNames, runsc: &str, kata: &str, cdi_dir: &str) -> String {
    serde_json::json!({
        "runtimes": {
            names.gvisor_gpu.clone(): { "path": runsc, "runtimeArgs": ["--nvproxy"] },
            names.vm.clone(): { "path": kata },
        },
        "features": { "cdi": true },
        "cdi-spec-dirs": [cdi_dir],
    })
    .to_string()
}

/// Podman passes no per-runtime flags, so runsc's `--nvproxy` comes from a
/// wrapper; `containers.conf` registers it and Kata.
pub fn podman_containers_conf(
    names: &RuntimeNames,
    wrapper: &str,
    kata: &str,
    cdi_dir: &str,
) -> String {
    format!(
        "[engine]\ncdi_spec_dirs = [\"{cdi_dir}\"]\n\n[engine.runtimes]\n{} = [\"{wrapper}\"]\n{} = [\"{kata}\"]\n",
        names.gvisor_gpu, names.vm
    )
}

pub fn runsc_nvproxy_wrapper(runsc: &str) -> String {
    format!(
        "#!/bin/sh\n# flagship-gpud: runsc with nvproxy for GPU workloads (attach.rs)\nexec {runsc} --nvproxy \"$@\"\n"
    )
}

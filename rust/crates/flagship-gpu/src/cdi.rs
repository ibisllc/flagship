//! CDI spec validation. A CDI spec's hooks, mounts, env and device nodes are
//! privileged host configuration, so a spec is accepted only if it came from
//! pinned host tooling and every edit it would inject for the claimed
//! devices is on an allowlist and no broader than the approved claim.

use std::collections::BTreeSet;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::device::Capability;

const CDI_VERSIONS: &[&str] = &["0.5.0", "0.6.0", "0.7.0", "0.8.0"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CdiSpec {
    pub cdi_version: String,
    pub kind: String,
    #[serde(default)]
    pub annotations: std::collections::BTreeMap<String, String>,
    pub devices: Vec<CdiDevice>,
    #[serde(default)]
    pub container_edits: ContainerEdits,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CdiDevice {
    pub name: String,
    #[serde(default)]
    pub annotations: std::collections::BTreeMap<String, String>,
    pub container_edits: ContainerEdits,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContainerEdits {
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub device_nodes: Vec<DeviceNode>,
    #[serde(default)]
    pub mounts: Vec<Mount>,
    #[serde(default)]
    pub hooks: Vec<Hook>,
    #[serde(default, rename = "additionalGIDs")]
    pub additional_gids: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceNode {
    pub path: String,
    #[serde(default)]
    pub host_path: Option<String>,
    #[serde(default, rename = "type")]
    pub node_type: Option<String>,
    #[serde(default)]
    pub major: Option<i64>,
    #[serde(default)]
    pub minor: Option<i64>,
    #[serde(default)]
    pub file_mode: Option<u32>,
    #[serde(default)]
    pub permissions: Option<String>,
    #[serde(default)]
    pub uid: Option<u32>,
    #[serde(default)]
    pub gid: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mount {
    pub host_path: String,
    pub container_path: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default, rename = "type")]
    pub mount_type: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hook {
    pub hook_name: String,
    pub path: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub timeout: Option<i64>,
}

/// Who wrote the spec. Only the broker's own generation path from pinned
/// tooling produces `HostTooling`; anything an app or image carries is
/// `AppSupplied` and is refused outright.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpecOrigin {
    HostTooling { generator: String },
    AppSupplied,
}

/// A hook the pinned toolkit is allowed to run, matched exactly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PinnedHook {
    pub hook_name: String,
    pub path: String,
    pub args: Vec<String>,
}

/// Per-backend allowlist, part of the endorsed release.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CdiPolicy {
    pub kind: String,
    pub trusted_generators: Vec<String>,
    pub hooks: Vec<PinnedHook>,
    /// Read-only bind sources (driver libraries, firmware).
    pub mount_host_prefixes: Vec<String>,
    /// Control nodes every claim of this backend needs (`/dev/nvidiactl`).
    pub shared_device_nodes: Vec<String>,
    /// `KEY` names a spec may set.
    pub env_keys: Vec<String>,
    pub additional_gids: Vec<u32>,
}

/// What the broker approved for this allocation, resolved to CDI terms.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovedClaim {
    /// CDI device names (`0`, `0:1`) the allocation reserved.
    pub device_names: Vec<String>,
    /// The per-device nodes those devices own (`/dev/nvidia0`, a MIG
    /// partition's `/dev/nvidia-caps/nvidia-capN`, `/dev/dri/renderD128`).
    pub device_nodes: Vec<String>,
    pub capabilities: BTreeSet<Capability>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CdiViolation {
    AppSupplied,
    UntrustedGenerator(String),
    Version(String),
    Kind(String),
    AllDevice,
    ClaimNamesAll,
    UnknownDevice(String),
    DuplicateDevice(String),
    Hook(String),
    HookEnv(String),
    Mount(String),
    DeviceNode(String),
    ManagementNode(String),
    Env(String),
    DriverCapability(String),
    Gid(u32),
}

/// A spec that passed, reduced to what may be injected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedCdi {
    /// Fully qualified (`nvidia.com/gpu=0`), only the claimed devices.
    pub devices: Vec<String>,
    /// `sha256:` of the canonical JSON of the spec that was checked, so the
    /// runtime can refuse a file that changed after validation.
    pub spec_digest: String,
}

/// Nodes that grant management or display control, never per-workload.
fn is_management_node(p: &str) -> bool {
    matches!(
        p,
        "/dev/nvidia-modeset" | "/dev/nvidia-uvm-tools" | "/dev/mem" | "/dev/kmem" | "/dev/port"
    ) || p == "/dev/nvidia-caps/nvidia-cap1"
        || p == "/dev/nvidia-caps/nvidia-cap2"
        || (p.starts_with("/dev/dri/card") && p.len() > "/dev/dri/card".len())
        || p.starts_with("/dev/vfio/")
}

fn clean_abs(p: &str) -> bool {
    let path = Path::new(p);
    path.is_absolute()
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
}

fn under(p: &str, prefix: &str) -> bool {
    let prefix = prefix.trim_end_matches('/');
    p == prefix
        || p.strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// NVIDIA_DRIVER_CAPABILITIES words a claim's capabilities allow.
fn driver_caps_allowed(caps: &BTreeSet<Capability>) -> BTreeSet<&'static str> {
    let mut s = BTreeSet::new();
    for c in caps {
        match c {
            Capability::Compute => {
                s.insert("compute");
                s.insert("utility");
            }
            Capability::Graphics => {
                s.insert("graphics");
            }
            Capability::VideoEncode | Capability::VideoDecode => {
                s.insert("video");
            }
        }
    }
    s
}

impl CdiSpec {
    /// The host generator's raw spec minus the `all` device. The broker
    /// writes this, never the raw output, into the root-owned spec dir.
    #[must_use]
    pub fn without_all(mut self) -> Self {
        self.devices.retain(|d| d.name != "all");
        self
    }
}

fn check_edits(
    edits: &ContainerEdits,
    policy: &CdiPolicy,
    claim: &ApprovedClaim,
    out: &mut Vec<CdiViolation>,
) {
    for h in &edits.hooks {
        let pinned = policy
            .hooks
            .iter()
            .any(|p| p.hook_name == h.hook_name && p.path == h.path && p.args == h.args);
        if !pinned {
            out.push(CdiViolation::Hook(format!("{} {}", h.hook_name, h.path)));
        }
        if !h.env.is_empty() {
            out.push(CdiViolation::HookEnv(h.path.clone()));
        }
    }
    for m in &edits.mounts {
        let ok_type = m.mount_type.as_deref().is_none_or(|t| t == "bind");
        let ro = m.options.iter().any(|o| o == "ro") && !m.options.iter().any(|o| o == "rw");
        let host_ok = clean_abs(&m.host_path)
            && policy
                .mount_host_prefixes
                .iter()
                .any(|p| under(&m.host_path, p));
        let target_ok = clean_abs(&m.container_path)
            && ![
                "/proc",
                "/sys",
                "/dev",
                "/data",
                "/run",
                "/etc/flagship",
                "/var/run",
            ]
            .iter()
            .any(|p| under(&m.container_path, p))
            && m.container_path != "/";
        if !(ok_type && ro && host_ok && target_ok) {
            out.push(CdiViolation::Mount(format!(
                "{} -> {}",
                m.host_path, m.container_path
            )));
        }
    }
    for n in &edits.device_nodes {
        let host = n.host_path.as_deref().unwrap_or(&n.path);
        if is_management_node(&n.path) || is_management_node(host) {
            out.push(CdiViolation::ManagementNode(n.path.clone()));
            continue;
        }
        let allowed = |p: &str| {
            claim.device_nodes.iter().any(|d| d == p)
                || policy.shared_device_nodes.iter().any(|d| d == p)
        };
        let ok = clean_abs(&n.path)
            && under(&n.path, "/dev")
            && host == n.path
            && allowed(&n.path)
            && n.permissions
                .as_deref()
                .is_none_or(|p| p.chars().all(|c| "rw".contains(c)));
        if !ok {
            out.push(CdiViolation::DeviceNode(n.path.clone()));
        }
    }
    let allowed_caps = driver_caps_allowed(&claim.capabilities);
    for e in &edits.env {
        let Some((k, v)) = e.split_once('=') else {
            out.push(CdiViolation::Env(e.clone()));
            continue;
        };
        if !policy.env_keys.iter().any(|a| a == k) || k.starts_with("LD_") {
            out.push(CdiViolation::Env(k.to_owned()));
            continue;
        }
        match k {
            "NVIDIA_VISIBLE_DEVICES" if v != "void" => out.push(CdiViolation::Env(e.clone())),
            "NVIDIA_DRIVER_CAPABILITIES" => {
                for word in v.split(',') {
                    if !allowed_caps.contains(word.trim()) {
                        out.push(CdiViolation::DriverCapability(word.trim().to_owned()));
                    }
                }
            }
            _ => {}
        }
    }
    for g in &edits.additional_gids {
        if !policy.additional_gids.contains(g) {
            out.push(CdiViolation::Gid(*g));
        }
    }
}

/// Validate `spec` for `claim`. Returns every violation, not just the first.
pub fn validate(
    spec: &CdiSpec,
    origin: &SpecOrigin,
    policy: &CdiPolicy,
    claim: &ApprovedClaim,
) -> Result<ValidatedCdi, Vec<CdiViolation>> {
    let mut v = Vec::new();
    match origin {
        SpecOrigin::AppSupplied => return Err(vec![CdiViolation::AppSupplied]),
        SpecOrigin::HostTooling { generator } => {
            if !policy.trusted_generators.contains(generator) {
                v.push(CdiViolation::UntrustedGenerator(generator.clone()));
            }
        }
    }
    if !CDI_VERSIONS.contains(&spec.cdi_version.as_str()) {
        v.push(CdiViolation::Version(spec.cdi_version.clone()));
    }
    if spec.kind != policy.kind {
        v.push(CdiViolation::Kind(spec.kind.clone()));
    }
    if spec.devices.iter().any(|d| d.name == "all") {
        v.push(CdiViolation::AllDevice);
    }
    let mut seen = BTreeSet::new();
    for d in &spec.devices {
        if !seen.insert(d.name.as_str()) {
            v.push(CdiViolation::DuplicateDevice(d.name.clone()));
        }
    }
    check_edits(&spec.container_edits, policy, claim, &mut v);
    for name in &claim.device_names {
        if name == "all" || name.contains('*') {
            v.push(CdiViolation::ClaimNamesAll);
            continue;
        }
        match spec.devices.iter().find(|d| d.name == *name) {
            Some(d) => check_edits(&d.container_edits, policy, claim, &mut v),
            None => v.push(CdiViolation::UnknownDevice(name.clone())),
        }
    }
    if !v.is_empty() {
        return Err(v);
    }
    let canonical = serde_json::to_vec(spec).unwrap_or_default();
    let digest = Sha256::digest(&canonical);
    let mut spec_digest = String::from("sha256:");
    for b in digest.iter() {
        spec_digest.push_str(&format!("{b:02x}"));
    }
    Ok(ValidatedCdi {
        devices: claim
            .device_names
            .iter()
            .map(|n| format!("{}={n}", spec.kind))
            .collect(),
        spec_digest,
    })
}

/// The spec file and its directory must be root-owned, not group- or
/// world-writable, and not a symlink.
pub fn check_spec_metadata(uid: u32, mode: u32, is_symlink: bool) -> Result<(), String> {
    if is_symlink {
        return Err("CDI spec path is a symlink".into());
    }
    if uid != 0 {
        return Err("CDI spec is not owned by root".into());
    }
    if mode & 0o022 != 0 {
        return Err("CDI spec is writable by group or others".into());
    }
    Ok(())
}

#[cfg(unix)]
pub fn check_spec_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    for p in [Some(path), path.parent()].into_iter().flatten() {
        let m =
            std::fs::symlink_metadata(p).map_err(|_| "CDI spec path is unreadable".to_owned())?;
        check_spec_metadata(m.uid(), m.mode(), m.file_type().is_symlink())?;
    }
    Ok(())
}

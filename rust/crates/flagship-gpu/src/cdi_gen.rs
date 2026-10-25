//! The broker's CDI write path (§9.3): run the pinned generator, drop the
//! `all` device and every display/management node, write the JSON spec atomically into the root-owned spec
//! directory, check the file's ownership and mode, and only then validate it
//! for a claim. The hook allowlist is built from the inventory, so a hook
//! that names a device or library path the broker didn't expect is refused.
//! Specs are regenerated whenever the inventory fingerprint changes (driver,
//! MIG or device changes).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::cdi::{
    ApprovedClaim, CdiPolicy, CdiSpec, CdiViolation, PinnedHook, SpecOrigin, ValidatedCdi,
    check_spec_file, spec_digest, validate,
};
use crate::device::{Backend, DeviceRecord, PciAddress};
use crate::provider::{Tool, ToolRunner};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WrittenSpec {
    pub path: PathBuf,
    pub spec: CdiSpec,
    pub digest: String,
    pub generator: String,
}

/// Render nodes (`renderD128`) the kernel lists for one PCI function.
pub fn render_nodes(sys: &Path, pci: &PciAddress) -> Vec<String> {
    let Ok(rd) = fs::read_dir(sys.join("bus/pci/devices").join(pci.as_str()).join("drm")) else {
        return Vec::new();
    };
    let mut out: Vec<String> = rd
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .filter(|n| {
            n.strip_prefix("renderD")
                .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
        })
        .collect();
    out.sort();
    out
}

/// The NVIDIA allowlist for this inventory: the pinned `nvidia-cdi-hook`
/// with `update-ldcache` for the driver's library directory and one
/// `create-symlinks` per render node, the driver's read-only library and
/// binary paths, the shared control nodes, and the env keys the toolkit
/// sets.
pub fn nvidia_policy(
    generator: &str,
    hook_path: &str,
    lib_dir: &str,
    devices: &[(&DeviceRecord, Vec<String>)],
) -> CdiPolicy {
    let mut hooks = vec![PinnedHook {
        hook_name: "createContainer".into(),
        path: hook_path.into(),
        args: vec![
            "nvidia-cdi-hook".into(),
            "update-ldcache".into(),
            "--folder".into(),
            lib_dir.into(),
        ],
    }];
    for (d, renders) in devices {
        for r in renders {
            hooks.push(PinnedHook {
                hook_name: "createContainer".into(),
                path: hook_path.into(),
                args: vec![
                    "nvidia-cdi-hook".into(),
                    "create-symlinks".into(),
                    "--link".into(),
                    format!("../{r}::/dev/dri/by-path/pci-{}-render", d.pci.as_str()),
                ],
            });
        }
    }
    CdiPolicy {
        kind: Backend::NvidiaCuda.cdi_kind().into(),
        trusted_generators: vec![generator.into()],
        hooks,
        mount_host_prefixes: vec![
            lib_dir.into(),
            "/usr/bin/nvidia-smi".into(),
            "/usr/bin/nvidia-debugdump".into(),
            "/usr/bin/nvidia-persistenced".into(),
            "/usr/share/nvidia".into(),
            "/lib/firmware/nvidia".into(),
            "/usr/share/glvnd/egl_vendor.d".into(),
            "/usr/share/vulkan/icd.d".into(),
            "/usr/share/egl/egl_external_platform.d".into(),
        ],
        shared_device_nodes: vec!["/dev/nvidiactl".into(), "/dev/nvidia-uvm".into()],
        env_keys: vec![
            "NVIDIA_VISIBLE_DEVICES".into(),
            "NVIDIA_DRIVER_CAPABILITIES".into(),
        ],
        additional_gids: Vec::new(),
    }
}

fn kind_file(kind: &str) -> String {
    kind.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>()
        + ".json"
}

/// Generate, sanitise and write the spec. `enforce_root` is off only in
/// tests and the self-test, which run as an unprivileged user.
pub fn generate_and_write(
    tools: &dyn ToolRunner,
    generator: &str,
    policy: &CdiPolicy,
    dir: &Path,
    enforce_root: bool,
) -> Result<WrittenSpec, String> {
    let raw = tools
        .output(&Tool::NvidiaCtkCdiGenerate)
        .map_err(|e| e.to_string())?;
    let spec: CdiSpec = serde_json::from_str(&raw)
        .map_err(|e| format!("generator output is not a CDI spec: {e}"))?;
    if spec.kind != policy.kind {
        return Err(format!(
            "generator wrote kind {}, expected {}",
            spec.kind, policy.kind
        ));
    }
    let spec = spec.sanitized();
    let text = serde_json::to_string_pretty(&spec).map_err(|e| e.to_string())?;
    let path = dir.join(kind_file(&spec.kind));
    let tmp = dir.join(format!(".{}.tmp", kind_file(&spec.kind)));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("spec write: {}", e.kind()))?;
        f.write_all(text.as_bytes())
            .and_then(|()| f.sync_all())
            .map_err(|e| format!("spec write: {}", e.kind()))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o644))
            .map_err(|e| format!("spec mode: {}", e.kind()))?;
    }
    fs::rename(&tmp, &path).map_err(|e| format!("spec rename: {}", e.kind()))?;
    if enforce_root {
        #[cfg(unix)]
        check_spec_file(&path)?;
    }
    Ok(WrittenSpec {
        path,
        digest: spec_digest(&spec),
        spec,
        generator: generator.into(),
    })
}

/// Re-read the written file (it may have changed since it was written) and
/// validate it for one claim.
pub fn validate_written(
    w: &WrittenSpec,
    policy: &CdiPolicy,
    claim: &ApprovedClaim,
) -> Result<ValidatedCdi, Vec<CdiViolation>> {
    let text = fs::read_to_string(&w.path).map_err(|_| vec![CdiViolation::AppSupplied])?;
    let spec: CdiSpec = serde_json::from_str(&text).map_err(|_| vec![CdiViolation::AppSupplied])?;
    if spec_digest(&spec) != w.digest {
        return Err(vec![CdiViolation::UntrustedGenerator(
            "spec changed after the broker wrote it".into(),
        )]);
    }
    validate(
        &spec,
        &SpecOrigin::HostTooling {
            generator: w.generator.clone(),
        },
        policy,
        claim,
    )
}

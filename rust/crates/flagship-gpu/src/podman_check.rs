//! The on-box half of the simulated path: a validated CDI spec for a
//! simulated device kind (`flagship.sim/gpu`, a character device that is
//! really `/dev/null`) is written where Podman reads CDI specs and a real
//! container is started with `--device flagship.sim/gpu=0`. This proves the
//! engine side of attachment (CDI resolution by name, node injection, env),
//! not isolation: it runs under the engine's default runtime because gVisor
//! only mediates real NVIDIA devices. Needs root (mknod, the spec dir) and
//! busybox-static for the container's root.

use std::fs;
use std::path::Path;
use std::time::Duration;

use crate::attach::RuntimeNames;
use crate::cdi::{ApprovedClaim, CdiPolicy, CdiSpec, SpecOrigin, validate};
use crate::device::Capability;
use crate::provider::run_fixed;

const KIND: &str = "flagship.sim/gpu";
const NODE: &str = "/dev/flagship-sim-gpu0";
const SPEC_DIR: &str = "/var/run/cdi";

fn spec() -> Result<CdiSpec, String> {
    serde_json::from_value(serde_json::json!({
        "cdiVersion": "0.6.0",
        "kind": KIND,
        "devices": [
            {"name": "0", "containerEdits": {"deviceNodes": [{"path": NODE, "type": "c", "major": 1, "minor": 3}], "env": ["FLAGSHIP_SIM_GPU=0"]}},
            {"name": "all", "containerEdits": {"deviceNodes": [{"path": NODE}]}}
        ],
        "containerEdits": {}
    }))
    .map_err(|e| e.to_string())
}

fn policy() -> CdiPolicy {
    CdiPolicy {
        kind: KIND.into(),
        trusted_generators: vec!["flagship-gpud self-test".into()],
        hooks: Vec::new(),
        mount_host_prefixes: Vec::new(),
        shared_device_nodes: Vec::new(),
        env_keys: vec!["FLAGSHIP_SIM_GPU".into()],
        additional_gids: Vec::new(),
    }
}

/// `(check, ok, detail)` rows.
pub fn run(
    podman: &Path,
    scratch: &Path,
    _names: &RuntimeNames,
) -> Result<Vec<(String, bool, String)>, String> {
    let mut out = Vec::new();
    let claim = ApprovedClaim {
        device_names: vec!["0".into()],
        device_nodes: vec![NODE.into()],
        capabilities: [Capability::Compute].into_iter().collect(),
    };
    let origin = SpecOrigin::HostTooling {
        generator: "flagship-gpud self-test".into(),
    };
    let raw = spec()?;
    out.push((
        "the raw spec with an `all` device is refused".into(),
        validate(&raw, &origin, &policy(), &claim).is_err(),
        String::new(),
    ));
    let clean = raw.sanitized();
    let v = validate(&clean, &origin, &policy(), &claim);
    out.push((
        "the sanitised spec validates for the claim".into(),
        v.is_ok(),
        format!("{v:?}"),
    ));
    let mknod = run_fixed(
        Path::new("/usr/bin/mknod"),
        &[
            "-m".into(),
            "0666".into(),
            NODE.into(),
            "c".into(),
            "1".into(),
            "3".into(),
        ],
        Duration::from_secs(10),
    );
    if !matches!(mknod, Ok((true, _))) && !Path::new(NODE).exists() {
        return Err("mknod failed (the Podman check needs root)".into());
    }
    fs::create_dir_all(SPEC_DIR).map_err(|e| e.to_string())?;
    let spec_path = Path::new(SPEC_DIR).join("flagship-sim-gpu.json");
    fs::write(
        &spec_path,
        serde_json::to_string_pretty(&clean).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    // A minimal root for the container: static busybox only (busybox-static).
    let root = scratch.join("simroot");
    for d in ["bin", "dev", "proc", "sys", "tmp", "etc"] {
        fs::create_dir_all(root.join(d)).map_err(|e| e.to_string())?;
    }
    fs::copy("/bin/busybox", root.join("bin/busybox"))
        .map_err(|_| "no /bin/busybox (install busybox-static)".to_owned())?;
    #[cfg(unix)]
    for l in ["sh", "test", "echo"] {
        let _ = std::os::unix::fs::symlink("busybox", root.join("bin").join(l));
    }
    let root_s = root.to_string_lossy().into_owned();
    let run = |device: &str| {
        run_fixed(
            podman,
            &[
                "run",
                "--rm",
                "--network=none",
                "--read-only",
                "--device",
                device,
                "--rootfs",
                &root_s,
                "/bin/sh",
                "-c",
                "test -c /dev/flagship-sim-gpu0 && echo \"ok:$FLAGSHIP_SIM_GPU\"",
            ]
            .iter()
            .map(|s| (*s).to_owned())
            .collect::<Vec<_>>(),
            Duration::from_secs(120),
        )
    };
    let good = run("flagship.sim/gpu=0");
    out.push((
        "Podman injects the claimed device node and the spec's env".into(),
        matches!(&good, Ok((true, s)) if s.trim() == "ok:0"),
        format!("{good:?}"),
    ));
    let unknown = run("flagship.sim/gpu=7");
    out.push((
        "an unknown CDI device name does not start".into(),
        !matches!(unknown, Ok((true, _))),
        String::new(),
    ));
    let all = run("flagship.sim/gpu=all");
    out.push((
        "the `all` device is gone from the written spec".into(),
        !matches!(all, Ok((true, _))),
        String::new(),
    ));
    let _ = fs::remove_file(&spec_path);
    let _ = fs::remove_file(NODE);
    Ok(out)
}

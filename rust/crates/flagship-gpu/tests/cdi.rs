//! CDI spec validation against an nvidia-ctk-shaped fixture.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod common;

use std::collections::BTreeSet;

use common::fixture;
use flagship_gpu::cdi::{
    ApprovedClaim, CdiPolicy, CdiSpec, CdiViolation, DeviceNode, Hook, Mount, PinnedHook,
    SpecOrigin, check_spec_metadata, validate,
};
use flagship_gpu::device::Capability;

fn policy() -> CdiPolicy {
    CdiPolicy {
        kind: "nvidia.com/gpu".into(),
        trusted_generators: vec![common::NVCTK.into()],
        hooks: vec![
            PinnedHook {
                hook_name: "createContainer".into(),
                path: "/usr/bin/nvidia-cdi-hook".into(),
                args: vec![
                    "nvidia-cdi-hook".into(),
                    "update-ldcache".into(),
                    "--folder".into(),
                    "/usr/lib/x86_64-linux-gnu".into(),
                ],
            },
            PinnedHook {
                hook_name: "createContainer".into(),
                path: "/usr/bin/nvidia-cdi-hook".into(),
                args: vec![
                    "nvidia-cdi-hook".into(),
                    "create-symlinks".into(),
                    "--link".into(),
                    "../renderD128::/dev/dri/by-path/pci-0000:01:00.0-render".into(),
                ],
            },
        ],
        mount_host_prefixes: vec![
            "/usr/lib/x86_64-linux-gnu".into(),
            "/usr/bin/nvidia-smi".into(),
        ],
        shared_device_nodes: vec!["/dev/nvidiactl".into(), "/dev/nvidia-uvm".into()],
        env_keys: vec![
            "NVIDIA_VISIBLE_DEVICES".into(),
            "NVIDIA_DRIVER_CAPABILITIES".into(),
        ],
        additional_gids: vec![],
    }
}

fn claim0() -> ApprovedClaim {
    ApprovedClaim {
        device_names: vec!["0".into()],
        device_nodes: vec!["/dev/nvidia0".into(), "/dev/dri/renderD128".into()],
        capabilities: BTreeSet::from([Capability::Compute]),
    }
}

fn spec() -> CdiSpec {
    serde_json::from_str(&fixture("nvidia-cdi.json")).unwrap()
}

fn tooling() -> SpecOrigin {
    SpecOrigin::HostTooling {
        generator: common::NVCTK.into(),
    }
}

fn violations(s: &CdiSpec, c: &ApprovedClaim) -> Vec<CdiViolation> {
    validate(s, &tooling(), &policy(), c)
        .err()
        .unwrap_or_default()
}

#[test]
fn generated_spec_for_the_claimed_device_passes() {
    let v = validate(&spec(), &tooling(), &policy(), &claim0()).unwrap();
    assert_eq!(v.devices, ["nvidia.com/gpu=0"]);
    assert!(v.spec_digest.starts_with("sha256:"));
}

#[test]
fn app_supplied_and_untrusted_generators_are_refused() {
    assert_eq!(
        validate(&spec(), &SpecOrigin::AppSupplied, &policy(), &claim0()),
        Err(vec![CdiViolation::AppSupplied])
    );
    let other = SpecOrigin::HostTooling {
        generator: "nvidia-ctk 0.9.0".into(),
    };
    assert!(matches!(
        validate(&spec(), &other, &policy(), &claim0()).unwrap_err()[..],
        [CdiViolation::UntrustedGenerator(_)]
    ));
}

#[test]
fn all_devices_are_refused() {
    let mut s = spec();
    let mut all = s.devices[0].clone();
    all.name = "all".into();
    s.devices.push(all);
    assert!(violations(&s, &claim0()).contains(&CdiViolation::AllDevice));
    // The broker's write path strips it, after which the spec passes.
    assert!(validate(&s.without_all(), &tooling(), &policy(), &claim0()).is_ok());
    let mut c = claim0();
    c.device_names = vec!["all".into()];
    assert!(violations(&spec(), &c).contains(&CdiViolation::ClaimNamesAll));
}

#[test]
fn hooks_outside_the_pinned_allowlist_are_refused() {
    let mut s = spec();
    s.container_edits.hooks.push(Hook {
        hook_name: "createRuntime".into(),
        path: "/tmp/evil.sh".into(),
        args: vec![],
        env: vec![],
        timeout: None,
    });
    assert!(matches!(
        violations(&s, &claim0())[..],
        [CdiViolation::Hook(_)]
    ));
    // Same binary, different arguments: still refused.
    let mut s = spec();
    s.container_edits.hooks[0].args.push("--extra".into());
    assert!(matches!(
        violations(&s, &claim0())[..],
        [CdiViolation::Hook(_)]
    ));
    let mut s = spec();
    s.container_edits.hooks[0]
        .env
        .push("LD_PRELOAD=/x.so".into());
    assert!(matches!(
        violations(&s, &claim0())[..],
        [CdiViolation::HookEnv(_)]
    ));
}

#[test]
fn unexpected_mounts_are_refused() {
    let bad = [
        ("/", "/host"),
        ("/var/run/docker.sock", "/var/run/docker.sock"),
        ("/usr/lib/x86_64-linux-gnu/../../../etc", "/etc2"),
        ("/usr/lib/x86_64-linux-gnu/libcuda.so", "/data/libcuda.so"),
        ("/usr/lib/x86_64-linux-gnu-evil/lib.so", "/usr/lib/lib.so"),
    ];
    for (h, c) in bad {
        let mut s = spec();
        s.container_edits.mounts.push(Mount {
            host_path: h.into(),
            container_path: c.into(),
            options: vec!["ro".into(), "bind".into()],
            mount_type: None,
        });
        assert!(
            matches!(violations(&s, &claim0())[..], [CdiViolation::Mount(_)]),
            "{h} -> {c}"
        );
    }
    let mut s = spec();
    s.container_edits.mounts[0].options = vec!["rw".into(), "bind".into()];
    assert!(matches!(
        violations(&s, &claim0())[..],
        [CdiViolation::Mount(_)]
    ));
}

#[test]
fn env_is_limited_to_the_allowlist_and_the_claim() {
    for e in [
        "LD_PRELOAD=/x.so",
        "LD_LIBRARY_PATH=/tmp",
        "PATH=/tmp",
        "NVIDIA_VISIBLE_DEVICES=all",
        "NOEQUALS",
    ] {
        let mut s = spec();
        s.container_edits.env.push(e.into());
        assert!(
            matches!(violations(&s, &claim0())[..], [CdiViolation::Env(_)]),
            "{e}"
        );
    }
    let mut s = spec();
    s.container_edits
        .env
        .push("NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics,video".into());
    let v = violations(&s, &claim0());
    assert_eq!(
        v,
        [
            CdiViolation::DriverCapability("graphics".into()),
            CdiViolation::DriverCapability("video".into())
        ]
    );
    let mut c = claim0();
    c.capabilities.insert(Capability::Graphics);
    c.capabilities.insert(Capability::VideoEncode);
    assert!(validate(&s, &tooling(), &policy(), &c).is_ok());
}

#[test]
fn device_nodes_broader_than_the_claim_are_refused() {
    // Device 0's edits reaching device 1's node.
    let mut s = spec();
    s.devices[0].container_edits.device_nodes.push(DeviceNode {
        path: "/dev/nvidia1".into(),
        host_path: None,
        node_type: None,
        major: None,
        minor: None,
        file_mode: None,
        permissions: None,
        uid: None,
        gid: None,
    });
    assert_eq!(
        violations(&s, &claim0()),
        [CdiViolation::DeviceNode("/dev/nvidia1".into())]
    );
    // Remapping a host node to a different container path.
    let mut s = spec();
    s.devices[0].container_edits.device_nodes[0].host_path = Some("/dev/nvidia1".into());
    assert!(matches!(
        violations(&s, &claim0())[..],
        [CdiViolation::DeviceNode(_)]
    ));
    // Management, display and raw-memory nodes, never.
    for p in [
        "/dev/nvidia-caps/nvidia-cap1",
        "/dev/nvidia-modeset",
        "/dev/dri/card0",
        "/dev/mem",
        "/dev/nvidia-uvm-tools",
        "/dev/vfio/12",
    ] {
        let mut s = spec();
        s.container_edits.device_nodes.push(DeviceNode {
            path: p.into(),
            host_path: None,
            node_type: None,
            major: None,
            minor: None,
            file_mode: None,
            permissions: None,
            uid: None,
            gid: None,
        });
        let mut c = claim0();
        c.device_nodes.push(p.into());
        assert_eq!(
            violations(&s, &c),
            [CdiViolation::ManagementNode(p.into())],
            "{p}"
        );
    }
    // Claiming a device the spec doesn't have, and a wrong kind.
    let mut c = claim0();
    c.device_names.push("7".into());
    assert!(violations(&spec(), &c).contains(&CdiViolation::UnknownDevice("7".into())));
    let mut s = spec();
    s.kind = "amd.com/gpu".into();
    assert!(violations(&s, &claim0()).contains(&CdiViolation::Kind("amd.com/gpu".into())));
}

#[test]
fn unknown_spec_fields_are_refused_at_parse() {
    let raw =
        fixture("nvidia-cdi.json").replace("\"cdiVersion\"", "\"intelRdt\": {}, \"cdiVersion\"");
    assert!(serde_json::from_str::<CdiSpec>(&raw).is_err());
}

#[test]
fn spec_files_must_be_root_owned_and_not_writable_by_others() {
    assert!(check_spec_metadata(0, 0o100644, false).is_ok());
    assert!(check_spec_metadata(1000, 0o100644, false).is_err());
    assert!(check_spec_metadata(0, 0o100664, false).is_err());
    assert!(check_spec_metadata(0, 0o100646, false).is_err());
    assert!(check_spec_metadata(0, 0o120777, true).is_err());
}

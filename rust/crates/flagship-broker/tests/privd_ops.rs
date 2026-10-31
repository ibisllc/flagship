//! packages/privd/tests/ops.test.ts, ported, plus the Podman, bridge and release-pin cases: the
//! operations the unprivileged daemon needs, and the refusals that keep the broker from being a
//! way back to root.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

mod common;

use common::{Client, FixedPeer, V1Recorder, fixed_env, tempdir, test_trust};
use flagship_broker::audit::Audit;
use flagship_broker::peer::PeerPolicy;
use flagship_broker::podman::EngineKind;
use flagship_broker::policy::{
    FILES_HELPER_IMAGE, PrivExec, ReleaseTrust, docker_exec, docker_file_exec, host_exec,
    icc_table, iptables_restore_exec, release_exec, setup_exec, systemctl_exec, wipe_exec,
};
use flagship_broker::privd::{V1Factory, V1Limits};
use flagship_broker::server::{ServerLimits, serve};
use flagship_broker::wire::{ErrorCode, PrivdError};
use serde_json::{Map, Value, json};
use std::os::unix::net::UnixListener;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

const VOL: &str = "flagship-files-alice--chess";
const ROOT: &str = "/var/lib/flagship-files";

fn args(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}
fn refused<T: std::fmt::Debug>(r: Result<T, PrivdError>, re: Option<&str>) -> PrivdError {
    let e = r.expect_err("expected a refusal");
    if let Some(re) = re {
        assert!(
            e.message.contains(re),
            "{} does not contain {re}",
            e.message
        );
    }
    e
}
fn docker(argv: &[&str]) -> Result<PrivExec, PrivdError> {
    docker_exec(&args(json!({ "argv": argv })), EngineKind::Docker)
}
fn podman(argv: &[&str]) -> Result<PrivExec, PrivdError> {
    docker_exec(&args(json!({ "argv": argv })), EngineKind::Podman)
}
fn systemctl(argv: &[&str]) -> Result<PrivExec, PrivdError> {
    systemctl_exec(&args(json!({ "argv": argv })))
}
fn host(file: &str, argv: &[&str]) -> Result<PrivExec, PrivdError> {
    host_mounts(file, argv, "")
}
fn host_mounts(file: &str, argv: &[&str], mounts: &str) -> Result<PrivExec, PrivdError> {
    let m = mounts.to_owned();
    host_exec(&args(json!({ "file": file, "argv": argv })), &move || {
        m.clone()
    })
}
fn v(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn systemctl_manages_the_daemons_own_units_with_known_verbs() {
    assert_eq!(
        systemctl(&["daemon-reload"]).unwrap().args,
        v(&["daemon-reload"])
    );
    systemctl(&[
        "start",
        "--no-block",
        "containerd.service",
        "docker.socket",
        "docker.service",
    ])
    .unwrap();
    systemctl(&[
        "show",
        "docker.service",
        "--property=ActiveState",
        "--property=SubState",
    ])
    .unwrap();
    systemctl(&["enable", "--now", "ssh"]).unwrap();
    systemctl(&["is-active", "flagship-data-services.service"]).unwrap();
}

#[test]
fn systemctl_refuses_any_other_unit_verb_or_flag() {
    refused(systemctl(&["start", "getty@tty1.service"]), Some("manages"));
    refused(systemctl(&["stop", "flagship-keyd.service; id"]), None);
    refused(
        systemctl(&["enable", "docker.service"]),
        Some("not enabled"),
    );
    refused(systemctl(&["mask", "ssh"]), Some("not allowed"));
    refused(systemctl(&["edit", "flagship-daemon.service"]), None);
    refused(
        systemctl(&["set-property", "flagship-daemon.service", "CPUQuota=1%"]),
        None,
    );
    refused(systemctl(&["start", "--root=/tmp", "ssh"]), Some("flag"));
    refused(systemctl(&["poweroff"]), None);
    refused(
        systemctl(&["restart", "flagship-broker.service"]),
        Some("manages"),
    );
    let e = refused(systemctl(&["start"]), None);
    assert_eq!(e.code, ErrorCode::BadRequest);
}

#[test]
fn the_root_docker_client_never_reads_or_writes_a_host_file() {
    for bad in [
        &["run", "--env-file", "/etc/shadow", "img"][..],
        &["run", "--env-file=/etc/shadow", "img"],
        &["run", "--label-file", "/root/.ssh/id_ed25519", "img"],
        &["run", "--cidfile", "/etc/cron.d/x", "img"],
        &["run", "--gpus", "all", "img"],
        &["run", "--cgroup-parent", "/", "img"],
    ] {
        refused(docker(bad), None);
    }
    let ctx = "/var/flagship/data/app-clones/alice--chess";
    docker(&[
        "build",
        "--network",
        "flagship-build",
        "--add-host",
        "registry.npmjs.org:10.0.0.1",
        "--memory",
        "2g",
        "--cpu-period",
        "100000",
        "--cpu-quota",
        "200000",
        "--ulimit",
        "nproc=256:256",
        "-t",
        "img",
        ctx,
    ])
    .unwrap();
    for bad in [
        &["build", "-o", "/etc", ctx][..],
        &["build", "--output=type=local,dest=/etc", ctx],
        &["build", "--secret", "id=x,src=/etc/shadow", ctx],
        &["build", "--build-context", "h=/", ctx],
        &["build", "--iidfile", "/etc/x", ctx],
        &["build", "--cache-to", "type=local,dest=/etc", ctx],
        &["build", "-t", "img", "/var/tmp/.flagship-x"],
        &["build", "-t", "img", "/"],
    ] {
        refused(docker(bad), None);
    }
}

#[test]
fn a_volume_binds_only_its_own_apps_disk_image() {
    docker(&["volume", "create", "--label", "flagship.files=prod", VOL]).unwrap();
    let dev = format!("device={ROOT}/{VOL}/data");
    docker(&[
        "volume",
        "create",
        "--driver",
        "local",
        "--opt",
        "type=none",
        "--opt",
        "o=bind",
        "--opt",
        &dev,
        "--label",
        "flagship.quota=loop",
        VOL,
    ])
    .unwrap();
    refused(
        docker(&[
            "volume",
            "create",
            "--driver",
            "local",
            "--opt",
            "type=none",
            "--opt",
            "o=bind",
            "--opt",
            "device=/etc",
            VOL,
        ]),
        Some("binds only"),
    );
    let other = format!("device={ROOT}/flagship-files-bob--x/data");
    refused(
        docker(&[
            "volume",
            "create",
            "--driver",
            "local",
            "--opt",
            "type=none",
            "--opt",
            "o=bind",
            "--opt",
            &other,
            VOL,
        ]),
        None,
    );
    refused(
        docker(&[
            "volume",
            "create",
            "--opt",
            "type=ext4",
            "--opt",
            "device=/dev/sda1",
            VOL,
        ]),
        None,
    );
    refused(
        docker(&["volume", "create", "--driver", "rexray", VOL]),
        None,
    );
    refused(
        docker(&["volume", "create", "a", "b"]),
        Some("volume create argument b"),
    );
}

#[test]
fn a_network_is_a_bridge_on_the_boxs_own_interface() {
    docker(&["network", "create", "--internal", "n"]).unwrap();
    docker(&[
        "network",
        "create",
        "--driver",
        "bridge",
        "--internal",
        "-o",
        "com.docker.network.bridge.name=fs-build",
        "-o",
        "com.docker.network.bridge.enable_icc=false",
        "flagship-build",
    ])
    .unwrap();
    refused(
        docker(&[
            "network",
            "create",
            "--driver",
            "macvlan",
            "-o",
            "parent=eth0",
            "lan",
        ]),
        Some("bridge driver"),
    );
    refused(docker(&["network", "create", "-d=ipvlan", "lan"]), None);
    refused(
        docker(&[
            "network",
            "create",
            "-o",
            "com.docker.network.bridge.name=br0",
            "x",
        ]),
        Some("network option"),
    );
    refused(
        docker(&["network", "create", "--subnet", "10.0.0.0/8", "x"]),
        None,
    );
    refused(
        docker(&[
            "network",
            "create",
            "--opt=com.docker.network.bridge.name=fs-x",
            "x",
        ]),
        None,
    );
    refused(
        docker(&["network", "create", "--internal"]),
        Some("name the network"),
    );
}

#[test]
fn exec_reaches_only_the_data_services_with_their_tools_passing_only_pgpassword() {
    docker(&[
        "exec",
        "-e",
        "PGPASSWORD=x",
        "flagship-postgres",
        "pg_dumpall",
        "-U",
        "a",
    ])
    .unwrap();
    docker(&[
        "exec",
        "flagship-forgejo",
        "sqlite3",
        "/var/lib/gitea/data/forgejo.db",
        ".backup '/x'",
    ])
    .unwrap();
    refused(
        docker(&["exec", "flagship-postgres", "sh", "-c", "id"]),
        Some("may not run"),
    );
    refused(
        docker(&["exec", "flagship-myapp", "pg_dump"]),
        Some("data services"),
    );
    refused(
        docker(&["exec", "-u", "0", "flagship-postgres", "psql"]),
        Some("flag"),
    );
    refused(
        docker(&["exec", "--privileged", "flagship-postgres", "psql"]),
        None,
    );
    refused(
        docker(&["exec", "-e", "LD_PRELOAD=/x", "flagship-postgres", "psql"]),
        Some("PGPASSWORD"),
    );
    // 300 astral characters are 600 UTF-16 units, over the 512 the regex allows.
    let long = format!("PGPASSWORD={}", "😀".repeat(300));
    refused(
        docker(&["exec", "-e", &long, "flagship-postgres", "psql"]),
        Some("PGPASSWORD"),
    );
    refused(
        docker(&["exec", "-e", "PGPASSWORD=a\nb", "flagship-postgres", "psql"]),
        Some("PGPASSWORD"),
    );
}

fn helper(over: &[&str]) -> Vec<String> {
    let mount = format!("type=volume,src={VOL},dst=/data,readonly");
    let mut a = v(&[
        "run",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "DAC_READ_SEARCH",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--user",
        "0:0",
    ]);
    a.extend(v(over));
    a.extend(v(&[
        "--mount",
        &mount,
        "--entrypoint",
        "tar",
        FILES_HELPER_IMAGE,
        "-cf",
        "-",
        "-C",
        "/data",
        ".",
    ]));
    a
}
fn docker_v(a: &[String]) -> Result<PrivExec, PrivdError> {
    docker_exec(&args(json!({ "argv": a })), EngineKind::Docker)
}

#[test]
fn the_files_helper_alone_runs_as_uid_0_and_only_in_its_locked_down_shape() {
    docker_v(&helper(&[])).unwrap();
    let restore_mount = format!("type=volume,src={VOL},dst=/data");
    docker(&[
        "run",
        "-i",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--cap-add",
        "DAC_OVERRIDE",
        "--cap-add",
        "FOWNER",
        "--cap-add",
        "FSETID",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--user",
        "0:0",
        "--mount",
        &restore_mount,
        "--entrypoint",
        "tar",
        FILES_HELPER_IMAGE,
        "-xpf",
        "-",
        "-C",
        "/data",
    ])
    .unwrap();
    let swap = |from: &str, to: &str| {
        helper(&[])
            .into_iter()
            .map(|a| if a == from { to.to_owned() } else { a })
            .collect::<Vec<_>>()
    };
    refused(docker_v(&helper(&["--cap-add", "SYS_ADMIN"])), None);
    refused(docker_v(&swap("none", "bridge")), None);
    refused(docker_v(&swap(FILES_HELPER_IMAGE, "alpine")), None);
    refused(docker_v(&swap("--read-only", "--rm")), None);
    refused(
        docker_v(
            &helper(&[])
                .into_iter()
                .map(|a| {
                    if a.starts_with("type=volume") {
                        "type=bind,src=/,dst=/data".to_owned()
                    } else {
                        a
                    }
                })
                .collect::<Vec<_>>(),
        ),
        None,
    );
    refused(docker_v(&swap("tar", "bash")), None);
    refused(docker_v(&helper(&["--pid", "host"])), None);
}

#[test]
fn save_load_and_dumps_stream_through_the_daemons_own_files_never_a_key() {
    let f = |a: Value| docker_file_exec(&args(a), EngineKind::Docker);
    let save = f(json!({ "argv": ["save", "img:1"], "stdoutPath": "/var/flagship/data/app-copies/x/image.tar.partial" })).unwrap();
    assert_eq!(
        save.stdout_file.as_deref(),
        Some("/var/flagship/data/app-copies/x/image.tar.partial")
    );
    assert_eq!(
        f(json!({ "argv": ["load", "-q"], "stdinPath": "/var/tmp/.flagship-copy/image.tar" }))
            .unwrap()
            .stdin_file
            .as_deref(),
        Some("/var/tmp/.flagship-copy/image.tar")
    );
    let e = f(json!({ "argv": ["exec", "-i", "-e", "PGPASSWORD", "flagship-postgres", "pg_restore", "-l"], "stdinPath": "/var/flagship/x.dump", "env": { "PGPASSWORD": "p" } })).unwrap();
    assert_eq!(e.env.get("PGPASSWORD").map(String::as_str), Some("p"));
    for p in [
        "/etc/shadow",
        "/var/flagship/identity/box.key",
        "/var/flagship/keyd/x",
        "/var/flagship/swk.hex",
        "/var/flagship/acme/cert/a.pem",
        "/var/flagship/../../etc/shadow",
        "/var/flagshipx/y",
        "relative",
        "/var/flagship/a\u{2028}b.key",
    ] {
        refused(f(json!({ "argv": ["save", "img"], "stdoutPath": p })), None);
        refused(f(json!({ "argv": ["load", "-q"], "stdinPath": p })), None);
    }
    refused(
        f(json!({ "argv": ["save", "-o", "/etc/x", "img"], "stdoutPath": "/var/flagship/a" })),
        None,
    );
    refused(
        f(json!({ "argv": ["load", "-i", "/etc/x"], "stdinPath": "/var/flagship/a" })),
        None,
    );
    refused(
        f(json!({ "argv": ["exec", "flagship-postgres", "psql"], "env": { "LD_PRELOAD": "/x" } })),
        Some("PGPASSWORD"),
    );
    refused(
        f(json!({ "argv": ["cp", "c:/etc", "-"], "stdoutPath": "/var/flagship/a" })),
        None,
    );
    assert_eq!(
        refused(f(json!({ "argv": ["save", "img"] })), None).code,
        ErrorCode::BadRequest
    );
}

#[test]
fn on_podman_the_same_request_runs_podman_translated_and_checked_again() {
    let p = podman(&["ps", "-a"]).unwrap();
    assert_eq!(
        (p.file, p.args.clone()),
        ("/usr/bin/podman", v(&["ps", "-a"]))
    );
    let ver = podman(&["version", "--format", "{{.Server.Version}}"]).unwrap();
    assert_eq!(ver.args, v(&["version", "--format", "{{.Client.Version}}"]));
    let net = podman(&[
        "network",
        "create",
        "--driver",
        "bridge",
        "-o",
        "com.docker.network.bridge.name=fs-apps",
        "flagship-apps",
    ])
    .unwrap();
    assert!(
        net.args
            .windows(2)
            .any(|w| w == ["--interface-name", "fs-apps"])
    );
    assert_eq!(podman_file_save().file, "/usr/bin/podman");
    // The docker refusals still apply under Podman.
    refused(
        podman(&["run", "--privileged", "img"]),
        Some("--privileged"),
    );
    refused(podman(&["run", "-v", "/:/h", "img"]), None);
    // And what only Podman would read.
    refused(podman(&["run", "--rootfs", "/", "img"]), Some("--rootfs"));
    refused(
        podman(&["ps", "--module", "/var/tmp/.flagship-x/evil.conf"]),
        Some("--module"),
    );
    refused(podman(&["ps", "--out=/etc/cron.d/x"]), Some("--out"));
    refused(
        podman(&["run", "--network-cmd-path", "/tmp/x", "img"]),
        None,
    );
    refused(podman(&["run", "--hooks-dir", "/tmp", "img"]), None);
    refused(podman(&["run", "--log-opt", "path=/etc/x", "img"]), None);
    refused(
        podman(&["pull", "oci-archive:/root/x.tar"]),
        Some("registry"),
    );
    refused(
        podman(&["run", "--network", "ns:/proc/1/ns/net", "img"]),
        Some("named network"),
    );
    refused(podman(&["system", "df"]), Some("no translation"));
    refused(
        podman(&["info", "--format", "{{json .}}"]),
        Some("no translation"),
    );
    // The same transport is harmless to Docker, which refuses it itself.
    docker(&["pull", "oci-archive:/root/x.tar"]).unwrap();
}

fn podman_file_save() -> PrivExec {
    docker_file_exec(
        &args(json!({ "argv": ["save", "img:1"], "stdoutPath": "/var/flagship/data/x.tar" })),
        EngineKind::Podman,
    )
    .unwrap()
}

#[test]
fn mount_unmount_and_resize_only_the_apps_own_images() {
    let mounts = format!("/dev/loop3 {ROOT}/{VOL} ext4 rw 0 0\n/dev/sda1 / ext4 rw 0 0\n");
    let img = format!("{ROOT}/{VOL}.img");
    let dir = format!("{ROOT}/{VOL}");
    assert_eq!(
        host(
            "mount",
            &["-o", "loop,nodev,nosuid,discard,noinit_itable", &img, &dir]
        )
        .unwrap()
        .file,
        "/usr/bin/mount"
    );
    host("mount", &["-o", "remount,ro", &dir]).unwrap();
    host("umount", &["-l", &dir]).unwrap();
    host_mounts("resize2fs", &["/dev/loop3"], &mounts).unwrap();
    host_mounts("losetup", &["-c", "/dev/loop3"], &mounts).unwrap();
    refused(host_mounts("resize2fs", &["/dev/sda1"], &mounts), None);
    refused(host_mounts("resize2fs", &["/dev/loop4"], &mounts), None);
    refused(host("mount", &["-o", "loop", &img, &dir]), None);
    refused(
        host(
            "mount",
            &[
                "-o",
                "loop,nodev,nosuid,discard,noinit_itable",
                &img,
                "/etc",
            ],
        ),
        None,
    );
    refused(
        host(
            "mount",
            &[
                "-o",
                "loop,nodev,nosuid,discard,noinit_itable",
                "/var/flagship/evil.img",
                &dir,
            ],
        ),
        None,
    );
    refused(host("mount", &["--bind", "/", &dir]), None);
    refused(host("umount", &["/"]), None);
}

#[test]
fn makes_sizes_moves_and_removes_only_the_images_own_entries() {
    assert_eq!(
        host("mkdir", &["0755", ROOT]).unwrap().args,
        v(&["-p", "-m", "0755", "--", ROOT])
    );
    let s = |x: &str| x.replace("$R", ROOT).replace("$V", VOL);
    for (f, a) in [
        ("mkdir", vec!["0777", "$R/$V/data"]),
        ("truncate", vec!["1073741824", "$R/$V.img"]),
        ("truncate", vec!["0", "$R/$V/.flagship-ballast"]),
        ("fallocate", vec!["-l", "4096", "$R/$V/.flagship-ballast"]),
        (
            "mkfs.ext4",
            vec![
                "-q",
                "-F",
                "-b",
                "4096",
                "-T",
                "default",
                "-m",
                "0",
                "-E",
                "lazy_itable_init=1,lazy_journal_init=1,nodiscard",
                "$R/$V.img",
            ],
        ),
        ("touch", vec!["$R/$V.pending"]),
        ("rm", vec!["$R/orphaned/$V.1760000000000.img"]),
        ("mv", vec!["$R/$V.img", "$R/orphaned/$V.1760000000000.img"]),
        ("chattr", vec!["+i", "$R/$V"]),
        (
            "du",
            vec!["-sk", "/var/lib/containers/storage/volumes/$V/_data"],
        ),
        (
            "chmod",
            vec!["0777", "/var/lib/containers/storage/volumes/$V/_data"],
        ),
        (
            "cp",
            vec![
                "-a",
                "--",
                "/var/lib/containers/storage/volumes/$V/_data/.",
                "$R/$V/data",
            ],
        ),
        ("fingerprint", vec!["/var/lib/docker/volumes/$V/_data"]),
    ] {
        let a: Vec<String> = a.iter().map(|x| s(x)).collect();
        let a: Vec<&str> = a.iter().map(String::as_str).collect();
        host(f, &a).unwrap_or_else(|e| panic!("{f} {a:?}: {e}"));
    }
    for (f, a) in [
        ("mkdir", vec!["0777", "/etc/cron.d"]),
        ("mkdir", vec!["4755", "$R/$V"]),
        ("truncate", vec!["0", "/etc/shadow"]),
        ("fallocate", vec!["-l", "1", "/var/flagship/x"]),
        ("mkfs.ext4", vec!["/dev/sda1"]),
        (
            "mkfs.ext4",
            vec![
                "-q",
                "-F",
                "-b",
                "4096",
                "-T",
                "default",
                "-m",
                "0",
                "-E",
                "root_owner=0:0",
                "$R/$V.img",
            ],
        ),
        ("touch", vec!["/etc/nologin"]),
        ("rm", vec![ROOT]),
        ("rm", vec!["-rf", ROOT]),
        ("rm", vec!["/etc/shadow"]),
        ("rmdir", vec!["/etc"]),
        (
            "mv",
            vec!["$R/$V.img", "$R/orphaned/flagship-files-bob--x.1.img"],
        ),
        ("mv", vec!["/etc/shadow", "$R/orphaned/$V.1.img"]),
        ("chattr", vec!["-i", "/etc/passwd"]),
        ("chmod", vec!["4755", "/var/lib/docker/volumes/x/_data"]),
        ("chmod", vec!["0777", "/etc"]),
        ("cp", vec!["-a", "--", "/etc/.", "$R/$V/data"]),
        ("du", vec!["-sk", "/root"]),
        ("fingerprint", vec!["/root"]),
        ("networkctl", vec!["up", "eth0"]),
    ] {
        let a: Vec<String> = a.iter().map(|x| s(x)).collect();
        let a: Vec<&str> = a.iter().map(String::as_str).collect();
        refused(host(f, &a), None);
    }
    let e = refused(host("sh", &["-c", "id"]), Some("unknown host operation"));
    assert_eq!(e.code, ErrorCode::UnknownOp);
}

#[test]
fn makes_and_fences_only_the_boxs_own_podman_bridges() {
    assert_eq!(
        host("ip", &["link", "add", "fs-apps", "type", "bridge"])
            .unwrap()
            .file,
        "/usr/sbin/ip"
    );
    host("ip", &["addr", "add", "10.89.0.1/24", "dev", "fs-apps"]).unwrap();
    host("ip", &["link", "set", "fs-apps", "up"]).unwrap();
    host(
        "sysctl",
        &["-q", "-w", "net.ipv6.conf.fs-apps.disable_ipv6=1"],
    )
    .unwrap();
    for (f, a) in [
        ("ip", &["link", "add", "eth0", "type", "bridge"][..]),
        ("ip", &["link", "del", "fs-apps"]),
        ("ip", &["addr", "add", "8.8.8.8/32", "dev", "fs-apps"]),
        ("ip", &["addr", "add", "10.0.0.1/24", "dev", "eth0"]),
        ("ip", &["route", "add", "default", "via", "10.0.0.1"]),
        ("ip", &["link", "set", "eth0", "down"]),
        ("sysctl", &["-w", "net.ipv4.ip_forward=0"]),
        ("sysctl", &["-q", "-w", "net.ipv6.conf.eth0.disable_ipv6=1"]),
        ("sysctl", &["-q", "-w", "net.ipv6.conf.all.disable_ipv6=1"]),
    ] {
        refused(host(f, a), None);
    }
    let icc = host("icc", &["fs-apps", "fs-build"]).unwrap();
    assert_eq!(
        (icc.file, icc.args.clone()),
        ("/usr/sbin/nft", v(&["-f", "-"]))
    );
    assert_eq!(
        icc.input.as_deref(),
        Some(icc_table(&v(&["fs-apps", "fs-build"])).as_str())
    );
    assert!(
        icc_table(&v(&["fs-apps"]))
            .contains("meta ibrname \"fs-apps\" meta obrname \"fs-apps\" counter drop")
    );
    refused(host("icc", &["x\"; flush ruleset"]), None);
}

#[test]
fn touches_only_the_boxs_own_egress_chains() {
    assert_eq!(
        host("iptables", &["-t", "filter", "-N", "DOCKER-USER"])
            .unwrap()
            .args,
        v(&["-w", "-t", "filter", "-N", "DOCKER-USER"])
    );
    host(
        "iptables",
        &[
            "-t",
            "nat",
            "-I",
            "PREROUTING",
            "1",
            "-j",
            "FLAGSHIP-EGRESS-NAT",
        ],
    )
    .unwrap();
    host("ip6tables", &["-t", "filter", "-F", "FLAGSHIP-EGRESS6"]).unwrap();
    refused(host("iptables", &["-t", "filter", "-F", "INPUT"]), None);
    refused(host("iptables", &["-P", "INPUT", "ACCEPT"]), None);
    refused(
        host(
            "iptables",
            &["-t", "filter", "-I", "INPUT", "1", "-j", "ACCEPT"],
        ),
        None,
    );
    let rules = "*filter\n:FLAGSHIP-EGRESS-FWD - [0:0]\n-A FLAGSHIP-EGRESS-FWD -i fs-apps -p tcp -j REJECT --reject-with tcp-reset\n-A FLAGSHIP-EGRESS-FWD -j RETURN\nCOMMIT\n";
    assert_eq!(
        iptables_restore_exec(&args(json!({ "family": 4, "rules": rules })))
            .unwrap()
            .args,
        v(&["-w", "--noflush"])
    );
    assert_eq!(
        iptables_restore_exec(&args(json!({ "family": 6.0, "rules": rules })))
            .unwrap()
            .file,
        "/usr/sbin/ip6tables-restore"
    );
    for bad in [
        "*filter\n-A INPUT -j ACCEPT\nCOMMIT",
        "*raw\nCOMMIT",
        "*filter\n-A FLAGSHIP-EGRESS-FWD -j DOCKER\nCOMMIT",
        "*filter\n-F\nCOMMIT",
        "*filter\n-A FLAGSHIP-EGRESS-FWD -g INPUT\nCOMMIT",
        "*filter\n:INPUT ACCEPT [0:0]\nCOMMIT",
        "*filter\n-A FLAGSHIP-EGRESS-FWD -j\u{3000}DOCKER\nCOMMIT",
        "*filter\n-A FLAGSHIP-EGRESS-FWD -p tcp\r-j DOCKER\nCOMMIT",
        "*filter\n-A FLAGSHIP-EGRESS-FWD -p tcp\u{2028}x\nCOMMIT",
    ] {
        refused(
            iptables_restore_exec(&args(json!({ "family": 4, "rules": bad }))),
            None,
        );
    }
    iptables_restore_exec(&args(
        json!({ "family": 4, "rules": "-A FLAGSHIP-EGRESS-FWD -j REJECTED" }),
    ))
    .unwrap();
    assert_eq!(
        refused(
            iptables_restore_exec(&args(json!({ "family": "4", "rules": rules }))),
            None
        )
        .code,
        ErrorCode::BadRequest
    );
}

#[test]
fn installs_a_release_from_a_root_copy_with_the_releases_own_trust() {
    let b = "b".repeat(40);
    let e = release_exec(
        &args(json!({ "action": "install", "commit": b, "sha256": "c".repeat(64) })),
        &test_trust(),
        "arm64",
    )
    .unwrap();
    let short = "b".repeat(12);
    assert_eq!(
        e.copy_in[0].from,
        format!("/var/tmp/.flagship-update-{short}/flagship-box-{short}-arm64.manifest.json")
    );
    assert_eq!(
        e.copy_in[1].to,
        format!("/var/lib/flagship-privd/release/flagship-box-{short}-arm64.tar.gz")
    );
    assert_eq!(e.file, "/bin/sh");
    assert_eq!(
        e.args[..4],
        v(&[
            "-c",
            flagship_broker::policy::RELEASE_LAUNCHER,
            "flagship-release",
            "install"
        ])
    );
    // The launcher prefers the running release's Rust updater and falls back to the shell scripts.
    let l = flagship_broker::policy::RELEASE_LAUNCHER;
    assert!(l.starts_with("u=/opt/flagship/installer/rust/flagship-updater\nif [ -x \"$u\" ]; then exec \"$u\" \"$@\"; fi\n"));
    assert!(l.contains(
        "install) exec /usr/bin/bash /opt/flagship/installer/install-box-artifact.sh \"$@\" ;;"
    ));
    assert!(l.contains(
        "restore) exec /usr/bin/bash /opt/flagship/installer/rollback-box-artifact.sh \"$@\" ;;"
    ));
    assert!(e.args.iter().any(|a| a == "--min-sequence"));
    let at = |f: &str| e.args[e.args.iter().position(|a| a == f).unwrap() + 1].clone();
    assert!(at("--artifact").starts_with("/var/lib/flagship-privd/"));
    assert_eq!(at("--trust-keys"), "a".repeat(64));
    assert!(!e.args.iter().any(|a| a == "--pq-key-ids"));
    let pq = ReleaseTrust {
        pq_key_ids: vec!["d".repeat(64)],
        legacy_manifests: vec!["e".repeat(64)],
        ..test_trust()
    };
    let e2 = release_exec(
        &args(json!({ "action": "install", "commit": "b".repeat(40), "sha256": "c".repeat(64) })),
        &pq,
        "amd64",
    )
    .unwrap();
    assert_eq!(
        e2.args[e2.args.len() - 4..],
        v(&[
            "--pq-key-ids",
            &"d".repeat(64),
            "--legacy-manifests",
            &"e".repeat(64)
        ])
    );
    assert_eq!(
        release_exec(
            &args(json!({ "action": "restore", "commit": "d".repeat(40) })),
            &test_trust(),
            "arm64"
        )
        .unwrap()
        .args,
        v(&[
            "-c",
            flagship_broker::policy::RELEASE_LAUNCHER,
            "flagship-release",
            "restore",
            &"d".repeat(40)
        ])
    );
    refused(
        release_exec(
            &args(json!({ "action": "install", "commit": "main", "sha256": "c".repeat(64) })),
            &test_trust(),
            "arm64",
        ),
        None,
    );
    refused(
        release_exec(
            &args(
                json!({ "action": "install", "commit": "b".repeat(40), "sha256": "c".repeat(64), "trustKeys": "evil" }),
            ),
            &test_trust(),
            "arm64",
        ),
        Some("unknown field"),
    );
    refused(
        release_exec(
            &args(
                json!({ "action": "restore", "commit": format!("{} --state /etc", "d".repeat(40)) }),
            ),
            &test_trust(),
            "arm64",
        ),
        None,
    );
    assert_eq!(refused(release_exec(&args(json!({ "action": "install", "commit": "b".repeat(40), "sha256": "c".repeat(64) })), &test_trust(), "riscv64"), None).code, ErrorCode::Failed);
}

#[test]
fn wipes_only_the_data_folder_and_runs_root_steps_by_name() {
    assert_eq!(
        wipe_exec(&args(json!({ "target": "data" }))).unwrap().args,
        v(&["-rf", "--one-file-system", "/var/flagship/data"])
    );
    refused(wipe_exec(&args(json!({ "target": "/" }))), None);
    assert_eq!(
        setup_exec(&args(json!({ "step": "debug-access" })))
            .unwrap()
            .args,
        v(&[
            "/opt/flagship/packages/server-daemon/dist/setup.js",
            "debug-access"
        ])
    );
    assert_eq!(
        setup_exec(&args(json!({ "step": "rust-stack" })))
            .unwrap()
            .file,
        "/usr/local/bin/node"
    );
    refused(
        setup_exec(&args(json!({ "step": "../../tmp/x" }))),
        Some("unknown setup step"),
    );
    refused(
        setup_exec(&args(json!({ "step": "gvisor", "script": "/tmp/x.js" }))),
        Some("unknown field"),
    );
}

#[test]
fn never_writes_a_database_password_or_a_body_into_the_audit_log() {
    let dir = tempdir("privd-ops");
    let path = dir.join("p.sock");
    let audit = dir.join("audit.log");
    let listener = UnixListener::bind(&path).unwrap();
    let rec = Arc::new(V1Recorder::default());
    let stop = Arc::new(AtomicBool::new(false));
    let factory = Arc::new(V1Factory {
        runner: rec.clone(),
        env: Arc::new(fixed_env(EngineKind::Docker)),
        audit: Arc::new(Audit::new(Some(audit.clone()))),
        limits: V1Limits::default(),
    });
    let stop2 = stop.clone();
    std::thread::spawn(move || {
        let _ = serve(
            listener,
            Arc::new(FixedPeer(1000)),
            PeerPolicy::uids([1000]),
            factory,
            ServerLimits::default(),
            stop2,
            Arc::new(Audit::new(None)),
        );
    });
    let mut c = Client::connect(&path);
    c.call(&json!({ "id": 0, "op": "hello", "args": { "version": 1 } }));
    assert_eq!(c.call(&json!({ "id": 1, "op": "docker", "args": { "argv": ["exec", "-e", "PGPASSWORD=s3cret", "flagship-postgres", "psql"] } }))["ok"], true);
    assert_eq!(c.call(&json!({ "id": 2, "op": "systemctl", "args": { "argv": ["start", "sshd-keygen@x.service"] } }))["code"], "forbidden");
    assert_eq!(
        c.call(
            &json!({ "id": 3, "op": "docker", "args": { "argv": ["run", "-v", "/:/host", "img"] } })
        )["code"],
        "forbidden"
    );
    assert_eq!(c.call(&json!({ "id": 4, "op": "docker.file", "args": { "argv": ["load", "-q"], "stdinPath": "/var/flagship/identity/box.key" } }))["code"], "forbidden");
    assert_eq!(c.call(&json!({ "id": 5, "op": "docker", "args": { "argv": "ps", "stdin": "body-text", "env": { "PGPASSWORD": "hunter2" } } }))["code"], "bad-request");
    let text = std::fs::read_to_string(&audit).unwrap();
    assert!(!text.contains("s3cret"));
    assert!(!text.contains("hunter2"));
    assert!(!text.contains("body-text"));
    assert!(text.contains("malformed request"));
    assert_eq!(
        text.lines().filter(|l| l.contains("\"ok\":false")).count(),
        4
    );
    assert_eq!(rec.ran.lock().unwrap().len(), 1);
    stop.store(true, Ordering::SeqCst);
}

#[test]
fn every_new_op_is_answered_over_the_socket() {
    let dir = tempdir("privd-new-ops");
    let path = dir.join("p.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let rec = Arc::new(V1Recorder::default());
    let stop = Arc::new(AtomicBool::new(false));
    let factory = Arc::new(V1Factory {
        runner: rec.clone(),
        env: Arc::new(fixed_env(EngineKind::Podman)),
        audit: Arc::new(Audit::new(None)),
        limits: V1Limits {
            max_per_second: 100,
            ..V1Limits::default()
        },
    });
    let stop2 = stop.clone();
    std::thread::spawn(move || {
        let _ = serve(
            listener,
            Arc::new(FixedPeer(1000)),
            PeerPolicy::uids([1000]),
            factory,
            ServerLimits::default(),
            stop2,
            Arc::new(Audit::new(None)),
        );
    });
    let mut c = Client::connect(&path);
    c.call(&json!({ "id": 0, "op": "hello", "args": { "version": 1 } }));
    let calls = [
        json!({ "op": "systemctl", "args": { "argv": ["daemon-reload"] } }),
        json!({ "op": "docker", "args": { "argv": ["ps"] } }),
        json!({ "op": "docker.file", "args": { "argv": ["load", "-q"], "stdinPath": "/var/tmp/.flagship-copy/i.tar" } }),
        json!({ "op": "host", "args": { "file": "networkctl", "argv": ["reload"] } }),
        json!({ "op": "iptables.restore", "args": { "family": 4, "rules": "*filter\nCOMMIT" } }),
        json!({ "op": "release", "args": { "action": "restore", "commit": "a".repeat(40) } }),
        json!({ "op": "wipe", "args": { "target": "data" } }),
        json!({ "op": "setup", "args": { "step": "gvisor" } }),
    ];
    for (i, call) in calls.iter().enumerate() {
        let mut req = call.clone();
        req["id"] = json!(i + 1);
        assert_eq!(c.call(&req)["ok"], true, "{call}");
    }
    let files: Vec<&str> = rec.ran.lock().unwrap().iter().map(|e| e.file).collect();
    assert_eq!(
        files,
        vec![
            "/usr/bin/systemctl",
            "/usr/bin/podman",
            "/usr/bin/podman",
            "/usr/bin/networkctl",
            "/usr/sbin/iptables-restore",
            "/bin/sh",
            "/usr/bin/rm",
            "/usr/local/bin/node"
        ]
    );
    stop.store(true, Ordering::SeqCst);
}

//! packages/privd/tests/privd.test.ts, ported: the Rust broker refuses what the TS broker refuses.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

mod common;

use common::{Client, FixedPeer, Recorder, tempdir};
use flagship_broker::audit::Audit;
use flagship_broker::peer::PeerPolicy;
use flagship_broker::policy::{docker_exec, nft_exec, power_exec, restart_exec};
use flagship_broker::privd::{V1Factory, V1Limits};
use flagship_broker::server::{ServerLimits, serve};
use flagship_broker::wire::{ErrorCode, PrivdError};
use flagship_runtime::exec::ExecOutput;
use serde_json::{Map, Value, json};
use std::os::unix::net::UnixListener;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

fn args(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

fn docker(argv: &[&str]) -> Result<flagship_runtime::exec::Exec, PrivdError> {
    docker_exec(&args(json!({ "argv": argv })))
}

fn refused<T: std::fmt::Debug>(r: Result<T, PrivdError>, re: Option<&str>) {
    let e = r.expect_err("expected a refusal");
    if let Some(re) = re {
        assert!(
            e.message.contains(re),
            "{} does not contain {re}",
            e.message
        );
    }
}

#[test]
fn power_and_unit_restarts_come_from_a_closed_list() {
    let p = power_exec(&args(json!({ "action": "poweroff" }))).unwrap();
    assert_eq!(
        (p.file, p.args),
        ("/usr/bin/systemctl", vec!["poweroff".to_owned()])
    );
    refused(
        power_exec(&args(json!({ "action": "halt; rm -rf /" }))),
        None,
    );
    refused(
        power_exec(&args(json!({ "action": "reboot", "extra": 1 }))),
        Some("unknown field"),
    );
    assert_eq!(
        restart_exec(&args(json!({ "unit": "docker.service" })))
            .unwrap()
            .args,
        vec!["restart", "docker.service"]
    );
    refused(
        restart_exec(&args(json!({ "unit": "ssh.service" }))),
        Some("cannot be restarted"),
    );
    refused(
        restart_exec(&args(json!({ "unit": "docker.service; id" }))),
        None,
    );
}

#[test]
fn a_container_is_never_the_host() {
    let a = format!("img@sha256:{}", "a".repeat(64));
    let ok = docker(&[
        "run",
        "--rm",
        "--runtime=runsc",
        "--network=flagship-apps",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user",
        "10001:10001",
        "--memory",
        "512m",
        &a,
    ])
    .unwrap();
    assert_eq!(ok.file, "/usr/bin/docker");
    let bad: &[&[&str]] = &[
        &["run", "--privileged", "img"],
        &["run", "--cap-add=SYS_ADMIN", "img"],
        &["run", "--cap-add", "ALL", "img"],
        &["run", "--device=/dev/sda", "img"],
        &["run", "--pid=host", "img"],
        &["run", "--ipc", "host", "img"],
        &["run", "--userns=host", "img"],
        &["run", "--network=host", "img"],
        &["run", "--net", "host", "img"],
        &["run", "--security-opt", "seccomp=unconfined", "img"],
        &["run", "--security-opt=apparmor=unconfined", "img"],
        &["run", "-v", "/:/host", "img"],
        &["run", "--volume=/etc:/etc", "img"],
        &["run", "--mount", "type=bind,src=/,dst=/h", "img"],
        &["run", "--mount=type=bind,src=/var/flagship,dst=/x", "img"],
        &["run", "--user", "root", "img"],
        &["run", "-u", "0:0", "img"],
        &[
            "run",
            "-v",
            "/var/run/docker.sock:/var/run/docker.sock",
            "img",
        ],
        &["run", "--volumes-from", "other", "img"],
        &["run", "--runtime=weird", "img"],
        &["run", "--sysctl", "kernel.x=1", "img"],
    ];
    for b in bad {
        refused(docker(b), None);
    }
}

#[test]
fn only_an_apps_own_files_volume_or_the_egress_resolver_may_be_mounted() {
    assert!(
        docker(&[
            "run",
            "--mount",
            "type=volume,src=flagship-files-alice--chess,dst=/data",
            "img"
        ])
        .is_ok()
    );
    assert!(
        docker(&[
            "run",
            "--mount",
            "type=bind,src=/run/flagship-resolv-apps.conf,dst=/etc/resolv.conf,readonly",
            "img"
        ])
        .is_ok()
    );
    refused(
        docker(&[
            "run",
            "--mount",
            "type=volume,src=somebody-elses,dst=/data",
            "img",
        ]),
        None,
    );
    refused(
        docker(&[
            "create",
            "--mount",
            "type=volume,src=flagship-files-x,dst=/data",
            "img",
        ]),
        None,
    );
}

#[test]
fn docker_subcommands_outside_the_list_and_exec_cp_are_refused() {
    let bad: &[&[&str]] = &[
        &["exec", "c", "sh"],
        &["system", "prune"],
        &["plugin", "install", "x"],
        &["swarm", "init"],
        &["cp", "c:/etc/shadow", "/var/flagship/x"],
        &["save", "-o", "/tmp/x", "i"],
        &["load", "-i", "/tmp/x"],
        &["context", "use", "x"],
        &["login"],
        &["image", "build", "."],
        &["network", "prune"],
    ];
    for b in bad {
        refused(docker(b), None);
    }
    let ok: &[&[&str]] = &[
        &["ps", "-a"],
        &["inspect", "c"],
        &["stop", "c"],
        &["rm", "-f", "c"],
        &["image", "inspect", "i"],
        &["network", "create", "--internal", "n"],
        &["volume", "ls"],
        &["info"],
    ];
    for o in ok {
        assert!(docker(o).is_ok(), "{o:?}");
    }
}

#[test]
fn a_build_may_use_only_an_app_clone_context() {
    assert!(
        docker(&[
            "build",
            "-t",
            "x",
            "--network",
            "flagship-build",
            "/var/flagship/data/app-clones/alice--chess"
        ])
        .is_ok()
    );
    refused(docker(&["build", "-t", "x", "/var/flagship"]), None);
    refused(
        docker(&[
            "build",
            "-t",
            "x",
            "/var/flagship/data/app-clones/../../secrets",
        ]),
        None,
    );
    refused(
        docker(&[
            "build",
            "-f",
            "/etc/passwd",
            "/var/flagship/data/app-clones/alice--chess",
        ]),
        None,
    );
    refused(
        docker(&[
            "build",
            "-t",
            "x",
            "/var/flagship/data/app-clones/./hidden/..",
        ]),
        None,
    );
    assert!(
        docker(&[
            "build",
            "-t",
            "x",
            "/var/flagship/data/app-clones/a/.hidden"
        ])
        .is_ok()
    );
}

#[test]
fn compose_manages_only_the_boxs_data_services() {
    let f = "/opt/flagship/installer/data-services/docker-compose.yml";
    assert!(
        docker(&[
            "compose",
            "-f",
            f,
            "--env-file",
            "/var/flagship/data-services.env",
            "up",
            "-d",
            "postgres"
        ])
        .is_ok()
    );
    refused(docker(&["compose", "-f", "/tmp/evil.yml", "up"]), None);
    refused(
        docker(&["compose", "-f", f, "exec", "postgres", "sh"]),
        None,
    );
    refused(docker(&["compose", "-f", f, "up", "-d", "--build"]), None);
    refused(
        docker(&["compose", "-f", f, "--env-file", "/etc/shadow", "up"]),
        None,
    );
}

#[test]
fn malformed_docker_requests_are_refused_before_anything_is_built() {
    refused(docker_exec(&args(json!({ "argv": [] }))), None);
    refused(docker_exec(&args(json!({ "argv": "run img" }))), None);
    refused(docker_exec(&args(json!({ "argv": ["run", 5] }))), None);
    refused(
        docker_exec(&args(json!({ "argv": ["run", "a\u{0000}b"] }))),
        None,
    );
    refused(
        docker_exec(&args(json!({ "argv": ["ps"], "shell": "true" }))),
        None,
    );
    let long = "x".repeat(4097);
    refused(docker_exec(&args(json!({ "argv": ["ps", long] }))), None);
    // JS counts UTF-16 units: 2049 astral characters are 4098 units.
    let astral = "😀".repeat(2049);
    refused(docker_exec(&args(json!({ "argv": ["ps", astral] }))), None);
}

#[test]
fn the_firewall_script_may_touch_only_the_boxs_own_table() {
    let ok = [
        "add table inet flagship_egress",
        "flush table inet flagship_egress",
        "add chain inet flagship_egress forward { type filter hook forward priority 0; policy drop; }",
        "add rule inet flagship_egress forward iifname \"fs-apps\" ip daddr 10.0.0.1 tcp dport 443 accept",
    ]
    .join("\n");
    assert_eq!(
        nft_exec(&args(json!({ "script": ok })))
            .unwrap()
            .input
            .as_deref(),
        Some(ok.as_str())
    );
    for bad in [
        "flush ruleset",
        "delete table inet filter",
        "add table inet other",
        "add rule inet flagship_egress forward exec /bin/sh",
        "add rule inet flagship_egress forward accept; flush ruleset",
        "include \"/etc/x.nft\"",
        "add rule ip nat prerouting accept",
        "add rule inet flagship_egress forward `id`",
        "add rule inet flagship_egress forward delete table filter",
    ] {
        refused(nft_exec(&args(json!({ "script": bad }))), None);
    }
    assert!(nft_exec(&args(json!({ "script": "add rule inet flagship_egress forward delete table inet flagship_egress" }))).is_ok());
    assert!(
        nft_exec(&args(
            json!({ "script": "\u{FEFF}add table inet flagship_egress\u{3000}" })
        ))
        .is_ok()
    );
}

#[test]
fn refusal_codes_and_messages_match_privd() {
    let e = docker(&["run", "--privileged", "img"]).unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (ErrorCode::Forbidden, "--privileged is not allowed")
    );
    let e = docker(&["exec", "c"]).unwrap_err();
    assert_eq!(e.message, "docker exec is not allowed");
    let e = docker(&["image", "build"]).unwrap_err();
    assert_eq!(e.message, "docker image build is not allowed");
    let e = docker(&[
        "run",
        "--mount=type=bind,src=/var/run/docker.sock,dst=/x",
        "i",
    ])
    .unwrap_err();
    assert_eq!(e.message, "the docker socket is never mounted");
    let e = nft_exec(&args(json!({ "script": 5 }))).unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (ErrorCode::BadRequest, "script must be text")
    );
}

struct Rig {
    path: std::path::PathBuf,
    audit: std::path::PathBuf,
    stop: Arc<AtomicBool>,
    rec: Arc<Recorder>,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

fn rig(answer: Option<ExecOutput>, limits: V1Limits) -> Rig {
    let dir = tempdir("privd");
    let path = dir.join("p.sock");
    let audit = dir.join("audit.log");
    let listener = UnixListener::bind(&path).unwrap();
    let rec = Arc::new(Recorder::default());
    *rec.answer.lock().unwrap() = answer;
    let stop = Arc::new(AtomicBool::new(false));
    let factory = Arc::new(V1Factory {
        executor: rec.clone(),
        audit: Arc::new(Audit::new(Some(audit.clone()))),
        limits,
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
    Rig {
        path,
        audit,
        stop,
        rec,
    }
}

fn hello(c: &mut Client) {
    assert_eq!(
        c.call(&json!({ "id": 0, "op": "hello", "args": { "version": 1 } })),
        json!({ "id": 0, "ok": true, "result": { "version": 1 } })
    );
}

#[test]
fn runs_an_allowed_op_refuses_a_forbidden_one_and_audits_without_bodies() {
    let r = rig(None, V1Limits::default());
    let mut c = Client::connect(&r.path);
    hello(&mut c);
    assert_eq!(
        c.call(&json!({ "id": 1, "op": "docker", "args": { "argv": ["ps", "-a"] } })),
        json!({ "id": 1, "ok": true, "result": { "stdout": "done", "stderr": "" } })
    );
    assert_eq!(
        c.call(
            &json!({ "id": 2, "op": "docker", "args": { "argv": ["run", "--privileged", "img"] } })
        )["code"],
        "forbidden"
    );
    assert_eq!(
        c.call(&json!({ "id": 3, "op": "shell", "args": { "cmd": "id" } }))["code"],
        "unknown-op"
    );
    assert_eq!(c.call(&json!({ "id": 4, "op": "nft.apply", "args": { "script": "flush table inet flagship_egress" } }))["ok"], true);
    let files: Vec<&str> = r.rec.ran.lock().unwrap().iter().map(|e| e.file).collect();
    assert_eq!(files, vec!["/usr/bin/docker", "/usr/sbin/nft"]);
    let audit = std::fs::read_to_string(&r.audit).unwrap();
    assert!(audit.contains("\"op\":\"docker\""));
    assert!(audit.contains("\"ok\":false"));
    assert!(!audit.contains("flush table"));
}

#[test]
fn reports_a_failing_command_and_a_timeout_honestly() {
    let r = rig(
        Some(ExecOutput {
            code: Some(3),
            stdout: String::new(),
            stderr: "no such container".into(),
            timed_out: false,
        }),
        V1Limits::default(),
    );
    let mut c = Client::connect(&r.path);
    hello(&mut c);
    let res = c.call(&json!({ "id": 1, "op": "docker", "args": { "argv": ["stop", "c"] } }));
    assert_eq!(
        res,
        json!({ "id": 1, "ok": false, "code": "failed", "message": "exited with code 3: no such container" })
    );
    let r = rig(
        Some(ExecOutput {
            code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: true,
        }),
        V1Limits::default(),
    );
    let mut c = Client::connect(&r.path);
    hello(&mut c);
    assert_eq!(
        c.call(&json!({ "id": 1, "op": "power", "args": { "action": "reboot" } }))["code"],
        "timed-out"
    );
}

#[test]
fn a_caller_that_skips_hello_gets_nothing() {
    let r = rig(None, V1Limits::default());
    let mut c = Client::connect(&r.path);
    assert_eq!(
        c.call(&json!({ "id": 1, "op": "power", "args": { "action": "poweroff" } })),
        json!({ "id": 1, "ok": false, "code": "not-hello", "message": "say hello first" })
    );
    assert!(r.rec.ran.lock().unwrap().is_empty());
}

#[test]
fn a_wrong_version_is_refused_and_the_connection_closed() {
    let r = rig(None, V1Limits::default());
    let mut c = Client::connect(&r.path);
    assert_eq!(
        c.call(&json!({ "id": 7, "op": "hello", "args": { "version": 2 } }))["message"],
        "this broker speaks version 1 only"
    );
    assert!(c.recv().is_none());
}

#[test]
fn a_bad_frame_closes_the_connection_and_a_bad_request_echoes_its_id() {
    let r = rig(None, V1Limits::default());
    let mut c = Client::connect(&r.path);
    assert_eq!(
        c.call(&json!({ "id": 1.5, "op": "hello" })),
        json!({ "id": 1.5, "ok": false, "code": "bad-request", "message": "bad id" })
    );
    c.send_raw(&[0, 0, 0, 0]);
    assert!(c.recv().is_none());
}

#[test]
fn a_runaway_caller_is_slowed_and_a_silent_one_dropped() {
    let r = rig(
        None,
        V1Limits {
            max_per_second: 3,
            hello_timeout: std::time::Duration::from_millis(300),
        },
    );
    let mut c = Client::connect(&r.path);
    hello(&mut c);
    for i in 1..=2 {
        assert_eq!(
            c.call(&json!({ "id": i, "op": "docker", "args": { "argv": ["ps"] } }))["ok"],
            true
        );
    }
    assert_eq!(
        c.call(&json!({ "id": 9, "op": "docker", "args": { "argv": ["ps"] } }))["message"],
        "slow down"
    );
    let mut silent = Client::connect(&r.path);
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(silent.recv().is_none());
}

#[test]
fn a_peer_outside_the_policy_is_dropped_before_any_frame() {
    let dir = tempdir("privd-peer");
    let path = dir.join("p.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let rec = Arc::new(Recorder::default());
    let stop = Arc::new(AtomicBool::new(false));
    let factory = Arc::new(V1Factory {
        executor: rec.clone(),
        audit: Arc::new(Audit::new(None)),
        limits: V1Limits::default(),
    });
    let stop2 = stop.clone();
    std::thread::spawn(move || {
        let _ = serve(
            listener,
            Arc::new(FixedPeer(4242)),
            PeerPolicy::uids([1000]),
            factory,
            ServerLimits::default(),
            stop2,
            Arc::new(Audit::new(None)),
        );
    });
    let mut c = Client::connect(&path);
    c.send(&json!({ "id": 0, "op": "hello", "args": { "version": 1 } }));
    assert!(c.recv().is_none());
    stop.store(true, Ordering::SeqCst);
}

#[cfg(not(target_os = "linux"))]
#[test]
fn without_so_peercred_every_connection_is_refused() {
    use flagship_broker::peer::{KernelPeerCredentials, PeerAuthenticator};
    let (a, _b) = std::os::unix::net::UnixStream::pair().unwrap();
    assert!(KernelPeerCredentials.peer(&a).is_err());
}

#[test]
#[ignore = "needs Linux SO_PEERCRED"]
fn linux_kernel_peer_credentials_name_this_process() {
    use flagship_broker::peer::{KernelPeerCredentials, PeerAuthenticator};
    let (a, _b) = std::os::unix::net::UnixStream::pair().unwrap();
    let p = KernelPeerCredentials.peer(&a).unwrap();
    assert_eq!(p.uid, rustix_uid());
}

fn rustix_uid() -> u32 {
    std::fs::metadata("/proc/self")
        .map(|m| std::os::unix::fs::MetadataExt::uid(&m))
        .unwrap_or(u32::MAX)
}

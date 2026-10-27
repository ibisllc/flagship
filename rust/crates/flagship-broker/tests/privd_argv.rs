//! The docker run argv read the way the docker CLI reads it (AT-PRV-03..07), an app's dedicated
//! database, WASI worker units and drop-ins, and the audit mask: the same refusals as
//! packages/privd/src/policy.ts and server.ts.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use flagship_broker::podman::EngineKind;
use flagship_broker::policy::{
    DEDICATED_PG_IMAGE, PrivExec, docker_exec, parse_run_argv, systemctl_exec, wasi_unit_exec,
};
use flagship_broker::privd::{mask_secret, summary};
use flagship_broker::wire::{PrivdError, Request};
use serde_json::{Map, Value, json};

fn args(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

fn docker(argv: &[&str]) -> Result<PrivExec, PrivdError> {
    docker_exec(&args(json!({ "argv": argv })), EngineKind::Docker)
}

fn refused<T: std::fmt::Debug>(r: Result<T, PrivdError>, want: &str) {
    let e = r.expect_err("expected a refusal");
    assert!(
        e.message.contains(want),
        "{} does not contain {want}",
        e.message
    );
}

const IMG: &str = "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn run(flags: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = ["run", "-d", "--runtime", "runsc"]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    v.extend(flags.iter().map(|s| (*s).to_owned()));
    v.push(IMG.to_owned());
    v
}

fn docker_v(argv: &[String]) -> Result<PrivExec, PrivdError> {
    docker_exec(&args(json!({ "argv": argv })), EngineKind::Docker)
}

#[test]
fn attached_and_grouped_short_flags_are_read_as_the_cli_reads_them() {
    let p = parse_run_argv(&run(&["-itv/:/host"])).unwrap();
    let names: Vec<(&str, &str)> = p
        .flags
        .iter()
        .map(|f| (f.name.as_str(), f.value.as_str()))
        .collect();
    assert_eq!(
        names,
        [
            ("detach", "true"),
            ("runtime", "runsc"),
            ("interactive", "true"),
            ("tty", "true"),
            ("volume", "/:/host"),
        ]
    );
    for bad in [
        vec!["-v/:/host"],
        vec!["-v=/:/host"],
        vec!["-itv", "/:/host"],
        vec!["-tv=/:/h"],
        vec!["--volume=/:/h"],
    ] {
        refused(docker_v(&run(&bad)), "host-path mounts are not allowed");
    }
    refused(
        docker(&["run", "-dv", "/:/host", "--runtime", "runsc", IMG]),
        "host-path mounts are not allowed",
    );
    refused(docker_v(&run(&["-Z"])), "-Z is not a flag the broker knows");
    refused(docker_v(&run(&["--rm=yes"])), "--rm takes true or false");
    refused(
        docker_v(&run(&["--=x"])),
        "a flag the broker cannot read is not allowed",
    );
    refused(
        docker_v(&run(&["--privileged=false"])),
        "--privileged is not allowed",
    );
    // After the image, everything is the container's own command.
    assert!(docker(&["run", "--runtime=runsc", "--", IMG, "-v", "/:/x"]).is_ok());
}

#[test]
fn root_in_any_spelling_is_refused() {
    for u in [
        vec!["-u0"],
        vec!["-uroot"],
        vec!["-u=0"],
        vec!["-u", "00"],
        vec!["-u", "+0:0"],
        vec!["--user=0"],
        vec!["-du0"],
        vec!["-itu", "root:root"],
    ] {
        refused(docker_v(&run(&u)), "a container may not run as root");
    }
    assert!(docker_v(&run(&["-u10001"])).is_ok());
}

#[test]
fn another_containers_network_namespace_is_refused_under_docker() {
    for n in [
        vec!["--network", "container:flagship-postgres"],
        vec!["--network=container:alice--chess"],
        vec!["--net=container:x"],
        vec!["--network", "ns:/proc/1/ns/net"],
    ] {
        refused(docker_v(&run(&n)), "a container joins a named network only");
    }
    refused(
        docker_v(&run(&["--net", "host"])),
        "host networking is not allowed",
    );
}

#[test]
fn an_ordinary_run_names_runsc() {
    let msg = "a container runs under gVisor (--runtime runsc)";
    refused(docker(&["run", "-d", IMG]), msg);
    refused(docker(&["run", "-d", "--runtime", "runc", IMG]), msg);
    refused(
        docker(&["run", "-d", "--runtime=runsc", "--runtime=runc", IMG]),
        msg,
    );
    // The first violation wins: a forbidden flag before the runtime is checked as missing.
    refused(
        docker(&["run", "--privileged", IMG]),
        "--privileged is not allowed",
    );
    assert!(docker_v(&run(&[])).is_ok());
}

const KEY: &str = "0123456789abcdef01234567";

fn dedicated(key: &str, extra: &[&str]) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "run".into(),
        "-d".into(),
        "--name".into(),
        format!("flagship-pgd-{KEY}"),
        "--label".into(),
        "flagship.role=dedicated-postgres".into(),
        "--restart".into(),
        "unless-stopped".into(),
        "--runtime=runsc".into(),
        "--cap-drop=ALL".into(),
    ];
    for c in ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"] {
        a.push("--cap-add".into());
        a.push(c.into());
    }
    for x in [
        "--security-opt=no-new-privileges",
        "--network",
        "flagship-apps",
        "--memory",
        "256m",
        "--memory-swap",
        "256m",
        "--cpus",
        "0.50",
        "--pids-limit",
        "128",
        "--shm-size",
        "64m",
        "-e",
        "POSTGRES_USER=flagship_admin",
        "-e",
        "POSTGRES_PASSWORD=Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-xy",
        "-e",
        "POSTGRES_DB=postgres",
        "-e",
        "POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256",
        "-p",
        "127.0.0.1:41234:5432",
    ] {
        a.push(x.into());
    }
    a.push("--mount".into());
    a.push(format!(
        "type=volume,src=flagship-pgdata-{key},dst=/var/lib/postgresql"
    ));
    a.push("--mount".into());
    a.push(format!(
        "type=volume,src=flagship-pgsock-{key},dst=/var/run/postgresql"
    ));
    a.extend(extra.iter().map(|s| (*s).to_owned()));
    a.push(DEDICATED_PG_IMAGE.into());
    for x in [
        "postgres",
        "-c",
        "max_connections=20",
        "-c",
        "statement_timeout=30s",
    ] {
        a.push(x.into());
    }
    a
}

#[test]
fn an_apps_dedicated_database_runs_only_in_its_exact_shape() {
    assert!(docker_v(&dedicated(KEY, &[])).is_ok());
    // Another app's volumes, or any loosening, make it an ordinary run, which adds no capability.
    refused(
        docker_v(&dedicated("fedcba9876543210fedcba98", &[])),
        "--cap-add is not allowed",
    );
    refused(
        docker_v(&dedicated(KEY, &["--cap-add", "SYS_ADMIN"])),
        "--cap-add is not allowed",
    );
    refused(
        docker_v(&dedicated(KEY, &["-v", "/:/host"])),
        "--cap-add is not allowed",
    );
    let runc: Vec<String> = dedicated(KEY, &[])
        .into_iter()
        .map(|x| {
            if x == "--runtime=runsc" {
                "--runtime=runc".into()
            } else {
                x
            }
        })
        .collect();
    refused(
        docker_v(&runc),
        "a container runs under gVisor (--runtime runsc)",
    );
    assert!(docker(&["exec", &format!("flagship-pgd-{KEY}"), "pg_isready", "-q"]).is_ok());
    refused(
        docker(&["exec", &format!("flagship-pgd-{KEY}"), "sh", "-c", "id"]),
        "exec may not run sh",
    );
}

#[test]
fn a_dedicated_database_may_carry_its_own_address_and_endpoint_labels_and_nothing_else() {
    let own = format!("flagship.service=pgd-{KEY}");
    let ok = dedicated(
        KEY,
        &[
            "--ip",
            "10.89.1.2",
            "--label",
            &own,
            "--label",
            "flagship.generation=1793112048092",
        ],
    );
    assert!(docker_v(&ok).is_ok());
    // Another service's identity, a name that is not an address, or a second address: an ordinary run.
    for bad in [
        vec!["--label", "flagship.service=pgd-fedcba9876543210fedcba98"],
        vec!["--label", "flagship.generation=x"],
        vec!["--ip", "not-an-ip"],
        vec!["--ip", "10.89.1.2", "--ip", "10.89.1.3"],
    ] {
        refused(docker_v(&dedicated(KEY, &bad)), "--cap-add is not allowed");
    }
}

fn sc(argv: &[&str]) -> Result<PrivExec, PrivdError> {
    systemctl_exec(&args(json!({ "argv": argv })))
}

#[test]
fn wasi_workers_get_only_their_verbs() {
    let u = "flagship-wasi@0123456789abcdef.service";
    for v in ["stop", "reset-failed", "freeze", "thaw"] {
        assert!(sc(&[v, u]).is_ok(), "{v}");
    }
    assert!(sc(&["start", "--no-block", u]).is_ok());
    assert!(sc(&["show", u, "--property=ActiveState,Result"]).is_ok());
    refused(
        sc(&["enable", u]),
        "not allowed on a WebAssembly app's worker",
    );
    refused(
        sc(&["stop", u, "docker.service"]),
        "not allowed on a WebAssembly app's worker",
    );
    refused(
        sc(&["freeze", "docker.service"]),
        "only for a WebAssembly app's worker",
    );
    for other in [
        "flagship-wasi@0123456789ABCDEF.service",
        "flagship-wasi@.service",
        "flagship-wasi@../../etc/x.service",
        "flagship-wasi@0123456789abcdef.service\nExecStart=/bin/sh",
        "getty@0123456789abcdef.service",
    ] {
        refused(
            sc(&["start", other]),
            "that unit is not one the daemon manages",
        );
    }
}

#[test]
fn wasi_drop_ins_are_rendered_from_typed_fields() {
    let ok = json!({ "action": "write", "instance": "0123456789abcdef", "world": "command", "memoryMiB": 384, "tasks": 64, "cpuPercent": 50, "restart": "never", "filesPath": "/var/lib/flagship-files/flagship-files-alice--chess/data" });
    let e = wasi_unit_exec(&args(ok.clone())).unwrap();
    assert_eq!(e.file, "/usr/bin/install");
    assert_eq!(
        e.args.last().map(String::as_str),
        Some("/run/systemd/system/flagship-wasi@0123456789abcdef.service.d/50-app.conf")
    );
    assert_eq!(
        e.input.as_deref(),
        Some(
            "# Written by the Flagship daemon (wasi/unit.ts) for one app.\n[Service]\nExecStart=\nExecStart=/usr/local/lib/flagship-wasi/flagship-wasi-worker run --config /var/app/pkg/worker.json\nRestart=no\nMemoryMax=384M\nTasksMax=64\nCPUQuota=50%\nBindPaths=/var/lib/flagship-files/flagship-files-alice--chess/data:/var/app/data\n"
        )
    );
    let with = |k: &str, v: Value| {
        let mut m = args(ok.clone());
        m.insert(k.into(), v);
        wasi_unit_exec(&m)
    };
    refused(
        with("world", json!("http-proxy\nExecStartPre=/bin/sh")),
        "world is command or http-proxy",
    );
    refused(
        with("restart", json!("on-failure\nUser=root")),
        "restart is always",
    );
    refused(
        with("memoryMiB", json!(64.5)),
        "memoryMiB must be a whole number from 32 to 8192",
    );
    refused(
        with("filesPath", json!("/etc")),
        "binds only its own files folder",
    );
    refused(
        with(
            "filesPath",
            json!("/var/lib/flagship-files/flagship-pgdata-0123456789abcdef01234567/data"),
        ),
        "binds only its own files folder",
    );
    refused(
        with("instance", json!("../../../etc/systemd")),
        "instance is 16 lowercase hex",
    );
    refused(
        with("text", json!("[Service]\nUser=root")),
        "unknown field text",
    );
    let rm = wasi_unit_exec(&args(
        json!({ "action": "remove", "instance": "0123456789abcdef" }),
    ))
    .unwrap();
    assert_eq!(
        rm.args,
        [
            "-rf",
            "--",
            "/run/systemd/system/flagship-wasi@0123456789abcdef.service.d"
        ]
    );
}

#[test]
fn the_audit_never_holds_a_password() {
    assert_eq!(
        mask_secret("POSTGRES_PASSWORD=s3cret"),
        "POSTGRES_PASSWORD=…"
    );
    assert_eq!(
        mask_secret("-ePOSTGRES_PASSWORD=s3cret"),
        "-ePOSTGRES_PASSWORD=…"
    );
    assert_eq!(mask_secret("--env=db_password=a=b"), "--env=db_password=…");
    assert_eq!(mask_secret("PORT=8080"), "PORT=8080");
    let req = Request {
        id: 1,
        op: "docker",
        args: args(json!({ "argv": ["run", "-e", "POSTGRES_PASSWORD=s3cret", "img"] })),
    };
    let line = summary(&req);
    assert!(!line.contains("s3cret"), "{line}");
    assert_eq!(line, "run -e POSTGRES_PASSWORD=…");
}

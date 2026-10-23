//! The Docker adapter's argv against what serviceRunner.ts generates today.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

use flagship_runtime::exec::{Exec, ExecOutput, Executor};
use flagship_runtime::oci_cli::{create_argv, observed_from};
use flagship_runtime::plan::ExecutionPlan;
use flagship_runtime::{
    Engine, FilesVolumeName, OciCli, PlanError, ResolvConf, ResolvedNetwork, ResolvedWorkload,
    Runtime, RuntimeError, SandboxDns, VolumeId,
};
use serde_json::{Value, json};
use std::sync::Mutex;

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn d(c: char) -> String {
    format!("sha256:{}", c.to_string().repeat(64))
}

pub fn plan_json(installation: &str) -> Value {
    json!({
        "schema": 1,
        "installation": installation,
        "generation": 3,
        "image": {
            "repository": "ghcr.io/flagship/notes",
            "indexDigest": d('b'),
            "platformManifestDigest": d('a'),
            "platform": { "os": "linux", "architecture": "amd64" }
        },
        "manifestDigest": d('c'),
        "capabilities": { "network": "apps", "publish": { "hostPort": 40000, "containerPort": 8080 }, "linuxCapabilities": [] },
        "resources": { "memoryBytes": 536870912u64, "cpuMillis": 1000, "pidsLimit": 256, "tmpfsBytes": 67108864u64 },
        "volumes": [{ "id": "v-notes1", "readOnly": false }],
        "networkPolicyDigest": d('e'),
        "environment": { "PORT": "8080" },
        "secrets": [{ "env": "DATABASE_URL", "handle": "s-db1" }],
        "health": { "kind": "http", "startupTimeoutSecs": 60, "intervalSecs": 1 },
        "restart": { "kind": "never" }
    })
}

fn plan(v: &Value) -> ExecutionPlan {
    ExecutionPlan::from_json(serde_json::to_string(v).unwrap().as_bytes()).unwrap()
}

fn mib(v: &str) -> u64 {
    let (n, unit) = v.split_at(v.len() - 1);
    let n: u64 = n.parse().unwrap();
    match unit {
        "m" => n,
        "g" => n * 1024,
        _ => panic!("unit {unit}"),
    }
}

/// The adapter's deliberate differences from `docker run -d`, removed so the rest compares 1:1:
/// it creates then starts (so the create can be journalled), labels the workload with its
/// installation, generation and plan digest, and never pulls at create time.
fn strip_deltas(rust: &[String], ts: &[String]) -> (Vec<String>, Vec<String>) {
    assert_eq!(&rust[..3], &["create", "--name", ts[3].as_str()]);
    assert_eq!(&ts[..2], &["run", "-d"]);
    let mut r: Vec<String> = Vec::new();
    let mut i = 3;
    while i < rust.len() {
        if rust[i] == "--label" {
            i += 2;
            continue;
        }
        if rust[i] == "--pull=never" {
            i += 1;
            continue;
        }
        r.push(rust[i].clone());
        i += 1;
    }
    let mut t: Vec<String> = ts[4..].to_vec();
    // ContainerLimits.memory is passed through verbatim ("2g"); the plan carries bytes.
    for list in [&mut r, &mut t] {
        if let Some(p) = list.iter().position(|a| a == "--memory") {
            list[p + 1] = format!("{}MiB", mib(&list[p + 1]));
        }
    }
    (r, t)
}

fn labels(argv: &[String]) -> Vec<String> {
    argv.windows(2)
        .filter(|w| w[0] == "--label")
        .map(|w| w[1].clone())
        .collect()
}

#[test]
fn sandboxed_deploy_matches_service_runner() {
    let fx = fixture("service-runner-deploy-sandboxed.json");
    let ts: Vec<String> = serde_json::from_value(fx["argv"].clone()).unwrap();
    let mut v = plan_json("alice--notes");
    v["image"]["repository"] = json!("ghcr.io/flagship/notes");
    let p = plan(&v);
    let net = ResolvedNetwork::Apps {
        sandbox: Some(SandboxDns {
            gateway: "10.89.0.1".parse().unwrap(),
            resolv: Some(ResolvConf::for_bridge_key("flagship-apps").unwrap()),
        }),
    };
    let w = ResolvedWorkload::resolve(
        &p,
        net,
        &[(
            VolumeId::parse("v-notes1").unwrap(),
            FilesVolumeName::parse("flagship-files-alice--notes").unwrap(),
        )],
        &[(
            flagship_runtime::SecretHandle::parse("s-db1").unwrap(),
            "postgres://u:p@host.flagship.internal:5432/x".to_owned(),
        )],
    )
    .unwrap();
    let rust = create_argv(&w);
    // env order: plain variables (sorted), then resolved secrets; the TS fixture has them sorted.
    let mut rust_sorted_env = rust.clone();
    sort_env(&mut rust_sorted_env);
    let (r, t) = strip_deltas(&rust_sorted_env, &ts);
    assert_eq!(r, t);
    assert_eq!(
        labels(&rust),
        vec![
            "flagship.installation=alice--notes".to_owned(),
            "flagship.generation=3".to_owned(),
            format!("flagship.plan={}", p.digest())
        ]
    );
    assert_eq!(
        rust.last().unwrap(),
        &format!("ghcr.io/flagship/notes@{}", d('a'))
    );
}

fn sort_env(argv: &mut [String]) {
    let pos: Vec<usize> = (0..argv.len()).filter(|i| argv[*i] == "-e").collect();
    let mut vals: Vec<String> = pos.iter().map(|i| argv[i + 1].clone()).collect();
    vals.sort();
    for (i, v) in pos.iter().zip(vals) {
        argv[i + 1] = v;
    }
}

#[test]
fn plain_deploy_with_overridden_limits_matches_service_runner() {
    let fx = fixture("service-runner-deploy-plain.json");
    let ts: Vec<String> = serde_json::from_value(fx["argv"].clone()).unwrap();
    let mut v = plan_json("photos");
    v["image"]["repository"] = json!("ghcr.io/flagship/photos");
    v["capabilities"] = json!({ "network": "apps", "publish": { "hostPort": 63015, "containerPort": 80 }, "linuxCapabilities": ["NET_BIND_SERVICE"] });
    v["resources"] = json!({ "memoryBytes": 2147483648u64, "cpuMillis": 2500, "pidsLimit": 1024, "tmpfsBytes": 67108864u64 });
    v["volumes"] = json!([]);
    v["secrets"] = json!([]);
    v["environment"] = json!({ "PORT": "80" });
    let p = plan(&v);
    let w =
        ResolvedWorkload::resolve(&p, ResolvedNetwork::Apps { sandbox: None }, &[], &[]).unwrap();
    let (r, t) = strip_deltas(&create_argv(&w), &ts);
    assert_eq!(r, t);
}

#[test]
fn every_hardening_flag_is_present_and_no_host_authority_is() {
    let p = plan(&plan_json("alice--notes"));
    let w = ResolvedWorkload::resolve(
        &p,
        ResolvedNetwork::Apps { sandbox: None },
        &[(
            VolumeId::parse("v-notes1").unwrap(),
            FilesVolumeName::parse("flagship-files-alice--notes").unwrap(),
        )],
        &[(
            flagship_runtime::SecretHandle::parse("s-db1").unwrap(),
            "x".to_owned(),
        )],
    )
    .unwrap();
    let a = create_argv(&w);
    for flag in [
        "--runtime=runsc",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--read-only",
        "--pids-limit",
        "--memory",
        "--cpus",
    ] {
        assert!(a.iter().any(|x| x == flag), "{flag} missing");
    }
    let joined = a.join(" ");
    for bad in [
        "--privileged",
        "--pid",
        "--ipc",
        "--uts",
        "--userns",
        "--device",
        "--cap-add",
        "docker.sock",
        "/var/flagship",
        "-v",
        "--volume",
        "host:",
        "--network host",
        "seccomp",
        "apparmor",
    ] {
        assert!(
            !a.iter().any(|x| x == bad) && !joined.contains(&format!(" {bad} ")),
            "{bad} present"
        );
    }
    assert!(!joined.contains("--network host") && !joined.contains("--net=host"));
}

#[test]
fn plans_that_ask_for_host_authority_are_refused() {
    let base = plan_json("alice--notes");
    let cases: Vec<(&str, Value)> = vec![
        ("privileged mode", json!(true)),
        ("a command line", json!(["sh", "-c", "id"])),
        ("a mount", json!([{ "src": "/", "dst": "/host" }])),
        ("a hook", json!({ "prestart": ["/bin/sh"] })),
        ("a raw device", json!(["/dev/sda"])),
        ("a host namespace", json!("host")),
    ];
    let keys = [
        "privileged",
        "command",
        "mounts",
        "hooks",
        "devices",
        "pidMode",
    ];
    for ((what, val), key) in cases.into_iter().zip(keys) {
        let mut v = base.clone();
        v[key] = val;
        let err =
            ExecutionPlan::from_json(serde_json::to_string(&v).unwrap().as_bytes()).unwrap_err();
        assert_eq!(err, PlanError::Forbidden(what.to_owned()), "{key}");
    }
    // nested inside an allowed object too
    let mut v = base.clone();
    v["capabilities"]["cap_add"] = json!(["SYS_ADMIN"]);
    assert!(matches!(
        ExecutionPlan::from_json(v.to_string().as_bytes()),
        Err(PlanError::Forbidden(_))
    ));
    let mut v = base.clone();
    v["capabilities"]["network"] = json!("host");
    assert_eq!(
        ExecutionPlan::from_json(v.to_string().as_bytes()),
        Err(PlanError::Forbidden("host networking".to_owned()))
    );
    let mut v = base.clone();
    v["capabilities"]["linuxCapabilities"] = json!(["SYS_ADMIN"]);
    assert!(matches!(
        ExecutionPlan::from_json(v.to_string().as_bytes()),
        Err(PlanError::Json(_))
    ));
    // unknown fields are refused, not ignored
    let mut v = base.clone();
    v["isolation"] = json!("none");
    assert!(matches!(
        ExecutionPlan::from_json(v.to_string().as_bytes()),
        Err(PlanError::Json(_))
    ));
    // environment keys are data, so an app may have a variable called COMMAND
    let mut v = base.clone();
    v["environment"]["COMMAND"] = json!("x");
    assert!(ExecutionPlan::from_json(v.to_string().as_bytes()).is_ok());
}

#[test]
fn digest_binds_every_field() {
    let base = plan_json("alice--notes");
    let d0 = plan(&base).digest();
    let edits: Vec<(&str, Value)> = vec![
        ("/generation", json!(4)),
        ("/image/platformManifestDigest", json!(d('f'))),
        ("/image/indexDigest", json!(d('f'))),
        ("/manifestDigest", json!(d('f'))),
        ("/networkPolicyDigest", json!(d('f'))),
        ("/resources/pidsLimit", json!(257)),
        ("/environment/PORT", json!("8081")),
        ("/volumes/0/readOnly", json!(true)),
        ("/secrets/0/handle", json!("s-db2")),
        ("/restart", json!({ "kind": "on-failure", "maxRetries": 3 })),
    ];
    for (ptr, val) in edits {
        let mut v = base.clone();
        *v.pointer_mut(ptr).unwrap() = val;
        assert_ne!(plan(&v).digest(), d0, "{ptr}");
    }
    let text = String::from_utf8(plan(&base).canonical_bytes()).unwrap();
    assert!(text.starts_with("flagship/execution-plan/v1|installation=alice--notes|generation=3|"));
}

#[test]
fn bad_values_are_refused() {
    let base = plan_json("alice--notes");
    let edits: Vec<(&str, Value)> = vec![
        ("/generation", json!(0)),
        ("/installation", json!("../etc")),
        ("/image/repository", json!("Evil/../x")),
        ("/image/platformManifestDigest", json!("sha256:short")),
        ("/resources/memoryBytes", json!(1)),
        ("/resources/pidsLimit", json!(0)),
        ("/capabilities/publish/hostPort", json!(22)),
        ("/volumes", json!([{ "id": "v-a" }, { "id": "v-b" }])),
        ("/schema", json!(2)),
        ("/secrets", json!([{ "env": "PORT", "handle": "s-x" }])),
    ];
    for (ptr, val) in edits {
        let mut v = base.clone();
        *v.pointer_mut(ptr).unwrap() = val;
        assert!(
            ExecutionPlan::from_json(v.to_string().as_bytes()).is_err(),
            "{ptr}"
        );
    }
    // duplicate environment variables in the JSON text
    let text = base
        .to_string()
        .replace("\"PORT\":\"8080\"", "\"PORT\":\"8080\",\"PORT\":\"9\"");
    assert!(ExecutionPlan::from_json(text.as_bytes()).is_err());
}

#[test]
fn device_claims_wait_for_the_gpu_journal() {
    let mut v = plan_json("alice--notes");
    v["deviceClaim"] = json!({ "claimId": "gpu-claim-1", "class": "gpu", "count": 1 });
    let p = plan(&v);
    let r = ResolvedWorkload::resolve(&p, ResolvedNetwork::Apps { sandbox: None }, &[], &[]);
    assert!(matches!(r, Err(RuntimeError::Unsupported(_))));
}

#[test]
fn every_reference_must_be_resolved_and_nothing_else() {
    let p = plan(&plan_json("alice--notes"));
    let vol = (
        VolumeId::parse("v-notes1").unwrap(),
        FilesVolumeName::parse("flagship-files-alice--notes").unwrap(),
    );
    let sec = (
        flagship_runtime::SecretHandle::parse("s-db1").unwrap(),
        "x".to_owned(),
    );
    assert!(
        ResolvedWorkload::resolve(
            &p,
            ResolvedNetwork::Apps { sandbox: None },
            &[],
            std::slice::from_ref(&sec)
        )
        .is_err()
    );
    assert!(
        ResolvedWorkload::resolve(
            &p,
            ResolvedNetwork::Apps { sandbox: None },
            std::slice::from_ref(&vol),
            &[]
        )
        .is_err()
    );
    assert!(
        ResolvedWorkload::resolve(
            &p,
            ResolvedNetwork::None,
            std::slice::from_ref(&vol),
            std::slice::from_ref(&sec)
        )
        .is_err()
    );
    let other = (
        VolumeId::parse("v-other").unwrap(),
        FilesVolumeName::parse("flagship-files-bob--chess").unwrap(),
    );
    assert!(
        ResolvedWorkload::resolve(
            &p,
            ResolvedNetwork::Apps { sandbox: None },
            &[other],
            std::slice::from_ref(&sec)
        )
        .is_err()
    );
    assert!(FilesVolumeName::parse("/var/flagship/data").is_err());
    assert!(ResolvConf::for_bridge_key("../../etc/shadow").is_err());
}

#[derive(Default)]
struct Recorder {
    calls: Mutex<Vec<Exec>>,
    answer: Mutex<Vec<ExecOutput>>,
}

impl Executor for Recorder {
    fn run(&self, exec: &Exec) -> ExecOutput {
        self.calls.lock().unwrap().push(exec.clone());
        self.answer.lock().unwrap().pop().unwrap_or(ExecOutput {
            code: Some(0),
            ..ExecOutput::default()
        })
    }
}

#[test]
fn adapter_runs_the_pinned_binary_without_input_and_classifies_failures() {
    let rec = Recorder::default();
    rec.answer.lock().unwrap().push(ExecOutput { code: Some(125), stderr: "Error response from daemon: Conflict. The container name \"/flagship-alice--notes\" is already in use".into(), ..ExecOutput::default() });
    let cli = OciCli::new(Engine::Docker, rec);
    let p = plan(&plan_json("alice--notes"));
    let w = ResolvedWorkload::resolve(
        &p,
        ResolvedNetwork::Apps { sandbox: None },
        &[(
            VolumeId::parse("v-notes1").unwrap(),
            FilesVolumeName::parse("flagship-files-alice--notes").unwrap(),
        )],
        &[(
            flagship_runtime::SecretHandle::parse("s-db1").unwrap(),
            "x".to_owned(),
        )],
    )
    .unwrap();
    assert_eq!(cli.create(&w), Err(RuntimeError::Conflict));
    let podman = OciCli::new(Engine::Podman, Recorder::default());
    podman.create(&w).unwrap();
}

#[test]
fn observations_trust_labels_only_when_they_match_the_name() {
    let row = json!({ "ID": "abc", "Names": "flagship-alice--notes", "Labels": format!("flagship.installation=alice--notes,flagship.generation=3,flagship.plan={}", d('a')), "State": "running", "Image": "x" });
    let o = observed_from(&row).unwrap();
    assert_eq!(o.generation, Some(3));
    assert!(!o.legacy());
    let lying = json!({ "ID": "abc", "Names": "flagship-alice--notes", "Labels": "flagship.installation=bob--chess,flagship.generation=9", "State": "running" });
    assert!(observed_from(&lying).unwrap().legacy());
    let legacy =
        json!({ "ID": "abc", "Names": "flagship-photos", "Labels": "", "State": "exited" });
    assert!(observed_from(&legacy).unwrap().legacy());
    assert!(
        observed_from(&json!({ "ID": "x", "Names": "postgres", "State": "running" })).is_none()
    );
    let inspect = json!({ "Id": "abc", "Name": "/flagship-photos", "State": { "Status": "running" }, "Config": { "Labels": { "flagship.installation": "photos", "flagship.generation": "2", "flagship.plan": d('a') }, "Image": "img" } });
    let o = observed_from(&inspect).unwrap();
    assert_eq!((o.generation, o.state.as_str()), (Some(2), "running"));
}

#[test]
fn containerd_says_unsupported() {
    let c = flagship_runtime::containerd::Containerd;
    assert!(matches!(c.list(), Err(RuntimeError::Unsupported(_))));
}

//! A hostile caller (a compromised core) against the typed broker: it holds the socket but not
//! the authority's key, so it cannot mount host paths, run a shell, grant devices, act across
//! apps, replay a capability or use a stale generation.
#![allow(
    clippy::too_many_arguments,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

mod common;

use common::{Recorder, tempdir};
use ed25519_dalek::{Signer, SigningKey};
use flagship_broker::audit::Audit;
use flagship_broker::capability::{Ed25519Authority, OpKind};
use flagship_broker::netpolicy::{EgressRule, NetworkPolicy};
use flagship_broker::peer::Peer;
use flagship_broker::state::BrokerState;
use flagship_broker::typed::{
    BrokerConfig, Clock, Parts, SandboxNetwork, SecretStore, TypedBroker, release_subject,
    shutdown_subject, stop_subject, volume_subject,
};
use flagship_runtime::exec::{Exec, ExecOutput, Executor};
use flagship_runtime::fake::FakeRuntime;
use flagship_runtime::plan::ExecutionPlan;
use flagship_runtime::{
    Digest, FilesVolumeName, InstallationId, SandboxDns, SecretHandle, VolumeId,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

const NOW: u64 = 1_800_000_000;

struct SharedExec(Arc<Recorder>);
impl Executor for SharedExec {
    fn run(&self, e: &Exec) -> ExecOutput {
        self.0.run(e)
    }
}

struct TestClock(Arc<AtomicU64>);
impl Clock for TestClock {
    fn now_unix(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct Secrets(BTreeMap<(String, String), String>);
impl SecretStore for Secrets {
    fn resolve(&self, i: &InstallationId, h: &SecretHandle) -> Option<String> {
        self.0.get(&(i.to_string(), h.to_string())).cloned()
    }
}

struct NoSandbox;
impl SandboxNetwork for NoSandbox {
    fn apps_sandbox(&self) -> Option<SandboxDns> {
        None
    }
}

struct H {
    broker: TypedBroker,
    rt: Arc<FakeRuntime>,
    host: Arc<Recorder>,
    key: SigningKey,
    files: std::path::PathBuf,
    state_dir: std::path::PathBuf,
    clock: Arc<AtomicU64>,
    n: AtomicU64,
}

fn d(c: char) -> String {
    format!("sha256:{}", c.to_string().repeat(64))
}

fn build(
    state_dir: &std::path::Path,
    files: &std::path::Path,
    rt: Arc<FakeRuntime>,
    host: Arc<Recorder>,
    require_mounted: bool,
) -> (TypedBroker, Arc<AtomicU64>) {
    let key = SigningKey::from_bytes(&[7u8; 32]);
    let verifier = Ed25519Authority::new()
        .with_key("authority-1", key.verifying_key().to_bytes())
        .unwrap();
    let mut cfg = BrokerConfig::production(files.to_path_buf(), state_dir.to_path_buf());
    cfg.require_mounted_volumes = require_mounted;
    cfg.app_uid = rustix::process::geteuid().as_raw();
    cfg.app_gid = rustix::process::getegid().as_raw();
    let mut secrets = BTreeMap::new();
    secrets.insert(
        ("alice--notes".into(), "s-db1".into()),
        "postgres://alice".into(),
    );
    secrets.insert(
        ("bob--chess".into(), "s-bob".into()),
        "postgres://bob".into(),
    );
    let clock = Arc::new(AtomicU64::new(NOW));
    let state = BrokerState::open(&state_dir.join("broker.db")).unwrap();
    let parts = Parts {
        verifier: Box::new(verifier),
        runtime: Box::new(rt),
        host: Box::new(SharedExec(host)),
        secrets: Box::new(Secrets(secrets)),
        network: Box::new(NoSandbox),
        clock: Box::new(TestClock(clock.clone())),
        audit: Arc::new(Audit::new(Some(state_dir.join("audit.log")))),
    };
    (TypedBroker::new(cfg, state, parts), clock)
}

fn harness(require_mounted: bool) -> H {
    let root = tempdir("typed");
    let files = root.join("files");
    let state_dir = root.join("state");
    for p in [
        &files,
        &state_dir,
        &files.join("flagship-files-alice--notes"),
        &files.join("flagship-files-bob--chess"),
    ] {
        std::fs::create_dir_all(p).unwrap();
        std::fs::set_permissions(p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    }
    let rt = Arc::new(FakeRuntime::new());
    let host = Arc::new(Recorder::default());
    let (broker, clock) = build(
        &state_dir,
        &files,
        rt.clone(),
        host.clone(),
        require_mounted,
    );
    H {
        broker,
        rt,
        host,
        key: SigningKey::from_bytes(&[7u8; 32]),
        files,
        state_dir,
        clock,
        n: AtomicU64::new(1),
    }
}

fn sign(key: &SigningKey, mut cap: Value) -> Value {
    let parsed: flagship_broker::capability::Capability =
        serde_json::from_value(cap.clone()).unwrap();
    let sig = key.sign(&parsed.signed_bytes());
    cap["signature"]["value"] = json!(flagship_runtime::hex::encode(&sig.to_bytes()));
    cap
}

impl H {
    fn cap_with(
        &self,
        op: OpKind,
        inst: Option<&str>,
        generation: u64,
        prior: u64,
        subject: Digest,
        epoch: u64,
        key: &SigningKey,
    ) -> Value {
        let id = format!("{:032x}", self.n.fetch_add(1, Ordering::SeqCst));
        sign(
            key,
            json!({
                "v": 1, "id": id, "op": op, "installation": inst, "generation": generation,
                "expectedPriorRevision": prior, "subject": subject.to_string(), "revocationEpoch": epoch,
                "notBefore": NOW - 10, "expiresAt": NOW + 300,
                "signature": { "suite": "ed25519", "keyId": "authority-1", "value": "" }
            }),
        )
    }
    fn cap(
        &self,
        op: OpKind,
        inst: Option<&str>,
        generation: u64,
        prior: u64,
        subject: Digest,
    ) -> Value {
        self.cap_with(op, inst, generation, prior, subject, 0, &self.key)
    }
    fn req(
        &self,
        op: &str,
        inst: Option<&str>,
        generation: u64,
        prior: u64,
        payload: Value,
        cap: Option<Value>,
    ) -> Value {
        json!({
            "protocolVersion": 2, "requestId": format!("r-{}", self.n.fetch_add(1, Ordering::SeqCst)), "op": op,
            "operationRef": "core-op-1", "target": { "installation": inst, "generation": generation },
            "expectedRevision": prior, "deadlineUnixMs": (NOW + 60) * 1000, "payload": payload, "capability": cap
        })
    }
    fn call(&self, v: &Value) -> Value {
        self.broker.handle(
            &Peer {
                uid: 1000,
                gid: 1000,
                pid: None,
            },
            v,
        )
    }
    fn revision(&self, inst: Option<&str>) -> u64 {
        let r = self.call(&self.req("Describe", inst, 0, 0, json!({}), None));
        r["result"]["revision"].as_u64().unwrap()
    }
    fn prepare(&self, inst: &str, vol: &str) -> Value {
        let i = InstallationId::parse(inst).unwrap();
        let v = VolumeId::parse(vol).unwrap();
        let name = FilesVolumeName::for_installation(&i).unwrap();
        let prior = self.revision(Some(inst));
        let cap = self.cap(
            OpKind::PrepareAppVolume,
            Some(inst),
            3,
            prior,
            volume_subject(&i, &v, &name),
        );
        self.call(&self.req(
            "PrepareAppVolume",
            Some(inst),
            3,
            prior,
            json!({ "volumeId": vol }),
            Some(cap),
        ))
    }
    fn policy(&self, inst: &str, generation: u64) -> (Value, Digest) {
        let p = NetworkPolicy {
            schema: 1,
            installation: InstallationId::parse(inst).unwrap(),
            generation,
            egress: vec![EgressRule {
                host: "api.example.com".into(),
                port: 443,
            }],
        };
        (serde_json::to_value(&p).unwrap(), p.digest())
    }
    fn apply_policy(&self, inst: &str, generation: u64) -> Value {
        let (p, digest) = self.policy(inst, generation);
        let prior = self.revision(Some(inst));
        let cap = self.cap(
            OpKind::ApplyNetworkPolicy,
            Some(inst),
            generation,
            prior,
            digest,
        );
        self.call(&self.req(
            "ApplyNetworkPolicy",
            Some(inst),
            generation,
            prior,
            json!({ "policy": p }),
            Some(cap),
        ))
    }
    fn start_req(&self, plan: &Value) -> (Value, Value) {
        let p = ExecutionPlan::from_value(plan).unwrap();
        let inst = p.installation.to_string();
        let prior = self.revision(Some(&inst));
        let cap = self.cap(
            OpKind::StartApprovedWorkload,
            Some(&inst),
            p.generation,
            prior,
            p.digest(),
        );
        (
            self.req(
                "StartApprovedWorkload",
                Some(&inst),
                p.generation,
                prior,
                json!({ "plan": plan }),
                Some(cap.clone()),
            ),
            cap,
        )
    }
}

fn plan(
    inst: &str,
    generation: u64,
    policy: Digest,
    vol: Option<&str>,
    secret: Option<&str>,
) -> Value {
    let repo = format!("ghcr.io/flagship/{}", inst.replace("--", "-"));
    json!({
        "schema": 1, "installation": inst, "generation": generation,
        "image": { "repository": repo, "indexDigest": d('b'), "platformManifestDigest": d('a'), "platform": { "os": "linux", "architecture": "arm64" } },
        "manifestDigest": d('c'),
        "capabilities": { "network": "apps", "publish": { "hostPort": 40000, "containerPort": 8080 } },
        "resources": { "memoryBytes": 536870912u64, "cpuMillis": 1000, "pidsLimit": 256, "tmpfsBytes": 67108864u64 },
        "volumes": vol.map_or(json!([]), |v| json!([{ "id": v }])),
        "networkPolicyDigest": policy.to_string(),
        "environment": { "PORT": "8080" },
        "secrets": secret.map_or(json!([]), |s| json!([{ "env": "DATABASE_URL", "handle": s }])),
        "health": { "kind": "http", "startupTimeoutSecs": 60, "intervalSecs": 1 },
        "restart": { "kind": "never" }
    })
}

fn code(v: &Value) -> &str {
    if v["ok"] == true {
        "ok"
    } else {
        v["code"].as_str().unwrap_or("?")
    }
}

fn ready_alice(h: &H) -> Digest {
    assert_eq!(code(&h.prepare("alice--notes", "v-alice")), "ok");
    assert_eq!(code(&h.apply_policy("alice--notes", 3)), "ok");
    h.policy("alice--notes", 3).1
}

#[test]
fn an_approved_plan_starts_exactly_as_approved() {
    let h = harness(false);
    let policy = ready_alice(&h);
    let (req, _) = h.start_req(&plan(
        "alice--notes",
        3,
        policy,
        Some("v-alice"),
        Some("s-db1"),
    ));
    let r = h.call(&req);
    assert_eq!(code(&r), "ok", "{r}");
    let s = h.rt.state();
    assert_eq!(s.create_argv.len(), 1);
    let argv = &s.create_argv[0];
    assert!(
        argv.contains(&"--runtime=runsc".to_owned()) && argv.contains(&"--cap-drop=ALL".to_owned())
    );
    assert!(argv.contains(&"type=volume,src=flagship-files-alice--notes,dst=/data".to_owned()));
    assert!(argv.contains(&"DATABASE_URL=postgres://alice".to_owned()));
    assert_eq!(
        s.workloads["flagship-alice--notes"].state.as_str(),
        "running"
    );
    let audit = std::fs::read_to_string(h.state_dir.join("audit.log")).unwrap();
    assert!(
        !audit.contains("postgres://alice"),
        "secrets never reach the audit log"
    );
    assert!(
        std::fs::metadata(h.files.join("flagship-files-alice--notes/data"))
            .unwrap()
            .is_dir()
    );
    assert!(
        std::fs::read_to_string(h.state_dir.join("egress/alice--notes.json"))
            .unwrap()
            .contains("api.example.com")
    );
}

#[test]
fn no_capability_no_effect_and_a_boolean_grants_nothing() {
    let h = harness(false);
    let policy = ready_alice(&h);
    let (mut req, _) = h.start_req(&plan("alice--notes", 3, policy, Some("v-alice"), None));
    req["capability"] = Value::Null;
    assert_eq!(code(&h.call(&req)), "forbidden");
    let (mut req, _) = h.start_req(&plan("alice--notes", 3, policy, Some("v-alice"), None));
    req["approved"] = json!(true);
    assert_eq!(code(&h.call(&req)), "bad-request");
    assert_eq!(
        code(&h.call(&h.req("Exec", None, 0, 0, json!({ "argv": ["sh"] }), None))),
        "unknown-op"
    );
    assert!(h.rt.state().create_argv.is_empty());
}

#[test]
fn a_forged_or_tampered_capability_does_not_verify() {
    let h = harness(false);
    let policy = ready_alice(&h);
    let forger = SigningKey::from_bytes(&[9u8; 32]);
    let p = plan("alice--notes", 3, policy, Some("v-alice"), None);
    let parsed = ExecutionPlan::from_value(&p).unwrap();
    let prior = h.revision(Some("alice--notes"));
    let forged = h.cap_with(
        OpKind::StartApprovedWorkload,
        Some("alice--notes"),
        3,
        prior,
        parsed.digest(),
        0,
        &forger,
    );
    assert_eq!(
        code(&h.call(&h.req(
            "StartApprovedWorkload",
            Some("alice--notes"),
            3,
            prior,
            json!({ "plan": p }),
            Some(forged)
        ))),
        "bad-signature"
    );
    let (mut req, _) = h.start_req(&p);
    req["capability"]["expiresAt"] = json!(NOW + 299);
    assert_eq!(code(&h.call(&req)), "bad-signature");
    let (mut req, _) = h.start_req(&p);
    req["capability"]["signature"]["suite"] = json!("none");
    assert_eq!(code(&h.call(&req)), "bad-signature");
    assert!(h.rt.state().create_argv.is_empty());
}

#[test]
fn a_plan_cannot_mount_host_paths_run_a_shell_or_grant_devices() {
    let h = harness(false);
    let policy = ready_alice(&h);
    for (key, val) in [
        (
            "mounts",
            json!([{ "type": "bind", "src": "/", "dst": "/host" }]),
        ),
        ("command", json!(["/bin/sh", "-c", "id"])),
        ("entrypoint", json!("/bin/sh")),
        ("devices", json!(["/dev/sda"])),
        ("privileged", json!(true)),
        ("pidMode", json!("host")),
        ("hooks", json!({ "prestart": [{ "path": "/bin/sh" }] })),
    ] {
        let mut p = plan("alice--notes", 3, policy, Some("v-alice"), None);
        p[key] = val;
        let prior = h.revision(Some("alice--notes"));
        // Even a correctly signed capability over the bytes cannot make such a plan acceptable:
        // the broker refuses to parse it before it looks at authority.
        let cap = h.cap(
            OpKind::StartApprovedWorkload,
            Some("alice--notes"),
            3,
            prior,
            Digest::of(p.to_string().as_bytes()),
        );
        let r = h.call(&h.req(
            "StartApprovedWorkload",
            Some("alice--notes"),
            3,
            prior,
            json!({ "plan": p }),
            Some(cap),
        ));
        assert_eq!(code(&r), "forbidden", "{key}: {r}");
    }
    let mut p = plan("alice--notes", 3, policy, Some("v-alice"), None);
    p["deviceClaim"] = json!({ "claimId": "gpu-1", "class": "gpu", "count": 1 });
    let (req, _) = h.start_req(&p);
    assert_eq!(code(&h.call(&req)), "unsupported");
    assert!(h.rt.state().create_argv.is_empty());
    assert_eq!(
        h.revision(Some("alice--notes")),
        2,
        "no refused start moved the revision"
    );
}

#[test]
fn nothing_crosses_from_one_app_to_another() {
    let h = harness(false);
    let alice_policy = ready_alice(&h);
    assert_eq!(code(&h.prepare("bob--chess", "v-bob")), "ok");
    assert_eq!(code(&h.apply_policy("bob--chess", 3)), "ok");
    let bob_policy = h.policy("bob--chess", 3).1;
    // alice's capability presented for bob's installation
    let (alice_req, alice_cap) = h.start_req(&plan(
        "alice--notes",
        3,
        alice_policy,
        Some("v-alice"),
        None,
    ));
    let mut stolen = alice_req.clone();
    stolen["target"]["installation"] = json!("bob--chess");
    stolen["payload"]["plan"] = plan("bob--chess", 3, bob_policy, Some("v-bob"), None);
    assert_eq!(code(&h.call(&stolen)), "forbidden");
    let _ = alice_cap;
    // bob's own, validly signed plan naming alice's volume, alice's secret, alice's policy
    for p in [
        plan("bob--chess", 3, bob_policy, Some("v-alice"), None),
        plan("bob--chess", 3, bob_policy, Some("v-bob"), Some("s-db1")),
        plan("bob--chess", 3, alice_policy, Some("v-bob"), None),
    ] {
        let (req, _) = h.start_req(&p);
        assert_eq!(code(&h.call(&req)), "forbidden", "{p}");
    }
    // bob cannot register alice's volume id either
    let i = InstallationId::parse("bob--chess").unwrap();
    let v = VolumeId::parse("v-alice").unwrap();
    let prior = h.revision(Some("bob--chess"));
    let cap = h.cap(
        OpKind::PrepareAppVolume,
        Some("bob--chess"),
        3,
        prior,
        volume_subject(&i, &v, &FilesVolumeName::for_installation(&i).unwrap()),
    );
    assert_eq!(
        code(&h.call(&h.req(
            "PrepareAppVolume",
            Some("bob--chess"),
            3,
            prior,
            json!({ "volumeId": "v-alice" }),
            Some(cap)
        ))),
        "forbidden"
    );
    // and stopping alice with a capability for bob is refused
    let cap = h.cap(
        OpKind::StopWorkload,
        Some("bob--chess"),
        0,
        h.revision(Some("bob--chess")),
        stop_subject(&i, 0, true),
    );
    let mut req = h.req(
        "StopWorkload",
        Some("alice--notes"),
        0,
        h.revision(Some("bob--chess")),
        json!({ "remove": true }),
        Some(cap),
    );
    req["expectedRevision"] = json!(h.revision(Some("bob--chess")));
    assert_eq!(code(&h.call(&req)), "forbidden");
    assert!(h.rt.state().create_argv.is_empty());
}

#[test]
fn a_capability_works_once_even_across_a_broker_restart() {
    let h = harness(false);
    let policy = ready_alice(&h);
    let (req, _) = h.start_req(&plan("alice--notes", 3, policy, Some("v-alice"), None));
    assert_eq!(code(&h.call(&req)), "ok");
    assert_eq!(code(&h.call(&req)), "replayed");
    drop(h.broker);
    let (again, _) = build(&h.state_dir, &h.files, h.rt.clone(), h.host.clone(), false);
    assert_eq!(
        code(&again.handle(
            &Peer {
                uid: 1,
                gid: 1,
                pid: None
            },
            &req
        )),
        "replayed"
    );
    assert_eq!(h.rt.state().create_argv.len(), 1);
}

#[test]
fn stale_generations_and_revisions_are_refused() {
    let h = harness(false);
    let policy = ready_alice(&h);
    let (req, _) = h.start_req(&plan("alice--notes", 3, policy, Some("v-alice"), None));
    assert_eq!(code(&h.call(&req)), "ok");
    // an older generation, even with a valid fresh capability
    let (req, _) = h.start_req(&plan("alice--notes", 2, policy, Some("v-alice"), None));
    assert_eq!(code(&h.call(&req)), "stale");
    let (p2, d2) = h.policy("alice--notes", 2);
    let prior = h.revision(Some("alice--notes"));
    let cap = h.cap(
        OpKind::ApplyNetworkPolicy,
        Some("alice--notes"),
        2,
        prior,
        d2,
    );
    assert_eq!(
        code(&h.call(&h.req(
            "ApplyNetworkPolicy",
            Some("alice--notes"),
            2,
            prior,
            json!({ "policy": p2 }),
            Some(cap)
        ))),
        "stale"
    );
    // the same generation with a different plan
    let mut other = plan("alice--notes", 3, policy, Some("v-alice"), None);
    other["environment"]["PORT"] = json!("9090");
    let (req, _) = h.start_req(&other);
    assert_eq!(code(&h.call(&req)), "stale");
    // a capability issued against an old revision
    let p = plan("alice--notes", 4, policy, Some("v-alice"), None);
    let parsed = ExecutionPlan::from_value(&p).unwrap();
    let old = h.revision(Some("alice--notes")) - 1;
    let cap = h.cap(
        OpKind::StartApprovedWorkload,
        Some("alice--notes"),
        4,
        old,
        parsed.digest(),
    );
    assert_eq!(
        code(&h.call(&h.req(
            "StartApprovedWorkload",
            Some("alice--notes"),
            4,
            old,
            json!({ "plan": p }),
            Some(cap)
        ))),
        "stale"
    );
    assert_eq!(h.rt.state().create_argv.len(), 1);
}

#[test]
fn a_new_generation_needs_the_old_one_removed_and_its_own_policy() {
    let h = harness(false);
    let policy = ready_alice(&h);
    let (req, _) = h.start_req(&plan("alice--notes", 3, policy, Some("v-alice"), None));
    assert_eq!(code(&h.call(&req)), "ok");
    let (p4, d4) = h.policy("alice--notes", 4);
    let (req, _) = h.start_req(&plan("alice--notes", 4, policy, Some("v-alice"), None));
    assert_eq!(code(&h.call(&req)), "conflict");
    let i = InstallationId::parse("alice--notes").unwrap();
    let prior = h.revision(Some("alice--notes"));
    let stop = h.cap(
        OpKind::StopWorkload,
        Some("alice--notes"),
        3,
        prior,
        stop_subject(&i, 3, true),
    );
    assert_eq!(
        code(&h.call(&h.req(
            "StopWorkload",
            Some("alice--notes"),
            3,
            prior,
            json!({ "remove": true }),
            Some(stop)
        ))),
        "ok"
    );
    let (req, _) = h.start_req(&plan("alice--notes", 4, d4, Some("v-alice"), None));
    assert_eq!(
        code(&h.call(&req)),
        "forbidden",
        "policy for generation 4 is not installed yet"
    );
    let prior = h.revision(Some("alice--notes"));
    let cap = h.cap(
        OpKind::ApplyNetworkPolicy,
        Some("alice--notes"),
        4,
        prior,
        d4,
    );
    assert_eq!(
        code(&h.call(&h.req(
            "ApplyNetworkPolicy",
            Some("alice--notes"),
            4,
            prior,
            json!({ "policy": p4 }),
            Some(cap)
        ))),
        "ok"
    );
    let (req, _) = h.start_req(&plan("alice--notes", 4, d4, Some("v-alice"), None));
    assert_eq!(code(&h.call(&req)), "ok");
    assert_eq!(
        h.rt.state().workloads["flagship-alice--notes"].generation,
        Some(4)
    );
}

#[test]
fn a_revocation_epoch_kills_every_older_capability() {
    let h = harness(false);
    let policy = ready_alice(&h);
    let (req, _) = h.start_req(&plan("alice--notes", 3, policy, Some("v-alice"), None));
    let unsigned = json!({ "statement": { "epoch": 5, "issuedAt": NOW, "signature": { "suite": "ed25519", "keyId": "authority-1", "value": "00" } } });
    assert_eq!(
        code(&h.call(&h.req("AdvanceRevocationEpoch", None, 0, 0, unsigned, None))),
        "bad-signature"
    );
    let mut st = json!({ "epoch": 5, "issuedAt": NOW, "signature": { "suite": "ed25519", "keyId": "authority-1", "value": "" } });
    let parsed: flagship_broker::capability::EpochStatement =
        serde_json::from_value(st.clone()).unwrap();
    st["signature"]["value"] = json!(flagship_runtime::hex::encode(
        &h.key.sign(&parsed.signed_bytes()).to_bytes()
    ));
    assert_eq!(
        code(&h.call(&h.req(
            "AdvanceRevocationEpoch",
            None,
            0,
            0,
            json!({ "statement": st }),
            None
        ))),
        "ok"
    );
    assert_eq!(code(&h.call(&req)), "revoked");
    // a capability issued under the new epoch works
    let p =
        ExecutionPlan::from_value(&plan("alice--notes", 3, policy, Some("v-alice"), None)).unwrap();
    let prior = h.revision(Some("alice--notes"));
    let cap = h.cap_with(
        OpKind::StartApprovedWorkload,
        Some("alice--notes"),
        3,
        prior,
        p.digest(),
        5,
        &h.key,
    );
    let r = h.call(&h.req(
        "StartApprovedWorkload",
        Some("alice--notes"),
        3,
        prior,
        json!({ "plan": serde_json::to_value(&p).unwrap() }),
        Some(cap),
    ));
    assert_eq!(code(&r), "ok");
}

#[test]
fn time_bounds_are_enforced() {
    let h = harness(false);
    let policy = ready_alice(&h);
    let (req, _) = h.start_req(&plan("alice--notes", 3, policy, Some("v-alice"), None));
    h.clock.store(NOW + 301, Ordering::SeqCst);
    let mut late = req.clone();
    late["deadlineUnixMs"] = json!((NOW + 400) * 1000);
    assert_eq!(code(&h.call(&late)), "expired");
    h.clock.store(NOW + 120, Ordering::SeqCst);
    assert_eq!(
        code(&h.call(&req)),
        "expired",
        "the request's own deadline passed"
    );
    h.clock.store(NOW, Ordering::SeqCst);
    let p =
        ExecutionPlan::from_value(&plan("alice--notes", 3, policy, Some("v-alice"), None)).unwrap();
    let prior = h.revision(Some("alice--notes"));
    let mut long = h.cap(
        OpKind::StartApprovedWorkload,
        Some("alice--notes"),
        3,
        prior,
        p.digest(),
    );
    long["expiresAt"] = json!(NOW + 86_400);
    let long = sign(&h.key, long);
    let r = h.call(&h.req(
        "StartApprovedWorkload",
        Some("alice--notes"),
        3,
        prior,
        json!({ "plan": serde_json::to_value(&p).unwrap() }),
        Some(long),
    ));
    assert_eq!(code(&r), "expired");
}

#[test]
fn volumes_are_reached_without_following_symlinks() {
    let h = harness(false);
    let outside = tempdir("outside");
    std::fs::create_dir_all(outside.join("data")).unwrap();
    std::os::unix::fs::symlink(&outside, h.files.join("flagship-files-carol--x")).unwrap();
    let r = h.prepare("carol--x", "v-carol");
    assert_eq!(code(&r), "failed", "{r}");
    // the data folder itself planted as a symlink
    std::fs::create_dir_all(h.files.join("flagship-files-dave--y")).unwrap();
    std::os::unix::fs::symlink(&outside, h.files.join("flagship-files-dave--y/data")).unwrap();
    assert_eq!(code(&h.prepare("dave--y", "v-dave")), "failed");
    // a group-writable root is not the broker's to trust
    std::fs::set_permissions(
        &h.files,
        std::os::unix::fs::PermissionsExt::from_mode(0o775),
    )
    .unwrap();
    assert_eq!(code(&h.prepare("alice--notes", "v-alice")), "failed");
    assert!(h.rt.state().volumes.is_empty());
}

#[test]
fn an_unmounted_volume_image_fails_closed() {
    let h = harness(true);
    let r = h.prepare("alice--notes", "v-alice");
    assert_eq!(code(&r), "failed");
    assert!(r["message"].as_str().unwrap().contains("not mounted"));
    assert!(!h.files.join("flagship-files-alice--notes/data").exists());
}

#[test]
fn host_operations_run_fixed_commands_only() {
    let h = harness(false);
    let commit = "0123456789abcdef0123456789abcdef01234567";
    let rel = Digest::parse(&d('9')).unwrap();
    let cap = h.cap(
        OpKind::ActivateRelease,
        None,
        1,
        0,
        release_subject(1, commit, &rel),
    );
    let r = h.call(&h.req(
        "ActivateRelease",
        None,
        1,
        0,
        json!({ "commit": commit, "releaseDigest": rel.to_string() }),
        Some(cap),
    ));
    assert_eq!(code(&r), "ok", "{r}");
    assert!(
        std::fs::read_to_string(h.state_dir.join("release/active.json"))
            .unwrap()
            .contains(commit)
    );
    let stale = h.cap(
        OpKind::RequestShutdown,
        None,
        0,
        1,
        shutdown_subject("reboot"),
    );
    assert_eq!(
        code(&h.call(&h.req(
            "RequestShutdown",
            None,
            0,
            1,
            json!({ "action": "reboot" }),
            Some(stale)
        ))),
        "stale"
    );
    let cap = h.cap(
        OpKind::RequestShutdown,
        None,
        1,
        1,
        shutdown_subject("reboot"),
    );
    assert_eq!(
        code(&h.call(&h.req(
            "RequestShutdown",
            None,
            1,
            1,
            json!({ "action": "reboot" }),
            Some(cap)
        ))),
        "ok"
    );
    let shell = h.cap(
        OpKind::RequestShutdown,
        None,
        1,
        2,
        shutdown_subject("halt; id"),
    );
    assert_eq!(
        code(&h.call(&h.req(
            "RequestShutdown",
            None,
            1,
            2,
            json!({ "action": "halt; id" }),
            Some(shell)
        ))),
        "bad-request"
    );
    let ran: Vec<Vec<String>> = h
        .host
        .ran
        .lock()
        .unwrap()
        .iter()
        .map(|e| e.args.clone())
        .collect();
    assert_eq!(
        ran,
        vec![
            vec!["restart".to_owned(), "flagship-daemon.service".to_owned()],
            vec!["reboot".to_owned()]
        ]
    );
    // a host capability may not name an installation
    let mut bad = h.cap(
        OpKind::RequestShutdown,
        None,
        1,
        2,
        shutdown_subject("reboot"),
    );
    bad["installation"] = json!("alice--notes");
    let bad = sign(&h.key, bad);
    assert_eq!(
        code(&h.call(&h.req(
            "RequestShutdown",
            Some("alice--notes"),
            1,
            2,
            json!({ "action": "reboot" }),
            Some(bad)
        ))),
        "bad-request"
    );
}

#[test]
fn the_typed_socket_answers_framed_requests_from_allowed_peers_only() {
    use flagship_broker::peer::PeerPolicy;
    use flagship_broker::server::{ServerLimits, serve};
    use flagship_broker::typed::TypedFactory;
    use std::sync::atomic::AtomicBool;
    let h = harness(false);
    let req = h.req("Describe", Some("alice--notes"), 0, 0, json!({}), None);
    let wrong = json!({ "protocolVersion": 1, "requestId": "r-x", "op": "Describe" });
    let sock = h.state_dir.join("core.sock");
    let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let factory = Arc::new(TypedFactory {
        broker: Arc::new(h.broker),
        max_per_second: 20,
    });
    let stop2 = stop.clone();
    std::thread::spawn(move || {
        let _ = serve(
            listener,
            Arc::new(common::FixedPeer(1000)),
            PeerPolicy::uids([1000]),
            factory,
            ServerLimits::default(),
            stop2,
            Arc::new(Audit::new(None)),
        );
    });
    let mut c = common::Client::connect(&sock);
    let r = c.call(&req);
    assert_eq!(
        (r["ok"].clone(), r["result"]["scope"].clone()),
        (json!(true), json!("app:alice--notes"))
    );
    assert_eq!(c.call(&wrong)["code"], "unsupported-version");
    stop.store(true, Ordering::SeqCst);
}

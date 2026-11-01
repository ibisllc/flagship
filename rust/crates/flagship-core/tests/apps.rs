//! The app reconciler (G3) against a simulated engine and executor: shadow mode never acts,
//! rust mode adopts what runs, installs, upgrades, stops and forgets with exactly one container
//! per workload, and a core or daemon that dies at any point converges without a second copy.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use flagship_core::apps::{
    AppController, DesiredWorkload, Effect, EffectKind, Kind, Mode, NetworkInfo, ObservedContainer,
    Outcome, Resources, SettleRequest, SyncRequest, SyncResponse, WorkloadKey,
};
use flagship_core::journal::Journal;
use flagship_core::schedule::Capacity;

static CLOCK: AtomicU64 = AtomicU64::new(1_800_000_000_000);
fn clock() -> u64 {
    CLOCK.load(Ordering::SeqCst)
}
fn advance(ms: u64) {
    CLOCK.fetch_add(ms, Ordering::SeqCst);
}

const NET: &str = "flagship-apps";

#[derive(Debug, Clone)]
struct Container {
    installation: String,
    component: String,
    generation: i64,
    running: bool,
    address: Option<String>,
}

/// The engine: containers by name, and a count of every create and remove.
#[derive(Debug, Default)]
struct Engine {
    containers: BTreeMap<String, Container>,
    creates: Vec<(String, i64)>,
    removes: Vec<(String, i64)>,
    seq: u64,
}

fn name_of(inst: &str, comp: &str) -> String {
    if comp == "main" {
        format!("flagship-{inst}")
    } else {
        format!("flagship-{inst}.{comp}")
    }
}

impl Engine {
    fn observed(&self) -> Vec<ObservedContainer> {
        self.containers
            .iter()
            .map(|(name, c)| ObservedContainer {
                name: name.clone(),
                container_id: format!("id-{name}-{}", c.generation),
                installation: c.installation.clone(),
                component: c.component.clone(),
                generation: Some(c.generation),
                running: c.running,
                started_at: "2026-11-01T00:00:00Z".into(),
                addresses: c
                    .address
                    .iter()
                    .map(|a| (NET.to_owned(), a.clone()))
                    .collect(),
            })
            .collect()
    }

    /// The executor's work: what the daemon does with an effect.
    fn perform(&mut self, e: &Effect) -> Result<(), String> {
        let name = name_of(&e.installation, &e.component);
        match e.kind {
            EffectKind::Deploy => {
                if self.containers.contains_key(&name) {
                    return Err(format!("the container name {name} is already in use"));
                }
                if let Some(a) = &e.address
                    && self
                        .containers
                        .values()
                        .any(|c| c.address.as_ref() == Some(a))
                {
                    return Err(format!("requested ip address {a} is already allocated"));
                }
                self.seq += 1;
                self.creates.push((name.clone(), e.generation));
                self.containers.insert(
                    name,
                    Container {
                        installation: e.installation.clone(),
                        component: e.component.clone(),
                        generation: e.generation,
                        running: true,
                        address: e.address.clone(),
                    },
                );
                Ok(())
            }
            EffectKind::Remove => {
                if self
                    .containers
                    .get(&name)
                    .is_some_and(|c| c.generation == e.generation)
                {
                    self.containers.remove(&name);
                    self.removes.push((name, e.generation));
                }
                Ok(())
            }
        }
    }
}

fn desired(inst: &str, digest: char, running: bool) -> DesiredWorkload {
    DesiredWorkload {
        installation: inst.into(),
        component: "main".into(),
        kind: Kind::App,
        network: NET.into(),
        spec_digest: std::iter::repeat_n(digest, 64).collect(),
        running,
        epoch: 0,
        resources: Resources {
            memory_bytes: 512 << 20,
            cpu_millis: 1000,
        },
        wants_address: true,
    }
}

fn request(executor: &str, mode: Mode, want: &[DesiredWorkload], engine: &Engine) -> SyncRequest {
    SyncRequest {
        executor: executor.into(),
        mode,
        desired: want.to_vec(),
        forget: vec![],
        observed: engine.observed(),
        occupied: vec![],
        networks: vec![NetworkInfo {
            name: NET.into(),
            subnet: "10.89.0.0/24".into(),
            gateways: vec!["10.89.0.1".into()],
        }],
        capacity: Capacity {
            memory_bytes: 4 << 30,
            cpu_millis: 4000,
        },
    }
}

fn open(dir: &Path) -> AppController {
    AppController::with_clock(Journal::open(&dir.join("journal.db")).unwrap(), clock)
}

/// Sync, perform every effect, settle; repeat until no effect is handed out.
fn converge(
    c: &mut AppController,
    executor: &str,
    want: &[DesiredWorkload],
    engine: &mut Engine,
) -> SyncResponse {
    for _ in 0..20 {
        let r = c
            .sync(&request(executor, Mode::Rust, want, engine))
            .unwrap();
        if r.effects.is_empty() {
            return r;
        }
        for e in &r.effects {
            let res = engine.perform(e);
            let conflict = res.as_ref().err().and_then(|m| {
                m.strip_prefix("requested ip address ")
                    .and_then(|r| r.split(' ').next())
                    .map(str::to_owned)
            });
            c.settle(&SettleRequest {
                executor: executor.into(),
                op: e.op,
                outcome: if res.is_ok() {
                    Outcome::Ok
                } else {
                    Outcome::Definite
                },
                detail: res.err(),
                conflict_ip: conflict,
            })
            .unwrap();
        }
        advance(1000);
    }
    panic!("no convergence");
}

fn state_of<'a>(r: &'a SyncResponse, inst: &str) -> &'a str {
    &r.workloads
        .iter()
        .find(|w| w.installation == inst)
        .unwrap()
        .state
}

#[test]
fn shadow_mode_never_hands_out_an_effect_and_counts_agreement() {
    let dir = tempdir();
    let mut c = open(dir.path());
    let engine = Engine::default();
    let want = [desired("alice--notes", 'a', true)];
    let r = c
        .sync(&request("ex1", Mode::Shadow, &want, &engine))
        .unwrap();
    assert!(r.effects.is_empty() && !r.live);
    assert_eq!(r.divergent.len(), 1);
    assert_eq!(r.agree_passes, 0);
    // The daemon deploys itself (TS owns the effects in shadow mode).
    let mut engine = engine;
    engine.containers.insert(
        "flagship-alice--notes".into(),
        Container {
            installation: "alice--notes".into(),
            component: "main".into(),
            generation: 77,
            running: true,
            address: Some("10.89.0.9".into()),
        },
    );
    for n in 1..=3 {
        let r = c
            .sync(&request("ex1", Mode::Shadow, &want, &engine))
            .unwrap();
        assert!(r.effects.is_empty());
        assert_eq!(r.agree_passes, n);
    }
    assert!(engine.creates.is_empty());
}

#[test]
fn rust_mode_adopts_what_runs_without_restarting_it() {
    let dir = tempdir();
    let mut c = open(dir.path());
    let mut engine = Engine::default();
    engine.containers.insert(
        "flagship-alice--notes".into(),
        Container {
            installation: "alice--notes".into(),
            component: "main".into(),
            generation: 77,
            running: true,
            address: Some("10.89.0.9".into()),
        },
    );
    let want = [desired("alice--notes", 'a', true)];
    let r = converge(&mut c, "ex1", &want, &mut engine);
    assert!(r.live);
    assert_eq!(state_of(&r, "alice--notes"), "running");
    assert!(engine.creates.is_empty() && engine.removes.is_empty());
    // A second app gets an address that is not the adopted one.
    let want2 = [
        desired("alice--notes", 'a', true),
        desired("alice--chess", 'b', true),
    ];
    let r = converge(&mut c, "ex1", &want2, &mut engine);
    assert_eq!(state_of(&r, "alice--chess"), "running");
    let chess = &engine.containers["flagship-alice--chess"];
    assert_ne!(chess.address.as_deref(), Some("10.89.0.9"));
    assert_eq!(engine.creates.len(), 1);
}

#[test]
fn install_upgrade_restart_stop_and_forget_keep_one_container() {
    let dir = tempdir();
    let mut c = open(dir.path());
    let mut engine = Engine::default();
    let r = converge(
        &mut c,
        "ex1",
        &[desired("alice--notes", 'a', true)],
        &mut engine,
    );
    assert_eq!(state_of(&r, "alice--notes"), "running");
    let first = engine.containers["flagship-alice--notes"].clone();
    assert!(first.address.as_deref().unwrap().starts_with("10.89.0."));
    // Upgrade: a new spec replaces the container, same address.
    converge(
        &mut c,
        "ex1",
        &[desired("alice--notes", 'b', true)],
        &mut engine,
    );
    let second = engine.containers["flagship-alice--notes"].clone();
    assert!(second.generation > first.generation);
    assert_eq!(second.address, first.address);
    assert_eq!(
        engine.removes,
        vec![("flagship-alice--notes".into(), first.generation)]
    );
    // An explicit restart raises the epoch.
    let mut restarted = desired("alice--notes", 'b', true);
    restarted.epoch = 1;
    converge(&mut c, "ex1", &[restarted.clone()], &mut engine);
    assert!(engine.containers["flagship-alice--notes"].generation > second.generation);
    // A container that stopped on its own is replaced.
    engine
        .containers
        .get_mut("flagship-alice--notes")
        .unwrap()
        .running = false;
    converge(&mut c, "ex1", &[restarted.clone()], &mut engine);
    assert!(engine.containers["flagship-alice--notes"].running);
    // Stop.
    let mut stopped = restarted.clone();
    stopped.running = false;
    let r = converge(&mut c, "ex1", &[stopped], &mut engine);
    assert_eq!(state_of(&r, "alice--notes"), "stopped");
    assert!(engine.containers.is_empty());
    // Forget: the record goes, and the address with it.
    let mut req = request("ex1", Mode::Rust, &[], &engine);
    req.forget = vec![WorkloadKey {
        installation: "alice--notes".into(),
        component: "main".into(),
    }];
    let r = c.sync(&req).unwrap();
    assert!(r.effects.is_empty());
    let r = c.sync(&request("ex1", Mode::Rust, &[], &engine)).unwrap();
    assert!(r.workloads.is_empty());
    let n_creates = engine.creates.len();
    assert_eq!(n_creates, engine.removes.len());
}

#[test]
fn a_core_that_dies_at_any_point_converges_to_one_container() {
    // Die after the intent is handed out but before the effect, and after the effect but before
    // it is settled; each time a new core (new term) and a new daemon (new executor) take over.
    for performed in [false, true] {
        let dir = tempdir();
        let mut engine = Engine::default();
        let want = [desired("alice--notes", 'a', true)];
        {
            let mut c = open(dir.path());
            let r = c.sync(&request("ex1", Mode::Rust, &want, &engine)).unwrap();
            assert_eq!(r.effects.len(), 1);
            if performed {
                engine.perform(&r.effects[0]).unwrap();
            }
        }
        let mut c = open(dir.path());
        let r = converge(&mut c, "ex2", &want, &mut engine);
        assert_eq!(state_of(&r, "alice--notes"), "running");
        assert_eq!(engine.containers.len(), 1);
        assert_eq!(
            engine.creates.len(),
            1,
            "performed={performed}: {:?}",
            engine.creates
        );
        assert!(engine.removes.is_empty());
        // And its generation is the one core recorded: no replacement on the next pass.
        let again = c.sync(&request("ex2", Mode::Rust, &want, &engine)).unwrap();
        assert!(again.effects.is_empty());
    }
}

#[test]
fn an_upgrade_cut_off_between_remove_and_deploy_recovers() {
    let dir = tempdir();
    let mut engine = Engine::default();
    {
        let mut c = open(dir.path());
        converge(
            &mut c,
            "ex1",
            &[desired("alice--notes", 'a', true)],
            &mut engine,
        );
        let r = c
            .sync(&request(
                "ex1",
                Mode::Rust,
                &[desired("alice--notes", 'b', true)],
                &engine,
            ))
            .unwrap();
        assert_eq!(r.effects[0].kind, EffectKind::Remove);
        engine.perform(&r.effects[0]).unwrap();
        // Core dies before it hears the outcome.
    }
    let mut c = open(dir.path());
    let r = converge(
        &mut c,
        "ex2",
        &[desired("alice--notes", 'b', true)],
        &mut engine,
    );
    assert_eq!(state_of(&r, "alice--notes"), "running");
    assert_eq!(engine.containers.len(), 1);
    assert_eq!(engine.creates.len(), 2);
    assert_eq!(engine.removes.len(), 1);
}

#[test]
fn an_effect_lost_by_its_executor_is_redone_once_by_the_next() {
    let dir = tempdir();
    let mut c = open(dir.path());
    let mut engine = Engine::default();
    let want = [desired("alice--notes", 'a', true)];
    let r = c.sync(&request("ex1", Mode::Rust, &want, &engine)).unwrap();
    assert_eq!(r.effects.len(), 1);
    // The same executor asking again gets the same effect (it lost the answer), not a new one.
    let again = c.sync(&request("ex1", Mode::Rust, &want, &engine)).unwrap();
    assert_eq!(again.effects, r.effects);
    // That daemon restarts before doing it.
    let r2 = converge(&mut c, "ex2", &want, &mut engine);
    assert_eq!(state_of(&r2, "alice--notes"), "running");
    assert_eq!(engine.creates.len(), 1);
    // A late settle from the dead executor changes nothing: its intent was already settled.
    c.settle(&SettleRequest {
        executor: "ex1".into(),
        op: r.effects[0].op,
        outcome: Outcome::Ok,
        detail: None,
        conflict_ip: None,
    })
    .unwrap();
    let after = c.sync(&request("ex2", Mode::Rust, &want, &engine)).unwrap();
    assert!(after.effects.is_empty());
    // And nobody may settle an operation handed to someone else.
    assert!(
        c.settle(&SettleRequest {
            executor: "ex3".into(),
            op: r.effects[0].op,
            outcome: Outcome::Ok,
            detail: None,
            conflict_ip: None
        })
        .is_err()
    );
}

#[test]
fn a_failing_deploy_backs_off() {
    let dir = tempdir();
    let mut c = open(dir.path());
    let engine = Engine::default();
    let want = [desired("alice--notes", 'a', true)];
    let r = c.sync(&request("ex1", Mode::Rust, &want, &engine)).unwrap();
    c.settle(&SettleRequest {
        executor: "ex1".into(),
        op: r.effects[0].op,
        outcome: Outcome::Definite,
        detail: Some("image not found".into()),
        conflict_ip: None,
    })
    .unwrap();
    let r = c.sync(&request("ex1", Mode::Rust, &want, &engine)).unwrap();
    assert!(r.effects.is_empty());
    assert_eq!(state_of(&r, "alice--notes"), "failed");
    assert!(
        r.workloads[0]
            .reason
            .as_deref()
            .unwrap()
            .contains("image not found")
    );
    advance(6_000);
    let r = c.sync(&request("ex1", Mode::Rust, &want, &engine)).unwrap();
    assert_eq!(r.effects.len(), 1);
}

#[test]
fn an_address_held_by_something_else_is_skipped() {
    let dir = tempdir();
    let mut c = open(dir.path());
    let mut engine = Engine::default();
    // A container the pool did not place holds .2, the first free address, without telling core.
    engine.containers.insert(
        "stray".into(),
        Container {
            installation: "other--x".into(),
            component: "main".into(),
            generation: 1,
            running: true,
            address: Some("10.89.0.2".into()),
        },
    );
    let mut req = request(
        "ex1",
        Mode::Rust,
        &[desired("alice--notes", 'a', true)],
        &engine,
    );
    req.observed.clear();
    let r = c.sync(&req).unwrap();
    let res = engine.perform(&r.effects[0]);
    assert!(res.is_err());
    c.settle(&SettleRequest {
        executor: "ex1".into(),
        op: r.effects[0].op,
        outcome: Outcome::Definite,
        detail: res.err(),
        conflict_ip: Some("10.89.0.2".into()),
    })
    .unwrap();
    advance(10_000);
    let r = converge(
        &mut c,
        "ex1",
        &[desired("alice--notes", 'a', true)],
        &mut engine,
    );
    assert_eq!(state_of(&r, "alice--notes"), "running");
    assert_ne!(
        engine.containers["flagship-alice--notes"]
            .address
            .as_deref(),
        Some("10.89.0.2")
    );
}

#[test]
fn what_does_not_fit_waits_and_nothing_running_is_evicted() {
    let dir = tempdir();
    let mut c = open(dir.path());
    let mut engine = Engine::default();
    let mut big = desired("alice--big", 'a', true);
    big.resources.memory_bytes = 1600 << 20;
    let mut req = request("ex1", Mode::Rust, &[big.clone()], &engine);
    req.capacity = Capacity {
        memory_bytes: 1 << 30,
        cpu_millis: 1000,
    };
    let r = c.sync(&req).unwrap();
    engine.perform(&r.effects[0]).unwrap();
    c.settle(&SettleRequest {
        executor: "ex1".into(),
        op: r.effects[0].op,
        outcome: Outcome::Ok,
        detail: None,
        conflict_ip: None,
    })
    .unwrap();
    let mut req = request(
        "ex1",
        Mode::Rust,
        &[big, desired("alice--notes", 'b', true)],
        &engine,
    );
    req.capacity = Capacity {
        memory_bytes: 1 << 30,
        cpu_millis: 1000,
    };
    let r = c.sync(&req).unwrap();
    assert!(r.effects.is_empty());
    assert_eq!(state_of(&r, "alice--notes"), "unschedulable");
    assert_eq!(state_of(&r, "alice--big"), "running");
}

#[test]
fn a_second_controller_fences_the_first() {
    let dir = tempdir();
    let mut first = open(dir.path());
    let engine = Engine::default();
    let want = [desired("alice--notes", 'a', true)];
    first
        .sync(&request("ex1", Mode::Shadow, &want, &engine))
        .unwrap();
    let _second = open(dir.path());
    assert!(
        first
            .sync(&request("ex1", Mode::Rust, &want, &engine))
            .is_err()
    );
}

#[test]
fn back_to_shadow_stops_effects_at_once_and_keeps_what_runs() {
    let dir = tempdir();
    let mut c = open(dir.path());
    let mut engine = Engine::default();
    let want = [desired("alice--notes", 'a', true)];
    converge(&mut c, "ex1", &want, &mut engine);
    let r = c
        .sync(&request(
            "ex1",
            Mode::Shadow,
            &[desired("alice--notes", 'b', true)],
            &engine,
        ))
        .unwrap();
    assert!(r.effects.is_empty() && !r.live);
    assert_eq!(engine.containers.len(), 1);
    // In rust mode again the same container is still recognised (no restart on the way back).
    let r = c.sync(&request("ex1", Mode::Rust, &want, &engine)).unwrap();
    assert!(r.live && r.effects.is_empty());
}

#[test]
fn addresses_survive_a_core_restart() {
    let dir = tempdir();
    let mut engine = Engine::default();
    let addr = {
        let mut c = open(dir.path());
        converge(
            &mut c,
            "ex1",
            &[desired("alice--notes", 'a', true)],
            &mut engine,
        );
        engine.containers["flagship-alice--notes"]
            .address
            .clone()
            .unwrap()
    };
    let mut c = open(dir.path());
    converge(
        &mut c,
        "ex2",
        &[desired("alice--notes", 'b', true)],
        &mut engine,
    );
    assert_eq!(
        engine.containers["flagship-alice--notes"]
            .address
            .as_deref(),
        Some(addr.as_str())
    );
}

#[test]
fn local_ai_and_group_components_are_workloads_too() {
    let dir = tempdir();
    let mut c = open(dir.path());
    let mut engine = Engine::default();
    let mut ai = desired("local-ai", 'c', true);
    ai.kind = Kind::LocalAi;
    let mut web = desired("alice--shop", 'd', true);
    web.component = "web".into();
    let mut worker = desired("alice--shop", 'e', true);
    worker.component = "worker".into();
    let r = converge(&mut c, "ex1", &[ai, web, worker], &mut engine);
    assert!(
        r.workloads.iter().all(|w| w.state == "running"),
        "{:?}",
        r.workloads
    );
    assert_eq!(engine.containers.len(), 3);
    let mut a: Vec<_> = engine
        .containers
        .values()
        .map(|c| c.address.clone().unwrap())
        .collect();
    a.sort();
    a.dedup();
    assert_eq!(a.len(), 3);
}

#[test]
fn bad_requests_are_refused() {
    let dir = tempdir();
    let mut c = open(dir.path());
    let engine = Engine::default();
    for bad in [
        DesiredWorkload {
            installation: "Alice".into(),
            ..desired("x", 'a', true)
        },
        DesiredWorkload {
            component: "a/b".into(),
            ..desired("x", 'a', true)
        },
        DesiredWorkload {
            spec_digest: "zz".into(),
            ..desired("x", 'a', true)
        },
        DesiredWorkload {
            network: "a b".into(),
            ..desired("x", 'a', true)
        },
    ] {
        assert!(
            c.sync(&request("ex1", Mode::Rust, &[bad], &engine))
                .is_err()
        );
    }
    let twice = [desired("x", 'a', true), desired("x", 'b', true)];
    assert!(
        c.sync(&request("ex1", Mode::Rust, &twice, &engine))
            .is_err()
    );
    let mut r = request("ex1", Mode::Rust, &[], &engine);
    r.executor = String::new();
    assert!(c.sync(&r).is_err());
}

struct TempDir(std::path::PathBuf);
impl TempDir {
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn tempdir() -> TempDir {
    static N: AtomicU64 = AtomicU64::new(0);
    let d = std::env::temp_dir().join(format!(
        "fcore-apps-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&d).unwrap();
    TempDir(d)
}

#[test]
fn the_socket_protocol_answers_sync_settle_and_status() {
    use flagship_core::ipc;
    use std::sync::{Arc, Mutex};
    let dir = tempdir();
    let ctrl = Arc::new(Mutex::new(open(dir.path())));
    let engine = Engine::default();
    let req = serde_json::json!({ "op": "Sync", "sync": request("ex1", Mode::Rust, &[desired("alice--notes", 'a', true)], &engine) });
    let a = ipc::handle(&ctrl, req.to_string().as_bytes());
    assert_eq!(a["ok"], true, "{a}");
    let effects = a["result"]["effects"].as_array().unwrap();
    assert_eq!(effects.len(), 1);
    assert_eq!(effects[0]["kind"], "deploy");
    assert_eq!(effects[0]["installation"], "alice--notes");
    let op = effects[0]["op"].as_i64().unwrap();
    let s = serde_json::json!({ "op": "Settle", "settle": { "executor": "ex1", "op": op, "outcome": "ok" } });
    assert_eq!(ipc::handle(&ctrl, s.to_string().as_bytes())["ok"], true);
    let st = ipc::handle(&ctrl, br#"{"op":"Status"}"#);
    assert_eq!(st["result"]["live"], true);
    // Unknown fields, unknown ops and junk are refused, never guessed at.
    let mut bad = serde_json::to_value(request("ex1", Mode::Rust, &[], &engine)).unwrap();
    bad["approved"] = serde_json::json!(true);
    assert_eq!(
        ipc::handle(
            &ctrl,
            serde_json::json!({ "op": "Sync", "sync": bad })
                .to_string()
                .as_bytes()
        )["ok"],
        false
    );
    assert_eq!(ipc::handle(&ctrl, br#"{"op":"Effects"}"#)["ok"], false);
    assert_eq!(ipc::handle(&ctrl, b"junk")["ok"], false);
}

#[test]
fn forgetting_a_container_core_never_wanted_removes_it_by_generation() {
    let dir = tempdir();
    let mut c = open(dir.path());
    let mut engine = Engine::default();
    engine.containers.insert(
        "flagship-alice--old".into(),
        Container {
            installation: "alice--old".into(),
            component: "main".into(),
            generation: 5,
            running: true,
            address: None,
        },
    );
    let mut req = request("ex1", Mode::Rust, &[], &engine);
    req.forget = vec![WorkloadKey {
        installation: "alice--old".into(),
        component: "main".into(),
    }];
    let r = c.sync(&req).unwrap();
    assert_eq!(r.effects.len(), 1);
    assert_eq!(
        (r.effects[0].kind, r.effects[0].generation),
        (EffectKind::Remove, 5)
    );
    engine.perform(&r.effects[0]).unwrap();
    c.settle(&SettleRequest {
        executor: "ex1".into(),
        op: r.effects[0].op,
        outcome: Outcome::Ok,
        detail: None,
        conflict_ip: None,
    })
    .unwrap();
    assert!(engine.containers.is_empty());
    // Without a forget, an unknown labelled container is reported and left alone.
    engine.containers.insert(
        "flagship-alice--stray".into(),
        Container {
            installation: "alice--stray".into(),
            component: "main".into(),
            generation: 6,
            running: true,
            address: None,
        },
    );
    let r = c.sync(&request("ex1", Mode::Rust, &[], &engine)).unwrap();
    assert!(r.effects.is_empty());
    assert_eq!(r.unmanaged, vec!["flagship-alice--stray".to_owned()]);
}

#[test]
fn addresses_held_by_containers_core_does_not_own_are_never_given_out() {
    use flagship_core::apps::OccupiedAddress;
    let dir = tempdir();
    let mut c = open(dir.path());
    let mut engine = Engine::default();
    let mut req = request(
        "ex1",
        Mode::Rust,
        &[desired("alice--notes", 'a', true)],
        &engine,
    );
    req.occupied = vec![OccupiedAddress {
        network: NET.into(),
        ip: "10.89.0.2".into(),
    }];
    let r = c.sync(&req).unwrap();
    assert_eq!(r.effects[0].address.as_deref(), Some("10.89.0.3"));
    engine.perform(&r.effects[0]).unwrap();
    c.settle(&SettleRequest {
        executor: "ex1".into(),
        op: r.effects[0].op,
        outcome: Outcome::Ok,
        detail: None,
        conflict_ip: None,
    })
    .unwrap();
    // The staging copy goes away: its address is free again for the next owner.
    let r = c
        .sync(&request(
            "ex1",
            Mode::Rust,
            &[
                desired("alice--notes", 'a', true),
                desired("alice--chess", 'b', true),
            ],
            &engine,
        ))
        .unwrap();
    assert_eq!(r.effects[0].address.as_deref(), Some("10.89.0.2"));
}

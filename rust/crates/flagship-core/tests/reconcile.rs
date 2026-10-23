//! Crash injection at every effect boundary, single-writer locking, shadow mode and handover.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

use flagship_core::controller::Review;
use flagship_core::handover::{CheckpointWorkload, TsCheckpoint};
use flagship_core::{Controller, Journal, JournalError, Mode, OpKind, RuntimePort};
use flagship_runtime::fake::{FakeRuntime, When};
use flagship_runtime::plan::ExecutionPlan;
use flagship_runtime::{InstallationId, WorkloadState};
use serde_json::json;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

type Ctl = Controller<RuntimePort<Arc<FakeRuntime>>>;

static N: AtomicU64 = AtomicU64::new(0);

fn tempdir() -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "fs-core-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn d(c: char) -> String {
    format!("sha256:{}", c.to_string().repeat(64))
}

fn plan(inst: &str, generation: u64) -> ExecutionPlan {
    let v = json!({
        "schema": 1, "installation": inst, "generation": generation,
        "image": { "repository": "ghcr.io/flagship/app", "indexDigest": d('b'), "platformManifestDigest": d(char::from_digit(u32::try_from(generation % 10).unwrap(), 10).unwrap()), "platform": { "os": "linux", "architecture": "amd64" } },
        "manifestDigest": d('c'),
        "capabilities": { "network": "apps", "publish": { "hostPort": 40000, "containerPort": 8080 } },
        "resources": { "memoryBytes": 536870912u64, "cpuMillis": 1000, "pidsLimit": 256, "tmpfsBytes": 67108864u64 },
        "volumes": [{ "id": "v-a" }],
        "networkPolicyDigest": d('e'),
        "environment": { "PORT": "8080" },
        "health": { "kind": "http", "startupTimeoutSecs": 60, "intervalSecs": 1 },
        "restart": { "kind": "never" }
    });
    ExecutionPlan::from_value(&v).unwrap()
}

fn open(dir: &Path, rt: &Arc<FakeRuntime>, mode: Mode) -> Ctl {
    Controller::open(
        dir,
        RuntimePort {
            runtime: rt.clone(),
        },
        mode,
    )
    .unwrap()
}

fn empty_handover(c: &mut Ctl) {
    let r = c
        .handover(&TsCheckpoint {
            taken_at: 0,
            ts_controller_paused: true,
            workloads: vec![],
        })
        .unwrap();
    assert!(r.effects_enabled, "{r:?}");
}

/// Reconcile until nothing is left to do, resolving reviews with Redo. Returns the number of
/// reviews it had to resolve.
fn converge(dir: &Path, rt: &Arc<FakeRuntime>) -> usize {
    let mut c = open(dir, rt, Mode::Effects);
    let mut reviews = 0;
    for _ in 0..10 {
        let r = c.reconcile().unwrap();
        if r.converged() {
            return reviews;
        }
        for op in c.journal().needs_review().unwrap() {
            reviews += 1;
            c.resolve_review(op.id, Review::Redo).unwrap();
        }
    }
    panic!("did not converge");
}

/// Run one reconcile that dies at the injected crash, dropping the controller with it (the lock
/// is released as a dead process's would be).
fn crash(dir: &Path, rt: &Arc<FakeRuntime>) {
    let c = open(dir, rt, Mode::Effects);
    let r = catch_unwind(AssertUnwindSafe(move || {
        let mut c = c;
        c.reconcile()
    }));
    assert!(r.is_err(), "the injected crash should have fired");
}

fn only_workload(rt: &FakeRuntime, inst: &str) -> flagship_runtime::ObservedWorkload {
    let s = rt.state();
    assert_eq!(s.workloads.len(), 1, "exactly one workload");
    s.workloads[&format!("flagship-{inst}")].clone()
}

#[test]
fn a_fresh_install_survives_a_crash_at_every_effect_boundary() {
    // effects for a fresh install: pull, create, start
    for at in 0..3 {
        for when in [When::Before, When::After] {
            let dir = tempdir();
            let rt = Arc::new(FakeRuntime::new());
            {
                let mut c = open(&dir, &rt, Mode::Effects);
                empty_handover(&mut c);
                c.journal().set_desired(&plan("alice--notes", 1)).unwrap();
            }
            rt.crash_at(at, when);
            crash(&dir, &rt);
            let reviews = converge(&dir, &rt);
            assert_eq!(
                reviews, 0,
                "non-destructive effects never need review ({at} {when:?})"
            );
            let w = only_workload(&rt, "alice--notes");
            assert_eq!(
                (w.state, w.plan_digest),
                (
                    WorkloadState::Running,
                    Some(plan("alice--notes", 1).digest())
                ),
                "{at} {when:?}"
            );
            let s = rt.state();
            assert_eq!(
                s.conflicts, 0,
                "never asked the engine for a second copy ({at} {when:?})"
            );
            assert_eq!(
                s.create_argv.len(),
                1,
                "created exactly once ({at} {when:?})"
            );
        }
    }
}

#[test]
fn an_upgrade_survives_a_crash_at_every_effect_boundary_and_never_repeats_a_destructive_effect() {
    // effects for an upgrade: stop, delete, pull, create, start
    for k in 0..5 {
        for when in [When::Before, When::After] {
            let dir = tempdir();
            let rt = Arc::new(FakeRuntime::new());
            {
                let mut c = open(&dir, &rt, Mode::Effects);
                empty_handover(&mut c);
                c.journal().set_desired(&plan("alice--notes", 1)).unwrap();
                assert!(!c.reconcile().unwrap().decisions.is_empty());
                assert!(c.reconcile().unwrap().converged());
                c.journal().set_desired(&plan("alice--notes", 2)).unwrap();
            }
            let base = rt.state().mutations.len();
            rt.crash_at(base + k, when);
            crash(&dir, &rt);
            let after_crash = rt.state().mutations.clone();
            // The first pass after the crash: a destructive effect whose outcome is unknown is
            // inspected, not repeated.
            {
                let mut c = open(&dir, &rt, Mode::Effects);
                let r = c.reconcile().unwrap();
                let destructive_unknown = k < 2 && when == When::Before;
                if destructive_unknown {
                    assert_eq!(r.blocked.len(), 1, "{k} {when:?}: {r:?}");
                    assert_eq!(
                        rt.state().mutations,
                        after_crash,
                        "{k} {when:?}: nothing ran while blocked"
                    );
                    let review = c.journal().needs_review().unwrap();
                    assert_eq!(review.len(), 1);
                    assert!(review[0].kind.destructive());
                } else {
                    assert!(r.blocked.is_empty(), "{k} {when:?}: {r:?}");
                }
            }
            converge(&dir, &rt);
            let w = only_workload(&rt, "alice--notes");
            assert_eq!(
                (w.state, w.generation),
                (WorkloadState::Running, Some(2)),
                "{k} {when:?}"
            );
            let s = rt.state();
            assert_eq!(s.conflicts, 0, "{k} {when:?}");
            let deletes = s
                .mutations
                .iter()
                .filter(|m| m.starts_with("delete"))
                .count();
            let stops = s.mutations.iter().filter(|m| m.starts_with("stop")).count();
            assert_eq!(
                deletes, 1,
                "{k} {when:?}: the old generation was deleted exactly once: {:?}",
                s.mutations
            );
            assert!(stops <= 1, "{k} {when:?}: {:?}", s.mutations);
            assert_eq!(
                s.create_argv
                    .iter()
                    .filter(|a| a.iter().any(|x| x == "flagship.generation=2"))
                    .count(),
                1,
                "{k} {when:?}"
            );
        }
    }
}

#[test]
fn an_uninstall_stops_and_removes_once() {
    for k in 0..2 {
        for when in [When::Before, When::After] {
            let dir = tempdir();
            let rt = Arc::new(FakeRuntime::new());
            {
                let mut c = open(&dir, &rt, Mode::Effects);
                empty_handover(&mut c);
                c.journal().set_desired(&plan("alice--notes", 1)).unwrap();
                c.reconcile().unwrap();
                c.journal()
                    .remove_desired(&InstallationId::parse("alice--notes").unwrap())
                    .unwrap();
            }
            let base = rt.state().mutations.len();
            rt.crash_at(base + k, when);
            crash(&dir, &rt);
            converge(&dir, &rt);
            let s = rt.state();
            assert!(s.workloads.is_empty(), "{k} {when:?}");
            assert_eq!(
                s.mutations
                    .iter()
                    .filter(|m| m.starts_with("delete"))
                    .count(),
                1,
                "{k} {when:?}"
            );
        }
    }
}

#[test]
fn one_controller_at_a_time_and_a_fenced_journal_refuses_writes() {
    let dir = tempdir();
    let rt = Arc::new(FakeRuntime::new());
    let first = open(&dir, &rt, Mode::Effects);
    let second = Controller::open(
        &dir,
        RuntimePort {
            runtime: rt.clone(),
        },
        Mode::Effects,
    );
    assert!(matches!(
        second,
        Err(flagship_core::controller::CoreError::Lock(_))
    ));
    drop(first);
    assert!(
        Controller::open(
            &dir,
            RuntimePort {
                runtime: rt.clone()
            },
            Mode::Effects
        )
        .is_ok()
    );
    // Even a writer that bypassed the lock is fenced by the term.
    let path = dir.join("journal.db");
    let mut old = Journal::open(&path).unwrap();
    let _new = Journal::open(&path).unwrap();
    assert!(matches!(
        old.set_desired(&plan("alice--notes", 1)),
        Err(JournalError::Fenced(_))
    ));
}

#[test]
fn shadow_mode_decides_but_performs_nothing() {
    let dir = tempdir();
    let rt = Arc::new(FakeRuntime::new());
    rt.insert_legacy(
        &InstallationId::parse("bob--chess").unwrap(),
        "flagship/bob:3",
        true,
    );
    let mut c = open(&dir, &rt, Mode::Shadow);
    c.journal().set_effects_enabled(true).unwrap();
    c.journal().set_desired(&plan("alice--notes", 1)).unwrap();
    let r = c.reconcile().unwrap();
    assert!(!r.performed);
    let kinds: Vec<OpKind> = r.decisions.iter().map(|d| d.kind).collect();
    assert_eq!(kinds, vec![OpKind::Pull, OpKind::Create, OpKind::Start]);
    assert_eq!(r.unmanaged, vec!["flagship-bob--chess".to_owned()]);
    assert!(rt.state().mutations.is_empty());
    assert!(
        c.journal().all_ops().unwrap().is_empty(),
        "shadow writes no intents"
    );
    assert_eq!(c.journal().shadow_decisions().unwrap().len(), 3);
}

#[test]
fn effects_stay_off_until_handover() {
    let dir = tempdir();
    let rt = Arc::new(FakeRuntime::new());
    let mut c = open(&dir, &rt, Mode::Effects);
    c.journal().set_desired(&plan("alice--notes", 1)).unwrap();
    let r = c.reconcile().unwrap();
    assert!(!r.performed && !r.decisions.is_empty());
    assert!(rt.state().mutations.is_empty());
}

#[test]
fn handover_adopts_legacy_workloads_without_restarting_them() {
    let dir = tempdir();
    let rt = Arc::new(FakeRuntime::new());
    let alice = InstallationId::parse("alice--notes").unwrap();
    rt.insert_legacy(&alice, "flagship/alice:7", true);
    let mut c = open(&dir, &rt, Mode::Effects);
    c.journal().set_desired(&plan("alice--notes", 7)).unwrap();
    let cp = TsCheckpoint {
        taken_at: 1,
        ts_controller_paused: true,
        workloads: vec![CheckpointWorkload {
            installation: alice.clone(),
            generation: 7,
            image: "flagship/alice:7".into(),
            running: true,
        }],
    };
    let r = c.handover(&cp).unwrap();
    assert_eq!(
        (r.adopted.clone(), r.effects_enabled),
        (vec![alice.clone()], true),
        "{r:?}"
    );
    assert!(c.reconcile().unwrap().converged());
    assert!(
        rt.state().mutations.is_empty(),
        "the adopted workload kept running untouched"
    );
    // The next generation replaces the legacy container with a labelled one.
    c.journal().set_desired(&plan("alice--notes", 8)).unwrap();
    let kinds: Vec<OpKind> = c
        .reconcile()
        .unwrap()
        .decisions
        .iter()
        .map(|d| d.kind)
        .collect();
    assert_eq!(
        kinds,
        vec![
            OpKind::Stop,
            OpKind::Delete,
            OpKind::Pull,
            OpKind::Create,
            OpKind::Start
        ]
    );
    let w = only_workload(&rt, "alice--notes");
    assert_eq!((w.generation, w.legacy()), (Some(8), false));
    assert!(c.journal().adopted(&alice).unwrap().is_none());
}

#[test]
fn handover_refuses_when_the_engine_and_the_checkpoint_disagree() {
    let alice = InstallationId::parse("alice--notes").unwrap();
    let cases: Vec<(&str, TsCheckpoint, bool)> = vec![
        (
            "not paused",
            TsCheckpoint {
                taken_at: 1,
                ts_controller_paused: false,
                workloads: vec![],
            },
            true,
        ),
        (
            "says stopped",
            TsCheckpoint {
                taken_at: 1,
                ts_controller_paused: true,
                workloads: vec![CheckpointWorkload {
                    installation: alice.clone(),
                    generation: 7,
                    image: "flagship/alice:7".into(),
                    running: false,
                }],
            },
            true,
        ),
        (
            "other generation",
            TsCheckpoint {
                taken_at: 1,
                ts_controller_paused: true,
                workloads: vec![CheckpointWorkload {
                    installation: alice.clone(),
                    generation: 6,
                    image: "flagship/alice:7".into(),
                    running: true,
                }],
            },
            true,
        ),
        (
            "omits a workload",
            TsCheckpoint {
                taken_at: 1,
                ts_controller_paused: true,
                workloads: vec![],
            },
            true,
        ),
    ];
    for (what, cp, _) in cases {
        let dir = tempdir();
        let rt = Arc::new(FakeRuntime::new());
        rt.insert_legacy(&alice, "flagship/alice:7", true);
        let mut c = open(&dir, &rt, Mode::Effects);
        c.journal().set_desired(&plan("alice--notes", 7)).unwrap();
        let r = c.handover(&cp).unwrap();
        assert!(
            !r.effects_enabled && !r.mismatches.is_empty(),
            "{what}: {r:?}"
        );
        let rec = c.reconcile().unwrap();
        assert!(!rec.performed, "{what}");
        assert!(rt.state().mutations.is_empty(), "{what}");
    }
}

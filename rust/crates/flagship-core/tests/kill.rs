//! Real-process crash recovery for core's journal (plan G10). The `reconcile.rs` tests inject a
//! crash as a panic inside one process; here a child process (this test binary re-run with
//! `FLAGSHIP_CORE_KILL_CHILD`, a variable only this test sets) writes desired state and operation
//! intents as fast as it can and is killed with SIGKILL at points spread over its run. The parent
//! then checks what a restarted controller finds: the lock is free, the journal opens under a
//! newer term, every write the child saw committed is there, and reconciliation replays the dead
//! term's open intents to a converged state without a duplicate effect.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

use flagship_core::handover::TsCheckpoint;
use flagship_core::journal::OpState;
use flagship_core::{Controller, ControllerLock, Journal, Mode, OpKind, RuntimePort};
use flagship_runtime::fake::FakeRuntime;
use flagship_runtime::plan::ExecutionPlan;
use flagship_runtime::{InstallationId, WorkloadState};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

const CHILD_ENV: &str = "FLAGSHIP_CORE_KILL_CHILD";
const APPS: [&str; 5] = ["alice--a", "alice--b", "bob--c", "bob--d", "carol--e"];

fn d(c: char) -> String {
    format!("sha256:{}", c.to_string().repeat(64))
}

fn plan(inst: &str, generation: u64, port: u64) -> ExecutionPlan {
    let v = json!({
        "schema": 1, "installation": inst, "generation": generation,
        "image": { "repository": "ghcr.io/flagship/app", "indexDigest": d('b'), "platformManifestDigest": d(char::from_digit(u32::try_from(generation % 10).unwrap(), 10).unwrap()), "platform": { "os": "linux", "architecture": "amd64" } },
        "manifestDigest": d('c'),
        "capabilities": { "network": "apps", "publish": { "hostPort": 40000 + port, "containerPort": 8080 } },
        "resources": { "memoryBytes": 536870912u64, "cpuMillis": 1000, "pidsLimit": 256, "tmpfsBytes": 67108864u64 },
        "volumes": [{ "id": "v-a" }],
        "networkPolicyDigest": d('e'),
        "environment": { "PORT": "8080" },
        "health": { "kind": "http", "startupTimeoutSecs": 60, "intervalSecs": 1 },
        "restart": { "kind": "never" }
    });
    ExecutionPlan::from_value(&v).unwrap()
}

/// The child: hold the lock, then write and acknowledge on stdout only after each commit returns.
fn child(dir: &Path) -> ! {
    let _lock = ControllerLock::acquire(&dir.join("controller.lock")).unwrap();
    let mut j = Journal::open(&dir.join("journal.db")).unwrap();
    let mut out = std::io::stdout().lock();
    writeln!(out, "T {}", j.term()).unwrap();
    out.flush().unwrap();
    let mut k = 0u64;
    loop {
        k += 1;
        let idx = usize::try_from(k % 5).unwrap();
        let p = plan(APPS[idx], k, k % 5);
        j.set_desired(&p).unwrap();
        writeln!(out, "D {} {k}", APPS[idx]).unwrap();
        out.flush().unwrap();
        let inst = InstallationId::parse(APPS[idx]).unwrap();
        let id = j
            .intent(&inst, k, OpKind::Pull, Some(p.digest()), k)
            .unwrap();
        writeln!(out, "I {id}").unwrap();
        out.flush().unwrap();
        if !k.is_multiple_of(3) {
            j.settle(id, OpState::Done, Some("rt"), None, k).unwrap();
            writeln!(out, "S {id}").unwrap();
            out.flush().unwrap();
        }
    }
}

fn tempdir(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("fs-core-kill-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

struct Acked {
    term: u64,
    desired: BTreeMap<String, u64>,
    intents: BTreeSet<i64>,
    settled: BTreeSet<i64>,
}

fn run_and_kill(dir: &Path, after: Duration) -> Acked {
    let mut c = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "kill_child_entry",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_ENV, dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = c.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });
    // Wait for the child to have the journal open (its term line), then let it run for `after`.
    let mut lines = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(l) => {
                // libtest prints "test kill_child_entry ... " without a newline before the child's first line.
                let l = l.rsplit("... ").next().unwrap_or(&l).to_owned();
                let open = l.starts_with("T ");
                lines.push(l);
                if open {
                    break;
                }
            }
            Err(_) => assert!(
                c.try_wait().unwrap().is_none(),
                "the child died before opening the journal"
            ),
        }
    }
    std::thread::sleep(after);
    assert!(c.try_wait().unwrap().is_none(), "the child ended by itself");
    c.kill().unwrap(); // SIGKILL
    c.wait().unwrap();
    reader.join().unwrap();
    lines.extend(
        rx.try_iter()
            .map(|l| l.rsplit("... ").next().unwrap_or(&l).to_owned()),
    );
    let mut a = Acked {
        term: 0,
        desired: BTreeMap::new(),
        intents: BTreeSet::new(),
        settled: BTreeSet::new(),
    };
    for line in lines {
        let f: Vec<&str> = line.split(' ').collect();
        match f.as_slice() {
            ["T", t] => a.term = t.parse().unwrap(),
            ["D", inst, k] => {
                a.desired.insert((*inst).to_owned(), k.parse().unwrap());
            }
            ["I", id] => {
                a.intents.insert(id.parse().unwrap());
            }
            ["S", id] => {
                a.settled.insert(id.parse().unwrap());
            }
            _ => {}
        }
    }
    a
}

/// Not a test of its own: the entry point the re-run child executes. Without the variable it
/// returns at once.
#[test]
fn kill_child_entry() {
    if let Some(dir) = std::env::var_os(CHILD_ENV) {
        child(Path::new(&dir));
    }
}

#[test]
fn a_controller_killed_mid_write_loses_nothing_it_acknowledged_and_replays_to_convergence() {
    for (i, ms) in [0u64, 3, 10, 25, 60, 150].into_iter().enumerate() {
        let dir = tempdir(&format!("{i}"));
        let acked = run_and_kill(&dir, Duration::from_millis(ms));
        assert!(
            acked.term >= 1,
            "the child never opened the journal ({ms} ms)"
        );

        let rt = Arc::new(FakeRuntime::new());
        // The dead child's lock is free: a new controller opens at once, under a newer term.
        let mut c = Controller::open(
            &dir,
            RuntimePort {
                runtime: rt.clone(),
            },
            Mode::Effects,
        )
        .unwrap_or_else(|e| panic!("restart after a kill at {ms} ms: {e}"));
        assert!(c.journal().term() > acked.term, "term did not advance");

        let desired: BTreeMap<String, u64> = c
            .journal()
            .desired()
            .unwrap()
            .into_iter()
            .map(|d| (d.plan.installation.as_str().to_owned(), d.plan.generation))
            .collect();
        for (inst, k) in &acked.desired {
            let got = desired.get(inst).copied().unwrap_or(0);
            assert!(
                got >= *k,
                "{inst}: acknowledged generation {k} lost (found {got}) at {ms} ms"
            );
        }
        let ops: BTreeMap<i64, OpState> = c
            .journal()
            .all_ops()
            .unwrap()
            .into_iter()
            .map(|o| (o.id, o.state))
            .collect();
        for id in &acked.intents {
            assert!(
                ops.contains_key(id),
                "acknowledged intent {id} lost at {ms} ms"
            );
        }
        for id in &acked.settled {
            assert_eq!(
                ops.get(id),
                Some(&OpState::Done),
                "acknowledged settle {id} lost at {ms} ms"
            );
        }

        // Replay: hand over (nothing legacy runs) and reconcile until converged.
        let r = c
            .handover(&TsCheckpoint {
                taken_at: 0,
                ts_controller_paused: true,
                workloads: vec![],
            })
            .unwrap();
        assert!(r.effects_enabled, "{r:?}");
        let mut converged = false;
        for _ in 0..10 {
            if c.reconcile().unwrap().converged() {
                converged = true;
                break;
            }
        }
        assert!(converged, "did not converge after a kill at {ms} ms");
        assert!(
            c.journal().pending().unwrap().is_empty(),
            "an intent of the dead term is still open at {ms} ms"
        );
        let s = rt.state();
        assert_eq!(
            s.workloads.len(),
            desired.len(),
            "one workload per desired app"
        );
        assert_eq!(s.conflicts, 0, "asked the engine for a second copy");
        for (inst, generation) in &desired {
            let w = &s.workloads[&format!("flagship-{inst}")];
            assert_eq!(w.state, WorkloadState::Running, "{inst}");
            let want = plan(inst, *generation, *generation % 5).digest();
            assert_eq!(w.plan_digest, Some(want), "{inst} runs another generation");
        }
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

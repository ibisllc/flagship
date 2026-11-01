//! Crash and power-loss recovery with the real binary (plan G10): `flagship-updater install` and
//! `restore` are started as child processes and killed with SIGKILL at points spread across their
//! whole run; then `flagship-updater reconcile` (what the boot guard runs first) must leave a box
//! that runs exactly one complete, verified release whose state files agree with the link, and the
//! interrupted operation must be repeatable to completion. No hook in the updater: the kill lands
//! wherever the process happens to be, which over the sweep covers unpack, rename, intent writes,
//! the link flip and the state files.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]
mod common;

use common::{Built, Spec, Tmp, build, install_args, temp_paths};
use flagship_updater::journal::{Intent, Phase};
use flagship_updater::release::{Paths, current_commit, install, restore};
use serde_json::Value;
use std::fs;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_flagship-updater");

/// A node body big enough (and incompressible enough) that unpacking takes a measurable time.
fn big_body(seed: u8) -> &'static [u8] {
    let mut x: u32 = 0x9e37_79b9 ^ u32::from(seed);
    let v: Vec<u8> = (0..6 * 1024 * 1024)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x.to_le_bytes()[0]
        })
        .collect();
    Box::leak(v.into_boxed_slice())
}

fn spec(c: char, seq: u64, body: &'static [u8]) -> Spec {
    let mut s = Spec::new(c, seq);
    s.node_body = body;
    s
}

fn dirs(p: &Paths) -> Vec<String> {
    let mut v = Vec::new();
    for (k, d) in [
        ("--releases", &p.releases),
        ("--current", &p.current),
        ("--state", &p.state),
        ("--bin", &p.bin),
    ] {
        v.push(k.to_owned());
        v.push(d.to_str().unwrap().to_owned());
    }
    v
}

fn spawn_install(b: &Built, p: &Paths) -> Child {
    let key = b.trust.keys.join(",");
    let mut args: Vec<String> = [
        "install",
        "--manifest",
        b.manifest.to_str().unwrap(),
        "--artifact",
        b.artifact.to_str().unwrap(),
        "--trust-keys",
        &key,
        "--threshold",
        "1",
        "--expect-sha256",
        &b.sha,
        "--expect-commit",
        &b.commit,
        "--arch",
        "amd64",
        "--node-floor",
        "22.0.0",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    args.extend(dirs(p));
    Command::new(BIN)
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn spawn_restore(commit: &str, p: &Paths) -> Child {
    let mut args = vec!["restore".to_owned(), commit.to_owned()];
    args.extend(dirs(p));
    Command::new(BIN)
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn reconcile_via_binary(p: &Paths) {
    let mut args = vec!["reconcile".to_owned()];
    args.extend(dirs(p));
    let st = Command::new(BIN).args(&args).status().unwrap();
    assert!(st.success(), "reconcile exits 0");
}

/// Kill the child after `after` (or let it finish first); true when the kill landed mid-run.
fn kill_after(mut c: Child, after: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < after {
        if c.try_wait().unwrap().is_some() {
            return false;
        }
        std::thread::sleep(Duration::from_micros(200));
    }
    let landed = c.try_wait().unwrap().is_none();
    let _ = c.kill(); // SIGKILL on Unix: no destructor, no flush, no cleanup
    let _ = c.wait();
    landed
}

fn read_json(p: &std::path::Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(p).ok()?).ok()
}

/// What must hold after any crash plus a reconcile: one complete release is current, the state
/// files name it, nothing half-unpacked is left, and no intent claims an unfinished switch.
fn assert_consistent(p: &Paths, allowed: &[(&str, u64)], at: &str) -> String {
    let cur = current_commit(p).unwrap_or_else(|| panic!("{at}: no current release"));
    let seq = allowed
        .iter()
        .find(|(c, _)| *c == cur)
        .unwrap_or_else(|| panic!("{at}: current {cur} is not one of the expected releases"))
        .1;
    let rec = read_json(&p.releases.join(&cur).join("INSTALLED.json"))
        .unwrap_or_else(|| panic!("{at}: current release has no INSTALLED.json"));
    assert_eq!(
        rec["commit"], cur,
        "{at}: INSTALLED.json names another commit"
    );
    assert!(
        p.current.join("BUILD-INFO.json").exists() || p.current.exists(),
        "{at}: the current link dangles"
    );
    let state = read_json(&p.state.join("artifact-current.json"))
        .unwrap_or_else(|| panic!("{at}: artifact-current.json unreadable"));
    assert_eq!(
        state["commit"], cur,
        "{at}: artifact-current.json disagrees with the link"
    );
    let known: u64 = fs::read_to_string(p.state.join("artifact-sequence"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(
        known >= seq,
        "{at}: sequence {known} below the running release's {seq}"
    );
    for e in fs::read_dir(&p.releases).unwrap().flatten() {
        assert!(
            !e.file_name().to_string_lossy().starts_with(".incoming-"),
            "{at}: a half-unpacked release was left"
        );
    }
    if let Some(i) = Intent::read(&p.state) {
        assert_eq!(
            i.phase,
            Phase::Switched,
            "{at}: an unfinished intent survived reconcile"
        );
        assert_eq!(i.commit, cur, "{at}: the intent names another release");
    }
    cur
}

fn timed<F: FnOnce() -> Child>(f: F) -> Duration {
    let s = Instant::now();
    let mut c = f();
    assert!(c.wait().unwrap().success());
    s.elapsed()
}

#[test]
fn an_install_killed_at_any_point_recovers_to_one_whole_release() {
    let body_a = big_body(1);
    let body_b = big_body(2);
    let a = build(&spec('a', 5, body_a));
    let b = build(&spec('b', 6, body_b));

    // How long one uninterrupted install of b over a takes on this machine.
    let t = Tmp::new("crash-cal");
    let p = temp_paths(&t);
    install(&install_args(&a, &p)).unwrap();
    let full = timed(|| spawn_install(&b, &p));
    drop(t);

    let steps: u32 = 24;
    let mut landed = 0u32;
    let mut ended_on_b = 0u32;
    for i in 0..=steps {
        let at = format!("kill {i}/{steps} of {full:?}");
        let t = Tmp::new("crash-inst");
        let p = temp_paths(&t);
        install(&install_args(&a, &p)).unwrap();
        if kill_after(spawn_install(&b, &p), full * i / steps) {
            landed += 1;
        }
        reconcile_via_binary(&p);
        let cur = assert_consistent(&p, &[(&a.commit, 5), (&b.commit, 6)], &at);
        if cur == b.commit {
            ended_on_b += 1;
        } else {
            // The interrupted update can simply be run again.
            install(&install_args(&b, &p))
                .unwrap_or_else(|f| panic!("{at}: re-running the install failed: {}", f.refusal));
        }
        assert_consistent(&p, &[(&b.commit, 6)], &format!("{at}, after completing"));
    }
    assert!(
        landed >= steps / 2,
        "only {landed} of {steps} kills landed mid-install"
    );
    assert!(ended_on_b < steps, "no kill landed before the switch");
}

#[test]
fn a_restore_killed_at_any_point_leaves_one_of_the_two_releases() {
    let body_a = big_body(3);
    let body_b = big_body(4);
    let a = build(&spec('a', 5, body_a));
    let b = build(&spec('b', 6, body_b));
    let steps: u32 = 12;
    let t = Tmp::new("crash-rcal");
    let p = temp_paths(&t);
    install(&install_args(&a, &p)).unwrap();
    install(&install_args(&b, &p)).unwrap();
    let full = timed(|| spawn_restore(&a.commit, &p)).max(Duration::from_millis(2));
    drop(t);
    for i in 0..=steps {
        let at = format!("restore kill {i}/{steps} of {full:?}");
        let t = Tmp::new("crash-rest");
        let p = temp_paths(&t);
        install(&install_args(&a, &p)).unwrap();
        install(&install_args(&b, &p)).unwrap();
        kill_after(spawn_restore(&a.commit, &p), full * i / steps);
        reconcile_via_binary(&p);
        let cur = assert_consistent(&p, &[(&a.commit, 5), (&b.commit, 6)], &at);
        if cur != a.commit {
            restore(&p, &a.commit)
                .unwrap_or_else(|f| panic!("{at}: re-running restore failed: {}", f.refusal));
        }
        assert_consistent(&p, &[(&a.commit, 5)], &format!("{at}, after completing"));
        // A restore never lowers the anti-rollback floor, whenever it was cut short.
        assert_eq!(
            fs::read_to_string(p.state.join("artifact-sequence"))
                .unwrap()
                .trim(),
            "6",
            "{at}: restore lowered the sequence"
        );
    }
}

#[test]
fn a_torn_intent_or_state_write_is_survivable() {
    // A power loss that tears a write (the file system kept only a prefix): every prefix of the
    // intent file is either the whole valid intent or ignored, never a different valid intent.
    let a = build(&Spec::new('a', 5));
    let b = build(&Spec::new('b', 6));
    let t = Tmp::new("crash-torn");
    let p = temp_paths(&t);
    install(&install_args(&a, &p)).unwrap();
    install(&install_args(&b, &p)).unwrap();
    let full = fs::read(p.state.join("update-intent.json")).unwrap();
    let whole = Intent::read(&p.state).unwrap();
    for n in 0..full.len() {
        fs::write(p.state.join("update-intent.json"), &full[..n]).unwrap();
        match Intent::read(&p.state) {
            None => {}
            Some(i) => assert_eq!(i, whole, "a {n}-byte prefix read as another intent"),
        }
        reconcile_via_binary(&p);
        assert_consistent(&p, &[(&b.commit, 6)], &format!("intent prefix {n}"));
    }
    // A torn artifact-current.json is rewritten from the release's own record once an intent
    // for the running release is replayed.
    fs::write(p.state.join("artifact-current.json"), b"{\"comm").unwrap();
    Intent {
        phase: Phase::Switching,
        commit: b.commit.clone(),
        previous: Some(a.commit.clone()),
        sequence: 6,
        at_ms: 1,
    }
    .write(&p.state)
    .unwrap();
    reconcile_via_binary(&p);
    assert_consistent(&p, &[(&b.commit, 6)], "torn artifact-current.json");
}

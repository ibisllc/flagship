#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]
mod common;

use common::{Spec, Tmp, build, install_args, temp_paths};
use flagship_updater::journal::{Intent, Phase};
use flagship_updater::recover::{GuardAction, guard, reconcile};
use flagship_updater::release::{current_commit, install, restore};
use serde_json::Value;
use std::fs;

fn read_json(p: &std::path::Path) -> Value {
    serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn an_install_switches_the_link_and_writes_every_state_file() {
    let t = Tmp::new("inst");
    let paths = temp_paths(&t);
    let b = build(&Spec::new('a', 5));
    let r = install(&install_args(&b, &paths)).unwrap();
    assert_eq!((r.commit.as_str(), r.sequence), (b.commit.as_str(), 5));
    assert_eq!(current_commit(&paths).as_deref(), Some(b.commit.as_str()));
    assert!(paths.current.join(".runtime/node/bin/node").exists());
    assert_eq!(
        fs::read_link(paths.bin.join("node")).unwrap(),
        paths.current.join(".runtime/node/bin/node")
    );
    let rec = read_json(&paths.releases.join(&b.commit).join("INSTALLED.json"));
    assert_eq!(rec["commit"], b.commit);
    assert_eq!(rec["sequence"], 5);
    assert_eq!(rec["artifactSha256"], b.sha);
    assert_eq!(read_json(&paths.state.join("artifact-current.json")), rec);
    assert_eq!(
        fs::read_to_string(paths.state.join("artifact-sequence"))
            .unwrap()
            .trim(),
        "5"
    );
    let intent = Intent::read(&paths.state).unwrap();
    assert_eq!((intent.phase, intent.previous), (Phase::Switched, None));
    assert!(fs::read_dir(&paths.releases).unwrap().all(|e| {
        !e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".incoming")
    }));
}

#[test]
fn the_next_install_keeps_the_previous_release_and_a_third_prunes_the_first() {
    let t = Tmp::new("inst");
    let paths = temp_paths(&t);
    let (a, b, c) = (
        build(&Spec::new('a', 5)),
        build(&Spec::new('b', 6)),
        build(&Spec::new('c', 7)),
    );
    install(&install_args(&a, &paths)).unwrap();
    install(&install_args(&b, &paths)).unwrap();
    assert_eq!(
        Intent::read(&paths.state).unwrap().previous.as_deref(),
        Some(a.commit.as_str())
    );
    let prev = fs::read_to_string(paths.state.join("artifact-previous")).unwrap();
    assert_eq!(
        prev.trim(),
        paths.releases.join(&a.commit).join("app").to_str().unwrap()
    );
    assert!(paths.releases.join(&a.commit).exists() && paths.releases.join(&b.commit).exists());
    install(&install_args(&c, &paths)).unwrap();
    assert!(!paths.releases.join(&a.commit).exists());
    assert!(paths.releases.join(&b.commit).exists() && paths.releases.join(&c.commit).exists());
}

#[test]
fn an_older_release_is_refused_and_changes_nothing() {
    let t = Tmp::new("inst");
    let paths = temp_paths(&t);
    let (new, old) = (build(&Spec::new('b', 9)), build(&Spec::new('a', 4)));
    install(&install_args(&new, &paths)).unwrap();
    let f = install(&install_args(&old, &paths)).unwrap_err();
    assert_eq!((f.exit, f.refusal.code), (1, "rollback"));
    assert_eq!(current_commit(&paths).as_deref(), Some(new.commit.as_str()));
    assert!(!paths.releases.join(&old.commit).exists());
}

#[test]
fn a_tampered_manifest_installs_nothing() {
    let t = Tmp::new("inst");
    let paths = temp_paths(&t);
    let mut s = Spec::new('a', 5);
    s.tamper = true;
    let b = build(&s);
    let f = install(&install_args(&b, &paths)).unwrap_err();
    assert_eq!(f.exit, 1);
    assert!(!paths.current.exists() && !paths.releases.join(&b.commit).exists());
}

#[test]
fn a_release_directory_is_immutable() {
    let t = Tmp::new("inst");
    let paths = temp_paths(&t);
    let first = build(&Spec::new('a', 5));
    install(&install_args(&first, &paths)).unwrap();
    // The same commit with different bytes (a differently built artifact) may not replace it.
    let mut s = Spec::new('a', 6);
    s.node_body = b"a different node binary";
    let again = build(&s);
    let f = install(&install_args(&again, &paths)).unwrap_err();
    assert_eq!((f.exit, f.refusal.code), (3, "release-exists"));
    // The identical bytes again are accepted once the sequence history allows it.
    fs::remove_file(paths.state.join("artifact-sequence")).unwrap();
    install(&install_args(&first, &paths)).unwrap();
}

#[test]
fn a_legacy_real_directory_is_never_replaced() {
    let t = Tmp::new("inst");
    let paths = temp_paths(&t);
    fs::create_dir_all(&paths.current).unwrap();
    fs::write(paths.current.join("keep"), b"x").unwrap();
    let b = build(&Spec::new('a', 5));
    let f = install(&install_args(&b, &paths)).unwrap_err();
    assert_eq!((f.exit, f.refusal.code), (3, "legacy-install"));
    assert!(paths.current.join("keep").exists() && !paths.current.is_symlink());
}

#[test]
fn a_correctly_signed_tree_that_is_not_what_it_claims_is_refused() {
    for (label, spec) in [
        ("BUILD-INFO names another commit", {
            let mut s = Spec::new('a', 5);
            s.build_info_commit = Some("f".repeat(40));
            s
        }),
        ("no unseal helper", {
            let mut s = Spec::new('a', 5);
            s.omit = Some("flagship-box/app/installer/flagship-unseal");
            s
        }),
        ("no Node runtime", {
            let mut s = Spec::new('a', 5);
            s.omit = Some("flagship-box/app/.runtime/node/bin/node");
            s
        }),
        ("no lockfile", {
            let mut s = Spec::new('a', 5);
            s.omit = Some("flagship-box/app/package-lock.json");
            s
        }),
        ("no BUILD-INFO", {
            let mut s = Spec::new('a', 5);
            s.omit = Some("flagship-box/BUILD-INFO.json");
            s
        }),
    ] {
        let t = Tmp::new("inst");
        let paths = temp_paths(&t);
        let b = build(&spec);
        let f = install(&install_args(&b, &paths)).unwrap_err();
        assert_eq!((f.exit, f.refusal.code), (3, "bad-tree"), "{label}");
        assert!(
            !paths.current.exists() && !paths.releases.join(&b.commit).exists(),
            "{label}: nothing was switched or kept"
        );
        assert!(Intent::read(&paths.state).is_none(), "{label}");
    }
}

#[test]
fn the_bundled_node_must_be_the_official_binary_the_releases_runtime_lock_names() {
    let t = Tmp::new("inst");
    let paths = temp_paths(&t);
    let mut honest = Spec::new('a', 5);
    honest.runtime_lock = Some(true);
    install(&install_args(&build(&honest), &paths)).unwrap();
    let t2 = Tmp::new("inst");
    let paths2 = temp_paths(&t2);
    let mut swapped = Spec::new('b', 6);
    swapped.runtime_lock = Some(false);
    let b = build(&swapped);
    let f = install(&install_args(&b, &paths2)).unwrap_err();
    assert_eq!((f.exit, f.refusal.code), (3, "runtime-mismatch"));
    assert!(!paths2.current.exists() && !paths2.releases.join(&b.commit).exists());
}

#[test]
fn restore_flips_back_and_never_lowers_the_sequence() {
    let t = Tmp::new("inst");
    let paths = temp_paths(&t);
    let (a, b) = (build(&Spec::new('a', 5)), build(&Spec::new('b', 6)));
    install(&install_args(&a, &paths)).unwrap();
    install(&install_args(&b, &paths)).unwrap();
    restore(&paths, &a.commit).unwrap();
    assert_eq!(current_commit(&paths).as_deref(), Some(a.commit.as_str()));
    assert_eq!(
        read_json(&paths.state.join("artifact-current.json"))["commit"],
        a.commit
    );
    assert_eq!(
        fs::read_to_string(paths.state.join("artifact-sequence"))
            .unwrap()
            .trim(),
        "6"
    );
    assert!(Intent::read(&paths.state).is_none());
    // the newer release can no longer be "installed" again at its old sequence
    let again = install(&install_args(&b, &paths)).unwrap_err();
    assert_eq!(again.refusal.code, "rollback");
}

#[test]
fn restore_refuses_a_release_that_is_not_installed() {
    let t = Tmp::new("inst");
    let paths = temp_paths(&t);
    let f = restore(&paths, &"d".repeat(40)).unwrap_err();
    assert_eq!((f.exit, f.refusal.code), (3, "not-installed"));
    assert_eq!(restore(&paths, "abc").unwrap_err().exit, 2);
}

fn marker(
    paths: &flagship_updater::release::Paths,
    prev: &str,
    target: &str,
    stage: &str,
    attempts: u64,
) {
    fs::write(
        paths.state.join("update-pending.json"),
        format!("{{\"previousCommit\":\"{prev}\",\"targetCommit\":\"{target}\",\"stage\":\"{stage}\",\"bootAttempts\":{attempts}}}"),
    )
    .unwrap();
}

fn two_installed() -> (Tmp, flagship_updater::release::Paths, String, String) {
    let t = Tmp::new("guard");
    let paths = temp_paths(&t);
    let (a, b) = (build(&Spec::new('a', 5)), build(&Spec::new('b', 6)));
    install(&install_args(&a, &paths)).unwrap();
    install(&install_args(&b, &paths)).unwrap();
    (t, paths, a.commit.clone(), b.commit.clone())
}

#[test]
fn the_guard_does_nothing_without_a_pending_update_and_clears_a_finished_intent() {
    let (_t, paths, _a, b) = two_installed();
    assert_eq!(guard(&paths, 8), GuardAction::NoMarker);
    assert!(Intent::read(&paths.state).is_none());
    assert_eq!(current_commit(&paths).as_deref(), Some(b.as_str()));
}

#[test]
fn the_guard_rolls_back_an_interrupted_apply_at_once() {
    let (_t, paths, a, b) = two_installed();
    marker(&paths, &a, &b, "applying", 0);
    assert_eq!(guard(&paths, 8), GuardAction::RolledBack { to: a.clone() });
    assert_eq!(current_commit(&paths).as_deref(), Some(a.as_str()));
    assert!(!paths.state.join("update-pending.json").exists());
    let outcome = read_json(&paths.state.join("update-outcome.json"));
    assert_eq!(
        (
            outcome["outcome"].as_str(),
            outcome["previousCommit"].as_str(),
            outcome["targetCommit"].as_str()
        ),
        (Some("rolled-back"), Some(a.as_str()), Some(b.as_str()))
    );
}

#[test]
fn the_guard_counts_starts_and_rolls_back_past_the_limit() {
    let (_t, paths, a, b) = two_installed();
    marker(&paths, &a, &b, "staged", 1);
    for n in 1..=3 {
        assert_eq!(guard(&paths, 3), GuardAction::Counted { starts: n });
    }
    assert_eq!(current_commit(&paths).as_deref(), Some(b.as_str()));
    assert_eq!(guard(&paths, 3), GuardAction::RolledBack { to: a.clone() });
    assert_eq!(current_commit(&paths).as_deref(), Some(a.as_str()));
    assert!(!paths.state.join("update-guard-starts").exists());
}

#[test]
fn a_count_left_by_an_earlier_update_does_not_carry_over() {
    let (_t, paths, a, b) = two_installed();
    fs::write(
        paths.state.join("update-guard-starts"),
        format!("{} 7\n", "9".repeat(40)),
    )
    .unwrap();
    marker(&paths, &a, &b, "staged", 0);
    assert_eq!(guard(&paths, 8), GuardAction::Counted { starts: 1 });
}

#[test]
fn an_unreadable_marker_falls_back_to_the_last_verified_release() {
    let (_t, paths, a, _b) = two_installed();
    fs::write(
        paths.state.join("update-pending.json"),
        b"{\"previousCommit\":\"",
    )
    .unwrap();
    fs::write(
        paths.state.join("update-outcome.json"),
        format!("{{\"outcome\":\"applied\",\"targetCommit\":\"{a}\"}}"),
    )
    .unwrap();
    assert_eq!(guard(&paths, 8), GuardAction::RolledBack { to: a.clone() });
    assert_eq!(current_commit(&paths).as_deref(), Some(a.as_str()));
}

#[test]
fn an_unreadable_marker_with_no_known_good_release_is_left_to_the_daemon() {
    let (_t, paths, _a, b) = two_installed();
    fs::write(paths.state.join("update-pending.json"), b"not json").unwrap();
    assert_eq!(guard(&paths, 8), GuardAction::NothingKnown);
    assert_eq!(current_commit(&paths).as_deref(), Some(b.as_str()));
}

#[test]
fn a_rollback_to_a_release_that_is_gone_is_reported_not_fatal() {
    let (_t, paths, _a, b) = two_installed();
    marker(&paths, &"d".repeat(40), &b, "applying", 0);
    match guard(&paths, 8) {
        GuardAction::RollbackFailed { to, .. } => assert_eq!(to, "d".repeat(40)),
        other => panic!("{other:?}"),
    }
    assert_eq!(current_commit(&paths).as_deref(), Some(b.as_str()));
}

#[test]
fn reconcile_finishes_a_switch_cut_short_after_the_flip() {
    let (_t, paths, a, b) = two_installed();
    // The power failed after the link moved to b but before the state files followed.
    fs::write(paths.state.join("artifact-sequence"), b"5\n").unwrap();
    fs::copy(
        paths.releases.join(&a).join("INSTALLED.json"),
        paths.state.join("artifact-current.json"),
    )
    .unwrap();
    Intent {
        phase: Phase::Switching,
        commit: b.clone(),
        previous: Some(a),
        sequence: 6,
        at_ms: 1,
    }
    .write(&paths.state)
    .unwrap();
    reconcile(&paths);
    assert_eq!(
        read_json(&paths.state.join("artifact-current.json"))["commit"],
        b
    );
    assert_eq!(
        fs::read_to_string(paths.state.join("artifact-sequence"))
            .unwrap()
            .trim(),
        "6"
    );
    assert_eq!(Intent::read(&paths.state).unwrap().phase, Phase::Switched);
}

#[test]
fn reconcile_undoes_nothing_when_the_link_never_moved() {
    let (_t, paths, a, b) = two_installed();
    restore(&paths, &a).unwrap();
    Intent {
        phase: Phase::Switching,
        commit: b,
        previous: Some(a.clone()),
        sequence: 6,
        at_ms: 1,
    }
    .write(&paths.state)
    .unwrap();
    fs::create_dir_all(paths.releases.join(format!(".incoming-{a}-1"))).unwrap();
    reconcile(&paths);
    assert!(Intent::read(&paths.state).is_none());
    assert_eq!(current_commit(&paths).as_deref(), Some(a.as_str()));
    assert!(!paths.releases.join(format!(".incoming-{a}-1")).exists());
}

#[test]
fn a_cut_short_intent_file_is_ignored_not_trusted() {
    let t = Tmp::new("intent");
    let paths = temp_paths(&t);
    fs::create_dir_all(&paths.state).unwrap();
    fs::write(
        paths.state.join("update-intent.json"),
        b"{\"v\":1,\"phase\":\"swi",
    )
    .unwrap();
    assert!(Intent::read(&paths.state).is_none());
    reconcile(&paths);
}

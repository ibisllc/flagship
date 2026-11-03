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
    honest.node_version = "24.22.1";
    honest.runtime_lock = Some(true);
    install(&install_args(&build(&honest), &paths)).unwrap();
    let t2 = Tmp::new("inst");
    let paths2 = temp_paths(&t2);
    let mut swapped = Spec::new('b', 6);
    swapped.node_version = "24.22.1";
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

#[test]
fn the_signed_manifest_must_name_the_runtime_lock_the_release_carries() {
    let t = Tmp::new("inst");
    let paths = temp_paths(&t);
    // the signed artifact manifest says 24.1.0, the lock inside says 24.22.1
    let mut lying = Spec::new('a', 5);
    lying.runtime_lock = Some(true);
    let b = build(&lying);
    let f = install(&install_args(&b, &paths)).unwrap_err();
    assert_eq!((f.exit, f.refusal.code), (3, "runtime-mismatch"));
    assert!(!paths.current.exists());
}

fn honest_release(c: char, seq: u64) -> common::Built {
    let mut s = Spec::new(c, seq);
    s.node_version = "24.22.1";
    s.runtime_lock = Some(true);
    build(&s)
}

const FAR: u64 = 4_000_000_000_000;

#[test]
fn the_published_runtime_manifest_binds_the_endorsed_release() {
    let fp0 = "0".repeat(40);
    type Make = Box<dyn Fn(&str) -> String>;
    let cases: Vec<(&str, Make, &str)> = vec![
        (
            "another lock for the same version",
            Box::new(|l: &str| {
                common::signed_runtime_manifest(
                    1,
                    &format!("{l} "),
                    "24.22.1",
                    "24.22.1",
                    3,
                    FAR,
                    &[],
                )
            }),
            "runtime-manifest-mismatch",
        ),
        (
            "the manifest of the release's own lock",
            Box::new(|l: &str| {
                common::signed_runtime_manifest(1, l, "24.22.1", "24.22.1", 3, FAR, &[])
            }),
            "",
        ),
        (
            "a newer runtime and floor than the release",
            Box::new(|l: &str| {
                let n = l.replace("24.22.1", "24.30.0");
                common::signed_runtime_manifest(1, &n, "24.30.0", "24.30.0", 3, FAR, &[])
            }),
            "runtime-below-floor",
        ),
        (
            "an upstream signer the manifest withdraws",
            {
                let fp = fp0.clone();
                Box::new(move |l: &str| {
                    common::signed_runtime_manifest(
                        1,
                        l,
                        "24.22.1",
                        "24.22.1",
                        3,
                        FAR,
                        &[fp.as_str()],
                    )
                })
            },
            "signer-revoked",
        ),
        (
            "an expired manifest (freeze)",
            Box::new(|l: &str| {
                common::signed_runtime_manifest(
                    1,
                    l,
                    "24.22.1",
                    "24.22.1",
                    3,
                    1_700_000_000_001,
                    &[],
                )
            }),
            "expired",
        ),
        (
            "a manifest signed by a key nobody authorised",
            Box::new(|l: &str| {
                common::signed_runtime_manifest(9, l, "24.22.1", "24.22.1", 3, FAR, &[])
            }),
            "not-enough-signatures",
        ),
    ];
    for (label, make, code) in cases {
        let t = Tmp::new("inst");
        let paths = temp_paths(&t);
        let b = honest_release('a', 5);
        let mpath = t.path().join("runtime-manifest.json");
        std::fs::write(&mpath, make(b.lock_text.as_deref().unwrap())).unwrap();
        let mut a = install_args(&b, &paths);
        a.runtime_manifest = Some(mpath);
        let r = install(&a);
        if code.is_empty() {
            r.unwrap();
            continue;
        }
        let f = r.unwrap_err();
        assert_eq!((f.exit, f.refusal.code), (1, code), "{label}");
        assert!(
            !paths.current.exists() && !paths.releases.join(&b.commit).exists(),
            "{label}: nothing switched"
        );
        assert!(
            !paths.state.join("runtime-manifest-accepted").exists(),
            "{label}: nothing recorded"
        );
    }
}

#[test]
fn an_accepted_runtime_manifest_is_recorded_and_an_older_one_is_then_refused() {
    let t = Tmp::new("inst");
    let paths = temp_paths(&t);
    let a1 = honest_release('a', 5);
    let lock = a1.lock_text.clone().unwrap();
    let m = |seq| {
        let p = t.path().join(format!("m{seq}.json"));
        std::fs::write(
            &p,
            common::signed_runtime_manifest(1, &lock, "24.22.1", "24.22.1", seq, FAR, &[]),
        )
        .unwrap();
        p
    };
    let mut args = install_args(&a1, &paths);
    args.runtime_manifest = Some(m(7));
    install(&args).unwrap();
    assert!(
        std::fs::read_to_string(paths.state.join("runtime-manifest-accepted"))
            .unwrap()
            .starts_with("7 ")
    );
    // the same manifest again is fine (a box re-reads the current one)
    let b = honest_release('b', 6);
    let mut again = install_args(&b, &paths);
    again.runtime_manifest = Some(m(7));
    install(&again).unwrap();
    // a replayed older one is refused and the running release stays
    let c = honest_release('c', 7);
    let mut old = install_args(&c, &paths);
    old.runtime_manifest = Some(m(6));
    let f = install(&old).unwrap_err();
    assert_eq!((f.exit, f.refusal.code), (1, "rollback"));
    assert_eq!(current_commit(&paths).as_deref(), Some(b.commit.as_str()));
    // without a manifest (fetching it failed) the signed lock alone decides: a healthy update still installs
    install(&install_args(&c, &paths)).unwrap();
}

fn put_dropins(paths: &flagship_updater::release::Paths) {
    let d = paths.systemd.join("flagship-daemon.service.d");
    fs::create_dir_all(&d).unwrap();
    fs::write(
        d.join("45-hardening.conf"),
        "[Service]\nProtectSystem=full\n",
    )
    .unwrap();
    fs::write(d.join("40-privd.conf"), "[Service]\nUser=flagship\n").unwrap();
}

#[test]
fn restore_removes_the_drop_ins_an_older_release_does_not_know() {
    let (_t, paths, a, _b) = two_installed();
    put_dropins(&paths);
    restore(&paths, &a).unwrap();
    let d = paths.systemd.join("flagship-daemon.service.d");
    assert!(!d.join("45-hardening.conf").exists());
    assert!(
        d.join("40-privd.conf").exists(),
        "only this release line's drop-ins go"
    );
    assert_eq!(
        flagship_updater::release::RELEASE_DROPINS,
        &["flagship-daemon.service.d/45-hardening.conf"]
    );
}

#[test]
fn the_guards_rollback_removes_them_too() {
    let (_t, paths, a, b) = two_installed();
    put_dropins(&paths);
    marker(&paths, &a, &b, "applying", 0);
    assert_eq!(guard(&paths, 8), GuardAction::RolledBack { to: a.clone() });
    assert!(
        !paths
            .systemd
            .join("flagship-daemon.service.d/45-hardening.conf")
            .exists()
    );
}

#[test]
fn a_restore_with_no_drop_ins_is_unchanged() {
    let (_t, paths, a, _b) = two_installed();
    restore(&paths, &a).unwrap();
    assert!(!paths.systemd.exists());
    assert!(flagship_updater::release::remove_release_dropins(&paths).is_empty());
}

#[test]
fn a_planted_intent_cannot_raise_the_anti_rollback_sequence() {
    let t = Tmp::new("intent");
    let paths = temp_paths(&t);
    let a = build(&Spec::new('a', 5));
    install(&install_args(&a, &paths)).unwrap();
    Intent {
        phase: Phase::Switched,
        commit: a.commit.clone(),
        previous: None,
        sequence: u64::MAX,
        at_ms: 1,
    }
    .write(&paths.state)
    .unwrap();
    reconcile(&paths);
    assert_eq!(
        fs::read_to_string(paths.state.join("artifact-sequence"))
            .unwrap()
            .trim(),
        "5"
    );
    install(&install_args(&build(&Spec::new('b', 6)), &paths)).unwrap();
}

#[test]
fn state_files_another_account_owns_are_not_read() {
    let t = Tmp::new("owner");
    let p = t.path().join("update-intent.json");
    fs::write(&p, "x").unwrap();
    let me = rustix::process::geteuid().as_raw();
    assert_eq!(
        flagship_updater::fsutil::read_owned_by(&p, me).as_deref(),
        Some("x")
    );
    assert!(flagship_updater::fsutil::read_owned_by(&p, me.wrapping_add(1)).is_none());
}

#[test]
fn an_accepted_manifest_records_its_floor_and_revocations() {
    let t = Tmp::new("inst");
    let paths = temp_paths(&t);
    let a = honest_release('a', 5);
    let lock = a.lock_text.clone().unwrap();
    let other = "1".repeat(40);
    let mpath = t.path().join("m.json");
    fs::write(
        &mpath,
        common::signed_runtime_manifest(1, &lock, "24.22.1", "24.20.0", 7, FAR, &[other.as_str()]),
    )
    .unwrap();
    let mut args = install_args(&a, &paths);
    args.runtime_manifest = Some(mpath);
    install(&args).unwrap();
    let rec = fs::read_to_string(paths.state.join("runtime-manifest-accepted")).unwrap();
    let f: Vec<&str> = rec.split_whitespace().collect();
    assert_eq!((f[0], f[2], f[3]), ("7", "24.20.0", other.as_str()));
}

#[test]
fn the_recorded_floor_and_revocations_apply_without_a_fresh_manifest() {
    let digest = "a".repeat(64);
    let cases = [
        (format!("7 {digest} 24.30.0 -\n"), "runtime-below-floor"),
        (
            format!("7 {digest} 24.0.0 {}\n", "0".repeat(40)),
            "signer-revoked",
        ),
        (format!("7 {digest} 24.0.0 -\n"), ""),
        (format!("7 {digest}\n"), ""),
    ];
    for (recorded, code) in cases {
        let t = Tmp::new("inst");
        let paths = temp_paths(&t);
        fs::create_dir_all(&paths.state).unwrap();
        fs::write(paths.state.join("runtime-manifest-accepted"), &recorded).unwrap();
        let b = honest_release('b', 6);
        let r = install(&install_args(&b, &paths));
        if code.is_empty() {
            r.unwrap();
            continue;
        }
        let f = r.unwrap_err();
        assert_eq!((f.exit, f.refusal.code), (1, code), "{recorded}");
        assert!(!paths.current.exists());
    }
}

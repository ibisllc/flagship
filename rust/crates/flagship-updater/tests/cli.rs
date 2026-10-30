#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]
mod common;

use common::{Spec, Tmp, build, temp_paths};
use flagship_updater::cli::run;

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| (*x).to_owned()).collect()
}

fn call(args: &[String]) -> (u8, String, String) {
    let (mut o, mut e) = (Vec::new(), Vec::new());
    let c = run(args, &mut o, &mut e);
    (
        c,
        String::from_utf8(o).unwrap(),
        String::from_utf8(e).unwrap(),
    )
}

#[test]
fn install_takes_the_shell_installers_flags_and_exit_codes() {
    let t = Tmp::new("cli");
    let p = temp_paths(&t);
    let b = build(&Spec::new('a', 5));
    let key = b.trust.keys.join(",");
    let mut args = s(&[
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
        "--min-sequence",
        "1",
    ]);
    for (k, v) in [
        ("--releases", &p.releases),
        ("--current", &p.current),
        ("--state", &p.state),
        ("--bin", &p.bin),
    ] {
        args.push(k.into());
        args.push(v.to_str().unwrap().into());
    }
    let (code, out, _) = call(&args);
    assert_eq!(code, 0, "{out}");
    assert_eq!(
        out.trim(),
        format!("installed: {} amd64 sequence 5", b.commit)
    );
    // the same again is the anti-rollback refusal: exit 1, "refused: rollback" on stderr
    let (code, _, err) = call(&args);
    assert_eq!((code, err.trim()), (1, "refused: rollback"));
    // restore to itself works and prints the script's line
    let (code, out, _) = call(&s(&[
        "restore",
        &b.commit,
        "--releases",
        p.releases.to_str().unwrap(),
        "--current",
        p.current.to_str().unwrap(),
        "--state",
        p.state.to_str().unwrap(),
        "--bin",
        p.bin.to_str().unwrap(),
    ]));
    assert_eq!(
        (code, out.trim()),
        (0, format!("rolled back: {}", b.commit).as_str())
    );
}

#[test]
fn verify_alone_reports_what_it_checked() {
    let b = build(&Spec::new('a', 5));
    let key = b.trust.keys.join(",");
    let args = s(&[
        "verify",
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
    ]);
    let (code, out, _) = call(&args);
    assert_eq!(code, 0);
    assert!(out.starts_with(&format!(
        "verified: {} amd64 sequence 5 signed by 1",
        b.commit
    )));
    let mut bad = args.clone();
    let at = bad.iter().position(|a| a == "--arch").unwrap() + 1;
    bad[at] = "arm64".into();
    assert_eq!(call(&bad).2.trim(), "refused: arch-mismatch");
}

#[test]
fn usage_errors_exit_two_and_the_guard_never_fails() {
    assert_eq!(call(&[]).0, 2);
    assert_eq!(call(&s(&["install", "--manifest"])).0, 2);
    assert_eq!(call(&s(&["frobnicate"])).0, 2);
    assert_eq!(call(&s(&["restore"])).0, 2);
    let t = Tmp::new("cli");
    let p = temp_paths(&t);
    std::fs::create_dir_all(&p.state).unwrap();
    // a pending update that cannot be rolled back still exits 0: the daemon must start
    std::fs::write(p.state.join("update-pending.json"), format!("{{\"previousCommit\":\"{0}\",\"targetCommit\":\"{0}\",\"stage\":\"applying\",\"bootAttempts\":0}}", "a".repeat(40))).unwrap();
    let (code, out, _) = call(&s(&[
        "guard",
        "--releases",
        p.releases.to_str().unwrap(),
        "--current",
        p.current.to_str().unwrap(),
        "--state",
        p.state.to_str().unwrap(),
        "--bin",
        p.bin.to_str().unwrap(),
    ]));
    assert_eq!(code, 0);
    assert!(out.contains("failed"), "{out}");
}

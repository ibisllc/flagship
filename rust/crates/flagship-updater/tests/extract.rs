#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]
mod common;

use common::{Entry, Tmp, tar_gz};
use flagship_updater::extract::{Limits, extract_tar_gz};
use std::fs;
use std::os::unix::fs::PermissionsExt;

fn unpack(entries: &[Entry]) -> (Tmp, Result<flagship_updater::extract::Extracted, String>) {
    unpack_with(entries, &Limits::default())
}

fn unpack_with(
    entries: &[Entry],
    limits: &Limits,
) -> (Tmp, Result<flagship_updater::extract::Extracted, String>) {
    let t = Tmp::new("extract");
    let a = t.path().join("a.tar.gz");
    fs::write(&a, tar_gz(entries)).unwrap();
    let dest = t.path().join("out");
    fs::create_dir(&dest).unwrap();
    let r = extract_tar_gz(&a, &dest, 1, limits).map_err(|r| r.to_string());
    (t, r)
}

fn refused(entries: &[Entry]) -> String {
    unpack(entries).1.unwrap_err()
}

#[test]
fn a_normal_tree_unpacks_with_the_top_directory_stripped() {
    let (t, r) = unpack(&[
        Entry::Dir("top/"),
        Entry::File("top/a.txt", b"hello".to_vec(), 0o644),
        Entry::Dir("top/bin/"),
        Entry::File("top/bin/run", b"#!/bin/sh\n".to_vec(), 0o755),
        Entry::Symlink("top/bin/link", "run"),
        Entry::Symlink("top/bin/up", "../a.txt"),
        Entry::File("top-level-file-is-dropped", b"x".to_vec(), 0o644),
    ]);
    let s = r.unwrap();
    assert_eq!((s.files, s.symlinks), (2, 2));
    let out = t.path().join("out");
    assert_eq!(fs::read(out.join("a.txt")).unwrap(), b"hello");
    assert_eq!(
        fs::metadata(out.join("bin/run"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    assert_eq!(
        fs::read_link(out.join("bin/up")).unwrap().to_str().unwrap(),
        "../a.txt"
    );
    assert!(!out.join("top-level-file-is-dropped").exists());
}

#[test]
fn absolute_and_climbing_paths_are_refused() {
    assert!(refused(&[Entry::File("/etc/passwd", b"x".to_vec(), 0o644)]).contains("absolute"));
    assert!(refused(&[Entry::File("top/../../x", b"x".to_vec(), 0o644)]).contains(".."));
    assert!(refused(&[Entry::File("top/a/../b", b"x".to_vec(), 0o644)]).contains(".."));
}

#[test]
fn control_characters_in_a_path_are_refused() {
    let e = Entry::LongFile("top/a\nb".into(), b"x".to_vec());
    assert!(refused(&[e]).contains("control"));
}

#[test]
fn symlinks_may_not_leave_the_release() {
    assert!(refused(&[Entry::Symlink("top/l", "/etc")]).contains("symlink"));
    assert!(refused(&[Entry::Symlink("top/l", "..")]).contains("symlink"));
    assert!(
        refused(&[Entry::Dir("top/d/"), Entry::Symlink("top/d/l", "../../x")]).contains("symlink")
    );
    assert!(
        refused(&[
            Entry::Dir("top/d/"),
            Entry::Symlink("top/d/l", "../a/../../x")
        ])
        .contains("symlink")
    );
    // a climb after descending cannot be judged without following links: refused
    assert!(
        refused(&[Entry::Dir("top/d/"), Entry::Symlink("top/d/l", "x/../../y")])
            .contains("symlink")
    );
}

#[test]
fn nothing_is_written_below_a_symlink() {
    let r = refused(&[
        Entry::Dir("top/"),
        Entry::Symlink("top/l", "."),
        Entry::File("top/l/pwned", b"x".to_vec(), 0o644),
    ]);
    assert!(r.contains("below"));
}

#[test]
fn hard_links_devices_and_other_special_files_are_refused() {
    assert!(
        refused(&[
            Entry::File("top/a", b"x".to_vec(), 0o644),
            Entry::Hard("top/b", "top/a")
        ])
        .contains("hard link")
    );
    assert!(refused(&[Entry::Device("top/dev")]).contains("special"));
}

#[test]
fn a_duplicate_entry_is_refused() {
    let r = refused(&[
        Entry::File("top/a", b"1".to_vec(), 0o644),
        Entry::File("top/a", b"2".to_vec(), 0o644),
    ]);
    assert!(r.contains("unpack-failed") || r.contains("unsafe"));
}

#[test]
fn a_bad_header_checksum_is_refused() {
    assert!(refused(&[Entry::BadChecksum("top/a")]).contains("checksum"));
}

#[test]
fn gnu_long_names_and_pax_paths_are_read() {
    let long = format!("top/{}/file.txt", "d".repeat(150));
    let (t, r) = unpack(&[Entry::GnuLong(long.clone(), b"gnu".to_vec())]);
    r.unwrap();
    assert_eq!(
        fs::read(
            t.path()
                .join("out")
                .join(long.strip_prefix("top/").unwrap())
        )
        .unwrap(),
        b"gnu"
    );
    let (t, r) = unpack(&[Entry::PaxPath(long.clone(), b"pax".to_vec())]);
    r.unwrap();
    assert_eq!(
        fs::read(
            t.path()
                .join("out")
                .join(long.strip_prefix("top/").unwrap())
        )
        .unwrap(),
        b"pax"
    );
}

#[test]
fn a_long_name_cannot_smuggle_a_climbing_path() {
    let r = refused(&[Entry::GnuLong(
        format!("top/{}/../../x", "d".repeat(150)),
        b"x".to_vec(),
    )]);
    assert!(r.contains(".."));
}

#[test]
fn limits_stop_a_bomb() {
    let big = vec![7u8; 100_000];
    let small = Limits {
        max_total_bytes: 50_000,
        ..Limits::default()
    };
    assert!(
        unpack_with(&[Entry::File("top/a", big.clone(), 0o644)], &small)
            .1
            .unwrap_err()
            .contains("too large")
    );
    let few = Limits {
        max_entries: 2,
        ..Limits::default()
    };
    let many = [
        Entry::File("top/a", b"1".to_vec(), 0o644),
        Entry::File("top/b", b"1".to_vec(), 0o644),
        Entry::File("top/c", b"1".to_vec(), 0o644),
    ];
    assert!(unpack_with(&many, &few).1.unwrap_err().contains("too many"));
    let deep = Limits {
        max_depth: 2,
        ..Limits::default()
    };
    assert!(
        unpack_with(&[Entry::File("top/a/b/c/d", b"1".to_vec(), 0o644)], &deep)
            .1
            .unwrap_err()
            .contains("deep")
    );
    let shortp = Limits {
        max_path_bytes: 12,
        ..Limits::default()
    };
    assert!(
        unpack_with(
            &[Entry::File("top/aaaaaaaaaaaaaaaa", b"1".to_vec(), 0o644)],
            &shortp
        )
        .1
        .unwrap_err()
        .contains("long")
    );
}

#[test]
fn setuid_bits_are_dropped() {
    let (t, r) = unpack(&[Entry::File("top/suid", b"x".to_vec(), 0o4755)]);
    r.unwrap();
    assert_eq!(
        fs::metadata(t.path().join("out/suid"))
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o755
    );
}

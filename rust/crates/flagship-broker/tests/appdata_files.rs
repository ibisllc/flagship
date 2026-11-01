//! `appdata.files` (plan G6): an app's files folder read, written and measured by the broker, the
//! volume derived from the app it names and required to be mounted, and a restore's archive
//! checked (tarcheck.rs) while the broker copies it, so the helper reads only checked bytes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

use flagship_broker::podman::EngineKind;
use flagship_broker::policy::{FILES_HELPER_IMAGE, PrivExec, appdata_files_exec};
use flagship_broker::runner::checked_tar_copy;
use flagship_broker::wire::{ErrorCode, PrivdError};
use serde_json::{Map, Value, json};
use std::io::{Read, Seek};
use std::os::fd::OwnedFd;

const MOUNTS: &str = "/dev/loop3 /var/lib/flagship-files/flagship-files-alice--chess ext4 rw,nosuid,nodev,noexec 0 0\n";

fn args(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}
fn call(v: Value) -> Result<PrivExec, PrivdError> {
    let m = MOUNTS.to_owned();
    appdata_files_exec(&args(v), EngineKind::Docker, &move || m.clone())
}

#[test]
fn a_dump_reads_only_the_named_apps_folder_read_only_into_a_transfer_file() {
    let e = call(json!({"action":"dump","installation":"alice--chess","path":"/var/flagship/backups/x/files.tar"})).unwrap();
    assert_eq!(e.file, "/usr/bin/docker");
    assert!(
        e.args
            .contains(&"type=volume,src=flagship-files-alice--chess,dst=/data,readonly".to_owned())
    );
    assert!(e.args.contains(&FILES_HELPER_IMAGE.to_owned()));
    assert_eq!(
        e.args[e.args.len() - 6..],
        ["--numeric-owner", "-cf", "-", "-C", "/data", "."]
    );
    assert_eq!(
        e.stdout_file.as_deref(),
        Some("/var/flagship/backups/x/files.tar")
    );
    assert!(e.stdin_file.is_none() && !e.stdin_tar_check);
}

#[test]
fn a_restore_writes_the_folder_from_a_checked_copy() {
    let e = call(json!({"action":"restore","installation":"alice--chess","path":"/var/flagship/restore/files.tar"})).unwrap();
    assert!(e.args.contains(&"-i".to_owned()));
    assert!(
        e.args
            .contains(&"type=volume,src=flagship-files-alice--chess,dst=/data".to_owned())
    );
    assert_eq!(
        e.stdin_file.as_deref(),
        Some("/var/flagship/restore/files.tar")
    );
    assert!(e.stdin_tar_check);
    assert!(e.args.iter().any(|a| a == "-xpf"));
}

#[test]
fn size_and_podman() {
    let e = call(json!({"action":"size","installation":"alice--chess"})).unwrap();
    assert_eq!(e.args[e.args.len() - 2..], ["-sb", "/data"]);
    let m = MOUNTS.to_owned();
    let p = appdata_files_exec(
        &args(json!({"action":"dump","installation":"alice--chess","path":"/var/flagship/t.tar"})),
        EngineKind::Podman,
        &move || m.clone(),
    )
    .unwrap();
    assert_eq!(p.file, "/usr/bin/podman");
}

#[test]
fn refusals() {
    let code = |v: Value| call(v).unwrap_err();
    // Not an app name, or a name that would reach another volume.
    for inst in ["alice", "../x", "alice--chess,dst=/etc", "Alice--chess"] {
        assert_eq!(
            code(json!({"action":"dump","installation":inst,"path":"/var/flagship/t"})).code,
            ErrorCode::BadRequest,
            "{inst}"
        );
    }
    // A volume name given as the app derives a different volume, which is not mounted.
    assert_eq!(code(json!({"action":"dump","installation":"flagship-files-alice--chess","path":"/var/flagship/t"})).code, ErrorCode::Forbidden);
    // An app with no mounted files image: nothing installed there to read or write.
    let e = code(json!({"action":"dump","installation":"bob--notes","path":"/var/flagship/t"}));
    assert_eq!(e.code, ErrorCode::Forbidden);
    // A path the daemon does not own, a missing path, an unknown action, an extra field.
    assert_eq!(
        code(json!({"action":"dump","installation":"alice--chess","path":"/etc/shadow"})).code,
        ErrorCode::Forbidden
    );
    assert_eq!(code(json!({"action":"restore","installation":"alice--chess","path":"/var/flagship/../etc/x"})).code, ErrorCode::Forbidden);
    assert_eq!(
        code(json!({"action":"restore","installation":"alice--chess"})).code,
        ErrorCode::BadRequest
    );
    assert_eq!(
        code(json!({"action":"wipe","installation":"alice--chess"})).code,
        ErrorCode::BadRequest
    );
    assert_eq!(
        code(json!({"action":"size","installation":"alice--chess","volume":"x"})).code,
        ErrorCode::BadRequest
    );
}

fn vector(name: &str) -> Vec<u8> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/test-vectors/archive-extraction/vectors.json"
    );
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let c = v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap();
    let s = c["tarB64"].as_str().unwrap();
    // A small base64 decoder keeps this test free of a dev-dependency.
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let (mut out, mut acc, mut bits) = (Vec::new(), 0u32, 0u32);
    for ch in s.bytes().take_while(|c| *c != b'=') {
        acc = (acc << 6) | A.iter().position(|x| *x == ch).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

fn fd_of(bytes: &[u8], dir: &std::path::Path) -> OwnedFd {
    let p = dir.join("in.tar");
    std::fs::write(&p, bytes).unwrap();
    std::fs::File::open(&p).unwrap().into()
}

#[test]
fn the_checked_copy_refuses_a_link_out_and_passes_a_folder() {
    let dir = std::env::temp_dir().join(format!("appdata-files-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let scratch = dir.join("scratch");

    let bad = vector("a symlink that climbs out");
    let err = checked_tar_copy(fd_of(&bad, &dir), &scratch).unwrap_err();
    assert!(err.contains("(symlink-escape)"), "{err}");

    let good =
        vector("a GNU tar of a files folder: root, files, a folder, an inside link, a hard link");
    let fd = checked_tar_copy(fd_of(&good, &dir), &scratch).unwrap();
    let mut f = std::fs::File::from(fd);
    f.rewind().unwrap();
    let mut copy = Vec::new();
    f.read_to_end(&mut copy).unwrap();
    assert!(copy.starts_with(&good[..512 * 6]));
    // Nothing is left behind by name in the broker's folder.
    assert_eq!(std::fs::read_dir(&scratch).unwrap().count(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

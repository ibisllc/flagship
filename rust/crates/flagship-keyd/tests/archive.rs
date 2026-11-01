//! Server-archive keys in keyd (plan G6): the bytes are @flagship/protocol's (the shared
//! server-backup vectors), frames are sealed once each in order, the pool is used once per key
//! and kept on disk, and no operation returns a key.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use flagship_keyd::archive::ArchiveKeys;
use flagship_keyd::wire::{Args, ErrorCode, decode_hex, to_hex};
use serde_json::{Value, json};

fn vectors() -> Value {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/test-vectors/server-backup/vectors.json"
    );
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}
fn args(v: Value) -> Args {
    v.as_object().unwrap().clone()
}
fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap().to_owned()
}
fn gcm_open(key: &[u8], nonce: &[u8], aad: &str, ct: &[u8]) -> Vec<u8> {
    Aes256Gcm::new_from_slice(key)
        .unwrap()
        .decrypt(
            &Nonce::try_from(nonce).unwrap(),
            Payload {
                msg: ct,
                aad: aad.as_bytes(),
            },
        )
        .unwrap()
}

#[test]
fn opens_the_vector_body_with_an_imported_key() {
    let v = vectors();
    let mut k = ArchiveKeys::load(None);
    let id = s(&v, "archiveId");
    let h = k
        .handle(
            "archive.import",
            &args(json!({"archiveId": id, "key": s(&v, "contentKeyHex")})),
            0,
        )
        .unwrap();
    let handle = h["handle"].as_str().unwrap().to_owned();
    let file: Value = serde_json::from_str(v["file"].as_str().unwrap()).unwrap();
    let body = k
        .handle("archive.openBody", &args(json!({"handle": handle, "nonce": s(&file, "bodyNonceHex"), "sealed": s(&file, "bodyHex")})), 1)
        .unwrap();
    let text = String::from_utf8(decode_hex(body["body"].as_str().unwrap()).unwrap()).unwrap();
    let parsed: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["server"]["domain"], v["body"]["server"]["domain"]);
    // A body under another archive's id does not open.
    let other = k
        .handle(
            "archive.import",
            &args(json!({"archiveId": "ff".repeat(16), "key": s(&v, "contentKeyHex")})),
            2,
        )
        .unwrap();
    let e = k
        .handle("archive.openBody", &args(json!({"handle": other["handle"], "nonce": s(&file, "bodyNonceHex"), "sealed": s(&file, "bodyHex")})), 3)
        .unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (ErrorCode::Failed, "authentication failed")
    );
}

#[test]
fn a_pool_key_makes_one_archive_whose_slot_opens_with_it_and_frames_go_in_order() {
    let v = vectors();
    let dir = std::env::temp_dir().join(format!("keyd-archive-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let pool = dir.join("archive-keks.json");
    let id = s(&v, "archiveId");
    let kek = s(&v, "accountKekHex");
    let mut k = ArchiveKeys::load(Some(pool.clone()));
    let added = k.handle("archive.pool.add", &args(json!({"keys": [{"archiveId": id, "kekHex": kek}, {"archiveId": id, "kekHex": kek}]})), 0).unwrap();
    assert_eq!(added["size"], 1);
    // Kept on disk and read back by a fresh keyd.
    let mut k = ArchiveKeys::load(Some(pool.clone()));
    assert_eq!(
        k.handle("archive.pool.list", &Args::new(), 0).unwrap()["archiveIds"],
        json!([id])
    );
    let made = k
        .handle("archive.create", &args(json!({"archiveId": id})), 0)
        .unwrap();
    // Used once: gone from the pool and from the file.
    assert_eq!(
        ArchiveKeys::load(Some(pool.clone()))
            .handle("archive.pool.list", &Args::new(), 0)
            .unwrap()["archiveIds"],
        json!([])
    );
    let e = k
        .handle("archive.create", &args(json!({"archiveId": id})), 0)
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotProvisioned);

    let slot = &made["slot"];
    assert_eq!(slot["kind"], "account");
    let content = gcm_open(
        &decode_hex(&kek).unwrap(),
        &decode_hex(slot["nonceHex"].as_str().unwrap()).unwrap(),
        &format!("flagship/server-backup-slot/v2|account|{id}"),
        &decode_hex(slot["wrappedHex"].as_str().unwrap()).unwrap(),
    );
    let handle = made["handle"].as_str().unwrap().to_owned();
    let seal = |k: &mut ArchiveKeys, i: u64, last: bool, plain: &[u8]| {
        k.handle(
            "archive.sealFrame",
            &args(json!({"handle": handle, "index": i, "last": last, "plain": to_hex(plain)})),
            5,
        )
    };
    let f0 = seal(&mut k, 0, false, b"tar part one").unwrap();
    // Out of order or again: refused, so a nonce is never used twice.
    assert_eq!(
        seal(&mut k, 0, false, b"again").unwrap_err().code,
        ErrorCode::Forbidden
    );
    assert_eq!(
        seal(&mut k, 2, false, b"skip").unwrap_err().code,
        ErrorCode::Forbidden
    );
    seal(&mut k, 1, true, b"").unwrap();
    assert_eq!(
        seal(&mut k, 2, false, b"after the last").unwrap_err().code,
        ErrorCode::Forbidden
    );
    let mut nonce = [0u8; 12];
    nonce[11] = 0;
    let plain = gcm_open(
        &content,
        &nonce,
        &format!("flagship/server-backup-data/v2|{id}|0"),
        &decode_hex(f0["frame"].as_str().unwrap()).unwrap(),
    );
    assert_eq!(plain, b"tar part one");
    // And keyd opens it too, but not as the last frame.
    let o = k
        .handle(
            "archive.openFrame",
            &args(json!({"handle": handle, "index": 0, "last": false, "frame": f0["frame"]})),
            6,
        )
        .unwrap();
    assert_eq!(o["plain"], to_hex(b"tar part one"));
    assert!(
        k.handle(
            "archive.openFrame",
            &args(json!({"handle": handle, "index": 0, "last": true, "frame": f0["frame"]})),
            6
        )
        .is_err()
    );
    // Closed: the handle is gone.
    assert_eq!(
        k.handle("archive.close", &args(json!({"handle": handle})), 7)
            .unwrap()["closed"],
        true
    );
    assert_eq!(
        seal(&mut k, 2, false, b"x").unwrap_err().code,
        ErrorCode::NotProvisioned
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn handles_are_bounded_and_expire() {
    let mut k = ArchiveKeys::load(None);
    let key = "11".repeat(32);
    let mut first = String::new();
    for i in 0..8 {
        let h = k
            .handle(
                "archive.import",
                &args(json!({"archiveId": format!("{i:032x}"), "key": key})),
                0,
            )
            .unwrap();
        if i == 0 {
            first = h["handle"].as_str().unwrap().to_owned();
        }
    }
    let e = k
        .handle(
            "archive.import",
            &args(json!({"archiveId": "aa".repeat(16), "key": key})),
            1,
        )
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::RateLimited);
    // Two idle hours later they are gone and new ones open.
    let later = 2 * 60 * 60_000 + 10;
    assert!(
        k.handle(
            "archive.import",
            &args(json!({"archiveId": "aa".repeat(16), "key": key})),
            later
        )
        .is_ok()
    );
    assert_eq!(
        k.handle(
            "archive.sealBody",
            &args(json!({"handle": first, "body": "00"})),
            later
        )
        .unwrap_err()
        .code,
        ErrorCode::NotProvisioned
    );
}

#[test]
fn bad_arguments_get_the_ts_messages() {
    let mut k = ArchiveKeys::load(None);
    let e = k
        .handle(
            "archive.import",
            &args(json!({"archiveId": "XY", "key": "00"})),
            0,
        )
        .unwrap_err();
    assert_eq!(e.message, "archiveId must be 16 bytes of lowercase hex");
    let e = k
        .handle(
            "archive.import",
            &args(json!({"archiveId": "00".repeat(16), "key": "00"})),
            0,
        )
        .unwrap_err();
    assert_eq!(e.message, "key must be 32 bytes");
    let e = k
        .handle("archive.pool.add", &args(json!({"keys": []})), 0)
        .unwrap_err();
    assert_eq!(e.message, "keys must be a list of archive keys");
    let e = k
        .handle(
            "archive.sealFrame",
            &args(json!({"handle": "nope", "index": 0, "last": true, "plain": ""})),
            0,
        )
        .unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (ErrorCode::NotProvisioned, "no such archive key")
    );
    let h = k
        .handle(
            "archive.import",
            &args(json!({"archiveId": "00".repeat(16), "key": "22".repeat(32)})),
            0,
        )
        .unwrap();
    let e = k
        .handle(
            "archive.sealFrame",
            &args(json!({"handle": h["handle"], "index": -1, "last": true, "plain": ""})),
            0,
        )
        .unwrap_err();
    assert_eq!(e.message, "index must be a non-negative integer");
    let e = k
        .handle(
            "archive.sealFrame",
            &args(json!({"handle": h["handle"], "index": 0, "last": 1, "plain": ""})),
            0,
        )
        .unwrap_err();
    assert_eq!(e.message, "last must be true or false");
}

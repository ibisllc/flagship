//! The Rust archive extraction check against the shared vectors
//! (packages/protocol/test-vectors/archive-extraction/vectors.json), which the TS twin
//! (packages/server-daemon/src/serverArchive/tarCheck.ts) also passes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use flagship_broker::tarcheck::{Limits, Profile, check, check_copy};
use serde_json::Value;
use std::io::Write;
use std::sync::{Arc, Mutex};

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/test-vectors/archive-extraction/vectors.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn b64(s: &str) -> Vec<u8> {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        let v = A.iter().position(|x| *x == c).unwrap() as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

fn limits(defaults: &Value, over: Option<&Value>) -> Limits {
    let get = |k: &str| {
        over.and_then(|o| o.get(k))
            .or_else(|| defaults.get(k))
            .and_then(Value::as_u64)
            .unwrap()
    };
    Limits {
        max_entries: get("maxEntries"),
        max_entry_bytes: get("maxEntryBytes"),
        max_total_bytes: get("maxTotalBytes"),
        max_name_bytes: get("maxNameBytes"),
        max_pax_bytes: get("maxPaxBytes"),
        max_name_total_bytes: get("maxNameTotalBytes"),
    }
}

#[test]
fn every_vector_gets_its_verdict() {
    let v = vectors();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 50);
    let mut wrong = Vec::new();
    for c in cases {
        let profile = Profile::parse(c["profile"].as_str().unwrap()).unwrap();
        let l = limits(&v["defaults"], c.get("limits"));
        let got = check(b64(c["tarB64"].as_str().unwrap()).as_slice(), profile, &l);
        let want = &c["expect"];
        let ok = match (&got, want["ok"].as_bool().unwrap()) {
            (Ok(s), true) => {
                s.entries == want["entries"].as_u64().unwrap()
                    && s.bytes == want["bytes"].as_u64().unwrap()
            }
            (Err(e), false) => e.code() == want["code"].as_str().unwrap(),
            _ => false,
        };
        if !ok {
            wrong.push(format!("{}: want {want} got {got:?}", c["name"]));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[derive(Clone, Default)]
struct Shared(Arc<Mutex<Vec<u8>>>);
impl Write for Shared {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn the_checked_copy_is_what_was_checked_and_ends_in_two_zero_blocks() {
    let v = vectors();
    let c = &v["cases"][0];
    let bytes = b64(c["tarB64"].as_str().unwrap());
    let out = Shared::default();
    let s = check_copy(
        bytes.as_slice(),
        Box::new(out.clone()),
        Profile::Volume,
        &Limits::default(),
    )
    .unwrap();
    assert_eq!(s.entries, 6);
    let copy = out.0.lock().unwrap().clone();
    // Up to and including the first zero block, then one more.
    let first_zero = bytes
        .chunks(512)
        .position(|b| b.iter().all(|x| *x == 0))
        .unwrap();
    assert_eq!(
        &copy[..(first_zero + 1) * 512],
        &bytes[..(first_zero + 1) * 512]
    );
    assert_eq!(copy.len(), (first_zero + 2) * 512);
    assert!(check(copy.as_slice(), Profile::Volume, &Limits::default()).is_ok());
}

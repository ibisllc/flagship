//! `relay_feed_seal` against `packages/control-plane/tests/vectors/relay-feed-seal.json` (chunk B's
//! `scripts/relay-feed-seal-vectors.ts`): the same ciphertext for the same key, nonce and AAD, and every sealed mesh key
//! opened with the relay's seed.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use flagship_crypto::relay_feed_seal::{
    mesh_key_from_line, open_relay_feed, open_sealed_from_ed25519_seed, relay_feed_aad,
    relay_mesh_key_line, seal_for_ed25519_recipient, seal_relay_feed,
};
use serde_json::Value;

const VECTORS: &str =
    include_str!("../../../../packages/control-plane/tests/vectors/relay-feed-seal.json");

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn b64(s: &str) -> Vec<u8> {
    let val = |c: u8| -> u32 {
        match c {
            b'A'..=b'Z' => u32::from(c - b'A'),
            b'a'..=b'z' => u32::from(c - b'a') + 26,
            b'0'..=b'9' => u32::from(c - b'0') + 52,
            b'+' => 62,
            b'/' => 63,
            _ => panic!("not base64"),
        }
    };
    let mut out = Vec::new();
    for chunk in s.trim_end_matches('=').as_bytes().chunks(4) {
        let n = chunk.iter().fold(0u32, |a, c| (a << 6) | val(*c)) << (6 * (4 - chunk.len()));
        let bytes = n.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    out
}

fn arr<const N: usize>(v: &[u8]) -> [u8; N] {
    v.try_into().unwrap()
}

#[test]
fn feed_files_open_and_seal_byte_for_byte() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let apex = v["servicesApex"].as_str().unwrap();
    for c in v["sealed"].as_array().unwrap() {
        let o = &c["object"];
        let aad = relay_feed_aad(
            apex,
            o["object"].as_str().unwrap(),
            o["page"].as_u64(),
            o["epoch"].as_u64().unwrap(),
        );
        assert_eq!(aad, c["aad"].as_str().unwrap(), "{}", c["name"]);
        let key = arr::<32>(&unhex(c["key"].as_str().unwrap()));
        let nonce = arr::<12>(&unhex(c["nonce"].as_str().unwrap()));
        let ct = b64(o["ciphertext"].as_str().unwrap());
        let pt = open_relay_feed(&key, &nonce, &aad, &ct).unwrap();
        assert_eq!(
            String::from_utf8(pt).unwrap(),
            c["plaintext"].as_str().unwrap()
        );
        assert_eq!(
            seal_relay_feed(
                &key,
                &nonce,
                &aad,
                c["plaintext"].as_str().unwrap().as_bytes()
            )
            .unwrap(),
            ct
        );
        let other = relay_feed_aad(apex, "log", Some(99), 1);
        assert!(
            open_relay_feed(&key, &nonce, &other, &ct).is_err(),
            "the AAD binds the slot"
        );
    }
}

#[test]
fn mesh_keys_open_with_the_relay_seed() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let apex = v["servicesApex"].as_str().unwrap();
    let mk = &v["meshKeys"];
    let seed = arr::<32>(&unhex(mk["relaySeed"].as_str().unwrap()));
    let relay = mk["relayId"].as_str().unwrap();
    let doc = &mk["document"];
    for e in doc["epochs"].as_array().unwrap() {
        let epoch = e["epoch"].as_u64().unwrap();
        let line =
            open_sealed_from_ed25519_seed(&unhex(e["sealed"].as_str().unwrap()), &seed).unwrap();
        let line = String::from_utf8(line).unwrap();
        let want = v["epochKeys"]
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["epoch"].as_u64() == Some(epoch))
            .unwrap();
        let key = mesh_key_from_line(&line, apex, relay, epoch).unwrap();
        assert_eq!(key.to_vec(), unhex(want["key"].as_str().unwrap()));
        assert!(mesh_key_from_line(&line, apex, "ams1", epoch).is_none());
        assert!(mesh_key_from_line(&line, apex, relay, epoch + 1).is_none());
        assert!(
            open_sealed_from_ed25519_seed(&unhex(e["sealed"].as_str().unwrap()), &[9; 32]).is_err()
        );
    }
    // A round trip through this side's own sealing opens the same way.
    let relay_key = arr::<32>(&unhex(mk["relayKey"].as_str().unwrap()));
    let line = relay_mesh_key_line(apex, relay, 7, &[5; 32]);
    let sealed = seal_for_ed25519_recipient(line.as_bytes(), &relay_key).unwrap();
    let back = String::from_utf8(open_sealed_from_ed25519_seed(&sealed, &seed).unwrap()).unwrap();
    assert_eq!(mesh_key_from_line(&back, apex, relay, 7), Some([5; 32]));
}

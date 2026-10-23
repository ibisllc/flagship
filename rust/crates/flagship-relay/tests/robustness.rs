//! Deterministic mutation runs over the parsers (the cargo-fuzz targets explore further):
//! no panics, bounded outcomes, and the reassembling SNI parser agreeing with the `sni.ts`
//! port on every single-record input.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use flagship_relay::echo::{ProxyParse, parse_proxy_header};
use flagship_relay::frame::{self, Decoded, FrameDecoder, TypeSet};
use flagship_relay::hello::parse_hello;
use flagship_relay::mail::{MailAssembler, MailKind};
use flagship_relay::payload;
use flagship_relay::sni::{SniLimits, SniStatus, parse_client_hello, parse_client_hello_ts_compat};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

fn seeds() -> Vec<Vec<u8>> {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/tunnel-protocol/test-vectors/sni-pq-hellos.json"
    );
    let doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    doc["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let h = c["hex"].as_str().unwrap();
            (0..h.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
                .collect()
        })
        .collect()
}

fn mutate(r: &mut Rng, mut b: Vec<u8>) -> Vec<u8> {
    for _ in 0..1 + r.below(4) {
        match r.below(5) {
            0 if !b.is_empty() => {
                let i = r.below(b.len());
                b[i] = r.next() as u8;
            }
            1 if !b.is_empty() => {
                let n = r.below(b.len());
                b.truncate(n);
            }
            2 => {
                let i = r.below(b.len() + 1);
                b.insert(i, r.next() as u8);
            }
            3 if b.len() > 8 => {
                let i = r.below(b.len() - 2);
                let v = (r.next() as u16).to_be_bytes();
                b[i] = v[0];
                b[i + 1] = v[1];
            }
            _ => {
                let n = r.below(64);
                b.extend((0..n).map(|_| r.next() as u8));
            }
        }
    }
    b
}

#[test]
fn sni_mutations_agree_with_ts_on_single_record_inputs() {
    let seeds = seeds();
    let mut r = Rng(0x5eed_1234_abcd_0001);
    let l = SniLimits::default();
    let mut agreed = 0;
    for i in 0..40_000 {
        let base = seeds[i % seeds.len()].clone();
        let m = mutate(&mut r, base);
        let full = parse_client_hello(&m, l);
        let ts = parse_client_hello_ts_compat(&m);
        match &ts {
            SniStatus::Done(_) | SniStatus::NeedMore(_) => assert_eq!(full, ts, "input {i}"),
            SniStatus::Reject(
                "handshake length exceeds record" | "record too small for handshake header",
            ) => {}
            SniStatus::Reject(_) => assert_eq!(full, ts, "input {i}"),
        }
        agreed += 1;
        if let SniStatus::NeedMore(n) = full {
            assert!(n > m.len() && n <= l.max_raw_bytes);
        }
    }
    assert_eq!(agreed, 40_000);
}

#[test]
fn frame_decoder_never_panics_and_respects_bounds() {
    let mut r = Rng(0xf00d_0000_0000_0002);
    for _ in 0..20_000 {
        let n = r.below(64);
        let mut b: Vec<u8> = (0..n).map(|_| r.next() as u8).collect();
        if b.len() > 8 && r.below(2) == 0 {
            b[4] = [1u8, 2, 3, 4, 0x10, 0x11, 0x42, 0x52][r.below(8)];
            b[5..9].copy_from_slice(&(r.below(64) as u32).to_be_bytes());
        }
        match frame::decode_frame(&b) {
            Decoded::Ok {
                consumed, payload, ..
            } => assert_eq!(consumed, 9 + payload.len()),
            Decoded::Incomplete { need_at_least } => {
                assert!(need_at_least > b.len() && need_at_least <= 9 + frame::MAX_FRAME_PAYLOAD)
            }
            Decoded::Error { .. } => {}
        }
        let mut d = FrameDecoder::new(TypeSet::V1, 128);
        for c in b.chunks(1 + r.below(16)) {
            if d.push(c).is_err() {
                break;
            }
            while let Ok(Some(_)) = d.next_frame() {}
        }
        let _ = payload::parse_hello_ack(&b);
        let _ = payload::parse_outbound_open(&b);
        let _ = payload::decode_mailbox_announce(&b);
        let _ = payload::decode_pb_challenge(&b);
        let _ = parse_hello(&b);
        let mut a = MailAssembler::new(if r.below(2) == 0 {
            MailKind::Req
        } else {
            MailKind::Resp
        });
        let _ = a.push(&b);
        match parse_proxy_header(&b) {
            ProxyParse::Done { length, .. } => assert!(length <= b.len()),
            ProxyParse::NeedMore | ProxyParse::Invalid(_) => {}
        }
    }
}

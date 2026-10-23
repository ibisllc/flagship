//! The Rust codec against the TypeScript-produced vectors in
//! `packages/tunnel-protocol/test-vectors/frames.json` (tools/tunnel-frame-vectors.mjs).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use flagship_relay::frame::{self, Decoded, Frame, FrameDecoder, TypeSet};
use flagship_relay::mail::{self, MailAssembler, MailKind};
use flagship_relay::payload::{self, HelloAckTrust, MailboxAnnouncement};
use serde_json::Value;

fn vectors() -> Value {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/tunnel-protocol/test-vectors/frames.json"
    );
    serde_json::from_str(&std::fs::read_to_string(p).expect("vectors file")).expect("vectors json")
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn fnv1a64(b: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for x in b {
        h ^= u64::from(*x);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str()
        .unwrap_or_else(|| panic!("{k} not a string in {v}"))
}

fn u(v: &Value, k: &str) -> u64 {
    v[k].as_u64()
        .unwrap_or_else(|| panic!("{k} not a u64 in {v}"))
}

fn build(builder: &str, a: &Value) -> Frame {
    let id = || u(a, "streamId") as u32;
    match builder {
        "helloAck" => {
            let trust =
                (a.get("serviceBlessingJson").is_some() || a.get("hubSig").is_some()).then(|| {
                    HelloAckTrust {
                        service_blessing_json: a
                            .get("serviceBlessingJson")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        hub_sig: a.get("hubSig").and_then(Value::as_str).map(str::to_owned),
                    }
                });
            let caps: Vec<&str> = a
                .get("capabilities")
                .and_then(Value::as_array)
                .map(|c| c.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            payload::hello_ack_frame(
                a["ok"].as_bool().unwrap(),
                a.get("reason").and_then(Value::as_str),
                trust.as_ref(),
                &caps,
            )
        }
        "domainGranted" => payload::domain_granted_frame(s(a, "fqdn"), s(a, "ownerServerId")),
        "requestTransfer" => payload::request_transfer_frame(s(a, "fqdn")),
        "open" => payload::open_frame(id(), s(a, "sni")),
        "data" => Frame::new(id(), frame::FRAME_DATA, unhex(s(a, "dataHex"))),
        "close" => Frame::new(
            id(),
            if a["remote"].as_bool().unwrap() {
                frame::FRAME_CLOSE_REMOTE
            } else {
                frame::FRAME_CLOSE
            },
            Vec::new(),
        ),
        "outboundOpen" => {
            payload::outbound_open_frame(id(), s(a, "host"), u(a, "port") as u16).unwrap()
        }
        "outboundResult" => payload::outbound_result_frame(
            id(),
            a["ok"].as_bool().unwrap(),
            a.get("reason").and_then(Value::as_str),
        ),
        "outboundCredit" => payload::outbound_credit_frame(id(), u(a, "bytes") as u32).unwrap(),
        "mailboxAnnounce" => {
            let list: Vec<MailboxAnnouncement> = a["announcements"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| MailboxAnnouncement {
                    pik_pub_hex: s(x, "pikPubHex").to_owned(),
                    epoch: x["epoch"].as_f64().unwrap(),
                    sig_hex: s(x, "sigHex").to_owned(),
                })
                .collect();
            payload::mailbox_announce_frame(&list).unwrap()
        }
        "pbPut" => payload::pb_put_frame(
            id(),
            s(a, "encChunkId"),
            u(a, "shardIndex"),
            u(a, "sizeBytes"),
            s(a, "signature"),
        )
        .unwrap(),
        "pbPutAck" => payload::pb_put_ack_frame(
            id(),
            s(a, "encChunkId"),
            u(a, "shardIndex"),
            a["ok"].as_bool().unwrap(),
            a.get("reason").and_then(Value::as_str),
        )
        .unwrap(),
        "pbGet" => payload::pb_get_frame(id(), s(a, "encChunkId"), u(a, "shardIndex")).unwrap(),
        "pbGetData" => payload::pb_get_data_frame(id(), &unhex(s(a, "dataHex"))),
        "pbGetEnd" => {
            payload::pb_get_end_frame(id(), s(a, "encChunkId"), u(a, "shardIndex"), s(a, "sha256"))
                .unwrap()
        }
        "pbChallenge" => payload::pb_challenge_frame(
            id(),
            s(a, "encChunkId"),
            u(a, "shardIndex"),
            s(a, "nonce"),
            u(a, "offset"),
            u(a, "length"),
        )
        .unwrap(),
        "pbResponse" => payload::pb_response_frame(
            id(),
            s(a, "encChunkId"),
            u(a, "shardIndex"),
            s(a, "hash"),
            s(a, "signature"),
        )
        .unwrap(),
        other => panic!("unknown builder {other}"),
    }
}

#[test]
fn encoders_are_byte_identical_and_round_trip() {
    let v = vectors();
    let cases = v["encoded"].as_array().unwrap();
    assert!(cases.len() >= 25);
    for c in cases {
        let name = s(c, "name");
        let f = build(s(c, "builder"), &c["args"]);
        let bytes = frame::encode_frame(&f).unwrap();
        assert_eq!(hex(&bytes), s(c, "hex"), "{name}: encoding differs from TS");
        match frame::decode_frame(&bytes) {
            Decoded::Ok {
                stream_id,
                frame_type,
                payload,
                consumed,
            } => {
                assert_eq!(u64::from(stream_id), u(c, "streamId"), "{name}");
                assert_eq!(u64::from(frame_type), u(c, "type"), "{name}");
                assert_eq!(hex(payload), s(c, "payloadHex"), "{name}");
                assert_eq!(consumed, bytes.len(), "{name}");
            }
            other => panic!("{name}: {other:?}"),
        }
    }
}

#[test]
fn decoder_matches_ts_outcomes() {
    let v = vectors();
    for c in v["decode"].as_array().unwrap() {
        let name = s(c, "name");
        let bytes = unhex(s(c, "hex"));
        let r = &c["result"];
        match (frame::decode_frame(&bytes), s(r, "kind")) {
            (
                Decoded::Ok {
                    stream_id,
                    frame_type,
                    payload,
                    consumed,
                },
                "ok",
            ) => {
                assert_eq!(u64::from(stream_id), u(r, "streamId"), "{name}");
                assert_eq!(u64::from(frame_type), u(r, "type"), "{name}");
                assert_eq!(hex(payload), s(r, "payloadHex"), "{name}");
                assert_eq!(consumed as u64, u(r, "consumed"), "{name}");
            }
            (Decoded::Incomplete { need_at_least }, "incomplete") => {
                assert_eq!(need_at_least as u64, u(r, "needAtLeast"), "{name}");
            }
            (Decoded::Error { reason }, "error") => assert_eq!(reason, s(r, "reason"), "{name}"),
            (got, want) => panic!("{name}: Rust {got:?}, TS {want}"),
        }
    }
}

#[test]
fn streaming_decoder_matches_one_shot_on_every_split() {
    let v = vectors();
    let mut stream = Vec::new();
    for c in v["encoded"].as_array().unwrap() {
        stream.extend(unhex(s(c, "hex")));
    }
    let count = v["encoded"].as_array().unwrap().len();
    for split in [1usize, 2, 3, 7, 9, 10, 64, 1000, stream.len()] {
        let mut d = FrameDecoder::new(TypeSet::V1, 64 * 1024);
        let mut got = Vec::new();
        for part in stream.chunks(split) {
            d.push(part).unwrap();
            while let Some(f) = d.next_frame().unwrap() {
                got.push(frame::encode_frame(&f).unwrap());
            }
        }
        assert_eq!(got.len(), count, "split {split}");
        assert_eq!(got.concat(), stream, "split {split}");
        assert_eq!(d.buffered(), 0);
    }
}

#[test]
fn encode_refuses_oversized_payload() {
    let v = vectors();
    let e = &v["encodeErrors"][0];
    let f = Frame::new(1, frame::FRAME_DATA, vec![0; u(e, "payloadLen") as usize]);
    let err = frame::encode_frame(&f).unwrap_err();
    assert_eq!(err.to_string(), s(e, "error"));
}

fn json_eq(rust: Value, ts: &Value, name: &str) {
    assert_eq!(&rust, ts, "{name}: Rust {rust} vs TS {ts}");
}

#[test]
fn parsers_accept_and_refuse_like_ts() {
    let v = vectors();
    let p = &v["parsers"];
    let run = |key: &str, f: &dyn Fn(&[u8]) -> Value| {
        for c in p[key].as_array().unwrap() {
            let name = format!("{key}/{}", s(c, "name"));
            json_eq(f(&unhex(s(c, "payloadHex"))), &c["result"], &name);
        }
    };
    run("helloAck", &|b| match payload::parse_hello_ack(b) {
        None => Value::Null,
        Some(a) => {
            let mut m = serde_json::Map::new();
            m.insert("ok".into(), a.ok.into());
            if let Some(r) = a.reason {
                m.insert("reason".into(), r.into());
            }
            if let Some(sb) = a.service_blessing {
                m.insert("serviceBlessing".into(), sb);
            }
            if let Some(h) = a.hub_sig {
                m.insert("hubSig".into(), h.into());
            }
            if let Some(c) = a.capabilities {
                m.insert("capabilities".into(), c.into());
            }
            Value::Object(m)
        }
    });
    run("outboundOpen", &|b| {
        payload::parse_outbound_open(b).map_or(
            Value::Null,
            |o| serde_json::json!({"host": o.host, "port": o.port}),
        )
    });
    run(
        "outboundResult",
        &|b| match payload::parse_outbound_result(b) {
            None => Value::Null,
            Some((true, _)) => serde_json::json!({"ok": true}),
            Some((false, r)) => serde_json::json!({"ok": false, "reason": r}),
        },
    );
    run("credit", &|b| {
        payload::parse_credit(b).map_or(Value::Null, Value::from)
    });
    run("mailboxAnnounce", &|b| {
        payload::decode_mailbox_announce(b).map_or(Value::Null, |l| {
            Value::Array(
                l.into_iter()
                    .map(|a| {
                        let epoch = if a.epoch < 9.0e15 { Value::from(a.epoch as u64) } else { Value::from(a.epoch) };
                        serde_json::json!({"pikPubHex": a.pik_pub_hex, "epoch": epoch, "sigHex": a.sig_hex})
                    })
                    .collect(),
            )
        })
    });
    let ok_or_threw = |r: bool| {
        if r {
            Value::Bool(true)
        } else {
            Value::Bool(false)
        }
    };
    for (key, f) in [
        (
            "pbPut",
            &(|b: &[u8]| payload::decode_pb_put(b).is_ok()) as &dyn Fn(&[u8]) -> bool,
        ),
        ("pbPutAck", &|b: &[u8]| {
            payload::decode_pb_put_ack(b).is_ok()
        }),
        ("pbGet", &|b: &[u8]| payload::decode_pb_get(b).is_ok()),
        ("pbGetEnd", &|b: &[u8]| {
            payload::decode_pb_get_end(b).is_ok()
        }),
        ("pbChallenge", &|b: &[u8]| {
            payload::decode_pb_challenge(b).is_ok()
        }),
        ("pbResponse", &|b: &[u8]| {
            payload::decode_pb_response(b).is_ok()
        }),
    ] {
        for c in p[key].as_array().unwrap() {
            let ts_ok = c["result"].get("threw").is_none();
            assert_eq!(
                ok_or_threw(f(&unhex(s(c, "payloadHex")))),
                Value::Bool(ts_ok),
                "{key}/{}",
                s(c, "name")
            );
        }
    }
    let put = payload::decode_pb_put(&unhex(s(&p["pbPut"][0], "payloadHex"))).unwrap();
    assert_eq!(
        put.shard_index,
        p["pbPut"][0]["result"]["shardIndex"].as_f64().unwrap()
    );
}

fn pattern(n: usize) -> Vec<u8> {
    (0..n).map(|i| ((i * 7 + 3) % 251) as u8).collect()
}

#[test]
fn mail_split_and_assembly_match_ts() {
    let v = vectors();
    for c in v["mail"]["splits"].as_array().unwrap() {
        let name = s(c, "name");
        let env = pattern(u(c, "envelopeLen") as usize);
        let id = u(c, "streamId") as u32;
        let (frames, kind) = if s(c, "kind") == "req" {
            (
                mail::mail_request_frames(id, s(c, "mailboxId"), &env).unwrap(),
                MailKind::Req,
            )
        } else {
            (
                mail::mail_response_frames(id, u(c, "status") as u16, &env),
                MailKind::Resp,
            )
        };
        let want = c["frames"].as_array().unwrap();
        assert_eq!(frames.len(), want.len(), "{name}");
        let mut asm = MailAssembler::new(kind);
        let mut body = None;
        for (f, w) in frames.iter().zip(want) {
            let b = frame::encode_frame(f).unwrap();
            assert_eq!(b.len() as u64, u(w, "len"), "{name}");
            assert_eq!(fnv1a64(&b), s(w, "fnv1a64"), "{name}");
            assert_eq!(hex(&b[..24.min(b.len())]), s(w, "headHex"), "{name}");
            body = asm.push(&f.payload).unwrap();
        }
        assert_eq!(body.as_deref(), Some(env.as_slice()), "{name}");
    }
    assert_eq!(
        mail::mail_request_frames(1, &"a".repeat(65), &[1])
            .unwrap_err()
            .to_string(),
        v["mail"]["idTooLong"].as_str().unwrap()
    );
    for c in v["mail"]["assembler"].as_array().unwrap() {
        let name = s(c, "name");
        let kind = if s(c, "kind") == "req" {
            MailKind::Req
        } else {
            MailKind::Resp
        };
        let mut asm = MailAssembler::new(kind);
        let payloads: Vec<Vec<u8>> = c["payloadsHex"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| unhex(p.as_str().unwrap()))
            .collect();
        for (p, step) in payloads.iter().zip(c["steps"].as_array().unwrap()) {
            match (asm.push(p), step) {
                (Err(e), st) => assert_eq!(e.0, s(st, "error"), "{name}"),
                (Ok(None), st) => assert_eq!(st["done"], Value::Bool(false), "{name}"),
                (Ok(Some(b)), st) => {
                    assert_eq!(hex(&b), s(st, "bodyHex"), "{name}");
                    assert_eq!(asm.mailbox_id, s(st, "mailboxId"), "{name}");
                    assert_eq!(u64::from(asm.status), u(st, "status"), "{name}");
                }
            }
        }
    }
}

#[test]
fn constants_match() {
    let v = vectors();
    let c = &v["constants"];
    assert_eq!(
        u(c, "FRAME_HEADER_BYTES") as usize,
        frame::FRAME_HEADER_BYTES
    );
    assert_eq!(u(c, "MAX_FRAME_PAYLOAD") as usize, frame::MAX_FRAME_PAYLOAD);
    assert_eq!(
        u(c, "OUTBOUND_STREAM_ID_BASE") as u32,
        payload::OUTBOUND_STREAM_ID_BASE
    );
    assert_eq!(
        u(c, "OUTBOUND_INITIAL_WINDOW") as u32,
        payload::OUTBOUND_INITIAL_WINDOW
    );
    assert_eq!(u(c, "MAIL_MAX_ENVELOPE") as usize, mail::MAIL_MAX_ENVELOPE);
}

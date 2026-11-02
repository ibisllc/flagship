//! The `mesh-v1` frame additions (ATTACHMENT 0x07, MOVE_HINT 0x08) against the TypeScript-produced `mesh` section of
//! `packages/tunnel-protocol/test-vectors/frames.json` (tools/tunnel-frame-vectors.mjs): a v1 decoder refuses them, a
//! mesh decoder accepts them, and the frames' bytes are identical.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use flagship_relay::frame::{self, Decoded, Frame, FrameDecoder, TypeSet};
use serde_json::Value;

fn mesh() -> Value {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/tunnel-protocol/test-vectors/frames.json"
    );
    let v: Value = serde_json::from_str(&std::fs::read_to_string(p).expect("vectors file"))
        .expect("vectors json");
    v["mesh"].clone()
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

const MESH: TypeSet = TypeSet {
    drain_notice: false,
    stream_credit: false,
    mesh: true,
};

#[test]
fn constants_match_ts() {
    let v = mesh();
    assert_eq!(v["capability"], frame::CAPABILITY_MESH_V1);
    assert_eq!(
        v["types"]["FRAME_ATTACHMENT"],
        u64::from(frame::FRAME_ATTACHMENT)
    );
    assert_eq!(
        v["types"]["FRAME_MOVE_HINT"],
        u64::from(frame::FRAME_MOVE_HINT)
    );
}

#[test]
fn mesh_frames_encode_byte_identically() {
    let v = mesh();
    for c in v["encoded"].as_array().unwrap() {
        let f = Frame::new(
            c["streamId"].as_u64().unwrap() as u32,
            c["type"].as_u64().unwrap() as u8,
            unhex(c["payloadHex"].as_str().unwrap()),
        );
        assert_eq!(
            hex(&frame::encode_frame(&f).unwrap()),
            c["hex"].as_str().unwrap(),
            "{}",
            c["name"]
        );
    }
}

fn check(types: TypeSet, cases: &Value) {
    for c in cases.as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let bytes = unhex(c["hex"].as_str().unwrap());
        let r = &c["result"];
        match (
            frame::decode_frame_with(&bytes, types),
            r["kind"].as_str().unwrap(),
        ) {
            (
                Decoded::Ok {
                    stream_id,
                    frame_type,
                    payload,
                    consumed,
                },
                "ok",
            ) => {
                assert_eq!(
                    u64::from(stream_id),
                    r["streamId"].as_u64().unwrap(),
                    "{name}"
                );
                assert_eq!(u64::from(frame_type), r["type"].as_u64().unwrap(), "{name}");
                assert_eq!(hex(payload), r["payloadHex"].as_str().unwrap(), "{name}");
                assert_eq!(consumed as u64, r["consumed"].as_u64().unwrap(), "{name}");
            }
            (Decoded::Incomplete { need_at_least }, "incomplete") => {
                assert_eq!(
                    need_at_least as u64,
                    r["needAtLeast"].as_u64().unwrap(),
                    "{name}"
                );
            }
            (Decoded::Error { reason }, "error") => {
                assert_eq!(reason, r["reason"].as_str().unwrap(), "{name}");
            }
            (got, want) => panic!("{name}: Rust {got:?}, TS {want}"),
        }
    }
}

#[test]
fn v1_decoder_refuses_mesh_frames_like_ts() {
    check(TypeSet::V1, &mesh()["decodeV1"]);
}

#[test]
fn mesh_decoder_accepts_them_like_ts() {
    check(MESH, &mesh()["decodeMesh"]);
}

#[test]
fn streaming_decoder_with_mesh_types() {
    let v = mesh();
    let mut stream = Vec::new();
    for c in v["encoded"].as_array().unwrap() {
        stream.extend(unhex(c["hex"].as_str().unwrap()));
    }
    let mut d = FrameDecoder::new(MESH, 64 * 1024);
    for part in stream.chunks(7) {
        d.push(part).unwrap();
        while d.next_frame().unwrap().is_some() {}
    }
    assert_eq!(d.buffered(), 0);
    let mut v1 = FrameDecoder::new(TypeSet::V1, 64 * 1024);
    v1.push(&stream).unwrap();
    assert!(
        v1.next_frame().is_err(),
        "a v1 decoder must refuse the first mesh frame"
    );
}

#[test]
fn hello_ack_mesh_fields_encode_and_parse_like_ts() {
    let v = mesh();
    let c = v["encoded"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "hello-ack mesh")
        .unwrap();
    let want = unhex(c["payloadHex"].as_str().unwrap());
    let p: Value = serde_json::from_slice(&want).unwrap();
    let trust = flagship_relay::payload::HelloAckTrust {
        service_blessing_json: Some(p["serviceBlessing"].to_string()),
        hub_sig: p["hubSig"].as_str().map(str::to_owned),
        relay_id: p["relayId"].as_str().map(str::to_owned),
        relay_blessing_json: Some(p["relayBlessing"].to_string()),
    };
    let f = flagship_relay::payload::hello_ack_frame(
        true,
        None,
        Some(&trust),
        &["drain-v1", "mesh-v1"],
    );
    assert_eq!(hex(&f.payload), hex(&want));
    for case in v["parsers"]["helloAck"].as_array().unwrap() {
        let got =
            flagship_relay::payload::parse_hello_ack(&unhex(case["payloadHex"].as_str().unwrap()))
                .unwrap();
        let r = &case["result"];
        assert_eq!(got.ok, r["ok"].as_bool().unwrap(), "{}", case["name"]);
        assert_eq!(
            got.relay_id.as_deref(),
            r["relayId"].as_str(),
            "{}",
            case["name"]
        );
        assert_eq!(
            got.relay_blessing.as_ref(),
            r.get("relayBlessing"),
            "{}",
            case["name"]
        );
    }
}

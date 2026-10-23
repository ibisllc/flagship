//! Frame decoding: the one-shot decoder, the streaming decoder at a data-chosen split, and
//! re-encoding of every frame it yields.
#![no_main]

use flagship_relay::frame::{self, Decoded, FrameDecoder, TypeSet};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Decoded::Ok {
        stream_id,
        frame_type,
        payload,
        consumed,
    } = frame::decode_frame(data)
    {
        let mut out = Vec::new();
        assert!(frame::encode_frame_into(stream_id, frame_type, payload, &mut out).is_ok());
        assert_eq!(out.as_slice(), data.get(..consumed).unwrap_or_default());
    }
    let split = usize::from(data.first().copied().unwrap_or(1)).max(1);
    let mut d = FrameDecoder::new(
        TypeSet {
            drain_notice: true,
            stream_credit: true,
        },
        4096,
    );
    for chunk in data.chunks(split) {
        if d.push(chunk).is_err() {
            return;
        }
        loop {
            match d.next_frame() {
                Ok(Some(f)) => assert!(f.payload.len() <= frame::MAX_FRAME_PAYLOAD),
                Ok(None) => break,
                Err(_) => return,
            }
        }
    }
});

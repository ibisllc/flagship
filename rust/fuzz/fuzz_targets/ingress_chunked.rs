#![no_main]
#![forbid(unsafe_code)]
//! The chunked decoder: arbitrary input never panics and never claims more bytes than it was
//! given; split feeding decodes the same as one feed; an encoded body decodes back to itself.
use flagship_ingress::http::{ChunkedDecoder, encode_chunk};
use libfuzzer_sys::fuzz_target;

fn decode(parts: &[&[u8]]) -> (Vec<u8>, bool, bool) {
    let mut d = ChunkedDecoder::new();
    let mut out = Vec::new();
    for p in parts {
        match d.push(p, &mut |b| out.extend_from_slice(b)) {
            Ok(n) => {
                assert!(n <= p.len(), "used more than given");
                if d.done() {
                    return (out, true, false);
                }
            }
            Err(_) => return (out, false, true),
        }
    }
    (out, d.done(), false)
}

fuzz_target!(|data: &[u8]| {
    let (whole, done, err) = decode(&[data]);
    let mid = data.len() / 2;
    let (a, b) = data.split_at(mid);
    let (split, done2, err2) = decode(&[a, b]);
    assert_eq!(
        (whole, done, err),
        (split, done2, err2),
        "split feeding changed the result"
    );

    if !data.is_empty() {
        let mut enc = encode_chunk(data);
        enc.extend_from_slice(b"0\r\n\r\n");
        let (back, done, err) = decode(&[&enc]);
        assert!(done && !err, "an encoded body decodes");
        assert_eq!(back, data, "encode/decode round trip");
    }
});

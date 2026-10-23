//! SNI extraction: the reassembling parser fed at data-chosen boundaries must agree with its
//! one-shot result, and with the `sni.ts` port whenever that port reaches a verdict it shares.
#![no_main]

use flagship_relay::sni::{
    ClientHelloReader, SniLimits, SniStatus, parse_client_hello, parse_client_hello_ts_compat,
};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let limits = SniLimits::default();
    let whole = parse_client_hello(data, limits);
    let step = usize::from(data.first().copied().unwrap_or(1)).max(1);
    let mut r = ClientHelloReader::new(limits);
    let mut last = SniStatus::NeedMore(5);
    for chunk in data.chunks(step) {
        last = r.push(chunk).clone();
        if !matches!(last, SniStatus::NeedMore(_)) {
            break;
        }
    }
    assert_eq!(last, whole);
    match parse_client_hello_ts_compat(data) {
        SniStatus::Reject(
            "handshake length exceeds record" | "record too small for handshake header",
        ) => {}
        ts => assert_eq!(whole, ts),
    }
});

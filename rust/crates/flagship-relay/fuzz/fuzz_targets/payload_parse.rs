//! Every payload parser (JSON and binary) on arbitrary bytes: no panic, no unbounded work.
#![no_main]

use flagship_relay::echo::parse_proxy_header;
use flagship_relay::hello::parse_hello;
use flagship_relay::mail::{MailAssembler, MailKind};
use flagship_relay::payload;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = parse_hello(data);
    let _ = payload::parse_hello_ack(data);
    let _ = payload::parse_outbound_open(data);
    let _ = payload::parse_outbound_result(data);
    let _ = payload::parse_credit(data);
    let _ = payload::decode_mailbox_announce(data);
    let _ = payload::decode_pb_put(data);
    let _ = payload::decode_pb_challenge(data);
    let _ = payload::parse_request_transfer(data);
    let _ = parse_proxy_header(data);
    let mut a = MailAssembler::new(MailKind::Req);
    for part in data.split(|b| *b == 0xff) {
        if a.push(part).is_err() {
            break;
        }
    }
});

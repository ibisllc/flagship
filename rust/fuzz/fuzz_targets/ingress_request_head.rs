#![no_main]
#![forbid(unsafe_code)]
//! The request head the proxy forwards: whatever the client sent, no identity header reaches the
//! app, and the serialised head ends exactly once (no header or line injection).
use flagship_ingress::http::{
    Injection, encode_request_head, find_head_end, forward_request_headers, is_identity_header,
    parse_request_head, request_body,
};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let block = match find_head_end(data) {
        Some(end) => data.get(..end).unwrap_or(data),
        None => data,
    };
    let Ok(head) = parse_request_head(block) else {
        return;
    };
    for (k, _) in &head.headers {
        assert_eq!(k, &k.to_ascii_lowercase(), "header names are lower case");
    }
    let _ = head.is_websocket_upgrade();
    let Ok(body) = request_body(&head) else {
        return;
    };
    let fwd = forward_request_headers(
        &head.headers,
        &Injection::default(),
        head.is_websocket_upgrade(),
        body,
    );
    for (k, v) in &fwd {
        assert!(
            !is_identity_header(k),
            "client identity header {k} forwarded"
        );
        assert!(
            !v.contains(['\r', '\n', '\0']),
            "line break in a forwarded value"
        );
    }
    let enc = encode_request_head(&head.method, &head.target, &fwd, "127.0.0.1:1");
    let end = find_head_end(&enc).expect("encoded head has an end");
    assert_eq!(end + 4, enc.len(), "encoded head ends exactly once");
});

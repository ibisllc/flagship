#![no_main]
#![forbid(unsafe_code)]
//! The app's response head: parsing and framing never panic, and a HEAD request never expects a body.
use flagship_ingress::http::{ResponseBody, parse_response_head, upgrade_response_head};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some(resp) = parse_response_head(data) else {
        return;
    };
    let _ = resp.body("GET");
    if let Some(b) = resp.body("HEAD") {
        assert_eq!(b, ResponseBody::None, "a HEAD answer has no body");
    }
    let _ = upgrade_response_head(&resp);
});

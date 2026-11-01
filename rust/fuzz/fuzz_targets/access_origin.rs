#![no_main]
#![forbid(unsafe_code)]
//! The sibling-app guard: origin normalisation is lower case and idempotent; safe methods are never
//! cross-origin; an Origin naming the routed host itself is never cross-origin.
//!
//! Every input that normalises must normalise to a fixed point (three crashes found on 2026-11-01, a control character,
//! a non-ASCII space and an unbracketed colon in the host, are fixed in `origin.rs` and kept in the corpus as regression seeds).
use std::collections::BTreeMap;

use flagship_access::origin::{is_cross_origin_unsafe, normalize_origin};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(s) = std::str::from_utf8(data) else {
        return;
    };
    if let Some(o) = normalize_origin(s) {
        assert_eq!(
            normalize_origin(&o).as_deref(),
            Some(o.as_str()),
            "not idempotent: {o:?}"
        );
        assert_eq!(o, o.to_ascii_lowercase());
        assert!(o.starts_with("https://") || o.starts_with("http://"));
    }
    let (a, b) = s.split_at(
        s.char_indices()
            .nth(s.chars().count() / 2)
            .map_or(s.len(), |(i, _)| i),
    );
    let mut h = BTreeMap::new();
    h.insert("origin".to_owned(), a.to_owned());
    h.insert("referer".to_owned(), b.to_owned());
    for m in ["GET", "HEAD", "OPTIONS", "get"] {
        assert!(
            !is_cross_origin_unsafe(m, false, &h, b),
            "a safe method lost its member"
        );
    }
    let _ = is_cross_origin_unsafe("POST", true, &h, b);
    if let Some(own) = normalize_origin(&format!("https://{}", b.trim()))
        .filter(|o| normalize_origin(o).as_deref() == Some(o.as_str()))
    {
        let mut same = BTreeMap::new();
        same.insert("origin".to_owned(), own.clone());
        assert!(
            !is_cross_origin_unsafe("POST", false, &same, b),
            "own origin {own:?} judged cross-origin"
        );
    }
});

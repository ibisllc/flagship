#![no_main]
#![forbid(unsafe_code)]
//! The public-route path normaliser: idempotent, its output never holds a dot segment, a
//! backslash or a control character, and a public route always matches itself.
use flagship_access::path::{matches_public_route, normalize_public_path, strip_query};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(s) = std::str::from_utf8(data) else {
        return;
    };
    let q = strip_query(s);
    assert!(!q.contains(['?', '#']));
    if let Some(n) = normalize_public_path(s) {
        assert!(n.starts_with('/'));
        assert!(!n.contains('\\'));
        assert!(!n.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}'));
        for seg in n.split('/') {
            let bare = seg.split(';').next().unwrap_or(seg);
            assert!(bare != "." && bare != "..", "dot segment survived: {n:?}");
        }
        if !n.contains('%') {
            assert_eq!(
                normalize_public_path(&n).as_deref(),
                Some(n.as_str()),
                "not idempotent"
            );
        }
        if !s.contains(['?', '#']) {
            assert!(
                matches_public_route(s, &[s.to_owned()]),
                "a route does not match itself"
            );
            assert!(
                matches_public_route(s, &["/*".to_owned()]),
                "/* does not cover a valid path"
            );
        }
    }
    if normalize_public_path(q).is_none() {
        assert!(
            !matches_public_route(s, &["/*".to_owned()]),
            "an unnormalisable path matched"
        );
    }
});

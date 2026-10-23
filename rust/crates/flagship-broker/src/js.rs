//! The few JavaScript string semantics the privd validators depend on, reproduced exactly so the
//! Rust broker refuses what the TS broker refuses.

/// `String.prototype.length`: UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `String.prototype.trim`: ECMAScript WhiteSpace and LineTerminator (not Rust's White_Space,
/// which adds U+0085 and lacks U+FEFF).
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{FEFF}'
            | '\u{000A}'
            | '\u{000D}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}'
    )
}

/// `s.split(sep)[n]`.
pub fn split_nth(s: &str, sep: char, n: usize) -> Option<&str> {
    s.split(sep).nth(n)
}

/// `s.slice(s.indexOf(sep) + 1)`: everything after the first `sep`, or all of `s` without one.
pub fn after_first(s: &str, sep: char) -> &str {
    match s.find(sep) {
        Some(i) => s
            .get(i.saturating_add(sep.len_utf8())..)
            .unwrap_or_default(),
        None => s,
    }
}

/// `s.slice(0, n)` over UTF-16 units, never splitting a character.
pub fn slice_units(s: &str, n: usize) -> &str {
    let mut units = 0usize;
    for (i, c) in s.char_indices() {
        units = units.saturating_add(c.len_utf16());
        if units > n {
            return s.get(..i).unwrap_or_default();
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_semantics() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(trim("\u{FEFF} x \u{3000}"), "x");
        assert_eq!(trim("\u{0085}x"), "\u{0085}x");
        assert_eq!(split_nth("--network=host=x", '=', 1), Some("host"));
        assert_eq!(after_first("--mount=a=b", '='), "a=b");
        assert_eq!(after_first("abc", '='), "abc");
        assert_eq!(slice_units("ab😀c", 3), "ab");
    }
}

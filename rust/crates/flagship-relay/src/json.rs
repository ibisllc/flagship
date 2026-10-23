//! The JSON corner of the frame payloads, matching what `JSON.stringify` writes and what
//! `JSON.parse(new TextDecoder().decode(bytes))` accepts.

use serde_json::{Map, Value};

/// Append `s` as a JSON string literal exactly as `JSON.stringify` writes it.
pub fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn str_lit(s: &str) -> String {
    let mut out = String::with_capacity(s.len().saturating_add(2));
    write_str(&mut out, s);
    out
}

/// Parse a payload the way the TS side does: `TextDecoder` (UTF-8, invalid sequences become
/// U+FFFD, one leading BOM dropped) followed by `JSON.parse`.
///
/// Known divergences, none reachable from a TS encoder: serde_json refuses lone-surrogate
/// escapes (`"\ud800"`) and nesting deeper than 128, both of which `JSON.parse` accepts.
pub fn parse(payload: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(payload);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    serde_json::from_str(text).ok()
}

/// `typeof v === "object" && v !== null && !Array.isArray(v)`.
pub fn as_object(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
}

/// A JS number as an f64, as `JSON.parse` would produce it.
pub fn number(v: &Value) -> Option<f64> {
    v.as_f64()
}

/// `Number.isInteger(n)`.
pub fn is_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}

/// String length in UTF-16 code units (`s.length` in JS).
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

pub fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_json_stringify() {
        assert_eq!(str_lit("a\"b\\c\n\u{1}é/"), "\"a\\\"b\\\\c\\n\\u0001é/\"");
    }

    #[test]
    fn bom_and_invalid_utf8_follow_text_decoder() {
        assert!(parse(b"\xef\xbb\xbf{\"ok\":true}").is_some());
        let v = parse(b"{\"reason\":\"\xff\"}");
        assert_eq!(
            v.as_ref()
                .and_then(|v| v.get("reason"))
                .and_then(Value::as_str),
            Some("\u{fffd}")
        );
    }
}

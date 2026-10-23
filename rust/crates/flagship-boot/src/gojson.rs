//! Decoding the `--response-json` input the way the Go helper's
//! `json.Unmarshal` into `sealedSecretResponseJSON` does: case-insensitive key
//! match, later duplicates win, `null` leaves a field alone, unknown keys are
//! ignored, a top-level `null` is accepted, type errors name the field, and
//! invalid UTF-8 or lone surrogates inside strings become U+FFFD instead of
//! failing. Syntax errors are refused like Go (the wording is serde_json's).

use serde::de::{self, Deserializer as _, IgnoredAny, MapAccess, Visitor};
use serde_json::value::RawValue;

/// The fields of `sealedSecretResponseJSON`. Strings are Go's UTF-8 bytes.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ResponseJson {
    /// `serverDomain` (read, unused, as in Go).
    pub server_domain: Vec<u8>,
    /// `requestNonceHex`: the expected nonce, as hex text.
    pub request_nonce_hex: Vec<u8>,
    /// `purpose`.
    pub purpose: Vec<u8>,
    /// `sealedHex`.
    pub sealed_hex: Vec<u8>,
    /// `issuedAt` (read, unused, as in Go).
    pub issued_at: i64,
}

#[derive(Clone, Copy)]
enum Field {
    ServerDomain,
    RequestNonceHex,
    Purpose,
    SealedHex,
    IssuedAt,
}

const FIELDS: [(&str, Field); 5] = [
    ("serverDomain", Field::ServerDomain),
    ("requestNonceHex", Field::RequestNonceHex),
    ("purpose", Field::Purpose),
    ("sealedHex", Field::SealedHex),
    ("issuedAt", Field::IssuedAt),
];

/// Go's `foldName`: ASCII upper-cased; the few non-ASCII runes whose
/// `ToUpper(ToLower(r))` is ASCII fold to it; anything else stays itself.
fn fold(s: &str) -> Vec<char> {
    s.chars()
        .map(|c| match c {
            'a'..='z' => c.to_ascii_uppercase(),
            '\u{130}' | '\u{131}' => 'I',
            '\u{17f}' => 'S',
            '\u{212a}' => 'K',
            _ => c,
        })
        .collect()
}

fn field_for(key: &str) -> Option<(&'static str, Field)> {
    if let Some(&f) = FIELDS.iter().find(|(n, _)| *n == key) {
        return Some(f);
    }
    let k = fold(key);
    FIELDS.iter().find(|(n, _)| fold(n) == k).copied()
}

struct Entries<'a>(Vec<(String, &'a RawValue)>);

impl<'de> de::Deserialize<'de> for Entries<'de> {
    fn deserialize<D: de::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Entries<'de>;
            fn expecting(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Self::Value, A::Error> {
                let mut out = Vec::new();
                while let Some(k) = m.next_key::<String>()? {
                    let v: &'de RawValue = m.next_value()?;
                    out.push((k, v));
                }
                Ok(Entries(out))
            }
        }
        d.deserialize_map(V)
    }
}

fn kind_of(raw: &str) -> &'static str {
    match raw.as_bytes().first() {
        Some(b'{') => "object",
        Some(b'[') => "array",
        Some(b'"') => "string",
        Some(b't' | b'f') => "bool",
        Some(b'n') => "null",
        _ => "number",
    }
}

fn syntax_error(e: &serde_json::Error) -> String {
    if e.classify() == serde_json::error::Category::Eof {
        "unexpected end of JSON input".into()
    } else {
        format!("invalid JSON: {e}")
    }
}

/// `json.Unmarshal(blob, &sealedSecretResponseJSON{})`.
pub fn unmarshal_response(input: &[u8]) -> Result<ResponseJson, String> {
    let text = sanitize_strings(input);
    let mut syntax = serde_json::Deserializer::from_slice(&text);
    syntax
        .deserialize_ignored_any(IgnoredAny)
        .map_err(|e| syntax_error(&e))?;
    syntax.end().map_err(|e| syntax_error(&e))?;

    let raw: &RawValue = serde_json::from_slice(&text).map_err(|e| syntax_error(&e))?;
    let mut out = ResponseJson::default();
    match kind_of(raw.get()) {
        "null" => return Ok(out),
        "object" => {}
        k => {
            return Err(format!(
                "json: cannot unmarshal {k} into Go value of type main.sealedSecretResponseJSON"
            ));
        }
    }
    let entries: Entries<'_> = serde_json::from_str(raw.get()).map_err(|e| syntax_error(&e))?;
    let mut first_err: Option<String> = None;
    for (key, value) in entries.0 {
        let Some((json_name, field)) = field_for(&key) else {
            continue;
        };
        let v = value.get();
        let kind = kind_of(v);
        let type_err = |value: &str, ty: &str| {
            format!(
                "json: cannot unmarshal {value} into Go struct field sealedSecretResponseJSON.{json_name} of type {ty}"
            )
        };
        if kind == "null" {
            continue;
        }
        match field {
            Field::IssuedAt => {
                if kind == "number" {
                    match v.parse::<i64>() {
                        Ok(n) => out.issued_at = n,
                        Err(_) => {
                            first_err
                                .get_or_insert_with(|| type_err(&format!("number {v}"), "int64"));
                        }
                    }
                } else {
                    first_err.get_or_insert_with(|| type_err(kind, "int64"));
                }
            }
            _ if kind != "string" => {
                first_err.get_or_insert_with(|| type_err(kind, "string"));
            }
            _ => {
                let s: String = serde_json::from_str(v).map_err(|e| syntax_error(&e))?;
                let slot = match field {
                    Field::ServerDomain => &mut out.server_domain,
                    Field::RequestNonceHex => &mut out.request_nonce_hex,
                    Field::Purpose => &mut out.purpose,
                    Field::SealedHex | Field::IssuedAt => &mut out.sealed_hex,
                };
                *slot = s.into_bytes();
            }
        }
    }
    match first_err {
        Some(e) => Err(e),
        None => Ok(out),
    }
}

fn hex4(s: &[u8]) -> Option<u32> {
    let t = core::str::from_utf8(s.get(..4)?).ok()?;
    if !t.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(t, 16).ok()
}

/// Inside JSON strings, replace each invalid UTF-8 byte with U+FFFD and each
/// unpaired surrogate escape with `�`, as Go's decoder does. Everything
/// outside strings is copied unchanged so syntax errors still surface.
fn sanitize_strings(s: &[u8]) -> Vec<u8> {
    const FFFD: &[u8] = "\u{fffd}".as_bytes();
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0usize;
    let mut in_str = false;
    while let Some(&b) = s.get(i) {
        if !in_str {
            out.push(b);
            in_str = b == b'"';
            i = i.saturating_add(1);
            continue;
        }
        match b {
            b'"' => {
                out.push(b);
                in_str = false;
                i = i.saturating_add(1);
            }
            b'\\' => {
                let rest = s.get(i.saturating_add(1)..).unwrap_or_default();
                if rest.first() == Some(&b'u')
                    && let Some(cp) = rest.get(1..).and_then(hex4)
                {
                    let paired = (0xd800..=0xdbff).contains(&cp)
                        && rest.get(5..7) == Some(b"\\u")
                        && rest
                            .get(7..)
                            .and_then(hex4)
                            .is_some_and(|lo| (0xdc00..=0xdfff).contains(&lo));
                    if paired {
                        out.extend_from_slice(s.get(i..i.saturating_add(12)).unwrap_or_default());
                        i = i.saturating_add(12);
                    } else if (0xd800..=0xdfff).contains(&cp) {
                        out.extend_from_slice(b"\\ufffd");
                        i = i.saturating_add(6);
                    } else {
                        out.extend_from_slice(s.get(i..i.saturating_add(6)).unwrap_or_default());
                        i = i.saturating_add(6);
                    }
                    continue;
                }
                let n = if rest.is_empty() { 1 } else { 2 };
                out.extend_from_slice(s.get(i..i.saturating_add(n)).unwrap_or_default());
                i = i.saturating_add(n);
            }
            0x00..=0x7f => {
                out.push(b);
                i = i.saturating_add(1);
            }
            _ => {
                let tail = s.get(i..).unwrap_or_default();
                let window = tail.get(..tail.len().min(4)).unwrap_or_default();
                let len = match core::str::from_utf8(window) {
                    Ok(t) => t.chars().next().map_or(0, char::len_utf8),
                    Err(e) if e.valid_up_to() > 0 => {
                        core::str::from_utf8(window.get(..e.valid_up_to()).unwrap_or_default())
                            .ok()
                            .and_then(|t| t.chars().next())
                            .map_or(0, char::len_utf8)
                    }
                    Err(_) => 0,
                };
                if len == 0 {
                    out.extend_from_slice(FFFD);
                    i = i.saturating_add(1);
                } else {
                    out.extend_from_slice(tail.get(..len).unwrap_or_default());
                    i = i.saturating_add(len);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn decodes_the_shell_shape() {
        let r = unmarshal_response(br#"{"serverDomain":"a.b","requestNonceHex":"00","purpose":"unlock-key","sealedHex":"ab","issuedAt":0}"#).unwrap();
        assert_eq!(r.sealed_hex, b"ab");
        assert_eq!(r.purpose, b"unlock-key");
    }

    #[test]
    fn follows_go_field_rules() {
        let r = unmarshal_response(br#"{"PURPOSE":"x","purpose":null,"sealedhex":"1","\u017fealedHex":"2","other":[1e400,{"a":1}]}"#).unwrap();
        assert_eq!(r.purpose, b"x");
        assert_eq!(r.sealed_hex, b"2");
        assert_eq!(
            unmarshal_response(b"null").unwrap(),
            ResponseJson::default()
        );
        assert_eq!(
            unmarshal_response(b"[]").unwrap_err(),
            "json: cannot unmarshal array into Go value of type main.sealedSecretResponseJSON"
        );
        assert_eq!(
            unmarshal_response(br#"{"issuedAt":1.5,"purpose":3}"#).unwrap_err(),
            "json: cannot unmarshal number 1.5 into Go struct field sealedSecretResponseJSON.issuedAt of type int64"
        );
        assert_eq!(
            unmarshal_response(br#"{"purpose":true}"#).unwrap_err(),
            "json: cannot unmarshal bool into Go struct field sealedSecretResponseJSON.purpose of type string"
        );
        assert_eq!(
            unmarshal_response(b"{").unwrap_err(),
            "unexpected end of JSON input"
        );
        assert!(unmarshal_response(b"{} x").is_err());
    }

    #[test]
    fn replaces_bad_text_inside_strings() {
        let r = unmarshal_response(b"{\"purpose\":\"a\xffb\",\"serverDomain\":\"\\ud800\\u0041\"}")
            .unwrap();
        assert_eq!(r.purpose, "a\u{fffd}b".as_bytes());
        assert_eq!(r.server_domain, "\u{fffd}A".as_bytes());
        let r = unmarshal_response(br#"{"purpose":"\ud83d\ude00"}"#).unwrap();
        assert_eq!(r.purpose, "\u{1f600}".as_bytes());
    }
}

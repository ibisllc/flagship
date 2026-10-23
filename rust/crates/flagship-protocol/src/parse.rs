//! Bounded, strict parsing helpers shared by every crate that reads
//! Flagship wire data. Each helper checks sizes before it allocates.

use crate::error::ProtocolError;

/// Largest integer every port can carry exactly (JavaScript `Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// Longest purpose tag accepted anywhere.
pub const MAX_PURPOSE_LEN: usize = 128;

const MAX_PURPOSE_SEGMENTS: usize = 6;
const MAX_SEGMENT_LEN: usize = 48;
const MAX_VERSION_DIGITS: usize = 4;

/// Decodes lowercase hex whose decoded length lies in `min_len..=max_len` bytes.
/// Uppercase, odd length, whitespace and any other character are refused.
///
/// # Errors
/// [`ProtocolError::HexLength`] when the length is out of bounds or odd,
/// [`ProtocolError::BadHex`] on a non-lowercase-hex character.
pub fn parse_lower_hex(s: &str, min_len: usize, max_len: usize) -> Result<Vec<u8>, ProtocolError> {
    let bytes = s.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err(ProtocolError::HexLength);
    }
    let n = bytes.len() / 2;
    if n < min_len || n > max_len {
        return Err(ProtocolError::HexLength);
    }
    let mut out = Vec::with_capacity(n);
    let (pairs, _) = bytes.as_chunks::<2>();
    for [hi, lo] in pairs {
        out.push((nibble(*hi)? << 4) | nibble(*lo)?);
    }
    Ok(out)
}

/// Decodes exactly `N` bytes of lowercase hex.
///
/// # Errors
/// As [`parse_lower_hex`].
pub fn parse_lower_hex_array<const N: usize>(s: &str) -> Result<[u8; N], ProtocolError> {
    let v = parse_lower_hex(s, N, N)?;
    <[u8; N]>::try_from(v.as_slice()).map_err(|_| ProtocolError::HexLength)
}

/// Lowercase hex, byte-identical to the TypeScript `hex()` helper.
#[must_use]
pub fn encode_lower_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len().saturating_mul(2));
    for b in bytes {
        for d in [b >> 4, b & 0x0f] {
            if let Some(c) = DIGITS.get(usize::from(d)) {
                s.push(char::from(*c));
            }
        }
    }
    s
}

fn nibble(c: u8) -> Result<u8, ProtocolError> {
    match c {
        b'0'..=b'9' => Ok(c.wrapping_sub(b'0')),
        b'a'..=b'f' => Ok(c.wrapping_sub(b'a').wrapping_add(10)),
        _ => Err(ProtocolError::BadHex),
    }
}

/// Parses a canonical unsigned decimal: `0` or a non-zero digit followed by
/// digits, no sign, no leading zero, at most `max`.
///
/// # Errors
/// [`ProtocolError::BadDecimal`] on a non-canonical form,
/// [`ProtocolError::IntegerRange`] above `max`.
pub fn parse_decimal_u64(s: &str, max: u64) -> Result<u64, ProtocolError> {
    let bytes = s.as_bytes();
    match bytes {
        [] => return Err(ProtocolError::BadDecimal),
        [b'0'] => return Ok(0),
        [b'0', ..] => return Err(ProtocolError::BadDecimal),
        _ => {}
    }
    if bytes.len() > 20 {
        return Err(ProtocolError::IntegerRange);
    }
    let mut v: u64 = 0;
    for c in bytes {
        if !c.is_ascii_digit() {
            return Err(ProtocolError::BadDecimal);
        }
        v = v
            .checked_mul(10)
            .and_then(|x| x.checked_add(u64::from(c.wrapping_sub(b'0'))))
            .ok_or(ProtocolError::IntegerRange)?;
    }
    if v > max {
        return Err(ProtocolError::IntegerRange);
    }
    Ok(v)
}

/// Splits a v1 canonical string on `|` into exactly `count` fields.
///
/// # Errors
/// [`ProtocolError::FieldCount`] when there are more or fewer fields.
pub fn split_fields_exact(s: &str, count: usize) -> Result<Vec<&str>, ProtocolError> {
    if count == 0 {
        return Err(ProtocolError::FieldCount);
    }
    let fields: Vec<&str> = s.splitn(count.saturating_add(1), '|').collect();
    if fields.len() != count {
        return Err(ProtocolError::FieldCount);
    }
    Ok(fields)
}

/// The v1 text-field guard: no `|` and no control character (0x00-0x1F, 0x7F).
///
/// # Errors
/// [`ProtocolError::FieldSeparator`] or [`ProtocolError::FieldControlChar`].
pub fn check_field_text(value: &str) -> Result<(), ProtocolError> {
    for c in value.chars() {
        if c == '|' {
            return Err(ProtocolError::FieldSeparator);
        }
        if c <= '\u{1f}' || c == '\u{7f}' {
            return Err(ProtocolError::FieldControlChar);
        }
    }
    Ok(())
}

/// Which namespaces a purpose tag may start with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TagNamespace {
    /// `flagship/...` only (every new tag, and every v2 envelope).
    Flagship,
    /// `flagship/...` or the legacy peer-backup `pb/...` tags.
    FlagshipOrLegacyPb,
}

/// Validates a purpose tag: `<namespace>/<segment>(/<segment>)*/v<N>`, where a
/// segment is `[a-z0-9][a-z0-9-]*` (at most 48 bytes), there are 1 to 6
/// segments, `N` is 1 to 9999 without a leading zero, and the whole tag is at
/// most 128 bytes.
///
/// # Errors
/// [`ProtocolError::BadPurpose`].
pub fn validate_purpose_tag(tag: &str, ns: TagNamespace) -> Result<(), ProtocolError> {
    if tag.is_empty() || tag.len() > MAX_PURPOSE_LEN {
        return Err(ProtocolError::BadPurpose);
    }
    let parts: Vec<&str> = tag.split('/').collect();
    let (Some(first), Some(last)) = (parts.first(), parts.last()) else {
        return Err(ProtocolError::BadPurpose);
    };
    let ns_ok = match ns {
        TagNamespace::Flagship => *first == "flagship",
        TagNamespace::FlagshipOrLegacyPb => *first == "flagship" || *first == "pb",
    };
    if !ns_ok {
        return Err(ProtocolError::BadPurpose);
    }
    let segments = parts
        .len()
        .checked_sub(2)
        .ok_or(ProtocolError::BadPurpose)?;
    if segments == 0 || segments > MAX_PURPOSE_SEGMENTS {
        return Err(ProtocolError::BadPurpose);
    }
    for seg in parts.iter().skip(1).take(segments) {
        if !valid_segment(seg) {
            return Err(ProtocolError::BadPurpose);
        }
    }
    let digits = last.strip_prefix('v').ok_or(ProtocolError::BadPurpose)?;
    let db = digits.as_bytes();
    let first_digit_ok = matches!(db.first(), Some(b'1'..=b'9'));
    if !first_digit_ok || db.len() > MAX_VERSION_DIGITS || !db.iter().all(u8::is_ascii_digit) {
        return Err(ProtocolError::BadPurpose);
    }
    Ok(())
}

fn valid_segment(seg: &str) -> bool {
    let b = seg.as_bytes();
    if b.is_empty() || b.len() > MAX_SEGMENT_LEN {
        return false;
    }
    let lead_ok = matches!(b.first(), Some(b'a'..=b'z' | b'0'..=b'9'));
    lead_ok
        && b.iter()
            .all(|c| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

/// Extracts and validates the purpose tag (first `|` field) of a v1 canonical string.
///
/// # Errors
/// [`ProtocolError::BadPurpose`].
pub fn purpose_tag_of(canonical: &str) -> Result<&str, ProtocolError> {
    let tag = canonical
        .split('|')
        .next()
        .ok_or(ProtocolError::BadPurpose)?;
    validate_purpose_tag(tag, TagNamespace::FlagshipOrLegacyPb)?;
    Ok(tag)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn hex_is_strict_and_bounded() {
        assert_eq!(parse_lower_hex("00ff", 2, 2).unwrap(), vec![0, 255]);
        assert_eq!(parse_lower_hex("", 0, 4).unwrap(), Vec::<u8>::new());
        assert_eq!(parse_lower_hex("00FF", 2, 2), Err(ProtocolError::BadHex));
        assert_eq!(parse_lower_hex("0g", 1, 1), Err(ProtocolError::BadHex));
        assert_eq!(parse_lower_hex("abc", 0, 4), Err(ProtocolError::HexLength));
        assert_eq!(parse_lower_hex("aabb", 1, 1), Err(ProtocolError::HexLength));
        assert_eq!(parse_lower_hex("aa", 2, 4), Err(ProtocolError::HexLength));
        assert_eq!(parse_lower_hex(" aa", 0, 4), Err(ProtocolError::HexLength));
        assert_eq!(parse_lower_hex("+a", 1, 1), Err(ProtocolError::BadHex));
        assert_eq!(parse_lower_hex_array::<2>("0102").unwrap(), [1, 2]);
        assert_eq!(encode_lower_hex(&[0, 0xab, 0x0f]), "00ab0f");
    }

    #[test]
    fn decimals_are_canonical() {
        assert_eq!(parse_decimal_u64("0", 10), Ok(0));
        assert_eq!(
            parse_decimal_u64("1735689600000", MAX_SAFE_INTEGER),
            Ok(1_735_689_600_000)
        );
        assert_eq!(
            parse_decimal_u64("9007199254740991", MAX_SAFE_INTEGER),
            Ok(MAX_SAFE_INTEGER)
        );
        assert_eq!(
            parse_decimal_u64("9007199254740992", MAX_SAFE_INTEGER),
            Err(ProtocolError::IntegerRange)
        );
        assert_eq!(
            parse_decimal_u64("99999999999999999999999", u64::MAX),
            Err(ProtocolError::IntegerRange)
        );
        for bad in ["", "01", "-1", "+1", "1.0", "1e3", " 1"] {
            assert!(parse_decimal_u64(bad, u64::MAX).is_err(), "{bad}");
        }
    }

    #[test]
    fn split_counts_exactly() {
        assert_eq!(split_fields_exact("a|b|c", 3).unwrap(), vec!["a", "b", "c"]);
        assert_eq!(split_fields_exact("a||", 3).unwrap(), vec!["a", "", ""]);
        assert_eq!(split_fields_exact("a|b", 3), Err(ProtocolError::FieldCount));
        assert_eq!(
            split_fields_exact("a|b|c|d", 3),
            Err(ProtocolError::FieldCount)
        );
        assert_eq!(split_fields_exact("a", 0), Err(ProtocolError::FieldCount));
    }

    #[test]
    fn purpose_tags() {
        let ok = TagNamespace::Flagship;
        assert!(validate_purpose_tag("flagship/hybrid-sig/ed25519-mldsa65/v1", ok).is_ok());
        assert!(validate_purpose_tag("flagship/order/set-front-page/v1", ok).is_ok());
        assert!(validate_purpose_tag("pb/announce/v1", ok).is_err());
        assert!(validate_purpose_tag("pb/announce/v1", TagNamespace::FlagshipOrLegacyPb).is_ok());
        for bad in [
            "",
            "flagship/v1",
            "flagship/x/v0",
            "flagship/x/v01",
            "flagship/x/v12345",
            "flagship/X/v1",
            "flagship/-x/v1",
            "flagship//v1",
            "flagship/x_y/v1",
            "flagship/x/1",
            "flagship/x/v1/",
            "other/x/v1",
            "flagship/a/b/c/d/e/f/g/v1",
        ] {
            assert_eq!(
                validate_purpose_tag(bad, ok),
                Err(ProtocolError::BadPurpose),
                "{bad}"
            );
        }
        let long = format!("flagship/{}/v1", "a".repeat(120));
        assert!(validate_purpose_tag(&long, ok).is_err());
        assert_eq!(
            purpose_tag_of("flagship/revoke/v1|harry|x").unwrap(),
            "flagship/revoke/v1"
        );
        assert!(purpose_tag_of("nope|x").is_err());
    }

    #[test]
    fn field_guard() {
        assert!(check_field_text("home.harry.flagship.services").is_ok());
        assert!(check_field_text("").is_ok());
        assert_eq!(check_field_text("a|b"), Err(ProtocolError::FieldSeparator));
        assert_eq!(
            check_field_text("a\nb"),
            Err(ProtocolError::FieldControlChar)
        );
        assert_eq!(
            check_field_text("a\u{7f}"),
            Err(ProtocolError::FieldControlChar)
        );
    }
}

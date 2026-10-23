//! Hex and whitespace handling with Go's `encoding/hex` and `strings.TrimSpace`
//! semantics, so the compatibility CLI accepts and refuses exactly what the Go
//! helper does and reports the same error text.

use core::fmt;

/// Go's `encoding/hex` errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HexError {
    /// `hex.InvalidByteError`: the first byte that is not a hex digit.
    InvalidByte(u8),
    /// `hex.ErrLength`: an odd number of hex digits.
    OddLength,
}

impl fmt::Display for HexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidByte(b) => write!(f, "encoding/hex: invalid byte: {}", go_sharp_u(*b)),
            Self::OddLength => f.write_str("encoding/hex: odd length hex string"),
        }
    }
}

impl std::error::Error for HexError {}

/// Go's `%#U` for `rune(b)`: `U+0041 'A'`, or just `U+0000` when unprintable.
fn go_sharp_u(b: u8) -> String {
    let printable = matches!(b, 0x20..=0x7e) || (b >= 0xa1 && b != 0xad);
    if printable {
        format!("U+{:04X} '{}'", b, char::from(b))
    } else {
        format!("U+{b:04X}")
    }
}

fn nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => b.checked_sub(b'0'),
        b'a'..=b'f' => b.checked_sub(b'a' - 10),
        b'A'..=b'F' => b.checked_sub(b'A' - 10),
        _ => None,
    }
}

/// `hex.DecodeString`: pairs are decoded left to right; an invalid byte is
/// reported before an odd length, as Go does.
pub fn decode(src: &[u8]) -> Result<Vec<u8>, HexError> {
    let mut out = Vec::with_capacity(src.len() / 2);
    let (pairs, remainder) = src.as_chunks::<2>();
    for &[p, q] in pairs {
        let hi = nibble(p).ok_or(HexError::InvalidByte(p))?;
        let lo = nibble(q).ok_or(HexError::InvalidByte(q))?;
        out.push(hi.wrapping_shl(4) | lo);
    }
    if let [last] = remainder {
        if nibble(*last).is_none() {
            return Err(HexError::InvalidByte(*last));
        }
        return Err(HexError::OddLength);
    }
    Ok(out)
}

/// Lowercase hex, as Go's `hex.EncodeToString`.
pub fn encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len().saturating_mul(2));
    for &b in bytes {
        for n in [b.wrapping_shr(4), b & 0x0f] {
            if let Some(&d) = DIGITS.get(usize::from(n)) {
                s.push(char::from(d));
            }
        }
    }
    s
}

/// Go's `unicode.IsSpace` on an ASCII byte.
fn ascii_space(b: u8) -> bool {
    matches!(b, b'\t' | b'\n' | 0x0b | 0x0c | b'\r' | b' ')
}

/// `strings.TrimSpace` on raw bytes. Invalid UTF-8 counts as non-space (Go
/// decodes it as `RuneError`), so trimming stops there.
pub fn trim_space(s: &[u8]) -> &[u8] {
    let mut spans: Vec<(usize, usize, bool)> = Vec::new();
    let mut at = 0usize;
    for chunk in s.utf8_chunks() {
        for (i, c) in chunk.valid().char_indices() {
            let start = at.saturating_add(i);
            let space = if c.is_ascii() {
                ascii_space(c as u8)
            } else {
                c.is_whitespace()
            };
            spans.push((start, start.saturating_add(c.len_utf8()), space));
        }
        at = at.saturating_add(chunk.valid().len());
        for _ in chunk.invalid() {
            spans.push((at, at.saturating_add(1), false));
            at = at.saturating_add(1);
        }
    }
    let first = spans.iter().find(|(_, _, sp)| !sp);
    let last = spans.iter().rev().find(|(_, _, sp)| !sp);
    match (first, last) {
        (Some(&(a, _, _)), Some(&(_, b, _))) => s.get(a..b).unwrap_or_default(),
        _ => s.get(s.len()..).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn decodes_like_go() {
        assert_eq!(decode(b"00ffAa").unwrap(), vec![0, 0xff, 0xaa]);
        assert_eq!(decode(b"").unwrap(), Vec::<u8>::new());
        assert_eq!(decode(b"abc"), Err(HexError::OddLength));
        assert_eq!(decode(b"abz"), Err(HexError::InvalidByte(b'z')));
        assert_eq!(decode(b"zz"), Err(HexError::InvalidByte(b'z')));
        assert_eq!(decode(b"a z1"), Err(HexError::InvalidByte(b' ')));
        assert_eq!(
            HexError::InvalidByte(b'z').to_string(),
            "encoding/hex: invalid byte: U+007A 'z'"
        );
        assert_eq!(
            HexError::InvalidByte(0).to_string(),
            "encoding/hex: invalid byte: U+0000"
        );
        assert_eq!(
            HexError::InvalidByte(0xc3).to_string(),
            "encoding/hex: invalid byte: U+00C3 '\u{c3}'"
        );
    }

    #[test]
    fn trims_like_go() {
        assert_eq!(trim_space(b"  ab \n"), b"ab");
        assert_eq!(trim_space(b" \t "), b"");
        assert_eq!(trim_space("\u{a0}ab\u{2003}".as_bytes()), b"ab");
        assert_eq!(trim_space(b"\xffab "), b"\xffab");
        assert_eq!(encode(&[0, 0xab, 0x10]), "00ab10");
    }
}

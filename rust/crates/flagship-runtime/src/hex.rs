//! Lowercase hex, kept here so the crate needs no extra dependency for it.

const DIGITS: &[u8; 16] = b"0123456789abcdef";

pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().saturating_mul(2));
    for b in bytes {
        for n in [b >> 4, b & 0x0f] {
            out.push(char::from(
                DIGITS.get(usize::from(n)).copied().unwrap_or(b'0'),
            ));
        }
    }
    out
}

/// Decodes lowercase hex only; uppercase is refused so one value has one spelling.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    let raw = text.as_bytes();
    if !raw.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(raw.len() / 2);
    for [hi, lo] in raw.as_chunks::<2>().0 {
        out.push((nibble(*hi)? << 4) | nibble(*lo)?);
    }
    Some(out)
}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => c.checked_sub(b'0'),
        b'a'..=b'f' => c.checked_sub(b'a').and_then(|v| v.checked_add(10)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trips_and_refuses_uppercase() {
        assert_eq!(super::encode(&[0, 0xab, 0xff]), "00abff");
        assert_eq!(super::decode("00abff"), Some(vec![0, 0xab, 0xff]));
        assert_eq!(super::decode("00ABFF"), None);
        assert_eq!(super::decode("0"), None);
    }
}

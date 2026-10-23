//! The few DER encodings a certificate request needs, byte-identical to `der.ts`.

pub fn len(n: usize) -> Vec<u8> {
    if n < 0x80 {
        return vec![u8::try_from(n).unwrap_or(0)];
    }
    let bytes: Vec<u8> = n
        .to_be_bytes()
        .into_iter()
        .skip_while(|b| *b == 0)
        .collect();
    let mut out = vec![0x80 | u8::try_from(bytes.len()).unwrap_or(0)];
    out.extend(bytes);
    out
}

pub fn tlv(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend(len(body.len()));
    out.extend_from_slice(body);
    out
}

pub fn seq(parts: &[&[u8]]) -> Vec<u8> {
    tlv(0x30, &parts.concat())
}

pub fn set(parts: &[&[u8]]) -> Vec<u8> {
    tlv(0x31, &parts.concat())
}

pub fn octets(b: &[u8]) -> Vec<u8> {
    tlv(0x04, b)
}

pub fn utf8(s: &str) -> Vec<u8> {
    tlv(0x0c, s.as_bytes())
}

pub fn int0() -> Vec<u8> {
    tlv(0x02, &[0])
}

pub fn bit_string(b: &[u8]) -> Vec<u8> {
    tlv(0x03, &[&[0u8][..], b].concat())
}

/// A dotted OID. Only called with constants; a malformed one encodes as an empty OID.
pub fn oid(dotted: &str) -> Vec<u8> {
    let parts: Option<Vec<u64>> = dotted.split('.').map(|p| p.parse().ok()).collect();
    let parts = parts.unwrap_or_default();
    let (Some(a), Some(b)) = (parts.first(), parts.get(1)) else {
        return tlv(0x06, &[]);
    };
    let mut out = vec![u8::try_from(a.saturating_mul(40).saturating_add(*b)).unwrap_or(0)];
    for p in parts.iter().skip(2) {
        let mut stack = vec![u8::try_from(p & 0x7f).unwrap_or(0)];
        let mut v = p >> 7;
        while v > 0 {
            stack.insert(0, u8::try_from(v & 0x7f).unwrap_or(0) | 0x80);
            v >>= 7;
        }
        out.extend(stack);
    }
    tlv(0x06, &out)
}

pub const OID_EC_PUBLIC_KEY: &str = "1.2.840.10045.2.1";
pub const OID_P256: &str = "1.2.840.10045.3.1.7";

/// SubjectPublicKeyInfo for an uncompressed P-256 point.
pub fn p256_spki(uncompressed: &[u8]) -> Vec<u8> {
    seq(&[
        &seq(&[&oid(OID_EC_PUBLIC_KEY), &oid(OID_P256)]),
        &bit_string(uncompressed),
    ])
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn encodes_like_the_ts_helpers() {
        assert_eq!(
            oid("1.2.840.10045.2.1"),
            vec![0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]
        );
        assert_eq!(len(0x7f), vec![0x7f]);
        assert_eq!(len(0x80), vec![0x81, 0x80]);
        assert_eq!(len(0x1234), vec![0x82, 0x12, 0x34]);
        assert_eq!(int0(), vec![2, 1, 0]);
        assert_eq!(bit_string(&[5]), vec![3, 2, 0, 5]);
    }
}

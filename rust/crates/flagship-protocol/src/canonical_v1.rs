//! v1 canonical bytes: `tag|field|field|...` as the TypeScript
//! `[...].join("|")` encoders produce them. The builder accepts a strict
//! subset of what the TypeScript encoders accept: every text field passes the
//! separator/control guard and every number must render identically in
//! JavaScript and Rust, so a value that could canonicalize ambiguously is
//! refused here instead of being signed.

use crate::error::ProtocolError;
use crate::parse::{
    MAX_SAFE_INTEGER, TagNamespace, check_field_text, encode_lower_hex, validate_purpose_tag,
};

/// Builds one v1 canonical message.
#[derive(Clone, Debug)]
pub struct CanonicalV1 {
    buf: String,
}

impl CanonicalV1 {
    /// Starts a message with its purpose tag (`flagship/...` or legacy `pb/...`).
    ///
    /// # Errors
    /// [`ProtocolError::BadPurpose`].
    pub fn new(tag: &str) -> Result<Self, ProtocolError> {
        validate_purpose_tag(tag, TagNamespace::FlagshipOrLegacyPb)?;
        Ok(Self {
            buf: String::from(tag),
        })
    }

    fn push(&mut self, s: &str) {
        self.buf.push('|');
        self.buf.push_str(s);
    }

    /// A text field (may be empty, as the TypeScript encoders render `null`).
    ///
    /// # Errors
    /// [`ProtocolError::FieldSeparator`] or [`ProtocolError::FieldControlChar`].
    pub fn text(mut self, value: &str) -> Result<Self, ProtocolError> {
        check_field_text(value)?;
        self.push(value);
        Ok(self)
    }

    /// An unsigned integer up to `Number.MAX_SAFE_INTEGER`.
    ///
    /// # Errors
    /// [`ProtocolError::IntegerRange`].
    pub fn uint(mut self, value: u64) -> Result<Self, ProtocolError> {
        if value > MAX_SAFE_INTEGER {
            return Err(ProtocolError::IntegerRange);
        }
        self.push(&value.to_string());
        Ok(self)
    }

    /// A signed integer within `±Number.MAX_SAFE_INTEGER` (e.g. the `-1` "unset" marker).
    ///
    /// # Errors
    /// [`ProtocolError::IntegerRange`].
    pub fn int(mut self, value: i64) -> Result<Self, ProtocolError> {
        if value.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(ProtocolError::IntegerRange);
        }
        self.push(&value.to_string());
        Ok(self)
    }

    /// Bytes as lowercase hex.
    #[must_use]
    pub fn hex(mut self, bytes: &[u8]) -> Self {
        self.push(&encode_lower_hex(bytes));
        self
    }

    /// A boolean rendered as `1` / `0`.
    #[must_use]
    pub fn flag01(mut self, value: bool) -> Self {
        self.push(if value { "1" } else { "0" });
        self
    }

    /// A JavaScript `Number` as `String(n)` renders it. Only values whose
    /// rendering is identical in both languages are accepted: integers up to
    /// `MAX_SAFE_INTEGER`, and non-integers with magnitude at least 1e-6
    /// (below that JavaScript switches to exponent notation).
    ///
    /// # Errors
    /// [`ProtocolError::BadNumber`].
    pub fn js_number(mut self, value: f64) -> Result<Self, ProtocolError> {
        let s = js_number_string(value)?;
        self.push(&s);
        Ok(self)
    }

    /// A comma-joined list; with `sort`, items are ordered by UTF-16 code
    /// unit, as JavaScript's default `Array.prototype.sort` orders strings.
    /// Items may not be empty and may not contain `,`.
    ///
    /// # Errors
    /// [`ProtocolError::ListItem`] or the text-field errors.
    pub fn list(mut self, items: &[&str], sort: bool) -> Result<Self, ProtocolError> {
        for item in items {
            if item.is_empty() || item.contains(',') {
                return Err(ProtocolError::ListItem);
            }
            check_field_text(item)?;
        }
        let mut v: Vec<&str> = items.to_vec();
        if sort {
            v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        }
        self.push(&v.join(","));
        Ok(self)
    }

    /// The canonical string.
    #[must_use]
    pub fn finish_string(self) -> String {
        self.buf
    }

    /// The canonical UTF-8 bytes.
    #[must_use]
    pub fn finish(self) -> Vec<u8> {
        self.buf.into_bytes()
    }
}

fn js_number_string(value: f64) -> Result<String, ProtocolError> {
    if !value.is_finite() {
        return Err(ProtocolError::BadNumber);
    }
    if value.fract() == 0.0 {
        let magnitude = value.abs();
        #[allow(clippy::cast_precision_loss)]
        let limit = MAX_SAFE_INTEGER as f64;
        if magnitude > limit {
            return Err(ProtocolError::BadNumber);
        }
        #[allow(clippy::cast_possible_truncation)]
        let as_int = value as i64;
        return Ok(as_int.to_string());
    }
    if value.abs() < 1e-6 {
        return Err(ProtocolError::BadNumber);
    }
    Ok(format!("{value}"))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn js_numbers_match_javascript() {
        // Right-hand sides are `String(n)` from Node 24.
        let cases: &[(f64, &str)] = &[
            (0.5, "0.5"),
            (0.1, "0.1"),
            (1.0 / 3.0, "0.3333333333333333"),
            (0.000_001, "0.000001"),
            (123.456, "123.456"),
            (-0.25, "-0.25"),
            (-0.0, "0"),
            (0.0, "0"),
            (1e15 + 0.5, "1000000000000000.5"),
            (9_007_199_254_740_991.0, "9007199254740991"),
            (104_857_600.0, "104857600"),
            (2.0f64.powi(-20), "9.5367431640625e-7"),
        ];
        for (v, want) in cases {
            let got = js_number_string(*v);
            if want.contains('e') {
                assert_eq!(got, Err(ProtocolError::BadNumber), "{v}");
            } else {
                assert_eq!(got.as_deref(), Ok(*want), "{v}");
            }
        }
        assert!(js_number_string(f64::NAN).is_err());
        assert!(js_number_string(f64::INFINITY).is_err());
        assert!(js_number_string(9_007_199_254_740_992.0).is_err());
    }

    #[test]
    fn builder_guards_fields() {
        let ok = CanonicalV1::new("flagship/revoke/v1")
            .and_then(|c| c.text("harry"))
            .and_then(|c| c.uint(5))
            .unwrap()
            .finish_string();
        assert_eq!(ok, "flagship/revoke/v1|harry|5");
        assert!(
            CanonicalV1::new("flagship/x/v1")
                .unwrap()
                .text("a|b")
                .is_err()
        );
        assert!(
            CanonicalV1::new("flagship/x/v1")
                .unwrap()
                .uint(1 << 53)
                .is_err()
        );
        assert!(
            CanonicalV1::new("flagship/x/v1")
                .unwrap()
                .list(&["a,b"], false)
                .is_err()
        );
        assert!(
            CanonicalV1::new("flagship/x/v1")
                .unwrap()
                .list(&[""], false)
                .is_err()
        );
        assert!(CanonicalV1::new("bad").is_err());
        let sorted = CanonicalV1::new("flagship/x/v1")
            .unwrap()
            .list(&["b", "a", "B"], true)
            .unwrap()
            .finish_string();
        assert_eq!(sorted, "flagship/x/v1|B,a,b");
        let neg = CanonicalV1::new("flagship/x/v1")
            .unwrap()
            .int(-1)
            .unwrap()
            .finish_string();
        assert_eq!(neg, "flagship/x/v1|-1");
    }
}

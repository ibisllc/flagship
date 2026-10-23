use core::fmt;

/// Every refusal the protocol crate can produce. `code()` is the stable
/// string shared with the TypeScript port and the vector files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtocolError {
    BadHex,
    HexLength,
    BadDecimal,
    IntegerRange,
    FieldCount,
    FieldSeparator,
    FieldControlChar,
    BadPurpose,
    BadNumber,
    ListItem,
    HeaderBadMagic,
    HeaderTruncated,
    HeaderTooLarge,
    HeaderUnknownField,
    HeaderDuplicateField,
    HeaderFieldOrder,
    HeaderFieldLength,
    HeaderMissingField,
    HeaderForbiddenField,
    HeaderBadValue,
    UnknownSuite,
    BodyLength,
}

impl ProtocolError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::BadHex => "bad-hex",
            Self::HexLength => "hex-length",
            Self::BadDecimal => "bad-decimal",
            Self::IntegerRange => "integer-range",
            Self::FieldCount => "field-count",
            Self::FieldSeparator => "field-separator",
            Self::FieldControlChar => "field-control-char",
            Self::BadPurpose => "bad-purpose",
            Self::BadNumber => "bad-number",
            Self::ListItem => "list-item",
            Self::HeaderBadMagic => "header-bad-magic",
            Self::HeaderTruncated => "header-truncated",
            Self::HeaderTooLarge => "header-too-large",
            Self::HeaderUnknownField => "header-unknown-field",
            Self::HeaderDuplicateField => "header-duplicate-field",
            Self::HeaderFieldOrder => "header-field-order",
            Self::HeaderFieldLength => "header-field-length",
            Self::HeaderMissingField => "header-missing-field",
            Self::HeaderForbiddenField => "header-forbidden-field",
            Self::HeaderBadValue => "header-bad-value",
            Self::UnknownSuite => "unknown-suite",
            Self::BodyLength => "body-length",
        }
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for ProtocolError {}

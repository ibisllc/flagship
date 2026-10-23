use core::fmt;
use flagship_protocol::ProtocolError;

/// Every refusal of the hybrid suites. `code()` matches the TypeScript port
/// and the `expect` strings in the shared vectors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CryptoError {
    Protocol(ProtocolError),
    BadPublicKey,
    BadSecretKey,
    BadPurpose,
    PurposeMismatch,
    SuiteMismatch,
    RecipientMismatch,
    ContextTooLarge,
    PlaintextTooLarge,
    PayloadTooLarge,
    DecryptFailed,
    BadSignature,
    Randomness,
}

impl CryptoError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Protocol(p) => p.code(),
            Self::BadPublicKey => "bad-public-key",
            Self::BadSecretKey => "bad-secret-key",
            Self::BadPurpose => "bad-purpose",
            Self::PurposeMismatch => "purpose-mismatch",
            Self::SuiteMismatch => "suite-mismatch",
            Self::RecipientMismatch => "recipient-mismatch",
            Self::ContextTooLarge => "context-too-large",
            Self::PlaintextTooLarge => "plaintext-too-large",
            Self::PayloadTooLarge => "payload-too-large",
            Self::DecryptFailed => "decrypt-failed",
            Self::BadSignature => "bad-signature",
            Self::Randomness => "randomness",
        }
    }
}

impl From<ProtocolError> for CryptoError {
    fn from(e: ProtocolError) -> Self {
        Self::Protocol(e)
    }
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for CryptoError {}

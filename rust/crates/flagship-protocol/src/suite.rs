//! Registry of v2 cryptographic suites. A suite id names one complete,
//! reviewed construction; there is no algorithm negotiation inside a suite.

use crate::error::ProtocolError;

/// A registered v2 suite.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SuiteId {
    /// `flagship/hybrid-seal/v1`: X-Wing, HKDF-SHA-512, AES-256-GCM.
    HybridSealV1,
    /// `flagship/hybrid-sig/ed25519-mldsa65/v1`: Ed25519 AND ML-DSA-65.
    HybridSigEd25519MlDsa65V1,
}

impl SuiteId {
    /// The registered 16-bit id.
    #[must_use]
    pub const fn id(self) -> u16 {
        match self {
            Self::HybridSealV1 => 0x0001,
            Self::HybridSigEd25519MlDsa65V1 => 0x0002,
        }
    }

    /// The suite's purpose-style tag, used as a domain separator.
    #[must_use]
    pub const fn tag(self) -> &'static str {
        match self {
            Self::HybridSealV1 => "flagship/hybrid-seal/v1",
            Self::HybridSigEd25519MlDsa65V1 => "flagship/hybrid-sig/ed25519-mldsa65/v1",
        }
    }

    /// Looks up a registered id.
    ///
    /// # Errors
    /// [`ProtocolError::UnknownSuite`].
    pub const fn from_id(id: u16) -> Result<Self, ProtocolError> {
        match id {
            0x0001 => Ok(Self::HybridSealV1),
            0x0002 => Ok(Self::HybridSigEd25519MlDsa65V1),
            _ => Err(ProtocolError::UnknownSuite),
        }
    }
}

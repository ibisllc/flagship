//! Pure parsing, canonical bytes and versioned schemas shared with the TypeScript, Swift and Kotlin ports. No IO, no private keys.

pub mod canonical_v1;
pub mod envelope;
pub mod error;
pub mod parse;
pub mod suite;

pub use canonical_v1::CanonicalV1;
pub use envelope::EnvelopeHeader;
pub use error::ProtocolError;
pub use suite::SuiteId;

//! Small reviewed wrapper over the selected crypto providers: classical suites, hybrid X25519+ML-KEM-768 sealing and Ed25519+ML-DSA-65 AND-signatures.
//!
//! Status: draft, pending Q01 external cryptographic review. The box pilot (keyd's hybrid sign, `trust`) uses it.
//! Specification: `docs/architecture-v2/pq-suites.md`.

mod ed25519_strict;
pub mod entitlements;
pub mod error;
pub mod key_id;
pub mod release;
mod rng;
pub mod seal;
pub mod session;
pub mod sig;
pub mod trust;

pub use error::CryptoError;
pub use key_id::key_id;
pub use seal::{
    HybridSealPublicKey, HybridSealSecretKey, Opened, SealOptions, open, seal, seal_with_randomness,
};
pub use sig::{HybridSigningKey, HybridVerifyingKey};

//! Verifiable runtime distribution (release plan G2): the box runs the Node.js binary its own signed release
//! locks, obtained from the official distributor and checked against three independent statements that must
//! agree before anything is unpacked:
//!
//! 1. the upstream's PGP-signed `SHASUMS256.txt` (verified with the signer key the lock names, bound by its
//!    fingerprint; a key that arrives with the download is never trusted),
//! 2. the lock (`release/runtime-lock.json`: exact version, per-target archive digest and size, the extracted
//!    executable's digest), which the signed release artifact carries and flagshipserver.com publishes signed,
//! 3. the archive's own SHA-256, computed here.
//!
//! A discrepancy or an unverifiable signature blocks the installation and leaves the running one alone. The
//! candidate is never executed before verification. Installation unpacks into a fresh versioned directory with
//! the bounded extractor, checks the executable's digest and moves the directory into place; activation goes
//! through the release switch ([`crate::release`]).

pub mod fetch;
pub mod install;
pub mod lock;
pub mod manifest;
pub mod upstream;

pub use install::{Installed, RuntimeStatus, install, status};
pub use lock::{Lock, Target};
pub use upstream::{Evidence, verify_archive, verify_shasums_signature};

//! Flagship's early-boot unlock client in Rust (architecture v2, BO01).
//!
//! Step one of IMPLEMENTATION-PLAN.md §7: reproduce v1 exactly before any v2
//! protocol. Two entry points share one implementation of the wire formats:
//!
//! - [`compat`]: the `flagship-unseal` command line of
//!   `installer/unseal-helper`, byte for byte (flags, stdin/stdout, exit
//!   codes, stderr), so the binary can replace `/boot/flagship-unseal`.
//! - [`unlock`]: the whole shell unlock flow (lease, relay, cryptsetup) in one
//!   process, with the secret handed to cryptsetup through a pipe.
//!
//! The formats: [`seal`] (sealed blobs and `SealedSecretResponse`),
//! [`canonical`] (signed `SecretRequest` and box-auth headers), [`identity`]
//! (the `/boot/identity.pem` STK).

pub mod canonical;
pub mod compat;
pub mod goflag;
pub mod gohex;
pub mod gojson;
pub mod hardening;
pub mod identity;
pub mod seal;
pub mod unlock;

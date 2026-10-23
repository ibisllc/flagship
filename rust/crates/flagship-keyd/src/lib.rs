//! Box key custody: the Rust backend for the flagship-keyd v1 contract (packages/keyd).
//!
//! Same wire protocol, operations, error codes, rate limits, audit lines and state files as the
//! TS service, so either backend can run against the same `/var/lib/flagship-keyd`. On top of
//! it: peer-credential caller checks, no core dumps, and zeroized key memory.

pub mod acme;
pub mod crypto;
pub mod der;
pub mod files;
pub mod hardening;
pub mod policy;
pub mod server;
pub mod service;
pub mod tls;
pub mod wire;

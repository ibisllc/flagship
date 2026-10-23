//! Narrow privileged broker: a closed set of typed host operations.
//!
//! Two protocols share one framing (a 4-byte big-endian length, then JSON):
//! - [`privd`]: the v1 contract of packages/privd, byte-compatible, for the TS daemon as it is.
//! - [`typed`]: the v2 operations of IMPLEMENTATION-PLAN.md §4.2, each of which verifies a signed
//!   capability bound to the exact object it acts on before it acts.
//!
//! Callers are identified by the kernel (SO_PEERCRED), never by what they write.

pub mod audit;
pub mod capability;
pub mod fsobj;
pub mod js;
pub mod netpolicy;
pub mod peer;
pub mod policy;
pub mod privd;
pub mod server;
pub mod state;
pub mod typed;
pub mod wire;

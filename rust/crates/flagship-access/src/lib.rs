//! Who reaches an app, as whom and with which rank (release plan R4, docs/app-apis.md §2-§5,
//! docs/service-access-gating.md "Account members").
//!
//! - [`state`]: the box's access state file (`flagship-access/service-access.json`) read the way the
//!   TypeScript store reads it, failing closed when it is unreadable.
//! - [`path`]: `access.public_routes` matching.
//! - [`origin`]: the sibling-app guard (an unsafe request from another origin carries no member).
//! - [`decide`]: the decision itself, from the state, the account people the box knows and the facts
//!   of one request. The app is the one the router selected; nothing the client writes picks another.
//! - [`rank`]: admin authority over `flagship/app-rank/v1` orders (admin root on a pinned box, the
//!   owner IRK only on a box that pins none).
//! - [`people`]: account-people classification from the box's own device book, revocations and shares.
//! - [`store`]: the access state file and every change to it.
//! - [`access_journal`], [`access_entry`]: the per-app journal of signed entries and their verification.
//! - [`apply`]: applying a handed-over entry (and the rank applier) against the people and the state.
//! - [`writes`]: the write operations behind the socket, authoritative or as a shadow dry run.
//! - [`server`]: the local socket the daemon asks (shadow or authoritative).
//!
//! Shared verdicts: `packages/protocol/test-vectors/access-enforcement/`.
#![forbid(unsafe_code)]

pub mod access_entry;
pub mod access_journal;
pub mod apply;
pub mod decide;
pub mod origin;
pub mod path;
pub mod people;
pub mod rank;
pub mod server;
pub mod state;
pub mod store;
pub mod writes;

pub use decide::{
    ApiKeyCheck, AppFacts, Decision, Principal, Principals, RequestFacts, SessionFact, decide,
};
pub use state::AccessState;

/// Milliseconds since the epoch (0 if the clock is before it).
#[must_use]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

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
//! - [`server`]: the local socket the daemon asks (shadow or authoritative).
//!
//! Shared verdicts: `packages/protocol/test-vectors/access-enforcement/`.
#![forbid(unsafe_code)]

pub mod decide;
pub mod origin;
pub mod path;
pub mod rank;
pub mod server;
pub mod state;

pub use decide::{
    ApiKeyCheck, AppFacts, Decision, Principal, Principals, RequestFacts, SessionFact, decide,
};
pub use state::AccessState;

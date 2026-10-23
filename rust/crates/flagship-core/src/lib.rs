//! Unprivileged controller: durable operation journal, desired state and single-writer
//! reconciliation (IMPLEMENTATION-PLAN.md §4.3).
//!
//! - [`journal`]: SQLite (WAL, `synchronous=FULL`) recording intent before every effect and the
//!   observed runtime id after it.
//! - [`lock`]: the exclusive controller lock; exactly one writer per host.
//! - [`controller`]: reconciliation of desired against observed state by deterministic labels and
//!   generation, in shadow mode (decide, never act) or with effects.
//! - [`handover`]: take over from the TS controller: checkpoint, lock, adopt, compare, enable.

pub mod controller;
pub mod handover;
pub mod journal;
pub mod lock;
pub mod port;

pub use controller::{Controller, Decision, Mode, Report};
pub use journal::{Journal, JournalError, OpKind, OpState};
pub use lock::ControllerLock;
pub use port::{EffectError, EffectPort, RuntimePort};

//! Unprivileged controller: durable operation journal, desired state and single-writer
//! reconciliation (IMPLEMENTATION-PLAN.md §4.3).
//!
//! - [`journal`]: SQLite (WAL, `synchronous=FULL`) recording intent before every effect and the
//!   observed runtime id after it.
//! - [`lock`]: the exclusive controller lock; exactly one writer per host.
//! - [`controller`]: reconciliation of desired against observed state by deterministic labels and
//!   generation, in shadow mode (decide, never act) or with effects.
//! - [`handover`]: take over from the TS controller: checkpoint, lock, adopt, compare, enable.
//! - [`apps`]: the app reconciler on an arch-v2 box (G3): desired workloads, the address pool,
//!   scheduling ([`schedule`]) and generations, with the daemon as the executor of its effects.
//! - [`ipc`]: core's socket, where the daemon syncs and settles.
#![forbid(unsafe_code)]

pub use flagship_access::access_entry;
pub use flagship_access::access_journal;
pub mod apps;
pub mod controller;
pub mod endpoints;
pub mod handover;
pub mod ipc;
pub mod journal;
pub mod lock;
pub mod port;
pub mod schedule;
pub mod shadow;

pub use controller::{Controller, Decision, Mode, Report};
pub use journal::{Journal, JournalError, OpKind, OpState};
pub use lock::ControllerLock;
pub use port::{EffectError, EffectPort, RuntimePort};

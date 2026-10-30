//! The relay's outbound side (box-initiated streams, `outbound-v1`; release plan G7): the destination policy, the per-box
//! budgets and the session that dials, splices under the credit window and keeps only totals.

pub mod budget;
pub mod policy;
pub mod session;

pub use session::{
    Connect, HostPolicy, HostRow, KnownHostsPolicy, Options, OutboundRelay, OutboundSession,
    Resolve, Sink, System, destination_label,
};

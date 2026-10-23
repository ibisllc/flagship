//! Opaque-stream relay: tunnel frame protocol v1, SNI routing and bounded per-stream flow control.
//!
//! The Rust replacement for the `.services` data plane (`apps/web/src/tunnel`). TLS always
//! terminates on the box; this crate reads only TLS framing and the ClientHello's SNI.
//! Conformance with the TypeScript relay: `docs/architecture-v2/relay-transport.md`.

pub mod allocator;
pub mod echo;
pub mod flow;
pub mod frame;
pub mod hello;
pub mod hub;
pub mod json;
pub mod mail;
pub mod payload;
pub mod pipe;
pub mod registry;
pub mod relay;
pub mod router;
pub mod sni;
pub mod throttle;

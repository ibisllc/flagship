//! Box-local TLS/HTTP ingress whose long-term TLS key stays in keyd.
//!
//! A drop-in candidate for flagship-tlsd (`installer/tls-frontend`): it terminates TLS on the
//! box, every handshake signature is a keyd `tls.sign` request, and each decrypted connection
//! goes to the daemon's Unix socket behind the same one-line JSON header.

pub mod args;
pub mod cert;
pub mod guard;
pub mod keyd;
pub mod server;
pub mod signer;
pub mod source;
pub mod wire;

//! The box's independent updater, rollback and recovery supervisor (release plan G1 / R1).
//!
//! It replaces `installer/verify-box-artifact.sh`, `installer/install-box-artifact.sh`,
//! `installer/rollback-box-artifact.sh` and the daemon's bash update guard with one binary that
//! needs neither Node nor a working new daemon:
//!
//! - [`manifest`] and [`verify`]: the signed release manifest and every check the shell verifier
//!   made (k-of-n Ed25519 over the canonical bytes, the hybrid ML-DSA companions once the PQ pin
//!   names a key, digest, size, commit, architecture, verifier version, anti-rollback sequence and
//!   the Node floor), through `flagship-crypto`.
//! - [`extract`]: a bounded `tar.gz` reader that refuses unsafe paths, links, special files and
//!   resource exhaustion before anything of the artifact is trusted.
//! - [`journal`]: the update intent, written whole and fsynced at every stage, so a power loss at
//!   any point leaves a state [`recover`] understands.
//! - [`release`]: the immutable release directories, the atomic link switch and the state files.
//! - [`recover`]: the boot-time guard (rolls back an interrupted apply, a release that starts but
//!   is never verified healthy, or an unreadable marker) and the boot-time reconcile.
//! - [`cli`]: the command line; `install` and `restore` take the shell installers' flags so the
//!   broker can exec this binary where it ran the scripts.
//!
//! A rollback flips back to a release that is already on disk and was verified when it was
//! installed. It never rolls back keys, revocation epochs or the minimum-security state: those
//! live in the state directory and in keyd, which this crate never touches.

pub mod cli;
pub mod extract;
pub mod fsutil;
pub mod journal;
pub mod manifest;
pub mod recover;
pub mod refusal;
pub mod release;
pub mod runtime;
pub mod verify;

pub use refusal::Refusal;

//! The controller lock: an exclusive, non-blocking `flock` on a lock file, held for the life of
//! the controller. A second controller (Rust or a TS one that honours the same lock) cannot start.

use rustix::fs::{FlockOperation, flock};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

#[derive(Debug)]
pub struct ControllerLock {
    _file: File,
}

impl ControllerLock {
    pub fn acquire(path: &Path) -> io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc_nofollow())
            .open(path)?;
        match flock(&file, FlockOperation::NonBlockingLockExclusive) {
            Ok(()) => Ok(Self { _file: file }),
            Err(e) if e == rustix::io::Errno::WOULDBLOCK => Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "another controller holds the lock",
            )),
            Err(e) => Err(io::Error::from(e)),
        }
    }
}

/// `O_NOFOLLOW`, so a symlink planted at the lock path is refused rather than followed.
fn libc_nofollow() -> i32 {
    i32::try_from(rustix::fs::OFlags::NOFOLLOW.bits()).unwrap_or(0)
}

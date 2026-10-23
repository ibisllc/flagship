//! Filesystem objects the broker acts on, reached from a broker-owned root one component at a
//! time with `O_NOFOLLOW`, so no symlink anywhere on the way is followed, and then acted on
//! through the descriptor that was validated (fchown/fchmod/renameat), never by path again.

use rustix::fs::{AtFlags, Mode, OFlags, fchmod, fchown, fstat, fsync, mkdirat, openat, renameat};
use rustix::io::Errno;
use std::io::{self, Write};
use std::os::fd::OwnedFd;
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};

const DIR_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

#[derive(Debug)]
pub struct SafeDir {
    fd: OwnedFd,
}

fn io_err(e: Errno) -> io::Error {
    io::Error::from(e)
}

/// One path component the broker generated: no separators, not `.` or `..`, no NUL.
fn component(name: &str) -> io::Result<&str> {
    let ok = !name.is_empty()
        && name.len() <= 255
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\0');
    if ok {
        Ok(name)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a single path component",
        ))
    }
}

fn raw_mode(mode: u32) -> Mode {
    Mode::from_raw_mode(rustix::fs::RawMode::try_from(mode & 0o7777).unwrap_or(0o700))
}

static TMP: AtomicU64 = AtomicU64::new(0);

impl SafeDir {
    /// Open a broker-owned root by absolute path without following any symlink, and require it
    /// to be owned by the broker's own user and writable by nobody else.
    pub fn open_root(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a root must be absolute",
            ));
        }
        let mut fd = openat(rustix::fs::CWD, "/", DIR_FLAGS, Mode::empty()).map_err(io_err)?;
        for c in path.components() {
            match c {
                Component::RootDir => {}
                Component::Normal(n) => {
                    fd = openat(&fd, n, DIR_FLAGS, Mode::empty()).map_err(io_err)?
                }
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "a root may not contain . or ..",
                    ));
                }
            }
        }
        let st = fstat(&fd).map_err(io_err)?;
        if st.st_uid != rustix::process::geteuid().as_raw() || (st.st_mode & 0o022) != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "a broker root must be the broker's own and not group- or world-writable",
            ));
        }
        Ok(Self { fd })
    }

    /// A child directory that must already exist; a symlink or a file there is refused.
    pub fn open_child(&self, name: &str) -> io::Result<Self> {
        let fd = openat(&self.fd, component(name)?, DIR_FLAGS, Mode::empty()).map_err(io_err)?;
        Ok(Self { fd })
    }

    /// A child directory, created with `mode` if missing.
    pub fn ensure_child(&self, name: &str, mode: u32) -> io::Result<Self> {
        match mkdirat(&self.fd, component(name)?, raw_mode(mode)) {
            Ok(()) | Err(Errno::EXIST) => {}
            Err(e) => return Err(io_err(e)),
        }
        self.open_child(name)
    }

    /// Whether this directory sits on another filesystem than `other` (a mounted image).
    pub fn is_mount_below(&self, other: &SafeDir) -> io::Result<bool> {
        let a = fstat(&self.fd).map_err(io_err)?;
        let b = fstat(&other.fd).map_err(io_err)?;
        Ok(a.st_dev != b.st_dev)
    }

    pub fn set_owner_and_mode(&self, uid: u32, gid: u32, mode: u32) -> io::Result<()> {
        // Safety of ownership: the descriptor is the directory that was validated, not a path.
        let (u, g) = (
            rustix::fs::Uid::from_raw(uid),
            rustix::fs::Gid::from_raw(gid),
        );
        fchown(&self.fd, Some(u), Some(g)).map_err(io_err)?;
        fchmod(&self.fd, raw_mode(mode)).map_err(io_err)
    }

    /// Replace `name` with `bytes` all at once: a fresh exclusive temp file, fsync, rename, fsync
    /// the directory. A symlink planted at the temp name is never followed.
    pub fn write_atomic(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        let name = component(name)?;
        let n = TMP.fetch_add(1, Ordering::SeqCst);
        let tmp = format!(".{name}.tmp-{}-{n}", std::process::id());
        let flags =
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let fd =
            openat(&self.fd, tmp.as_str(), flags, Mode::from_raw_mode(0o640)).map_err(io_err)?;
        let mut f = std::fs::File::from(fd);
        let written = f.write_all(bytes).and_then(|()| f.sync_all());
        if let Err(e) = written {
            let _ = rustix::fs::unlinkat(&self.fd, tmp.as_str(), AtFlags::empty());
            return Err(e);
        }
        renameat(&self.fd, tmp.as_str(), &self.fd, name).map_err(io_err)?;
        fsync(&self.fd).map_err(io_err)
    }

    pub fn read_file(&self, name: &str) -> io::Result<Vec<u8>> {
        let fd = openat(
            &self.fd,
            component(name)?,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(io_err)?;
        let mut out = Vec::new();
        std::io::Read::read_to_end(&mut std::fs::File::from(fd), &mut out)?;
        Ok(out)
    }
}

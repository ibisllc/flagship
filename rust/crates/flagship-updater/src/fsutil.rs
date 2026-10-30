//! Durable file helpers: a state file is written whole to a fresh sibling, fsynced, renamed into
//! place and the directory fsynced, so a power loss leaves the old file or the new one, never a
//! cut-short one.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// fsync a directory so a rename inside it is durable.
///
/// # Errors
/// An I/O error.
pub fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

fn sibling_tmp(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.{}.new", std::process::id()))
}

/// Writes `bytes` to `path` through a fresh file (mode `mode`), durably.
///
/// # Errors
/// An I/O error; the old `path` is untouched when it fails.
pub fn write_durable(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let tmp = sibling_tmp(path);
    let _ = fs::remove_file(&tmp);
    let result = (|| {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
        fs::rename(&tmp, path)?;
        if let Some(dir) = path.parent() {
            sync_dir(dir)?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Atomically points the symlink `link` at `target` (create a sibling link, rename over).
///
/// # Errors
/// An I/O error; `link` still names what it did before when it fails.
pub fn switch_symlink(link: &Path, target: &Path) -> io::Result<()> {
    let tmp = link.with_file_name(format!(
        ".{}.switch.{}",
        link.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        std::process::id()
    ));
    let _ = fs::remove_file(&tmp);
    std::os::unix::fs::symlink(target, &tmp)?;
    let result = fs::rename(&tmp, link);
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        return result;
    }
    if let Some(dir) = link.parent() {
        sync_dir(dir)?;
    }
    Ok(())
}

/// Reads a state file only if it is a regular file (never through a link), as text.
#[must_use]
pub fn read_regular(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() || meta.len() > (1 << 20) {
        return None;
    }
    fs::read_to_string(path).ok()
}

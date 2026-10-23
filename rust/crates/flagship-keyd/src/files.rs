//! State files, in the same names, modes and formats the TS service writes.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use zeroize::Zeroizing;

use crate::wire::{decode_hex, to_hex};

pub fn ensure_dir(dir: &Path, mode: u32) -> std::io::Result<()> {
    fs::DirBuilder::new().recursive(true).mode(mode).create(dir)
}

fn tmp_of(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".tmp");
    PathBuf::from(s)
}

/// Write `<path>.tmp` with `mode`, flush it to disk, then rename it over `path`.
pub fn write_atomic(path: &Path, contents: &[u8], mode: u32) -> std::io::Result<()> {
    let tmp = tmp_of(path);
    // A leftover 0400 temp file from a crash would make the create fail; it holds nothing we need.
    match fs::remove_file(&tmp) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&tmp)?;
    f.write_all(contents)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path)
}

/// A 32-byte key file as `fileKeyStore` writes it: lowercase hex and a newline, 0400.
pub fn save_key_file(dir: &Path, name: &str, key: &[u8; 32]) -> std::io::Result<()> {
    ensure_dir(dir, 0o700)?;
    let mut text = Zeroizing::new(to_hex(key));
    text.push('\n');
    write_atomic(&dir.join(format!("{name}.key")), text.as_bytes(), 0o400)
}

#[derive(Debug)]
pub enum KeyFileError {
    Io(std::io::Error),
    Readable(PathBuf),
    NotAKey(PathBuf),
}

impl std::fmt::Display for KeyFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "{e}"),
            Self::Readable(p) => {
                write!(f, "{} must not be readable by group or others", p.display())
            }
            Self::NotAKey(p) => write!(f, "{} is not a 32-byte hex key", p.display()),
        }
    }
}

impl std::error::Error for KeyFileError {}

/// `readKeyFile`: absent is `None`; group/other access or a malformed key is an error.
pub fn read_key_file(path: &Path) -> Result<Option<Zeroizing<[u8; 32]>>, KeyFileError> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(KeyFileError::Io(e)),
    };
    if meta.permissions().mode() & 0o077 != 0 {
        return Err(KeyFileError::Readable(path.to_owned()));
    }
    read_hex_key(path).map(Some)
}

/// A hex key file without the mode check (the ACME account key, as `acme.ts` reads it).
pub fn read_hex_key(path: &Path) -> Result<Zeroizing<[u8; 32]>, KeyFileError> {
    let text = Zeroizing::new(fs::read_to_string(path).map_err(KeyFileError::Io)?);
    let hex = text.trim();
    if hex.len() != 64 {
        return Err(KeyFileError::NotAKey(path.to_owned()));
    }
    let bytes =
        Zeroizing::new(decode_hex(hex).ok_or_else(|| KeyFileError::NotAKey(path.to_owned()))?);
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(
        bytes
            .get(..32)
            .ok_or_else(|| KeyFileError::NotAKey(path.to_owned()))?,
    );
    Ok(out)
}

/// `policy.json`, written by the TS migration from the box's own recipe.
pub fn load_policy(state: &Path) -> std::io::Result<Option<String>> {
    let path = state.join("policy.json");
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    Ok(v.get("serverFqdn")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned))
}

/// `namesFor`: the names a box may have a certificate for.
pub fn names_for(fqdn: &str) -> Vec<String> {
    vec![fqdn.to_owned(), format!("*.{fqdn}")]
}

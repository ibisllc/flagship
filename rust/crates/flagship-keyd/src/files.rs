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

/// `namesFor` (migrate.ts): the names a box may have a certificate for. The last is the
/// account's wildcard `*.<user>.<apex>`, which a box asks for once an admin grants it the
/// account's app names (server-daemon runtime.ts `boxCertSans`).
/// A name of any other shape than `<server>.<user>.<apex>` yields no names at all, never a
/// wildcard over the whole apex (AT-CRT-06).
pub fn names_for(fqdn: &str) -> Vec<String> {
    account_zone_of(fqdn, SERVICES_APEXES).map_or_else(Vec::new, |account| {
        vec![fqdn.to_owned(), format!("*.{fqdn}"), format!("*.{account}")]
    })
}

/// `SERVICES_APEXES` (migrate.ts): the data-plane apexes a box name may sit under.
pub const SERVICES_APEXES: &[&str] = &["flagship.services", "gym.flagship.services"];

/// `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`
fn is_server_label(s: &str) -> bool {
    let b = s.as_bytes();
    let alnum = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    match (b.first(), b.last()) {
        (Some(f), Some(l)) => {
            b.len() <= 63 && alnum(f) && alnum(l) && b.iter().all(|c| alnum(c) || *c == b'-')
        }
        _ => false,
    }
}

/// `^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$`, without `--`.
fn is_user_label(s: &str) -> bool {
    (3..=30).contains(&s.len()) && is_server_label(s) && !s.contains("--")
}

/// `accountZoneOf` (migrate.ts): `<user>.<apex>` for a box name of exactly the shape
/// `<server>.<user>.<apex>` under one of the apexes, or `None`.
pub fn account_zone_of(fqdn: &str, apexes: &[&str]) -> Option<String> {
    apexes.iter().find_map(|apex| {
        let head = fqdn.strip_suffix(apex)?.strip_suffix('.')?;
        let (server, user) = head.split_once('.')?;
        (!user.contains('.') && is_server_label(server) && is_user_label(user))
            .then(|| format!("{user}.{apex}"))
    })
}

/// `loadOwnerAnchor` (migrate.ts): the owner key root in `owner.json`, lowercase hex, or `None`.
pub fn load_owner_anchor(state: &Path) -> Option<String> {
    let text = fs::read_to_string(state.join("owner.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let k = v.get("irkPubHex")?.as_str()?;
    (k.len() == 64
        && k.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
    .then(|| k.to_owned())
}

/// The admin root in `owner.json` (`adminRootPubHex`), lowercase hex, or `None`.
pub fn load_admin_root_anchor(state: &Path) -> Option<String> {
    let text = fs::read_to_string(state.join("owner.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let k = v.get("adminRootPubHex")?.as_str()?;
    (k.len() == 64
        && k.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
    .then(|| k.to_owned())
}

/// `CEREMONY_TOKEN_FILE` and `CEREMONY_WINDOW_MS` (migrate.ts).
pub const CEREMONY_TOKEN_FILE: &str = "provision-ceremony.token";
pub const CEREMONY_WINDOW_MS: i64 = 10 * 60_000;

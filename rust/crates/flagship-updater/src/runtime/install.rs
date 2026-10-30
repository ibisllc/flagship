//! Unpacking a verified runtime into its own immutable directory and reporting what is installed.

use super::lock::{Lock, Target};
use super::upstream::{Evidence, verify_archive};
use crate::extract::{Limits, extract_tar_gz};
use crate::fsutil::{read_regular, sync_dir, write_durable};
use crate::refusal::Refusal;
use crate::verify::sha256_file;
use serde_json::{Map, Value};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Installed {
    pub dir: PathBuf,
    pub executable: PathBuf,
    pub evidence: Evidence,
    /// False when the directory was already there with the right executable.
    pub new: bool,
}

/// `<runtimes>/node-<version>-<target>-<first 12 of the archive digest>`.
#[must_use]
pub fn dir_for(runtimes: &Path, lock: &Lock, t: &Target) -> PathBuf {
    runtimes.join(format!(
        "node-{}-{}-{}",
        lock.version,
        t.name,
        t.sha256.get(..12).unwrap_or(&t.sha256)
    ))
}

fn io(e: &std::io::Error) -> Refusal {
    Refusal::with("install-failed", e.to_string())
}

fn limits_for(t: &Target) -> Limits {
    Limits {
        max_total_bytes: t.executable_bytes.saturating_mul(4).max(1 << 28),
        max_file_bytes: t.executable_bytes.saturating_mul(2).max(1 << 28),
        ..Limits::default()
    }
}

fn check_executable(dir: &Path, t: &Target) -> Result<(), Refusal> {
    let exe = dir.join(&t.executable);
    let meta = fs::symlink_metadata(&exe).map_err(|_| {
        Refusal::with(
            "bad-runtime",
            format!("{} is not in the archive", t.executable),
        )
    })?;
    if !meta.file_type().is_file() || meta.permissions().mode() & 0o111 == 0 {
        return Err(Refusal::with(
            "bad-runtime",
            format!("{} is not an executable file", t.executable),
        ));
    }
    if meta.len() != t.executable_bytes {
        return Err(Refusal::with(
            "bad-runtime",
            "the executable's size differs from the lock",
        ));
    }
    let digest = sha256_file(&exe).map_err(|e| io(&e))?;
    if digest != t.executable_sha256 {
        return Err(Refusal::with(
            "bad-runtime",
            "the executable's digest differs from the lock",
        ));
    }
    Ok(())
}

fn record(lock: &Lock, t: &Target, e: &Evidence) -> String {
    let mut m = Map::new();
    m.insert("runtime".into(), Value::from("node"));
    m.insert("version".into(), Value::from(lock.version.clone()));
    m.insert("target".into(), Value::from(t.name.clone()));
    m.insert("file".into(), Value::from(t.file.clone()));
    m.insert("lockSha256".into(), Value::from(lock.sha256.clone()));
    m.insert("archiveSha256".into(), Value::from(e.local_digest.clone()));
    m.insert(
        "executableSha256".into(),
        Value::from(t.executable_sha256.clone()),
    );
    m.insert("upstreamSigner".into(), Value::from(e.signer.clone()));
    Value::Object(m).to_string()
}

/// Verifies the archive and installs it.
///
/// Nothing is unpacked, let alone run, until [`verify_archive`] agrees; a discrepancy leaves whatever is installed
/// alone.
///
/// # Errors
/// Any refusal of [`verify_archive`], the extractor's `unsafe-artifact`/`unpack-failed`, `bad-runtime` or
/// `install-failed`.
pub fn install(
    lock: &Lock,
    target: &Target,
    archive: &Path,
    shasums: &[u8],
    sig: &[u8],
    runtimes: &Path,
) -> Result<Installed, Refusal> {
    let evidence = verify_archive(lock, target, archive, shasums, sig)?;
    fs::create_dir_all(runtimes).map_err(|e| io(&e))?;
    let dest = dir_for(runtimes, lock, target);
    let exe = dest.join(&target.executable);
    if dest.exists() {
        check_executable(&dest, target)?;
        return Ok(Installed {
            dir: dest,
            executable: exe,
            evidence,
            new: false,
        });
    }
    let staging = runtimes.join(format!(".incoming-{}-{}", target.name, std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir(&staging).map_err(|e| io(&e))?;
    let result = (|| {
        extract_tar_gz(archive, &staging, 1, &limits_for(target))?;
        check_executable(&staging, target)?;
        write_durable(
            &staging.join("RUNTIME.json"),
            record(lock, target, &evidence).as_bytes(),
            0o644,
        )
        .map_err(|e| io(&e))?;
        fs::rename(&staging, &dest).map_err(|e| io(&e))?;
        sync_dir(runtimes).map_err(|e| io(&e))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result?;
    Ok(Installed {
        dir: dest,
        executable: exe,
        evidence,
        new: true,
    })
}

/// What the owner-facing view shows about the runtime in a target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeStatus {
    pub version: String,
    pub target: String,
    pub official_url: String,
    pub expected_archive_sha256: String,
    pub expected_executable_sha256: String,
    pub installed: bool,
    /// The executable's digest computed now (None when not installed).
    pub local_executable_sha256: Option<String>,
    /// True only when the installed executable's digest equals the lock's.
    pub matches_lock: bool,
    pub upstream_signer: Option<String>,
    pub lock_sha256: String,
}

/// Recomputes the installed executable's digest and reads the install record.
///
/// # Errors
/// `bad-runtime-lock` for an unknown target.
pub fn status(lock: &Lock, target_name: &str, runtimes: &Path) -> Result<RuntimeStatus, Refusal> {
    let t = lock.target(target_name)?;
    let dir = dir_for(runtimes, lock, t);
    let exe = dir.join(&t.executable);
    let local = fs::symlink_metadata(&exe)
        .ok()
        .filter(|m| m.file_type().is_file())
        .and_then(|_| sha256_file(&exe).ok());
    let signer = read_regular(&dir.join("RUNTIME.json"))
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| {
            v.get("upstreamSigner")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    Ok(RuntimeStatus {
        version: lock.version.clone(),
        target: t.name.clone(),
        official_url: lock.archive_url(t),
        expected_archive_sha256: t.sha256.clone(),
        expected_executable_sha256: t.executable_sha256.clone(),
        installed: local.is_some(),
        matches_lock: local.as_deref() == Some(t.executable_sha256.as_str()),
        local_executable_sha256: local,
        upstream_signer: signer,
        lock_sha256: lock.sha256.clone(),
    })
}

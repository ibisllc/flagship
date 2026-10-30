//! The upstream side of the check: the PGP signature on `SHASUMS256.txt` and the three-way agreement on the archive.

use super::lock::{Lock, Target};
use crate::refusal::Refusal;
use crate::verify::sha256_file;
use pgp::composed::{Deserializable, DetachedSignature, SignedPublicKey};
use pgp::types::KeyDetails;
use std::path::Path;

/// What was checked, for the owner-facing view and the install record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Evidence {
    /// Fingerprint (40 lowercase hex) of the pinned key whose signature on the checksum list verified.
    pub signer: String,
    /// The digest `SHASUMS256.txt` (as signed) lists for the archive.
    pub shasums_digest: String,
    /// The archive's SHA-256 as computed here.
    pub local_digest: String,
    /// The digest the lock names.
    pub lock_digest: String,
}

fn refuse(code: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal::with(code, detail)
}

/// The digest `shasums` lists for `file`.
fn listed_digest(shasums: &[u8], file: &str) -> Option<String> {
    let text = std::str::from_utf8(shasums).ok()?;
    let mut found: Option<String> = None;
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(digest), Some(name)) = (it.next(), it.next()) else {
            continue;
        };
        if name.trim_start_matches('*') == file
            && digest.len() == 64
            && digest
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            // A second, different line for the same file makes the list ambiguous.
            if found.as_deref().is_some_and(|d| d != digest) {
                return None;
            }
            found = Some(digest.to_owned());
        }
    }
    found
}

/// Verifies the detached signature over `shasums` with the lock's signers (each key must hash to its declared
/// fingerprint); returns the fingerprint of the signer that verified.
pub fn verify_shasums_signature(
    lock: &Lock,
    shasums: &[u8],
    sig: &[u8],
) -> Result<String, Refusal> {
    let signature = DetachedSignature::from_bytes(sig).map_err(|e| {
        refuse(
            "upstream-signature",
            format!("the signature does not parse: {e}"),
        )
    })?;
    let mut last = String::from("no signer in the lock verified it");
    for signer in &lock.signers {
        let key = match SignedPublicKey::from_string(&signer.armored) {
            Ok((k, _)) => k,
            Err(e) => {
                last = format!("a pinned key does not parse: {e}");
                continue;
            }
        };
        if key.fingerprint().to_string().to_ascii_lowercase() != signer.fingerprint {
            return Err(refuse(
                "upstream-key-mismatch",
                format!(
                    "a key in the lock is not the one its fingerprint {} names",
                    signer.fingerprint
                ),
            ));
        }
        if key.verify_bindings().is_err() {
            last = format!(
                "{}: the key's own signatures do not verify (revoked or damaged)",
                signer.fingerprint
            );
            continue;
        }
        let primary = signature.verify(&key, shasums).is_ok();
        let sub = key
            .public_subkeys
            .iter()
            .any(|s| signature.verify(&s.key, shasums).is_ok());
        if primary || sub {
            return Ok(signer.fingerprint.clone());
        }
    }
    Err(refuse("upstream-signature", last))
}

/// Checks the archive against the signed checksum list, the lock and its own bytes.
///
/// # Errors
/// `upstream-signature` / `upstream-key-mismatch` (the signature), `checksum-missing` (the list does not name the
/// file), `checksum-mismatch` (any two of list, lock and local digest disagree) or `size-mismatch`.
pub fn verify_archive(
    lock: &Lock,
    target: &Target,
    archive: &Path,
    shasums: &[u8],
    sig: &[u8],
) -> Result<Evidence, Refusal> {
    let signer = verify_shasums_signature(lock, shasums, sig)?;
    let listed = listed_digest(shasums, &target.file).ok_or_else(|| {
        refuse(
            "checksum-missing",
            format!("{} is not (uniquely) in the signed list", target.file),
        )
    })?;
    if listed != target.sha256 {
        return Err(refuse(
            "checksum-mismatch",
            "the signed list and the lock name different digests",
        ));
    }
    let size = std::fs::metadata(archive)
        .map_err(|e| refuse("unpack-failed", e.to_string()))?
        .len();
    if size != target.bytes {
        return Err(refuse(
            "size-mismatch",
            format!("{size} bytes, the lock says {}", target.bytes),
        ));
    }
    let local = sha256_file(archive).map_err(|e| refuse("unpack-failed", e.to_string()))?;
    if local != target.sha256 {
        return Err(refuse(
            "checksum-mismatch",
            "the archive's own digest differs from the signed list and the lock",
        ));
    }
    Ok(Evidence {
        signer,
        shasums_digest: listed,
        local_digest: local,
        lock_digest: target.sha256.clone(),
    })
}

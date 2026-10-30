//! The signed runtime manifest (`flagship/runtime-manifest/v1`), the Rust twin of
//! `packages/protocol/src/runtimeManifest.ts`; shared vectors in
//! `packages/protocol/test-vectors/runtime-manifest/`.
//!
//! It states, under the release keys, which runtime lock is current: the lock's own digest, a sequence that only goes up,
//! a validity window, and any upstream signer it withdraws. The box and an independent checker use it the same way:
//! nothing in it can make a runtime run by itself, it can only say "this lock is the current one" or refuse.

use super::lock::Lock;
use crate::manifest::{PqBindingWire, SignatureEntry, is_hex, parse_signatures_and_bindings};
use crate::refusal::Refusal;
use crate::verify::{Signed, Trust, bound_keys, count_signatures, sha256_hex, trust_set};
use serde_json::Value;
use std::collections::HashSet;

pub const TAG_V1: &str = "flagship/runtime-manifest/v1";
pub const TAG_V2: &str = "flagship/runtime-manifest/v2";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeManifest {
    pub version: String,
    pub lock_sha256: String,
    pub security_floor: String,
    pub sequence: u64,
    pub issued_at: u64,
    pub valid_until: u64,
    pub revoked_signers: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeManifestFile {
    pub manifest: RuntimeManifest,
    pub signatures: Vec<SignatureEntry>,
    pub pq_bindings: Vec<PqBindingWire>,
    /// The exact bytes of the lock the manifest carries.
    pub lock_text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verified {
    pub version: String,
    pub sequence: u64,
    pub valid_until: u64,
    pub signers: usize,
}

fn bad(detail: &'static str) -> Refusal {
    Refusal::with("bad-manifest", detail)
}

fn semver(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.split('.');
    let t = (
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
    );
    it.next().is_none().then_some(t)
}

impl RuntimeManifest {
    fn check(&self) -> Result<(), Refusal> {
        if semver(&self.version).is_none() || semver(&self.security_floor).is_none() {
            return Err(bad("version"));
        }
        if !is_hex(&self.lock_sha256, 64) {
            return Err(bad("lockSha256"));
        }
        if self.valid_until <= self.issued_at {
            return Err(bad("validUntil"));
        }
        if self.revoked_signers.iter().any(|f| !is_hex(f, 40)) {
            return Err(bad("revokedSigners"));
        }
        Ok(())
    }

    /// `flagship/runtime-manifest/v1|node|<version>|<lockSha256>|<floor>|<sequence>|<issuedAt>|<validUntil>|<revoked>`.
    ///
    /// # Errors
    /// `bad-manifest` for a field the canonical form cannot carry.
    pub fn canonical(&self) -> Result<String, Refusal> {
        self.check()?;
        let mut revoked = self.revoked_signers.clone();
        revoked.sort();
        let revoked = if revoked.is_empty() {
            "-".to_owned()
        } else {
            revoked.join(",")
        };
        Ok(format!(
            "{TAG_V1}|node|{}|{}|{}|{}|{}|{}|{revoked}",
            self.version,
            self.lock_sha256,
            self.security_floor,
            self.sequence,
            self.issued_at,
            self.valid_until
        ))
    }
}

/// Parses `{ "manifest": {...}, "signatures": [...], "pqBindings": [...], "lockJson": "<exact lock text>" }`.
///
/// # Errors
/// `bad-manifest`.
pub fn parse(text: &str) -> Result<RuntimeManifestFile, Refusal> {
    let v: Value = serde_json::from_str(text).map_err(|_| bad("not JSON"))?;
    let m = v
        .get("manifest")
        .filter(|m| m.is_object())
        .ok_or_else(|| bad("manifest"))?;
    let s = |k: &'static str| {
        m.get(k)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| bad(k))
    };
    let n = |k: &'static str| m.get(k).and_then(Value::as_u64).ok_or_else(|| bad(k));
    if m.get("runtime").and_then(Value::as_str) != Some("node") {
        return Err(bad("runtime"));
    }
    let revoked = m
        .get("revokedSigners")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("revokedSigners"))?
        .iter()
        .map(|f| {
            f.as_str()
                .map(str::to_owned)
                .ok_or_else(|| bad("revokedSigners"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let manifest = RuntimeManifest {
        version: s("version")?,
        lock_sha256: s("lockSha256")?,
        security_floor: s("securityFloor")?,
        sequence: n("sequence")?,
        issued_at: n("issuedAt")?,
        valid_until: n("validUntil")?,
        revoked_signers: revoked,
    };
    manifest.check()?;
    let (signatures, pq_bindings) = parse_signatures_and_bindings(&v)?;
    Ok(RuntimeManifestFile {
        manifest,
        signatures,
        pq_bindings,
        lock_text: v
            .get("lockJson")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("lockJson"))?
            .to_owned(),
    })
}

/// Verifies the manifest against `trust`, the clock and the last accepted sequence, given the fingerprints the
/// lock it carries names as upstream signers.
///
/// # Errors
/// `bad-trust`, `not-enough-signatures`, `pq-signature-required`, `lock-mismatch`, `expired`, `rollback`,
/// `signer-revoked` or `bad-manifest`.
pub fn verify_manifest(
    file: &RuntimeManifestFile,
    lock_signers: &[String],
    trust: &Trust,
    now_ms: u64,
    last_sequence: Option<u64>,
) -> Result<Verified, Refusal> {
    let m = &file.manifest;
    let canonical = m.canonical()?;
    let authorised = trust_set(trust)?;
    let pinned: HashSet<String> = trust
        .pq_key_ids
        .iter()
        .map(|k| k.to_ascii_lowercase())
        .collect();
    if pinned.iter().any(|k| !is_hex(k, 64)) {
        return Err(Refusal::with("bad-trust", "pq-key-id"));
    }
    let v1_digest = sha256_hex(canonical.as_bytes());
    let need_pq = !pinned.is_empty()
        && !trust
            .legacy_manifests
            .iter()
            .any(|d| d.eq_ignore_ascii_case(&v1_digest));
    let bound = if need_pq {
        bound_keys(&file.pq_bindings, &pinned, now_ms)
    } else {
        std::collections::HashMap::new()
    };
    let signed = count_signatures(&Signed {
        canonical: &canonical,
        tag_v1: TAG_V1,
        tag_v2: TAG_V2,
        signatures: &file.signatures,
        authorised: &authorised,
        threshold: trust.threshold,
        need_pq,
        bound: &bound,
        v1_digest: &v1_digest,
    })?;
    if sha256_hex(file.lock_text.as_bytes()) != m.lock_sha256 {
        return Err(Refusal::new("lock-mismatch"));
    }
    if now_ms > m.valid_until {
        return Err(Refusal::new("expired"));
    }
    if last_sequence.is_some_and(|last| m.sequence <= last) {
        return Err(Refusal::new("rollback"));
    }
    let revoked: HashSet<&str> = m.revoked_signers.iter().map(String::as_str).collect();
    if lock_signers
        .iter()
        .any(|f| revoked.contains(f.to_ascii_lowercase().as_str()))
    {
        return Err(Refusal::new("signer-revoked"));
    }
    if semver(&m.version) < semver(&m.security_floor) {
        return Err(bad("version below its own floor"));
    }
    Ok(Verified {
        version: m.version.clone(),
        sequence: m.sequence,
        valid_until: m.valid_until,
        signers: signed.len(),
    })
}

/// [`verify_manifest`] for a real file: the lock text is parsed, bound to the manifest's version, and its signer
/// fingerprints are the ones checked against the revocation list.
///
/// # Errors
/// The refusals of [`verify_manifest`], `bad-runtime-lock` for an unparsable lock, `bad-manifest` when the lock is
/// not the manifest's version.
pub fn verify_file(
    file: &RuntimeManifestFile,
    trust: &Trust,
    now_ms: u64,
    last_sequence: Option<u64>,
) -> Result<(Verified, Lock), Refusal> {
    let lock = Lock::parse(&file.lock_text)?;
    if lock.version != file.manifest.version {
        return Err(bad("the lock is not the manifest's version"));
    }
    let signers: Vec<String> = lock.signers.iter().map(|s| s.fingerprint.clone()).collect();
    let v = verify_manifest(file, &signers, trust, now_ms, last_sequence)?;
    Ok((v, lock))
}

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
    /// The Flagship product release (`major.minor[.patch]`).
    pub release: String,
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
    pub release: String,
    pub security_floor: String,
    pub lock_sha256: String,
    pub revoked_signers: Vec<String>,
    /// SHA-256 of the canonical v1 bytes: two manifests with one sequence must be the same manifest.
    pub digest: String,
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

fn release_ok(r: &str) -> bool {
    let parts: Vec<&str> = r.split('.').collect();
    (2..=3).contains(&parts.len())
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.len() <= 9
                && p.bytes().all(|b| b.is_ascii_digit())
                && (*p == "0" || !p.starts_with('0'))
        })
}

impl RuntimeManifest {
    fn check(&self) -> Result<(), Refusal> {
        if semver(&self.version).is_none() || semver(&self.security_floor).is_none() {
            return Err(bad("version"));
        }
        if !release_ok(&self.release) {
            return Err(bad("release"));
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

    /// `flagship/runtime-manifest/v1|node|<version>|<lockSha256>|<floor>|<release>|<sequence>|<issuedAt>|<validUntil>|<revoked>`.
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
            "{TAG_V1}|node|{}|{}|{}|{}|{}|{}|{}|{revoked}",
            self.version,
            self.lock_sha256,
            self.security_floor,
            self.release,
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
        release: s("release")?,
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
        release: m.release.clone(),
        security_floor: m.security_floor.clone(),
        lock_sha256: m.lock_sha256.clone(),
        revoked_signers: m.revoked_signers.clone(),
        digest: v1_digest,
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

/// How a VERIFIED manifest binds an endorsed release's own lock (the one its signed artifact carries); the twin of
/// `checkReleaseLock` in TypeScript. A release may lock a newer runtime than the manifest names (it ships before the
/// manifest is republished), but never one below the manifest's floor, never a different lock for the same version,
/// and never one that names a withdrawn signer.
///
/// # Errors
/// `runtime-below-floor`, `runtime-manifest-mismatch` or `signer-revoked`.
pub fn check_release_lock(
    m: &Verified,
    lock_text: &str,
    version: &str,
    signers: &[String],
) -> Result<(), Refusal> {
    match (semver(version), semver(&m.security_floor)) {
        (Some(v), Some(f)) if v >= f => {}
        _ => return Err(Refusal::new("runtime-below-floor")),
    }
    if version == m.version && sha256_hex(lock_text.as_bytes()) != m.lock_sha256 {
        return Err(Refusal::new("runtime-manifest-mismatch"));
    }
    if signers
        .iter()
        .any(|f| m.revoked_signers.iter().any(|r| r.eq_ignore_ascii_case(f)))
    {
        return Err(Refusal::new("signer-revoked"));
    }
    Ok(())
}

/// What a box last accepted: `<state>/runtime-manifest-accepted` holds `<sequence> <digest> <floor> <revoked>`
/// (`revoked` comma-separated, `-` for none; files written before the floor was kept have only the first two).
pub const ACCEPTED: &str = "runtime-manifest-accepted";

/// The security floor and withdrawn upstream signers of the last manifest the box accepted. They keep applying to
/// every install after that manifest stops being published, expires or cannot be fetched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptedPolicy {
    pub security_floor: String,
    pub revoked_signers: Vec<String>,
}

struct Accepted {
    sequence: u64,
    digest: String,
    policy: Option<AcceptedPolicy>,
}

fn read_accepted(state: &std::path::Path) -> Option<Accepted> {
    let t = crate::fsutil::read_own(&state.join(ACCEPTED))?;
    let mut it = t.split_whitespace();
    let sequence = it.next()?.parse().ok()?;
    let digest = it.next()?.to_owned();
    let policy = it
        .next()
        .filter(|f| semver(f).is_some())
        .map(|floor| AcceptedPolicy {
            security_floor: floor.to_owned(),
            revoked_signers: it
                .next()
                .filter(|r| *r != "-")
                .map(|r| r.split(',').map(str::to_ascii_lowercase).collect())
                .unwrap_or_default(),
        });
    Some(Accepted {
        sequence,
        digest,
        policy,
    })
}

/// The floor and revocations this box recorded, if it ever accepted a manifest that carried them.
#[must_use]
pub fn accepted_policy(state: &std::path::Path) -> Option<AcceptedPolicy> {
    read_accepted(state)?.policy
}

/// An install with no fresh manifest still honours the recorded one: a runtime below its floor, or a lock naming a
/// signer it withdrew, is refused.
///
/// # Errors
/// `runtime-below-floor` or `signer-revoked`.
pub fn check_accepted_policy(
    p: &AcceptedPolicy,
    version: &str,
    signers: &[String],
) -> Result<(), Refusal> {
    match (semver(version), semver(&p.security_floor)) {
        (Some(v), Some(f)) if v >= f => {}
        _ => return Err(Refusal::new("runtime-below-floor")),
    }
    if signers
        .iter()
        .any(|f| p.revoked_signers.iter().any(|r| r.eq_ignore_ascii_case(f)))
    {
        return Err(Refusal::new("signer-revoked"));
    }
    Ok(())
}

/// Verifies a manifest for USE on a box: the sequence may equal the last accepted one only when it is the very same
/// manifest (a box re-reads the current one every day), never lower. With `record`, an accepted manifest is recorded
/// so a later replay of an older one is refused even after the newer one disappears from the site; a status read
/// passes `false` and changes nothing.
///
/// # Errors
/// The refusals of [`verify_file`]; `rollback` also for a different manifest under an already accepted sequence.
pub fn accept(
    file: &RuntimeManifestFile,
    trust: &Trust,
    now_ms: u64,
    state: &std::path::Path,
    record: bool,
) -> Result<(Verified, Lock), Refusal> {
    let last = read_accepted(state);
    let (v, lock) = verify_file(
        file,
        trust,
        now_ms,
        last.as_ref().map(|a| a.sequence.saturating_sub(1)),
    )?;
    if let Some(a) = &last
        && v.sequence == a.sequence
        && v.digest != a.digest
    {
        return Err(Refusal::with(
            "rollback",
            "another manifest under an accepted sequence",
        ));
    }
    if record
        && last
            .as_ref()
            .is_none_or(|a| v.sequence > a.sequence || a.policy.is_none())
    {
        let mut revoked: Vec<String> = v
            .revoked_signers
            .iter()
            .map(|r| r.to_ascii_lowercase())
            .collect();
        revoked.sort();
        let revoked = if revoked.is_empty() {
            "-".to_owned()
        } else {
            revoked.join(",")
        };
        std::fs::create_dir_all(state)
            .and_then(|()| {
                crate::fsutil::write_durable(
                    &state.join(ACCEPTED),
                    format!(
                        "{} {} {} {revoked}\n",
                        v.sequence, v.digest, v.security_floor
                    )
                    .as_bytes(),
                    0o644,
                )
            })
            .map_err(|e| Refusal::with("install-failed", e.to_string()))?;
    }
    Ok((v, lock))
}

//! The PQ half of a release endorsement (`flagship/release-endorsement/v2`),
//! the Rust twin of `packages/protocol/src/releaseEndorsementPq.ts`. Spec:
//! `docs/architecture-v2/pq-suites.md` §12. DRAFT, pending Q01 review.
//!
//! A release is endorsed by the maintainers v1 `ReleaseEndorsement` (Ed25519
//! over `maintainers/release/v1|...`) and, once the pin names a release key,
//! also by a hybrid companion over
//!
//! `flagship/release-endorsement/v2|<releaseId>|<semverTag>|<commitHash>|<previousReleaseId>|<previousCommitHash>|<intermediateMerkleRoot>|<v1Digest>|<signedBy>|<keyId>`
//!
//! under a `release-key` binding whose key id the pin names. Endorsements on
//! the chain that ends at the pin's marker stay valid for lineage only.

use core::fmt;
use flagship_protocol::SuiteId;
use flagship_protocol::parse::{encode_lower_hex, parse_lower_hex};
use sha2::{Digest, Sha256};

use crate::ed25519_strict;
use crate::key_id::key_id;
use crate::trust::{
    BindingWire, Envelope, Expectation, PolicyState, Profile, Role, Rollout, TrustError,
    VerifiedBinding, verify_binding, verify_critical_signature,
};

pub const TAG_RELEASE_ENDORSEMENT_V2: &str = "flagship/release-endorsement/v2";
pub const RELEASE_BINDING_SUBJECT: &str = "flagship-release";
pub const COMPANION_KIND: &str = "ReleaseEndorsementPq";
const V1_TAG: &str = "maintainers/release/v1";

/// The release gate's scope: strict and enforced, always.
pub const RELEASE_POLICY: PolicyState = PolicyState {
    profile: Profile::Strict,
    rollout: Rollout::Enforced,
};

/// Every refusal; `code()` matches the TypeScript `ReleasePqError.code`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseError {
    PqMissing,
    PqMalformed,
    PqMismatch,
    PqKeyNotPinned,
    V1Malformed,
    V1Signature,
    Trust(TrustError),
}

impl ReleaseError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::PqMissing => "pq-missing",
            Self::PqMalformed => "pq-malformed",
            Self::PqMismatch => "pq-mismatch",
            Self::PqKeyNotPinned => "pq-key-not-pinned",
            Self::V1Malformed => "v1-malformed",
            Self::V1Signature => "v1-signature",
            Self::Trust(t) => t.code(),
        }
    }
}

impl fmt::Display for ReleaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for ReleaseError {}

/// A maintainers v1 `ReleaseEndorsement`, fields as they travel.
#[derive(Clone, Copy, Debug)]
pub struct ReleaseV1<'a> {
    pub release_id: &'a str,
    pub semver_tag: &'a str,
    pub commit_hash: &'a str,
    pub previous_release_id: Option<&'a str>,
    pub previous_commit_hash: Option<&'a str>,
    pub intermediate_merkle_root: &'a str,
    pub endorsed_notes: Option<&'a str>,
    pub issued_at: &'a str,
    pub signed_by: &'a str,
    /// `(pubkey, sig)` hex pairs.
    pub signatures: &'a [(&'a str, &'a str)],
}

/// The companion as it travels (exact keys are checked by the JSON reader).
#[derive(Clone, Copy, Debug)]
pub struct CompanionWire<'a> {
    pub kind: &'a str,
    pub version: u64,
    pub release_id: &'a str,
    pub commit_hash: &'a str,
    pub v1_digest: &'a str,
    pub key_id: &'a str,
    pub suite: &'a str,
    pub signature: &'a str,
}

/// The pin: accepted release key ids, and the last classical-only endorsement.
#[derive(Clone, Copy, Debug)]
pub struct Pin<'a> {
    pub key_ids: &'a [&'a str],
    /// `(releaseId, commitHash)`.
    pub require_pq_after: Option<(&'a str, &'a str)>,
}

impl Pin<'_> {
    #[must_use]
    pub const fn configured(&self) -> bool {
        !self.key_ids.is_empty()
    }

    fn pins(&self, key_id_hex: &str) -> bool {
        self.key_ids
            .iter()
            .any(|k| k.eq_ignore_ascii_case(key_id_hex))
    }
}

fn field_ok(s: &str) -> bool {
    !s.bytes().any(|c| c == b'|' || c <= 0x1f || c == 0x7f)
}

fn lower_hex_len(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// `maintainers/release/v1|...`, with the maintainers library's field checks.
///
/// # Errors
/// [`ReleaseError::V1Malformed`].
pub fn v1_canonical(e: &ReleaseV1<'_>) -> Result<Vec<u8>, ReleaseError> {
    let prev = e.previous_release_id.unwrap_or("");
    let prev_commit = e.previous_commit_hash.unwrap_or("");
    let notes = e.endorsed_notes.unwrap_or("");
    let ok = field_ok(e.release_id)
        && field_ok(e.semver_tag)
        && lower_hex_len(e.commit_hash, 40)
        && field_ok(prev)
        && (prev_commit.is_empty() || lower_hex_len(prev_commit, 40))
        && lower_hex_len(e.intermediate_merkle_root, 64)
        && field_ok(notes)
        && field_ok(e.issued_at)
        && lower_hex_len(e.signed_by, 64);
    if !ok {
        return Err(ReleaseError::V1Malformed);
    }
    Ok([
        V1_TAG,
        e.release_id,
        e.semver_tag,
        e.commit_hash,
        prev,
        prev_commit,
        e.intermediate_merkle_root,
        notes,
        e.issued_at,
        e.signed_by,
    ]
    .join("|")
    .into_bytes())
}

/// SHA-256 of the v1 canonical bytes, lowercase hex.
///
/// # Errors
/// [`ReleaseError::V1Malformed`].
pub fn v1_digest(e: &ReleaseV1<'_>) -> Result<String, ReleaseError> {
    Ok(encode_lower_hex(&Sha256::digest(v1_canonical(e)?)))
}

/// The statement the hybrid release key signs.
///
/// # Errors
/// [`ReleaseError::V1Malformed`] or [`ReleaseError::PqMalformed`].
pub fn v2_statement(e: &ReleaseV1<'_>, key_id_hex: &str) -> Result<Vec<u8>, ReleaseError> {
    let digest = v1_digest(e)?;
    if !lower_hex_len(key_id_hex, 64) {
        return Err(ReleaseError::PqMalformed);
    }
    Ok([
        TAG_RELEASE_ENDORSEMENT_V2,
        e.release_id,
        e.semver_tag,
        e.commit_hash,
        e.previous_release_id.unwrap_or(""),
        e.previous_commit_hash.unwrap_or(""),
        e.intermediate_merkle_root,
        &digest,
        e.signed_by,
        key_id_hex,
    ]
    .join("|")
    .into_bytes())
}

fn binding_key_id(b: &VerifiedBinding) -> String {
    encode_lower_hex(&key_id(
        SuiteId::HybridSigEd25519MlDsa65V1,
        b.hybrid_key().as_bytes(),
    ))
}

/// Verifies release-key bindings; only one whose key id the pin names counts.
#[must_use]
pub fn verify_release_bindings(
    wires: &[BindingWire<'_>],
    pin: &Pin<'_>,
    now: u64,
) -> (Vec<VerifiedBinding>, Vec<(Option<String>, &'static str)>) {
    let mut ok = Vec::new();
    let mut errors = Vec::new();
    for w in wires {
        let mut pk = String::with_capacity(
            w.ed25519_pub_hex
                .len()
                .saturating_add(w.mldsa_pub_hex.len()),
        );
        pk.push_str(w.ed25519_pub_hex);
        pk.push_str(w.mldsa_pub_hex);
        let id = parse_lower_hex(&pk, 0, 1 << 16)
            .ok()
            .map(|b| encode_lower_hex(&key_id(SuiteId::HybridSigEd25519MlDsa65V1, &b)));
        if let Some(id) = &id
            && !pin.pins(id)
        {
            errors.push((Some(id.clone()), "pq-key-not-pinned"));
            continue;
        }
        let e = Expectation {
            role: Role::ReleaseKey,
            subject_id: RELEASE_BINDING_SUBJECT,
            ed25519_pub_hex: w.ed25519_pub_hex,
            mldsa_pub_hex: None,
            now,
            min_issued_at: None,
        };
        match verify_binding(w, &e) {
            Ok(b) => ok.push(b),
            Err(t) => errors.push((id, t.code())),
        }
    }
    (ok, errors)
}

/// Verifies one endorsement's v1 signature and its companion, in the
/// TypeScript port's order. Returns the key id that verified.
///
/// # Errors
/// Any [`ReleaseError`].
pub fn verify_companion(
    e: &ReleaseV1<'_>,
    wire: Option<&CompanionWire<'_>>,
    pin: &Pin<'_>,
    bindings: &[VerifiedBinding],
) -> Result<String, ReleaseError> {
    let w = wire.ok_or(ReleaseError::PqMissing)?;
    let shape = w.kind == COMPANION_KIND
        && w.version == 2
        && !w.release_id.is_empty()
        && w.release_id.len() <= 128
        && lower_hex_len(w.commit_hash, 40)
        && lower_hex_len(w.v1_digest, 64)
        && lower_hex_len(w.key_id, 64)
        && w.suite.len() <= 64
        && parse_lower_hex(w.signature, 0, 1 << 16).is_ok();
    if !shape {
        return Err(ReleaseError::PqMalformed);
    }
    let digest = v1_digest(e)?;
    if w.release_id != e.release_id
        || !w.commit_hash.eq_ignore_ascii_case(e.commit_hash)
        || w.v1_digest != digest
    {
        return Err(ReleaseError::PqMismatch);
    }
    if !pin.pins(w.key_id) {
        return Err(ReleaseError::PqKeyNotPinned);
    }
    let binding = bindings
        .iter()
        .find(|b| binding_key_id(b) == w.key_id)
        .ok_or(ReleaseError::Trust(TrustError::NoBinding))?;
    let signed_by = e.signed_by.to_ascii_lowercase();
    if encode_lower_hex(binding.ed25519_pub()) != signed_by {
        return Err(ReleaseError::Trust(TrustError::BindingKeyMismatch));
    }
    let v1_sig = e
        .signatures
        .iter()
        .find(|(pk, _)| pk.eq_ignore_ascii_case(&signed_by))
        .and_then(|(_, sig)| {
            parse_lower_hex(&sig.to_ascii_lowercase(), 64, 64)
                .ok()
                .and_then(|b| <[u8; 64]>::try_from(b.as_slice()).ok())
        })
        .ok_or(ReleaseError::V1Signature)?;
    let vk =
        ed25519_strict::parse_public(binding.ed25519_pub()).ok_or(ReleaseError::V1Signature)?;
    if !ed25519_strict::verify(&vk, &v1_canonical(e)?, &v1_sig) {
        return Err(ReleaseError::V1Signature);
    }
    verify_critical_signature(
        &v2_statement(e, w.key_id)?,
        TAG_RELEASE_ENDORSEMENT_V2,
        Envelope {
            suite: w.suite,
            signature_hex: w.signature,
        },
        &signed_by,
        Some(binding),
        &RELEASE_POLICY,
    )
    .map_err(ReleaseError::Trust)?;
    Ok(w.key_id.to_owned())
}

/// Endorsements (oldest first, already past the v1 chain check) split by the
/// PQ rule; indices into the input.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Classification {
    pub pinned: bool,
    pub eligible: Vec<usize>,
    pub lineage_only: Vec<usize>,
    pub refused: Vec<(usize, &'static str)>,
}

#[must_use]
pub fn classify(
    endorsements: &[ReleaseV1<'_>],
    companions: &[CompanionWire<'_>],
    bindings: &[VerifiedBinding],
    pin: &Pin<'_>,
) -> Classification {
    if !pin.configured() {
        return Classification {
            pinned: false,
            eligible: (0..endorsements.len()).collect(),
            ..Classification::default()
        };
    }
    let legacy = legacy_set(endorsements, pin);
    let mut out = Classification {
        pinned: true,
        ..Classification::default()
    };
    for (i, e) in endorsements.iter().enumerate() {
        let mut code = "pq-missing";
        let mut ok = false;
        for c in companions.iter().filter(|c| c.release_id == e.release_id) {
            match verify_companion(e, Some(c), pin, bindings) {
                Ok(_) => {
                    ok = true;
                    break;
                }
                Err(err) => code = err.code(),
            }
        }
        if ok {
            out.eligible.push(i);
        } else if legacy.contains(&i) {
            out.lineage_only.push(i);
        } else {
            out.refused.push((i, code));
        }
    }
    out
}

fn legacy_set(endorsements: &[ReleaseV1<'_>], pin: &Pin<'_>) -> Vec<usize> {
    let mut out = Vec::new();
    let Some((rid, commit)) = pin.require_pq_after else {
        return out;
    };
    let find = |id: &str| endorsements.iter().position(|e| e.release_id == id);
    let mut cur = find(rid).filter(|&i| {
        endorsements
            .get(i)
            .is_some_and(|e| e.commit_hash.eq_ignore_ascii_case(commit))
    });
    while let Some(i) = cur {
        if out.contains(&i) {
            break;
        }
        out.push(i);
        cur = endorsements
            .get(i)
            .and_then(|e| e.previous_release_id)
            .and_then(find);
    }
    out
}

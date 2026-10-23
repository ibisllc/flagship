//! Key bindings (`flagship/pq-key-binding/v1`) and the critical-signature
//! gate, the Rust twin of `packages/protocol/src/pqTrust.ts`. Spec:
//! `docs/architecture-v2/pq-suites.md` §9-§10. DRAFT, pending Q01 review.
//!
//! A binding is an identity's Ed25519 key and its ML-DSA-65 key signing one
//! statement together with the hybrid suite, so each proves possession for
//! the other:
//!
//! `flagship/pq-key-binding/v1|<role>|<subjectId>|<ed25519PubHex>|<mldsa65PubHex>|<issuedAt>`
//!
//! The gate accepts a critical message with the classical Ed25519 signature
//! or the hybrid one, except while the scope's strict profile is in force:
//! then only the hybrid AND-signature over a bound key. The policy, never the
//! envelope, decides, so stripping the suite cannot downgrade a strict scope.

use core::fmt;
use flagship_protocol::parse::{
    TagNamespace, encode_lower_hex, parse_lower_hex, validate_purpose_tag,
};

use crate::ed25519_strict;
use crate::error::CryptoError;
use crate::sig::{
    ED25519_PK_LEN, ED25519_SIG_LEN, HybridVerifyingKey, MLDSA65_PK_LEN, SIGNATURE_LEN,
};

pub const TAG_PQ_KEY_BINDING: &str = "flagship/pq-key-binding/v1";
/// How far ahead of the verifier's clock a binding may be dated (ms).
pub const MAX_SKEW_MS: u64 = 300_000;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// Every refusal; `code()` matches the TypeScript `PqTrustError.code`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustError {
    BindingMalformed,
    BindingRole,
    BindingSubject,
    BindingKeyMismatch,
    BindingPqKeyChanged,
    BindingFuture,
    BindingStale,
    BadPublicKey,
    BadSignature,
    BadPurpose,
    PurposeMismatch,
    UnknownSuite,
    StrictRequiresHybrid,
    StrictRequiresBinding,
    NoBinding,
}

impl TrustError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::BindingMalformed => "binding-malformed",
            Self::BindingRole => "binding-role",
            Self::BindingSubject => "binding-subject",
            Self::BindingKeyMismatch => "binding-key-mismatch",
            Self::BindingPqKeyChanged => "binding-pq-key-changed",
            Self::BindingFuture => "binding-future",
            Self::BindingStale => "binding-stale",
            Self::BadPublicKey => "bad-public-key",
            Self::BadSignature => "bad-signature",
            Self::BadPurpose => "bad-purpose",
            Self::PurposeMismatch => "purpose-mismatch",
            Self::UnknownSuite => "unknown-suite",
            Self::StrictRequiresHybrid => "strict-requires-hybrid",
            Self::StrictRequiresBinding => "strict-requires-binding",
            Self::NoBinding => "no-binding",
        }
    }
}

impl fmt::Display for TrustError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for TrustError {}

/// Whose key a binding is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    AccountIrk,
    AdminRoot,
    Device,
    BoxStk,
    BootKey,
}

impl Role {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AccountIrk => "account-irk",
            Self::AdminRoot => "admin-root",
            Self::Device => "device",
            Self::BoxStk => "box-stk",
            Self::BootKey => "boot-key",
        }
    }

    /// # Errors
    /// [`TrustError::BindingRole`] for any other string.
    pub fn parse(s: &str) -> Result<Self, TrustError> {
        match s {
            "account-irk" => Ok(Self::AccountIrk),
            "admin-root" => Ok(Self::AdminRoot),
            "device" => Ok(Self::Device),
            "box-stk" => Ok(Self::BoxStk),
            "boot-key" => Ok(Self::BootKey),
            _ => Err(TrustError::BindingRole),
        }
    }
}

/// `^[a-z0-9][a-z0-9._:@-]{0,252}$`
fn subject_ok(s: &str) -> bool {
    let b = s.as_bytes();
    let Some((first, rest)) = b.split_first() else {
        return false;
    };
    b.len() <= 253
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && rest.iter().all(|c| {
            c.is_ascii_lowercase()
                || c.is_ascii_digit()
                || matches!(c, b'.' | b'_' | b':' | b'@' | b'-')
        })
}

/// A binding as it travels (all hex lowercase).
#[derive(Clone, Copy, Debug)]
pub struct BindingWire<'a> {
    pub role: &'a str,
    pub subject_id: &'a str,
    pub ed25519_pub_hex: &'a str,
    pub mldsa_pub_hex: &'a str,
    pub issued_at: u64,
    pub signature_hex: &'a str,
}

/// What the verifier already trusts about the identity.
#[derive(Clone, Copy, Debug)]
pub struct Expectation<'a> {
    pub role: Role,
    pub subject_id: &'a str,
    /// The trusted (pinned or registered) Ed25519 key.
    pub ed25519_pub_hex: &'a str,
    /// The ML-DSA key already pinned, if any; a different one is refused.
    pub mldsa_pub_hex: Option<&'a str>,
    pub now: u64,
    /// Refuse a binding dated before this.
    pub min_issued_at: Option<u64>,
}

/// A verified binding. Only [`verify_binding`] makes one.
#[derive(Clone, Debug)]
pub struct VerifiedBinding {
    role: Role,
    subject_id: String,
    ed25519_pub: [u8; ED25519_PK_LEN],
    issued_at: u64,
    key: HybridVerifyingKey,
}

impl VerifiedBinding {
    #[must_use]
    pub const fn role(&self) -> Role {
        self.role
    }
    #[must_use]
    pub fn subject_id(&self) -> &str {
        &self.subject_id
    }
    #[must_use]
    pub const fn ed25519_pub(&self) -> &[u8; ED25519_PK_LEN] {
        &self.ed25519_pub
    }
    #[must_use]
    pub const fn issued_at(&self) -> u64 {
        self.issued_at
    }
    #[must_use]
    pub const fn hybrid_key(&self) -> &HybridVerifyingKey {
        &self.key
    }
}

/// The statement both keys sign.
///
/// # Errors
/// [`TrustError::BindingRole`], [`TrustError::BindingSubject`] or
/// [`TrustError::BindingMalformed`].
pub fn canonical_binding(
    role: &str,
    subject_id: &str,
    ed25519_pub_hex: &str,
    mldsa_pub_hex: &str,
    issued_at: u64,
) -> Result<Vec<u8>, TrustError> {
    let role = Role::parse(role)?;
    if !subject_ok(subject_id) {
        return Err(TrustError::BindingSubject);
    }
    parse_lower_hex(ed25519_pub_hex, ED25519_PK_LEN, ED25519_PK_LEN)
        .map_err(|_| TrustError::BindingMalformed)?;
    parse_lower_hex(mldsa_pub_hex, MLDSA65_PK_LEN, MLDSA65_PK_LEN)
        .map_err(|_| TrustError::BindingMalformed)?;
    if issued_at > MAX_SAFE_INTEGER {
        return Err(TrustError::BindingMalformed);
    }
    Ok(format!(
        "{TAG_PQ_KEY_BINDING}|{}|{subject_id}|{ed25519_pub_hex}|{mldsa_pub_hex}|{issued_at}",
        role.as_str()
    )
    .into_bytes())
}

/// Verifies a binding, in the same order as the TypeScript port.
///
/// # Errors
/// Any [`TrustError`] of the binding kind, `bad-public-key` or `bad-signature`.
pub fn verify_binding(
    w: &BindingWire<'_>,
    e: &Expectation<'_>,
) -> Result<VerifiedBinding, TrustError> {
    parse_lower_hex(w.signature_hex, 0, 1 << 16).map_err(|_| TrustError::BindingMalformed)?;
    let ed = parse_lower_hex(w.ed25519_pub_hex, ED25519_PK_LEN, ED25519_PK_LEN)
        .map_err(|_| TrustError::BindingMalformed)?;
    let ml = parse_lower_hex(w.mldsa_pub_hex, MLDSA65_PK_LEN, MLDSA65_PK_LEN)
        .map_err(|_| TrustError::BindingMalformed)?;
    if w.issued_at > MAX_SAFE_INTEGER {
        return Err(TrustError::BindingMalformed);
    }
    let role = Role::parse(w.role)?;
    if !subject_ok(w.subject_id) {
        return Err(TrustError::BindingSubject);
    }
    if role != e.role {
        return Err(TrustError::BindingRole);
    }
    if w.subject_id != e.subject_id {
        return Err(TrustError::BindingSubject);
    }
    if !w.ed25519_pub_hex.eq_ignore_ascii_case(e.ed25519_pub_hex) {
        return Err(TrustError::BindingKeyMismatch);
    }
    if let Some(pinned) = e.mldsa_pub_hex
        && !pinned.is_empty()
        && !w.mldsa_pub_hex.eq_ignore_ascii_case(pinned)
    {
        return Err(TrustError::BindingPqKeyChanged);
    }
    if w.issued_at > e.now.saturating_add(MAX_SKEW_MS) {
        return Err(TrustError::BindingFuture);
    }
    if e.min_issued_at.is_some_and(|m| w.issued_at < m) {
        return Err(TrustError::BindingStale);
    }
    let mut pk = Vec::with_capacity(ed.len().saturating_add(ml.len()));
    pk.extend_from_slice(&ed);
    pk.extend_from_slice(&ml);
    let key = HybridVerifyingKey::from_bytes(&pk).map_err(|_| TrustError::BadPublicKey)?;
    let sig =
        parse_lower_hex(w.signature_hex, 0, 1 << 16).map_err(|_| TrustError::BindingMalformed)?;
    let stmt = canonical_binding(
        w.role,
        w.subject_id,
        w.ed25519_pub_hex,
        w.mldsa_pub_hex,
        w.issued_at,
    )?;
    key.verify(TAG_PQ_KEY_BINDING, &stmt, &sig)
        .map_err(|_| TrustError::BadSignature)?;
    let ed25519_pub = <[u8; ED25519_PK_LEN]>::try_from(ed.as_slice())
        .map_err(|_| TrustError::BindingMalformed)?;
    Ok(VerifiedBinding {
        role,
        subject_id: w.subject_id.to_owned(),
        ed25519_pub,
        issued_at: w.issued_at,
        key,
    })
}

// ── policy (the subset of assurancePolicy.ts the gate reads) ──

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    Strict,
    Compatibility,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rollout {
    Legacy,
    Capable,
    Prepared,
    Enforced,
    Retired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PolicyState {
    pub profile: Profile,
    pub rollout: Rollout,
}

impl PolicyState {
    /// An installation before any migration.
    #[must_use]
    pub const fn legacy() -> Self {
        Self {
            profile: Profile::Compatibility,
            rollout: Rollout::Legacy,
        }
    }

    /// True when classical-only messages are refused in this scope.
    #[must_use]
    pub const fn strict_in_force(&self) -> bool {
        matches!(self.profile, Profile::Strict)
            && matches!(self.rollout, Rollout::Enforced | Rollout::Retired)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignatureSuite {
    Ed25519V1,
    HybridEd25519MlDsa65V1,
}

impl SignatureSuite {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ed25519V1 => "ed25519/v1",
            Self::HybridEd25519MlDsa65V1 => "hybrid-ed25519-mldsa65/v1",
        }
    }
}

/// What the gate accepted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub suite: SignatureSuite,
    pub strict: bool,
}

/// Everything before the first `|`, or "" when there is none or it is not UTF-8.
#[must_use]
pub fn message_purpose(msg: &[u8]) -> &str {
    match msg.iter().position(|&c| c == b'|') {
        Some(i) if i > 0 => msg
            .get(..i)
            .and_then(|h| core::str::from_utf8(h).ok())
            .unwrap_or(""),
        _ => "",
    }
}

/// A critical message's signature, as it travels.
#[derive(Clone, Copy, Debug)]
pub struct Envelope<'a> {
    pub suite: &'a str,
    pub signature_hex: &'a str,
}

/// The one check for a critical signature, in the TypeScript port's order.
///
/// # Errors
/// `bad-purpose`, `purpose-mismatch`, `unknown-suite`, `bad-signature`,
/// `bad-public-key`, `binding-key-mismatch`, `strict-requires-hybrid`,
/// `strict-requires-binding` or `no-binding`.
pub fn verify_critical_signature(
    message: &[u8],
    expected_purpose: &str,
    envelope: Envelope<'_>,
    signer_ed25519_pub_hex: &str,
    binding: Option<&VerifiedBinding>,
    policy: &PolicyState,
) -> Result<Verdict, TrustError> {
    validate_purpose_tag(expected_purpose, TagNamespace::Flagship)
        .map_err(|_| TrustError::BadPurpose)?;
    if message_purpose(message) != expected_purpose {
        return Err(TrustError::PurposeMismatch);
    }
    let suite = match envelope.suite {
        "ed25519/v1" => SignatureSuite::Ed25519V1,
        "hybrid-ed25519-mldsa65/v1" => SignatureSuite::HybridEd25519MlDsa65V1,
        _ => return Err(TrustError::UnknownSuite),
    };
    let sig = parse_lower_hex(envelope.signature_hex, 0, 1 << 16)
        .map_err(|_| TrustError::BadSignature)?;
    let signer = signer_ed25519_pub_hex.to_ascii_lowercase();
    let signer_pub = parse_lower_hex(&signer, ED25519_PK_LEN, ED25519_PK_LEN)
        .map_err(|_| TrustError::BadPublicKey)?;
    if let Some(b) = binding
        && b.ed25519_pub.as_slice() != signer_pub.as_slice()
    {
        return Err(TrustError::BindingKeyMismatch);
    }
    let strict = policy.strict_in_force();
    if strict && suite != SignatureSuite::HybridEd25519MlDsa65V1 {
        return Err(TrustError::StrictRequiresHybrid);
    }
    if strict && binding.is_none() {
        return Err(TrustError::StrictRequiresBinding);
    }
    match suite {
        SignatureSuite::HybridEd25519MlDsa65V1 => {
            let b = binding.ok_or(TrustError::NoBinding)?;
            if sig.len() != SIGNATURE_LEN {
                return Err(TrustError::BadSignature);
            }
            b.key
                .verify(expected_purpose, message, &sig)
                .map_err(|_: CryptoError| TrustError::BadSignature)?;
        }
        SignatureSuite::Ed25519V1 => {
            let sig = <[u8; ED25519_SIG_LEN]>::try_from(sig.as_slice())
                .map_err(|_| TrustError::BadSignature)?;
            let pk = <[u8; ED25519_PK_LEN]>::try_from(signer_pub.as_slice())
                .map_err(|_| TrustError::BadPublicKey)?;
            let vk = ed25519_strict::parse_public(&pk).ok_or(TrustError::BadSignature)?;
            if !ed25519_strict::verify(&vk, message, &sig) {
                return Err(TrustError::BadSignature);
            }
        }
    }
    Ok(Verdict { suite, strict })
}

/// Lowercase hex, for callers building wires.
#[must_use]
pub fn hex(b: &[u8]) -> String {
    encode_lower_hex(b)
}

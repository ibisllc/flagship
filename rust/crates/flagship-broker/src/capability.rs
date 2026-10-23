//! The authority a typed effect needs. A capability is issued by the security authority (not by
//! core), names one operation on one object, and is bound to that object's exact digest, its
//! installation and generation, the revision it expects to find, and the revocation epoch it was
//! issued under. The broker checks all of it itself; nothing the caller asserts is believed.
//!
//! Signatures go through [`CapabilityVerifier`], selected by the suite named in the signed bytes,
//! so a hybrid Ed25519+ML-DSA suite can replace Ed25519 without changing any caller.

use ed25519_dalek::{Signature, VerifyingKey};
use flagship_runtime::{Digest, InstallationId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

pub const CAPABILITY_TAG: &str = "flagship/broker-capability/v1";
pub const EPOCH_TAG: &str = "flagship/revocation-epoch/v1";
pub const SUITE_ED25519: &str = "ed25519";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpKind {
    PrepareAppVolume,
    ApplyNetworkPolicy,
    StartApprovedWorkload,
    StopWorkload,
    ActivateRelease,
    RequestShutdown,
}

impl OpKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PrepareAppVolume => "prepare-app-volume",
            Self::ApplyNetworkPolicy => "apply-network-policy",
            Self::StartApprovedWorkload => "start-approved-workload",
            Self::StopWorkload => "stop-workload",
            Self::ActivateRelease => "activate-release",
            Self::RequestShutdown => "request-shutdown",
        }
    }
    /// Host-wide effects have no installation.
    pub fn is_host(self) -> bool {
        matches!(self, Self::ActivateRelease | Self::RequestShutdown)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignatureEnvelope {
    pub suite: String,
    pub key_id: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capability {
    pub v: u32,
    /// 128 random bits, lowercase hex. Consumed once.
    pub id: String,
    pub op: OpKind,
    pub installation: Option<InstallationId>,
    pub generation: u64,
    pub expected_prior_revision: u64,
    pub subject: Digest,
    pub revocation_epoch: u64,
    pub not_before: u64,
    pub expires_at: u64,
    pub signature: SignatureEnvelope,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorityError {
    Malformed(String),
    UnknownSuite,
    UnknownKey,
    BadSignature,
}

impl fmt::Display for AuthorityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed(m) => write!(f, "the capability is malformed: {m}"),
            Self::UnknownSuite => f.write_str("the capability's signature suite is not accepted"),
            Self::UnknownKey => {
                f.write_str("the capability is signed by a key this broker does not trust")
            }
            Self::BadSignature => f.write_str("the capability's signature does not verify"),
        }
    }
}

fn is_token(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

impl Capability {
    pub fn check_shape(&self) -> Result<(), AuthorityError> {
        let m = |s: &str| Err(AuthorityError::Malformed(s.to_owned()));
        if self.v != 1 {
            return m("unknown version");
        }
        if self.id.len() != 32
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return m("id must be 32 lowercase hex");
        }
        if self.op.is_host() != self.installation.is_none() {
            return m("host operations name no installation and app operations name one");
        }
        if self.generation > i64::MAX as u64
            || self.expected_prior_revision >= i64::MAX as u64
            || self.revocation_epoch > i64::MAX as u64
        {
            return m("a counter is out of range");
        }
        if self.expires_at <= self.not_before || self.expires_at > i64::MAX as u64 {
            return m("expiry must follow not-before");
        }
        if !is_token(&self.signature.suite, 32) || !is_token(&self.signature.key_id, 64) {
            return m("bad signature envelope");
        }
        Ok(())
    }

    /// The signed bytes. The suite and key id are inside them, so a signature cannot be moved to
    /// a weaker suite or another key.
    pub fn signed_bytes(&self) -> Vec<u8> {
        let inst = self
            .installation
            .as_ref()
            .map_or("-", InstallationId::as_str);
        format!(
            "{CAPABILITY_TAG}|{}|{}|{inst}|{}|{}|{}|{}|{}|{}|{}|{}",
            self.id,
            self.op.as_str(),
            self.generation,
            self.expected_prior_revision,
            self.subject,
            self.revocation_epoch,
            self.not_before,
            self.expires_at,
            self.signature.suite,
            self.signature.key_id
        )
        .into_bytes()
    }
}

/// A signed statement from the authority that every capability below `epoch` is revoked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EpochStatement {
    pub epoch: u64,
    pub issued_at: u64,
    pub signature: SignatureEnvelope,
}

impl EpochStatement {
    pub fn signed_bytes(&self) -> Vec<u8> {
        format!(
            "{EPOCH_TAG}|{}|{}|{}|{}",
            self.epoch, self.issued_at, self.signature.suite, self.signature.key_id
        )
        .into_bytes()
    }
}

pub trait CapabilityVerifier: Send + Sync {
    fn verify(&self, message: &[u8], signature: &SignatureEnvelope) -> Result<(), AuthorityError>;
}

/// Ed25519 (strict verification: no malleable or small-order signatures) over pinned keys.
#[derive(Debug, Clone, Default)]
pub struct Ed25519Authority {
    keys: BTreeMap<String, VerifyingKey>,
}

impl Ed25519Authority {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with_key(mut self, key_id: &str, public_key: [u8; 32]) -> Result<Self, AuthorityError> {
        let k = VerifyingKey::from_bytes(&public_key)
            .map_err(|_| AuthorityError::Malformed("bad public key".into()))?;
        if k.is_weak() {
            return Err(AuthorityError::Malformed("weak public key".into()));
        }
        self.keys.insert(key_id.to_owned(), k);
        Ok(self)
    }
}

impl CapabilityVerifier for Ed25519Authority {
    fn verify(&self, message: &[u8], sig: &SignatureEnvelope) -> Result<(), AuthorityError> {
        if sig.suite != SUITE_ED25519 {
            return Err(AuthorityError::UnknownSuite);
        }
        let key = self
            .keys
            .get(&sig.key_id)
            .ok_or(AuthorityError::UnknownKey)?;
        let raw = flagship_runtime::hex::decode(&sig.value).ok_or(AuthorityError::BadSignature)?;
        let bytes: [u8; 64] = raw.try_into().map_err(|_| AuthorityError::BadSignature)?;
        key.verify_strict(message, &Signature::from_bytes(&bytes))
            .map_err(|_| AuthorityError::BadSignature)
    }
}

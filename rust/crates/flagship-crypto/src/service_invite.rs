//! The signed messages behind an app's invites, the Rust twin of the create, redeem, accept and revoke parts of
//! `packages/protocol/src/serviceInvite.ts`:
//!
//! ```text
//! flagship/service-invite/create/v1|<inviteId>|<authorAID hex>|<serviceRef>|<secretHash>|<bundle hex>|<issuedAt>[|maxN=<n>][|exp=<ms>]
//! flagship/service-invite/redeem/v1|<secretHash>|<visitorAID hex>|<redeemedAt>
//! flagship/service-invite/accept/v1|<inviteId>|<serviceRef>|<contactAID hex>|<acceptedAt>
//! flagship/service-invite/revoke/v1|<inviteId>|<issuedAt>
//! ```
//!
//! Canonical bytes come from the strict v1 builder (a value that could canonicalise ambiguously is refused, not
//! signed) and every signature is strict Ed25519. WHICH key may sign (the author's IRK, the friend's per-app AID,
//! the contact AID) is the caller's pinned source. Shared vectors:
//! `packages/protocol/test-vectors/service-invite/vectors.json`.

use crate::entitlements::verify;
use flagship_protocol::canonical_v1::CanonicalV1;
use flagship_protocol::error::ProtocolError;
use flagship_protocol::parse::encode_lower_hex;
use sha2::{Digest, Sha256};

pub const TAG_CREATE: &str = "flagship/service-invite/create/v1";
pub const TAG_REDEEM: &str = "flagship/service-invite/redeem/v1";
pub const TAG_ACCEPT: &str = "flagship/service-invite/accept/v1";
pub const TAG_REVOKE: &str = "flagship/service-invite/revoke/v1";

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateServiceInvite {
    pub invite_id: String,
    /// The author's stable AID public key: the identity recorded as the inviter.
    pub author_aid: Vec<u8>,
    pub service_ref: String,
    /// SHA-256 hex of the random 32-byte capability secret in the link.
    pub secret_hash: String,
    /// Hex of the sealed bundle (`.com` stores ciphertext only).
    pub encrypted_bundle: String,
    pub issued_at: u64,
    /// Group link cap: `Some(0)` is unlimited, `None` a single-use personal invite (the v1 bytes).
    pub max_redemptions: Option<u64>,
    /// Optional expiry (epoch ms).
    pub expires_at: Option<u64>,
}

/// # Errors
/// A field with the separator or a control character, or an integer past `Number.MAX_SAFE_INTEGER`.
pub fn create_canonical(c: &CreateServiceInvite) -> Result<String, ProtocolError> {
    let mut b = CanonicalV1::new(TAG_CREATE)?
        .text(&c.invite_id)?
        .hex(&c.author_aid)
        .text(&c.service_ref)?
        .text(&c.secret_hash)?
        .text(&c.encrypted_bundle)?
        .uint(c.issued_at)?;
    if let Some(n) = c.max_redemptions {
        guard(n)?;
        b = b.text(&format!("maxN={n}"))?;
    }
    if let Some(n) = c.expires_at {
        guard(n)?;
        b = b.text(&format!("exp={n}"))?;
    }
    Ok(b.finish_string())
}

fn guard(n: u64) -> Result<(), ProtocolError> {
    // The appended `maxN=` and `exp=` fields keep to the same safe-integer range as every other number.
    if n > MAX_SAFE_INTEGER { Err(ProtocolError::IntegerRange) } else { Ok(()) }
}

#[must_use]
pub fn verify_create(c: &CreateServiceInvite, signature_hex: &str, irk_pub_hex: &str) -> bool {
    create_canonical(c).is_ok_and(|s| verify(&s, signature_hex, irk_pub_hex))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RedeemServiceInvite {
    /// SHA-256 hex of the secret the friend pulled from the link.
    pub secret_hash: String,
    /// The friend's stable per-app AID public key, bound to the invite on first redeem.
    pub visitor_aid: Vec<u8>,
    pub redeemed_at: u64,
}

/// # Errors
/// As [`create_canonical`].
pub fn redeem_canonical(r: &RedeemServiceInvite) -> Result<String, ProtocolError> {
    Ok(CanonicalV1::new(TAG_REDEEM)?.text(&r.secret_hash)?.hex(&r.visitor_aid).uint(r.redeemed_at)?.finish_string())
}

#[must_use]
pub fn verify_redeem(r: &RedeemServiceInvite, signature_hex: &str, visitor_aid_pub_hex: &str) -> bool {
    redeem_canonical(r).is_ok_and(|s| verify(&s, signature_hex, visitor_aid_pub_hex))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptServiceInvite {
    pub invite_id: String,
    pub service_ref: String,
    /// The friend's per-author contact AID public key to be bound.
    pub contact_aid: Vec<u8>,
    pub accepted_at: u64,
}

/// # Errors
/// As [`create_canonical`].
pub fn accept_canonical(a: &AcceptServiceInvite) -> Result<String, ProtocolError> {
    Ok(CanonicalV1::new(TAG_ACCEPT)?.text(&a.invite_id)?.text(&a.service_ref)?.hex(&a.contact_aid).uint(a.accepted_at)?.finish_string())
}

#[must_use]
pub fn verify_accept(a: &AcceptServiceInvite, signature_hex: &str, contact_aid_pub_hex: &str) -> bool {
    accept_canonical(a).is_ok_and(|s| verify(&s, signature_hex, contact_aid_pub_hex))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevokeServiceInvite {
    pub invite_id: String,
    pub issued_at: u64,
}

/// # Errors
/// As [`create_canonical`].
pub fn revoke_canonical(r: &RevokeServiceInvite) -> Result<String, ProtocolError> {
    Ok(CanonicalV1::new(TAG_REVOKE)?.text(&r.invite_id)?.uint(r.issued_at)?.finish_string())
}

#[must_use]
pub fn verify_revoke(r: &RevokeServiceInvite, signature_hex: &str, irk_pub_hex: &str) -> bool {
    revoke_canonical(r).is_ok_and(|s| verify(&s, signature_hex, irk_pub_hex))
}

/// SHA-256 hex of a 32-byte capability secret: the form `.com` stores and indexes.
#[must_use]
pub fn secret_hash(secret: &[u8]) -> String {
    encode_lower_hex(&Sha256::digest(secret))
}

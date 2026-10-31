//! The signed envelopes that make and end a server share, the Rust twin of the grant, revoke, accept, leave and
//! accept-admin parts of `packages/protocol/src/serverShare.ts` (docs/share-a-server.md):
//!
//! ```text
//! flagship/server-share/v1|<domain>|<shareId>|<memberPub>|<view|manage>|<0|1 unlock>|<0|1 appdata>|<label>|<issuedAt>   (owner)
//! flagship/server-share-revoke/v1|<domain>|<shareId>|<issuedAt>                                                        (owner)
//! flagship/server-share-accept/v1|<domain>|<shareId>|<memberPub>|<acceptedAt>                                          (member)
//! flagship/server-share-leave/v1|<domain>|<shareId>|<memberPub>|<issuedAt>                                             (member)
//! flagship/server-share-accept-admin/v1|<domain>|<shareId>|<memberPub>|<acceptedAt>|share|<keyPub>                     (per-share admin key)
//! ```
//!
//! Canonical bytes come from the strict v1 builder; every signature is strict Ed25519. Which key may sign (the
//! owner's sensitive-order key, the member key, the CA-attested share key) is the caller's pinned source.
//! Shared vectors: `packages/protocol/test-vectors/server-share` and `server-share-accept-admin`.
//!
//! One deliberate narrowing: a label must not begin or end with ANY character that JavaScript's `trim()` or
//! Rust's `trim()` would remove (they differ at U+FEFF and U+0085), so both ports agree on what is "trimmed".

use crate::entitlements::verify;
use flagship_protocol::canonical_v1::CanonicalV1;
use flagship_protocol::error::ProtocolError;

pub const TAG_SERVER_SHARE: &str = "flagship/server-share/v1";
pub const TAG_SERVER_SHARE_REVOKE: &str = "flagship/server-share-revoke/v1";
pub const TAG_SERVER_SHARE_ACCEPT: &str = "flagship/server-share-accept/v1";
pub const TAG_SERVER_SHARE_LEAVE: &str = "flagship/server-share-leave/v1";
pub const TAG_SERVER_SHARE_ACCEPT_ADMIN: &str = "flagship/server-share-accept-admin/v1";

pub const SHARE_LABEL_MAX: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShareError {
    EmptyDomain,
    BadShareId,
    BadPublicKey,
    BadLevel,
    BadLabel,
    BadKeyKind,
    Canonical(ProtocolError),
}

impl std::fmt::Display for ShareError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyDomain => write!(f, "empty serverDomain"),
            Self::BadShareId => write!(f, "shareId must be 32 lowercase hex"),
            Self::BadPublicKey => write!(f, "a public key must be 64 lowercase hex"),
            Self::BadLevel => write!(f, "level must be view or manage"),
            Self::BadLabel => write!(f, "label must be 1-64 trimmed characters"),
            Self::BadKeyKind => write!(f, "keyKind must be share"),
            Self::Canonical(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ShareError {}

impl From<ProtocolError> for ShareError {
    fn from(e: ProtocolError) -> Self {
        Self::Canonical(e)
    }
}

fn lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn domain(d: &str) -> Result<(), ShareError> {
    if d.is_empty() { Err(ShareError::EmptyDomain) } else { Ok(()) }
}

fn share_id(s: &str) -> Result<(), ShareError> {
    if lower_hex(s, 32) { Ok(()) } else { Err(ShareError::BadShareId) }
}

fn pubkey(s: &str) -> Result<(), ShareError> {
    if lower_hex(s, 64) { Ok(()) } else { Err(ShareError::BadPublicKey) }
}

/// A label the owner may name a member: 1 to 64 code points, trimmed, with no separator or control character.
#[must_use]
pub fn label_ok(raw: &str) -> bool {
    let edge = |c: char| c.is_whitespace() || c == '\u{feff}';
    let trimmed_both_ways = !raw.starts_with(edge) && !raw.ends_with(edge);
    !raw.is_empty()
        && raw.chars().count() <= SHARE_LABEL_MAX
        && trimmed_both_ways
        && !raw.chars().any(|c| c == '|' || c <= '\u{1f}' || c == '\u{7f}')
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerShareGrant {
    pub server_domain: String,
    pub share_id: String,
    pub member_pub_hex: String,
    /// `view` or `manage`.
    pub level: String,
    pub unlock_at_boot: bool,
    pub see_app_data: bool,
    pub label: String,
    pub issued_at: u64,
}

/// # Errors
/// A field that is not what the envelope allows.
pub fn grant_canonical(g: &ServerShareGrant) -> Result<String, ShareError> {
    domain(&g.server_domain)?;
    share_id(&g.share_id)?;
    pubkey(&g.member_pub_hex)?;
    if g.level != "view" && g.level != "manage" {
        return Err(ShareError::BadLevel);
    }
    if !label_ok(&g.label) {
        return Err(ShareError::BadLabel);
    }
    Ok(CanonicalV1::new(TAG_SERVER_SHARE)?
        .text(&g.server_domain)?
        .text(&g.share_id)?
        .text(&g.member_pub_hex)?
        .text(&g.level)?
        .flag01(g.unlock_at_boot)
        .flag01(g.see_app_data)
        .text(&g.label)?
        .uint(g.issued_at)?
        .finish_string())
}

#[must_use]
pub fn verify_grant(g: &ServerShareGrant, signature_hex: &str, signer_pub_hex: &str) -> bool {
    grant_canonical(g).is_ok_and(|c| verify(&c, signature_hex, signer_pub_hex))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerShareRevoke {
    pub server_domain: String,
    pub share_id: String,
    pub issued_at: u64,
}

/// # Errors
/// A field that is not what the envelope allows.
pub fn revoke_canonical(r: &ServerShareRevoke) -> Result<String, ShareError> {
    domain(&r.server_domain)?;
    share_id(&r.share_id)?;
    Ok(CanonicalV1::new(TAG_SERVER_SHARE_REVOKE)?.text(&r.server_domain)?.text(&r.share_id)?.uint(r.issued_at)?.finish_string())
}

#[must_use]
pub fn verify_revoke(r: &ServerShareRevoke, signature_hex: &str, signer_pub_hex: &str) -> bool {
    revoke_canonical(r).is_ok_and(|c| verify(&c, signature_hex, signer_pub_hex))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerShareAccept {
    pub server_domain: String,
    pub share_id: String,
    pub member_pub_hex: String,
    pub accepted_at: u64,
}

/// # Errors
/// A field that is not what the envelope allows.
pub fn accept_canonical(a: &ServerShareAccept) -> Result<String, ShareError> {
    domain(&a.server_domain)?;
    share_id(&a.share_id)?;
    pubkey(&a.member_pub_hex)?;
    Ok(CanonicalV1::new(TAG_SERVER_SHARE_ACCEPT)?
        .text(&a.server_domain)?
        .text(&a.share_id)?
        .text(&a.member_pub_hex)?
        .uint(a.accepted_at)?
        .finish_string())
}

#[must_use]
pub fn verify_accept(a: &ServerShareAccept, signature_hex: &str, signer_pub_hex: &str) -> bool {
    accept_canonical(a).is_ok_and(|c| verify(&c, signature_hex, signer_pub_hex))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerShareLeave {
    pub server_domain: String,
    pub share_id: String,
    pub member_pub_hex: String,
    pub issued_at: u64,
}

/// # Errors
/// A field that is not what the envelope allows.
pub fn leave_canonical(l: &ServerShareLeave) -> Result<String, ShareError> {
    domain(&l.server_domain)?;
    share_id(&l.share_id)?;
    pubkey(&l.member_pub_hex)?;
    Ok(CanonicalV1::new(TAG_SERVER_SHARE_LEAVE)?
        .text(&l.server_domain)?
        .text(&l.share_id)?
        .text(&l.member_pub_hex)?
        .uint(l.issued_at)?
        .finish_string())
}

#[must_use]
pub fn verify_leave(l: &ServerShareLeave, signature_hex: &str, signer_pub_hex: &str) -> bool {
    leave_canonical(l).is_ok_and(|c| verify(&c, signature_hex, signer_pub_hex))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerShareAcceptAdmin {
    pub server_domain: String,
    pub share_id: String,
    pub member_pub_hex: String,
    pub accepted_at: u64,
    /// Must be `share`: only the per-share admin key accepts.
    pub key_kind: String,
    pub key_pub_hex: String,
}

/// # Errors
/// A field that is not what the envelope allows.
pub fn accept_admin_canonical(a: &ServerShareAcceptAdmin) -> Result<String, ShareError> {
    domain(&a.server_domain)?;
    share_id(&a.share_id)?;
    pubkey(&a.member_pub_hex)?;
    if a.key_kind != "share" {
        return Err(ShareError::BadKeyKind);
    }
    pubkey(&a.key_pub_hex)?;
    Ok(CanonicalV1::new(TAG_SERVER_SHARE_ACCEPT_ADMIN)?
        .text(&a.server_domain)?
        .text(&a.share_id)?
        .text(&a.member_pub_hex)?
        .uint(a.accepted_at)?
        .text(&a.key_kind)?
        .text(&a.key_pub_hex)?
        .finish_string())
}

#[must_use]
pub fn verify_accept_admin(a: &ServerShareAcceptAdmin, signature_hex: &str, signer_pub_hex: &str) -> bool {
    accept_admin_canonical(a).is_ok_and(|c| verify(&c, signature_hex, signer_pub_hex))
}

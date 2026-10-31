//! Admin-only orders over one app's access, the Rust twin of `packages/protocol/src/appAccessOrders.ts`
//! (docs/service-access-gating.md, "Account members, ranks and who may change them"):
//!
//! ```text
//! flagship/app-rank/v1|<serviceRef>|<target>|<rank>|<issuedAt>
//! flagship/service-access-mode/v2|<serviceRef>|<open|restricted>|<issuedAt>
//! flagship/service-allow-remove/v2|<serviceRef>|<aid hex>|<issuedAt>
//! flagship/restored-access-approve/v1|<serviceRef>|<draftSha256 hex>|<issuedAt>
//! ```
//!
//! They name the app (its `serviceRef`, the same on every server of the account), never one server. Each is
//! signed by the box's sensitive-order key and applied only when its `issuedAt` is newer than the last order
//! applied to the same target. This module says what the bytes canonically mean and whether they were signed
//! (strict Ed25519); WHICH key may sign is the caller's pinned source. Shared vectors:
//! `packages/protocol/test-vectors/app-access-orders/vectors.json`.

use crate::entitlements::verify;
use flagship_protocol::canonical_v1::CanonicalV1;
use flagship_protocol::error::ProtocolError;

pub const TAG_APP_RANK: &str = "flagship/app-rank/v1";
pub const TAG_SERVICE_ACCESS_MODE_V2: &str = "flagship/service-access-mode/v2";
pub const TAG_SERVICE_ALLOW_REMOVE_V2: &str = "flagship/service-allow-remove/v2";
pub const TAG_RESTORED_ACCESS_APPROVE: &str = "flagship/restored-access-approve/v1";

/// Ranks an order can set, lowest first, then `refused` (device and share targets only).
pub const APP_RANK_VALUES: [&str; 4] = ["member", "manager", "master", "refused"];

/// Why a field was refused (the TypeScript encoders throw with the same wording per tag).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrderError {
    BadServiceRef,
    BadTarget,
    BadRank,
    RefusedTarget,
    BadMode,
    BadAid,
    BadDigest,
    BadIssuedAt,
    Canonical(ProtocolError),
}

impl std::fmt::Display for OrderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadServiceRef => write!(f, "bad serviceRef"),
            Self::BadTarget => write!(f, "bad target"),
            Self::BadRank => write!(f, "bad rank"),
            Self::RefusedTarget => write!(f, "only a device or a co-manager can be refused"),
            Self::BadMode => write!(f, "bad mode"),
            Self::BadAid => write!(f, "aid must be 64 lowercase hex"),
            Self::BadDigest => write!(f, "draftSha256 must be 64 lowercase hex"),
            Self::BadIssuedAt => write!(f, "bad issuedAt"),
            Self::Canonical(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for OrderError {}

impl From<ProtocolError> for OrderError {
    fn from(e: ProtocolError) -> Self {
        Self::Canonical(e)
    }
}

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$`
fn service_ref_ok(s: &str) -> bool {
    let b = s.as_bytes();
    let alnum = |c: u8| c.is_ascii_digit() || c.is_ascii_lowercase();
    match (b.first(), b.last()) {
        (Some(&first), Some(&last)) => b.len() <= 128 && alnum(first) && alnum(last) && b.iter().all(|&c| alnum(c) || c == b'-'),
        _ => false,
    }
}

/// `^[A-Za-z0-9._-]{1,128}$`
fn invite_id_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-')
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppRankTarget {
    Device { pub_hex: String },
    Share { share_id: String },
    Aid { aid: String },
    Invite { invite_id: String },
    Grant { invite_id: String, aid: String },
}

/// The parsed target, or `None` when malformed.
#[must_use]
pub fn parse_app_rank_target(t: &str) -> Option<AppRankTarget> {
    if let Some(h) = t.strip_prefix("device:") {
        return lower_hex(h, 64).then(|| AppRankTarget::Device { pub_hex: h.to_string() });
    }
    if let Some(h) = t.strip_prefix("share:") {
        return lower_hex(h, 32).then(|| AppRankTarget::Share { share_id: h.to_string() });
    }
    if let Some(h) = t.strip_prefix("aid:") {
        return lower_hex(h, 64).then(|| AppRankTarget::Aid { aid: h.to_string() });
    }
    if let Some(h) = t.strip_prefix("invite:") {
        return invite_id_ok(h).then(|| AppRankTarget::Invite { invite_id: h.to_string() });
    }
    if let Some(rest) = t.strip_prefix("grant:") {
        let (invite, aid) = rest.split_once('/')?;
        return (invite_id_ok(invite) && lower_hex(aid, 64)).then(|| AppRankTarget::Grant { invite_id: invite.to_string(), aid: aid.to_string() });
    }
    None
}

fn check_ref(s: &str) -> Result<(), OrderError> {
    if service_ref_ok(s) { Ok(()) } else { Err(OrderError::BadServiceRef) }
}

fn check_issued_at(at: u64) -> Result<(), OrderError> {
    if at <= MAX_SAFE_INTEGER { Ok(()) } else { Err(OrderError::BadIssuedAt) }
}

// ── app-rank/v1 ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppRankOrder {
    pub service_ref: String,
    pub target: String,
    pub rank: String,
    pub issued_at: u64,
}

/// # Errors
/// A field that is not what the order allows (see [`OrderError`]).
pub fn app_rank_canonical(o: &AppRankOrder) -> Result<String, OrderError> {
    check_ref(&o.service_ref)?;
    let target = parse_app_rank_target(&o.target).ok_or(OrderError::BadTarget)?;
    if !APP_RANK_VALUES.contains(&o.rank.as_str()) {
        return Err(OrderError::BadRank);
    }
    if o.rank == "refused" && !matches!(target, AppRankTarget::Device { .. } | AppRankTarget::Share { .. }) {
        return Err(OrderError::RefusedTarget);
    }
    check_issued_at(o.issued_at)?;
    Ok(CanonicalV1::new(TAG_APP_RANK)?.text(&o.service_ref)?.text(&o.target)?.text(&o.rank)?.uint(o.issued_at)?.finish_string())
}

/// Never fails loudly: a malformed order simply does not verify.
#[must_use]
pub fn verify_app_rank(o: &AppRankOrder, signature_hex: &str, public_key_hex: &str) -> bool {
    app_rank_canonical(o).is_ok_and(|c| verify(&c, signature_hex, public_key_hex))
}

// ── service-access-mode/v2 ───────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceAccessModeOrder {
    pub service_ref: String,
    /// `open` or `restricted`.
    pub mode: String,
    pub issued_at: u64,
}

/// # Errors
/// A field that is not what the order allows.
pub fn service_access_mode_canonical(o: &ServiceAccessModeOrder) -> Result<String, OrderError> {
    check_ref(&o.service_ref)?;
    if o.mode != "open" && o.mode != "restricted" {
        return Err(OrderError::BadMode);
    }
    check_issued_at(o.issued_at)?;
    Ok(CanonicalV1::new(TAG_SERVICE_ACCESS_MODE_V2)?.text(&o.service_ref)?.text(&o.mode)?.uint(o.issued_at)?.finish_string())
}

#[must_use]
pub fn verify_service_access_mode(o: &ServiceAccessModeOrder, signature_hex: &str, public_key_hex: &str) -> bool {
    service_access_mode_canonical(o).is_ok_and(|c| verify(&c, signature_hex, public_key_hex))
}

// ── service-allow-remove/v2 ──────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceAllowRemoveOrder {
    pub service_ref: String,
    /// Lower-hex 32-byte id to drop from the app's allow-list.
    pub aid: String,
    pub issued_at: u64,
}

/// # Errors
/// A field that is not what the order allows.
pub fn service_allow_remove_canonical(o: &ServiceAllowRemoveOrder) -> Result<String, OrderError> {
    check_ref(&o.service_ref)?;
    if !lower_hex(&o.aid, 64) {
        return Err(OrderError::BadAid);
    }
    check_issued_at(o.issued_at)?;
    Ok(CanonicalV1::new(TAG_SERVICE_ALLOW_REMOVE_V2)?.text(&o.service_ref)?.text(&o.aid)?.uint(o.issued_at)?.finish_string())
}

#[must_use]
pub fn verify_service_allow_remove(o: &ServiceAllowRemoveOrder, signature_hex: &str, public_key_hex: &str) -> bool {
    service_allow_remove_canonical(o).is_ok_and(|c| verify(&c, signature_hex, public_key_hex))
}

// ── restored-access-approve/v1 ───────────────────────────────────────

/// An admin's approval of the permissions a restore held back: it names the app and the SHA-256 of the exact
/// draft shown, so a draft replaced since cannot be approved with an old signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoredAccessApproval {
    pub service_ref: String,
    pub draft_sha256: String,
    pub issued_at: u64,
}

/// # Errors
/// A field that is not what the order allows.
pub fn restored_access_approve_canonical(o: &RestoredAccessApproval) -> Result<String, OrderError> {
    check_ref(&o.service_ref)?;
    if !lower_hex(&o.draft_sha256, 64) {
        return Err(OrderError::BadDigest);
    }
    check_issued_at(o.issued_at)?;
    Ok(CanonicalV1::new(TAG_RESTORED_ACCESS_APPROVE)?.text(&o.service_ref)?.text(&o.draft_sha256)?.uint(o.issued_at)?.finish_string())
}

#[must_use]
pub fn verify_restored_access_approve(o: &RestoredAccessApproval, signature_hex: &str, public_key_hex: &str) -> bool {
    restored_access_approve_canonical(o).is_ok_and(|c| verify(&c, signature_hex, public_key_hex))
}

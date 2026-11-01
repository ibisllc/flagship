//! Admin authority over sensitive app orders (`authorizeSensitiveOrder` in adminAuthorityLocal.ts with
//! `requireMasterAdmin` in packages/protocol): on a box that pins an admin root only that root, or a
//! device holding an admin-root-signed `admin` grant, may sign; the owner IRK never does there. A
//! box that pins no admin root takes the owner IRK. The hybrid (ML-DSA) half of the strict profile
//! is not checked here yet.

use flagship_crypto::access_orders::{AppRankOrder, app_rank_canonical};
use flagship_crypto::entitlements::verify;
use serde_json::Value;

const DEVICE_SCOPES: [&str; 9] = [
    "browse",
    "install-service",
    "vibe-code",
    "add-device",
    "manage-services",
    "revoke-others",
    "demo-provision",
    "admin",
    "view-directory",
];

/// One admin device grant as the box's device book holds it.
#[derive(Debug, Clone)]
pub struct GrantView {
    pub grant_id: String,
    pub username: String,
    pub device_id: String,
    pub device_pub_hex: String,
    pub scopes: Vec<String>,
    pub issued_at: u64,
    pub expires_at: u64,
    pub signature_hex: String,
    /// Only `admin-root` carries authority.
    pub signer_root: String,
    pub revoked: bool,
}

/// What this box pins.
#[derive(Debug, Clone)]
pub struct AdminTrust {
    pub owner_irk_hex: String,
    pub admin_root_hex: Option<String>,
    pub username: String,
    pub grants: Vec<GrantView>,
    pub now_ms: u64,
}

fn lower_hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `canonicalDeviceCapabilityGrant` (deviceCapability.ts), or `None` where it would throw.
#[must_use]
pub fn device_grant_canonical(g: &GrantView) -> Option<String> {
    for f in [&g.grant_id, &g.username, &g.device_id] {
        if f.chars()
            .any(|c| c == '|' || c <= '\u{1f}' || c == '\u{7f}')
        {
            return None;
        }
    }
    if g.expires_at <= g.issued_at
        || g.scopes.is_empty()
        || !lower_hex(&g.device_id, 32)
        || !lower_hex(&g.device_pub_hex.to_ascii_lowercase(), 64)
    {
        return None;
    }
    let mut idx: Vec<usize> = Vec::new();
    for s in &g.scopes {
        let i = DEVICE_SCOPES.iter().position(|x| x == s)?;
        if idx.contains(&i) {
            return None;
        }
        idx.push(i);
    }
    idx.sort_unstable();
    let scopes: Vec<&str> = idx
        .iter()
        .filter_map(|i| DEVICE_SCOPES.get(*i).copied())
        .collect();
    Some(format!(
        "flagship/device-capability-grant/v2|{}|{}|{}|{}|{}|{}|{}",
        g.grant_id,
        g.username,
        g.device_id,
        g.device_pub_hex.to_ascii_lowercase(),
        scopes.join(","),
        g.issued_at,
        g.expires_at
    ))
}

fn holds_admin_grant(signer: &str, root: &str, t: &AdminTrust) -> bool {
    let Some(g) = t
        .grants
        .iter()
        .find(|g| g.device_pub_hex.to_ascii_lowercase() == signer)
    else {
        return false;
    };
    if g.revoked
        || g.username.to_lowercase() != t.username.to_lowercase()
        || t.now_ms >= g.expires_at
    {
        return false;
    }
    if g.signer_root != "admin-root" || !g.scopes.iter().any(|s| s == "admin") {
        return false;
    }
    device_grant_canonical(g).is_some_and(|c| verify(&c, &g.signature_hex, root))
}

/// The key the order's signature verifies under, when that key may sign admin orders here.
#[must_use]
pub fn admin_signer(canonical: &str, signature_hex: &str, t: &AdminTrust) -> Option<String> {
    let Some(root) = t
        .admin_root_hex
        .as_ref()
        .map(|r| r.to_ascii_lowercase())
        .filter(|r| lower_hex(r, 64))
    else {
        let irk = t.owner_irk_hex.to_ascii_lowercase();
        return verify(canonical, signature_hex, &irk).then_some(irk);
    };
    if verify(canonical, signature_hex, &root) {
        return Some(root);
    }
    t.grants
        .iter()
        .map(|g| g.device_pub_hex.to_ascii_lowercase())
        .filter(|k| lower_hex(k, 64))
        .find(|k| verify(canonical, signature_hex, k) && holds_admin_grant(k, &root, t))
}

/// A handed-over `rank` journal entry's order: well formed, for this app, installed here, and
/// signed by an admin this box trusts. Applying it (newest per target wins) stays with the store.
#[must_use]
pub fn verify_rank_entry(
    order: &Value,
    signature_hex: &str,
    service_ref: &str,
    installed: bool,
    t: &AdminTrust,
) -> bool {
    let (Some(sr), Some(target), Some(rank)) = (
        order.get("serviceRef").and_then(Value::as_str),
        order.get("target").and_then(Value::as_str),
        order.get("rank").and_then(Value::as_str),
    ) else {
        return false;
    };
    let Some(issued_at) = order.get("issuedAt").and_then(Value::as_u64) else {
        return false;
    };
    if sr != service_ref || !installed || !lower_hex(&signature_hex.to_ascii_lowercase(), 128) {
        return false;
    }
    let o = AppRankOrder {
        service_ref: sr.to_owned(),
        target: target.to_owned(),
        rank: rank.to_owned(),
        issued_at,
    };
    app_rank_canonical(&o).is_ok_and(|c| admin_signer(&c, signature_hex, t).is_some())
}

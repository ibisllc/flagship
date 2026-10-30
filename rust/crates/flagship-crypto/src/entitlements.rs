//! The pod entitlement domain, the Rust twin of `packages/protocol/src/entitlements.ts`: RootEntitlement,
//! ServiceEntitlement, the entitlement revocation list, TunnelHello v2 and ServiceGrant. Canonical bytes are built with
//! the shared v1 builder (a strict subset of what the TypeScript encoders accept: a value that could canonicalise
//! ambiguously is refused rather than signed) and every signature is the strict Ed25519 profile both ports enforce.
//! Shared vectors: `packages/protocol/test-vectors/entitlements/vectors.json`.
//!
//! This is the authority contract the relay's HELLO check (release plan G7) and, later, the access enforcement
//! (G5) stand on: nothing here decides *who* the user's keys are (the caller supplies them from its own pinned
//! source); it only says whether bytes were signed and what they canonically mean.

use crate::ed25519_strict;
use flagship_protocol::canonical_v1::CanonicalV1;
use flagship_protocol::error::ProtocolError;
use flagship_protocol::parse::{encode_lower_hex, parse_lower_hex};
use sha2::{Digest, Sha256};

pub const TAG_ROOT_ENTITLEMENT: &str = "flagship/root-entitlement/v1";
pub const TAG_SERVICE_ENTITLEMENT: &str = "flagship/service-entitlement/v1";
pub const TAG_ENTITLEMENT_REVOKE: &str = "flagship/entitlement-revoke/v1";
pub const TAG_TUNNEL_HELLO_V2: &str = "flagship/tunnel-hello/v2";
pub const TAG_SERVICE_GRANT: &str = "flagship/service-grant/v1";

/// The cert id: SHA-256 hex of the canonical bytes.
#[must_use]
pub fn cert_id(canonical: &str) -> String {
    encode_lower_hex(&Sha256::digest(canonical.as_bytes()))
}

/// Verifies an Ed25519 signature (hex) over the canonical string under a public key (hex), strictly. Malformed input is
/// simply "not verified".
#[must_use]
pub fn verify(canonical: &str, signature_hex: &str, public_key_hex: &str) -> bool {
    let (Ok(sig), Ok(pk)) = (
        parse_lower_hex(&signature_hex.to_ascii_lowercase(), 64, 64),
        parse_lower_hex(&public_key_hex.to_ascii_lowercase(), 32, 32),
    ) else {
        return false;
    };
    let (Ok(sig), Ok(pk)) = (
        <[u8; 64]>::try_from(sig.as_slice()),
        <[u8; 32]>::try_from(pk.as_slice()),
    ) else {
        return false;
    };
    ed25519_strict::parse_public(&pk)
        .is_some_and(|vk| ed25519_strict::verify(&vk, canonical.as_bytes(), &sig))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootEntitlement {
    pub username: String,
    pub pod_pub_key_hex: String,
    pub pod_canonical: String,
    pub issued_at: u64,
}

/// # Errors
/// A field with the separator or a control character, or an integer past `Number.MAX_SAFE_INTEGER`.
pub fn root_entitlement(c: &RootEntitlement) -> Result<String, ProtocolError> {
    Ok(CanonicalV1::new(TAG_ROOT_ENTITLEMENT)?
        .text(&c.username)?
        .text(&c.pod_pub_key_hex)?
        .text(&c.pod_canonical)?
        .uint(c.issued_at)?
        .finish_string())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceEntitlement {
    pub username: String,
    pub pod_pub_key_hex: String,
    pub canonicals: Vec<String>,
    pub issued_at: u64,
    pub expires_at: u64,
}

/// Canonicals are lower-cased and sorted, so signing does not depend on their order.
///
/// # Errors
/// As [`root_entitlement`], and an empty or comma-bearing canonical.
pub fn service_entitlement(c: &ServiceEntitlement) -> Result<String, ProtocolError> {
    let lowered: Vec<String> = c.canonicals.iter().map(|s| s.to_lowercase()).collect();
    let refs: Vec<&str> = lowered.iter().map(String::as_str).collect();
    Ok(CanonicalV1::new(TAG_SERVICE_ENTITLEMENT)?
        .text(&c.username)?
        .text(&c.pod_pub_key_hex)?
        .list(&refs, true)?
        .uint(c.issued_at)?
        .uint(c.expires_at)?
        .finish_string())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TunnelHelloV2 {
    pub server_id: String,
    pub root_entitlement_cert_id: String,
    /// Empty when no service entitlement is presented.
    pub service_entitlement_cert_id: String,
    pub nonce_hex: String,
    pub issued_at: u64,
}

/// # Errors
/// As [`root_entitlement`].
pub fn tunnel_hello_v2(h: &TunnelHelloV2) -> Result<String, ProtocolError> {
    Ok(CanonicalV1::new(TAG_TUNNEL_HELLO_V2)?
        .text(&h.server_id)?
        .text(&h.root_entitlement_cert_id)?
        .text(&h.service_entitlement_cert_id)?
        .text(&h.nonce_hex)?
        .uint(h.issued_at)?
        .finish_string())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntitlementRevocationList {
    pub username: String,
    pub cert_ids: Vec<String>,
    pub issued_at: u64,
}

/// # Errors
/// As [`root_entitlement`].
pub fn entitlement_revocation_list(r: &EntitlementRevocationList) -> Result<String, ProtocolError> {
    let refs: Vec<&str> = r.cert_ids.iter().map(String::as_str).collect();
    let mut b = CanonicalV1::new(TAG_ENTITLEMENT_REVOKE)?.text(&r.username)?;
    // An empty list renders as an empty field, as the TypeScript `[].join(",")` does.
    b = if refs.is_empty() {
        b.text("")?
    } else {
        b.list(&refs, true)?
    };
    Ok(b.uint(r.issued_at)?.finish_string())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteScope {
    Canonical,
    NonCanonical,
    Subpath,
}

impl RouteScope {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Canonical => "canonical",
            Self::NonCanonical => "non-canonical",
            Self::Subpath => "subpath",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrantRoute {
    pub url: String,
    pub scope: RouteScope,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceGrant {
    pub grant_id: String,
    pub username: String,
    pub service_canonical: String,
    pub service_instance_id: Option<String>,
    pub server_domains: Vec<String>,
    pub server_identities_hex: Vec<String>,
    pub routes: Vec<GrantRoute>,
    pub issued_at: u64,
    pub expires_at: u64,
}

/// # Errors
/// As [`root_entitlement`], plus the grant's own rules: it must expire after it is issued and name at least one pod
/// identity and one route.
pub fn service_grant(g: &ServiceGrant) -> Result<String, ProtocolError> {
    if g.expires_at <= g.issued_at || g.server_identities_hex.is_empty() || g.routes.is_empty() {
        return Err(ProtocolError::ListItem);
    }
    let domains: Vec<String> = g.server_domains.iter().map(|d| d.to_lowercase()).collect();
    let identities: Vec<String> = g
        .server_identities_hex
        .iter()
        .map(|d| d.to_lowercase())
        .collect();
    let routes: Vec<String> = g
        .routes
        .iter()
        .map(|r| format!("{}:{}", r.scope.as_str(), r.url.to_lowercase()))
        .collect();
    let join = |v: &[String]| {
        let mut s: Vec<&str> = v.iter().map(String::as_str).collect();
        s.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        s.join(",")
    };
    for f in [&g.grant_id, &g.username, &g.service_canonical] {
        flagship_protocol::parse::check_field_text(f)?;
    }
    if let Some(i) = &g.service_instance_id {
        flagship_protocol::parse::check_field_text(i)?;
    }
    for f in domains.iter().chain(routes.iter()) {
        flagship_protocol::parse::check_field_text(f)?;
    }
    Ok(CanonicalV1::new(TAG_SERVICE_GRANT)?
        .text(&g.grant_id)?
        .text(&g.username)?
        .text(&g.service_canonical)?
        .text(g.service_instance_id.as_deref().unwrap_or(""))?
        .text(&join(&domains))?
        .text(&join(&identities))?
        .text(&join(&routes))?
        .uint(g.issued_at)?
        .uint(g.expires_at)?
        .finish_string())
}

/// The window is half-open: `[issued_at, expires_at)`.
#[must_use]
pub const fn grant_active_at(g_issued_at: u64, g_expires_at: u64, now: u64) -> bool {
    now >= g_issued_at && now < g_expires_at
}

/// True when `pod_pub_key_hex` is one of the grant's pod identities.
#[must_use]
pub fn grant_authorizes_pod(g: &ServiceGrant, pod_pub_key_hex: &str) -> bool {
    g.server_identities_hex
        .iter()
        .any(|id| id.eq_ignore_ascii_case(pod_pub_key_hex))
}

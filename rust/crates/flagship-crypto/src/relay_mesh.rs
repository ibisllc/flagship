//! The relay mesh protocol: the Rust twin of `packages/protocol/src/relayMesh.ts`
//! (`docs/architecture-v2/relay-mesh.md`, release 0.3, chunk A), for the Rust relay's mesh (`flagship-relay/src/mesh/`).
//! Shared vectors: `packages/protocol/test-vectors/relay-mesh/vectors.json` (`npx tsx tools/relay-mesh-vectors.ts`).
//!
//! ```text
//! flagship/relay-blessing/v1|<relayId>|<relayKey>|<servicesApex>|<tunnelHost>|<relayKind>|<nonce>|<issuedAt>|<expiresAt>
//! flagship/relay-blessing-request/v1|<relayId>|<relayKey>|<servicesApex>|<issuedAt>
//! flagship/relay-directory/v1|<servicesApex>|<directoryVersion>|<issuedAt>|<expiresAt>|<entriesSha256>
//!   entry line: `<relayId> <relayKey> <tunnelHost> <relayKind> <region> <ipv4,… or -> <ipv6,… or ->`
//! flagship/relay-log/v1|<servicesApex>|<sequence>|<kind>|<at>|<f1>|<f2>|<f3>|<f4>
//! flagship/relay-log-head/v1|<servicesApex>|<sequence>|<tipSha256>|<directoryVersion>|<issuedAt>
//! flagship/relay-attachment/v1|<serverFqdn>|<boxPub>|<regGen>|<relayId>|<attachedAt>|<issuedAt>|<notAfter>
//! flagship/relay-legacy-attachment/v1|<serverFqdn>|<boxPub>|<regGen>|<relayId>|<attachedAt>|<issuedAt>|<notAfter>
//! flagship/relay-withdraw/v1|<subjectKind>|<subject>|<relayId>|<withdrawnIssuedAt>|<at>
//! flagship/relay-bridge-auth/v1|<role>|<signerRelayId>|<peerRelayId>|<serverNonce>|<clientNonce>|<at>
//! flagship/relay-move-hint/v1|<serverFqdn>|<boxPub>|<fromRelayId>|<toRelayId>|<reason>|<issuedAt>|<notAfter>
//! flagship/relay-account-move/v1|<accountHash>|<fromRelayId>|<toRelayId>|<issuedAt>|<notAfter>
//! flagship/phone-route-grant/v1|<hostname>|<phoneRoutePub>|<generation>|<holderRelayId>|<ledgerRelayId>|<issuedAt>|<notAfter>
//! ```
//!
//! Public API (snake_case of the TypeScript names): the constants of §15.8; [`name_hash`], [`account_hash`];
//! `*_canonical` for every record; [`verify_relay_blessing`], [`check_relay_blessing_request`],
//! [`relay_directory_entry_line`], [`relay_directory_entries_sha256`], [`verify_relay_directory`],
//! [`newer_relay_directory`], [`directory_relay`]; the log: [`RelayLogState`], [`apply_relay_log`],
//! [`verify_relay_log_head`], [`relay_log_head_status`], [`relay_log_fresh`], [`newer_relay_log_head`],
//! [`relay_log_box`], [`relay_log_admin_key`], [`relay_log_policy_head`], [`relay_log_revocations`]; the checks:
//! [`check_box_attachment`], [`check_legacy_attachment`], [`check_attachment_item`], [`attachment_refusal_code`],
//! [`compare_attachments`], [`check_withdraw`], [`withdraw_covers`], [`check_bridge_auth`], [`check_move_hint`],
//! [`record_move_hint`], [`record_move_target_failed`], [`check_account_move`], [`check_phone_item`],
//! [`compare_phone_items`]; routing: [`account_home`], [`phone_ledger_ranking`], [`rebalance_decision`]. Refusals are
//! the same `&'static str` reason codes as the TypeScript checks.
//!
//! CA-signed artifacts (blessing, directory) are verified against the CA keys the caller resolved as authorized now
//! (TS `relayMeshCaKeys` from the maintainer chain). Whether the published log is public or encrypted to a mesh key is
//! an open owner decision; nothing here depends on it (an encryption layer wraps the published files, not these
//! records).

use crate::ed25519_strict;
use crate::entitlements::verify as ed_verify_hex;
use crate::serving::RevocationState;
use ed25519_dalek::SigningKey;
use flagship_protocol::canonical_v1::CanonicalV1;
use flagship_protocol::error::ProtocolError;
use flagship_protocol::parse::encode_lower_hex;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

pub const TAG_RELAY_BLESSING: &str = "flagship/relay-blessing/v1";
pub const TAG_RELAY_BLESSING_REQUEST: &str = "flagship/relay-blessing-request/v1";
pub const TAG_RELAY_DIRECTORY: &str = "flagship/relay-directory/v1";
pub const TAG_RELAY_LOG: &str = "flagship/relay-log/v1";
pub const TAG_RELAY_LOG_HEAD: &str = "flagship/relay-log-head/v1";
pub const TAG_RELAY_ATTACHMENT: &str = "flagship/relay-attachment/v1";
pub const TAG_RELAY_LEGACY_ATTACHMENT: &str = "flagship/relay-legacy-attachment/v1";
pub const TAG_RELAY_WITHDRAW: &str = "flagship/relay-withdraw/v1";
pub const TAG_RELAY_BRIDGE_AUTH: &str = "flagship/relay-bridge-auth/v1";
pub const TAG_RELAY_MOVE_HINT: &str = "flagship/relay-move-hint/v1";
pub const TAG_RELAY_ACCOUNT_MOVE: &str = "flagship/relay-account-move/v1";
pub const TAG_PHONE_ROUTE_GRANT: &str = "flagship/phone-route-grant/v1";
pub const TAG_RELAY_NAME: &str = "flagship/relay-name/v1";
pub const TAG_RELAY_ACCOUNT: &str = "flagship/relay-account/v1";

const MIN: u64 = 60_000;
const HOUR: u64 = 60 * MIN;
const DAY: u64 = 24 * HOUR;

pub const ATTACH_TTL_MS: u64 = 30 * MIN;
pub const ATTACH_RENEW_MS: u64 = 10 * MIN;
pub const LEGACY_TTL_MS: u64 = 3 * MIN;
pub const LEGACY_RENEW_MS: u64 = 60_000;
pub const LEGACY_ATTACH_WAIT_MS: u64 = 10_000;
pub const MESH_CLOCK_SKEW_MS: u64 = 60_000;
pub const MESH_QUERY_TIMEOUT_MS: u64 = 1_500;
pub const MESH_NEG_CACHE_MS: u64 = 10_000;
pub const MESH_NEG_CACHE_MAX: usize = 50_000;
pub const MESH_STORE_MAX_BOX_ITEMS: usize = 200_000;
pub const MESH_STORE_MAX_PER_RELAY: usize = 100_000;
pub const MESH_STORE_MAX_PHONE_ITEMS: usize = 20_000;
pub const MESH_PEER_QUERY_RATE: u32 = 500;
pub const MESH_PEER_QUERY_BURST: u32 = 1_000;
pub const MESH_PEER_OPEN_RATE: u32 = 2_000;
pub const MESH_PEER_OPEN_BURST: u32 = 4_000;
pub const MESH_PEER_MAX_STREAMS: usize = 20_000;
pub const MESH_PEER_MAX_QUEUED_BYTES: usize = 64 * 1024 * 1024;
pub const MESH_PEER_OVER_LIMIT_MS: u64 = 60_000;
pub const MESH_PEER_CUT_MS: u64 = 10 * MIN;
pub const MESH_DIAL_TIMEOUT_MS: u64 = 5_000;
pub const MESH_HANDSHAKE_STEP_MS: u64 = 5_000;
pub const MESH_PING_MS: u64 = 10_000;
pub const MESH_PEER_DOWN_MS: u64 = 30_000;
pub const MESH_BACKOFF_MIN_MS: u64 = 1_000;
pub const MESH_BACKOFF_MAX_MS: u64 = 60_000;
pub const MESH_CONTROL_MAX_BYTES: usize = 1024 * 1024;
pub const MESH_ANNOUNCE_DELAY_MS: u64 = 1_000;
pub const MESH_ANNOUNCE_BATCH_MAX: usize = 500;
pub const MESH_LOG_PUSH_MAX: usize = 256;
pub const MESH_LOG_SINCE_MAX: usize = 1_024;
pub const MESH_LOAD_INTERVAL_MS: u64 = 30_000;
pub const MESH_LOAD_FRESH_MS: u64 = 60_000;
pub const MESH_STREAM_INITIAL_WINDOW: u32 = 256 * 1024;
pub const FEED_HEAD_MINT_MS: u64 = 5_000;
pub const FEED_POLL_MS: u64 = 5_000;
pub const FEED_PAGE_ENTRIES: u64 = 512;
pub const HEAD_FRESH_MS: u64 = 60_000;
pub const HEAD_REFUSE_NEW_MS: u64 = 60_000;
pub const HEAD_CLOSE_ALL_MS: u64 = 10 * MIN;
pub const DIRECTORY_TTL_MS: u64 = 7 * DAY;
pub const DIRECTORY_REMINT_MS: u64 = DAY;
pub const DIRECTORY_EXPIRED_UNHEALTHY_MS: u64 = DAY;
pub const BOX_RELAY_CHECK_MS: u64 = HOUR;
pub const BOX_DIRECTORY_MAX_AGE_MS: u64 = DAY;
pub const RELAY_BLESSING_TTL_MS: u64 = 26 * HOUR;
pub const RELAY_BLESSING_REFRESH_MS: u64 = 12 * HOUR;
pub const REBALANCE_INTERVAL_MS: u64 = HOUR;
pub const REBALANCE_JITTER_MS: u64 = 10 * MIN;
pub const REBALANCE_WINDOW_MS: u64 = HOUR;
pub const REBALANCE_BUCKET_MS: u64 = MIN;
pub const REBALANCE_MIN_BYTES: u64 = 64 * 1024 * 1024;
pub const REBALANCE_MIN_STREAMS: u64 = 500;
pub const REBALANCE_MIN_SHARE_TENTHS: u64 = 6;
pub const REBALANCE_MIN_LEAD_TENTHS: u64 = 3;
pub const REBALANCE_MAX_LOAD_TENTHS: u64 = 8;
pub const ACCOUNT_MOVE_TTL_MS: u64 = 10 * MIN;
pub const ACCOUNT_MOVE_MIN_INTERVAL_MS: u64 = 6 * HOUR;
pub const MOVE_HINT_TTL_MS: u64 = 10 * MIN;
pub const MOVE_LOCALITY_MIN_MS: u64 = 6 * HOUR;
pub const MOVE_COLOCATE_MIN_MS: u64 = 10 * MIN;
pub const MOVE_COLOCATE_MAX_PER_DAY: usize = 6;
pub const MOVE_DIAL_TIMEOUT_MS: u64 = 10_000;
pub const MOVE_OLD_TUNNEL_GRACE_MS: u64 = 30_000;
pub const MOVE_FAILED_TARGET_MS: u64 = HOUR;
pub const ACCOUNT_MOVE_HINT_SPACING_MS: u64 = 2_000;
/// Equal to the phone ledger lease (`PHONE_ROUTE_LEASE_MS`, 60 s).
pub const PHONE_ROUTE_GRANT_TTL_MS: u64 = 60_000;
pub const RELAY_LOG_ZERO_TIP: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";
pub const RELAY_LOG_TIP_HISTORY: u64 = 1_024;

/// A field out of shape; the message names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeshError(pub String);

impl std::fmt::Display for MeshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MeshError {}

impl From<ProtocolError> for MeshError {
    fn from(e: ProtocolError) -> Self {
        Self(e.to_string())
    }
}

fn bad<T>(name: &str, why: &str) -> Result<T, MeshError> {
    Err(MeshError(format!("{name} {why}")))
}

// ── field rules ───────────────────────────────────────────────────────────

fn lower_hex(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex64(name: &str, s: &str) -> Result<(), MeshError> {
    if lower_hex(s, 64) {
        Ok(())
    } else {
        bad(name, "must be lowercase hex of the right length")
    }
}

fn p256_pub(s: &str) -> bool {
    lower_hex(s, 66) && (s.starts_with("02") || s.starts_with("03"))
}

/// `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`.
fn label_ok(s: &str) -> bool {
    let b = s.as_bytes();
    let alnum = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    match (b.first(), b.last()) {
        (Some(first), Some(last)) => {
            b.len() <= 63 && alnum(first) && alnum(last) && b.iter().all(|c| alnum(c) || *c == b'-')
        }
        _ => false,
    }
}

/// A relay id: `^[a-z][a-z0-9-]{1,30}$`.
#[must_use]
pub fn is_relay_id(s: &str) -> bool {
    let b = s.as_bytes();
    (2..=31).contains(&b.len())
        && b.first().is_some_and(u8::is_ascii_lowercase)
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn relay_id(name: &str, s: &str) -> Result<(), MeshError> {
    if is_relay_id(s) {
        Ok(())
    } else {
        bad(name, "must be a relay id")
    }
}

/// A services apex: lowercase DNS labels, at least two, at most 200 characters.
#[must_use]
pub fn is_services_apex(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && s.split('.').count() >= 2 && s.split('.').all(label_ok)
}

fn apex(name: &str, s: &str) -> Result<(), MeshError> {
    if is_services_apex(s) {
        Ok(())
    } else {
        bad(name, "must be a lowercase services apex")
    }
}

fn under_apex<'a>(fqdn: &'a str, apex: &str) -> Option<&'a str> {
    if !is_services_apex(apex) {
        return None;
    }
    fqdn.strip_suffix(apex)?.strip_suffix('.')
}

/// `<server>.<user>.<apex>`, lowercase: exactly two labels under the apex.
#[must_use]
pub fn is_pod_name(fqdn: &str, apex: &str) -> bool {
    under_apex(fqdn, apex).is_some_and(|head| {
        let labels: Vec<&str> = head.split('.').collect();
        labels.len() == 2 && labels.iter().all(|l| label_ok(l))
    })
}

/// The account a pod name belongs to.
#[must_use]
pub fn account_of_pod_name<'a>(fqdn: &'a str, apex: &str) -> Option<&'a str> {
    if !is_pod_name(fqdn, apex) {
        return None;
    }
    fqdn.split('.').nth(1)
}

/// `<account>.<apex>`: the phone's bare name.
#[must_use]
pub fn is_bare_phone_name(hostname: &str, apex: &str) -> bool {
    under_apex(hostname, apex).is_some_and(label_ok)
}

/// `<relayId>.tunnel.<servicesApex>`.
#[must_use]
pub fn relay_tunnel_host(relay_id: &str, services_apex: &str) -> String {
    format!("{relay_id}.tunnel.{services_apex}")
}

fn host_labels(name: &str, s: &str, min_labels: usize) -> Result<(), MeshError> {
    if s.is_empty()
        || s.len() > 253
        || s.split('.').count() < min_labels
        || !s.split('.').all(label_ok)
    {
        return bad(name, "must be a lowercase host name");
    }
    Ok(())
}

fn ipv4_ok(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.len() <= 3
                && p.bytes().all(|c| c.is_ascii_digit())
                && (p.len() == 1 || !p.starts_with('0'))
                && p.parse::<u16>().is_ok_and(|v| v <= 255)
        })
}

fn ipv6_ok(s: &str) -> bool {
    (2..=45).contains(&s.len())
        && s.contains(':')
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c) || c == b':' || c == b'.')
}

fn region_ok(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=32).contains(&b.len())
        && b.first()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn sha256_hex(s: &[u8]) -> String {
    encode_lower_hex(&Sha256::digest(s))
}

/// Strict Ed25519 over canonical bytes; false for anything malformed (lowercase hex only, as the TS check).
fn verify(canonical: &str, sig_hex: &str, pub_hex: &str) -> bool {
    lower_hex(sig_hex, 128) && lower_hex(pub_hex, 64) && ed_verify_hex(canonical, sig_hex, pub_hex)
}

/// Sign canonical bytes (relay key, log key, STK); 128 lowercase hex.
#[must_use]
pub fn sign_canonical(key: &SigningKey, canonical: &str) -> String {
    encode_lower_hex(&ed25519_strict::sign(key, canonical.as_bytes()))
}

// ── hashes (§1) ───────────────────────────────────────────────────────────

/// `sha256hex("flagship/relay-name/v1|" + lowercase(fqdn))`; printable ASCII without `|`, 1–253 characters.
///
/// # Errors
/// [`MeshError`] for anything else.
pub fn name_hash(fqdn: &str) -> Result<String, MeshError> {
    if fqdn.is_empty()
        || fqdn.len() > 253
        || !fqdn
            .bytes()
            .all(|c| (0x21..=0x7e).contains(&c) && c != b'|')
    {
        return bad("fqdn", "must be a host name");
    }
    Ok(sha256_hex(
        format!("{TAG_RELAY_NAME}|{}", fqdn.to_ascii_lowercase()).as_bytes(),
    ))
}

/// `sha256hex("flagship/relay-account/v1|" + account)`.
///
/// # Errors
/// [`MeshError`] when `account` is not a lowercase account name.
pub fn account_hash(account: &str) -> Result<String, MeshError> {
    if !label_ok(account) {
        return bad("account", "must be a lowercase account name");
    }
    Ok(sha256_hex(
        format!("{TAG_RELAY_ACCOUNT}|{account}").as_bytes(),
    ))
}

// ── relay blessing (§3.2) ─────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayKind {
    Full,
    Entry,
}

impl RelayKind {
    /// # Errors
    /// [`MeshError`] for anything but `full` / `entry`.
    pub fn parse(s: &str) -> Result<Self, MeshError> {
        match s {
            "full" => Ok(Self::Full),
            "entry" => Ok(Self::Entry),
            _ => bad("relayKind", "must be full or entry"),
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Entry => "entry",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayBlessingBody {
    pub relay_id: String,
    pub relay_key: String,
    pub services_apex: String,
    pub tunnel_host: String,
    pub relay_kind: RelayKind,
    /// 32 lowercase hex.
    pub nonce: String,
    pub issued_at: u64,
    pub expires_at: u64,
}

/// The JSON envelope `{kind:"RelayBlessing", version:1, …body, signedBy, signatures:[{pubkey, sig}]}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayBlessing {
    pub body: RelayBlessingBody,
    pub signed_by: String,
    /// `(pubkey, sig)` pairs.
    pub signatures: Vec<(String, String)>,
}

/// # Errors
/// [`MeshError`] for any field out of shape.
pub fn relay_blessing_canonical(b: &RelayBlessingBody) -> Result<String, MeshError> {
    relay_id("relayId", &b.relay_id)?;
    hex64("relayKey", &b.relay_key)?;
    apex("servicesApex", &b.services_apex)?;
    if b.tunnel_host != relay_tunnel_host(&b.relay_id, &b.services_apex) {
        return bad("tunnelHost", "must be <relayId>.tunnel.<servicesApex>");
    }
    if !lower_hex(&b.nonce, 32) {
        return bad("nonce", "must be 32 lowercase hex");
    }
    if b.expires_at <= b.issued_at {
        return bad("expiresAt", "must be after issuedAt");
    }
    Ok(CanonicalV1::new(TAG_RELAY_BLESSING)?
        .text(&b.relay_id)?
        .text(&b.relay_key)?
        .text(&b.services_apex)?
        .text(&b.tunnel_host)?
        .text(b.relay_kind.as_str())?
        .text(&b.nonce)?
        .uint(b.issued_at)?
        .uint(b.expires_at)?
        .finish_string())
}

fn ca_signed(
    signed_by: &str,
    signatures: &[(String, String)],
    canonical: &str,
    ca_keys: &[String],
) -> bool {
    ca_keys.iter().any(|k| k.to_ascii_lowercase() == signed_by)
        && signatures
            .iter()
            .any(|(pubkey, sig)| pubkey == signed_by && verify(canonical, sig, signed_by))
}

/// Verify a relay blessing against the CA keys authorized now. Reasons: `malformed`, `wrong-apex`,
/// `no-authorized-ca-keys`, `artifact-expired`, `signature-unverified`.
///
/// # Errors
/// The reason code.
pub fn verify_relay_blessing(
    b: &RelayBlessing,
    ca_keys: &[String],
    now: u64,
    services_apex: &str,
) -> Result<(), &'static str> {
    let Ok(canonical) = relay_blessing_canonical(&b.body) else {
        return Err("malformed");
    };
    if b.body.services_apex != services_apex {
        return Err("wrong-apex");
    }
    if ca_keys.is_empty() {
        return Err("no-authorized-ca-keys");
    }
    if now.saturating_add(MESH_CLOCK_SKEW_MS) < b.body.issued_at || now >= b.body.expires_at {
        return Err("artifact-expired");
    }
    if !ca_signed(&b.signed_by, &b.signatures, &canonical, ca_keys) {
        return Err("signature-unverified");
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayBlessingRequest {
    pub relay_id: String,
    pub relay_key: String,
    pub services_apex: String,
    pub issued_at: u64,
}

/// # Errors
/// [`MeshError`] for any field out of shape.
pub fn relay_blessing_request_canonical(r: &RelayBlessingRequest) -> Result<String, MeshError> {
    relay_id("relayId", &r.relay_id)?;
    hex64("relayKey", &r.relay_key)?;
    apex("servicesApex", &r.services_apex)?;
    Ok(CanonicalV1::new(TAG_RELAY_BLESSING_REQUEST)?
        .text(&r.relay_id)?
        .text(&r.relay_key)?
        .text(&r.services_apex)?
        .uint(r.issued_at)?
        .finish_string())
}

/// Reasons: `malformed`, `wrong-apex`, `stale`, `bad-signature`.
///
/// # Errors
/// The reason code.
pub fn check_relay_blessing_request(
    r: &RelayBlessingRequest,
    signature: &str,
    services_apex: &str,
    now: u64,
) -> Result<(), &'static str> {
    let Ok(canonical) = relay_blessing_request_canonical(r) else {
        return Err("malformed");
    };
    if r.services_apex != services_apex {
        return Err("wrong-apex");
    }
    if r.issued_at.abs_diff(now) > MESH_CLOCK_SKEW_MS {
        return Err("stale");
    }
    if !verify(&canonical, signature, &r.relay_key) {
        return Err("bad-signature");
    }
    Ok(())
}

// ── relay directory (§3.3) ────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayDirectoryEntry {
    pub relay_id: String,
    pub relay_key: String,
    pub tunnel_host: String,
    pub relay_kind: RelayKind,
    pub region: String,
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayDirectoryBody {
    pub services_apex: String,
    pub directory_version: u64,
    pub issued_at: u64,
    pub expires_at: u64,
    pub relays: Vec<RelayDirectoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayDirectory {
    pub body: RelayDirectoryBody,
    pub signed_by: String,
    pub signatures: Vec<(String, String)>,
}

fn address_list(name: &str, list: &[String], ok: fn(&str) -> bool) -> Result<String, MeshError> {
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for a in list {
        if !ok(a) {
            return bad(name, "holds a malformed address");
        }
        if !seen.insert(a) {
            return bad(name, "holds a duplicate");
        }
    }
    if seen.is_empty() {
        return Ok("-".to_owned());
    }
    Ok(seen.into_iter().collect::<Vec<_>>().join(","))
}

/// # Errors
/// [`MeshError`] for any field out of shape.
pub fn relay_directory_entry_line(
    e: &RelayDirectoryEntry,
    services_apex: &str,
) -> Result<String, MeshError> {
    relay_id("relayId", &e.relay_id)?;
    hex64("relayKey", &e.relay_key)?;
    apex("servicesApex", services_apex)?;
    if e.tunnel_host != relay_tunnel_host(&e.relay_id, services_apex) {
        return bad("tunnelHost", "must be <relayId>.tunnel.<servicesApex>");
    }
    if !region_ok(&e.region) {
        return bad("region", "must be a short lowercase region");
    }
    let v4 = address_list("ipv4", &e.ipv4, ipv4_ok)?;
    let v6 = address_list("ipv6", &e.ipv6, ipv6_ok)?;
    Ok(format!(
        "{} {} {} {} {} {v4} {v6}",
        e.relay_id,
        e.relay_key,
        e.tunnel_host,
        e.relay_kind.as_str(),
        e.region
    ))
}

/// # Errors
/// [`MeshError`] for a malformed entry or a repeated relay id or key.
pub fn relay_directory_entries_sha256(
    relays: &[RelayDirectoryEntry],
    services_apex: &str,
) -> Result<String, MeshError> {
    let mut ids = BTreeSet::new();
    let mut keys = BTreeSet::new();
    let mut lines = Vec::with_capacity(relays.len());
    for r in relays {
        lines.push(relay_directory_entry_line(r, services_apex)?);
        if !ids.insert(r.relay_id.as_str()) {
            return bad("relays", "lists a relay twice");
        }
        if !keys.insert(r.relay_key.as_str()) {
            return bad("relays", "lists one relay key twice");
        }
    }
    lines.sort();
    Ok(sha256_hex(lines.join("\n").as_bytes()))
}

/// # Errors
/// [`MeshError`] for any field out of shape.
pub fn relay_directory_canonical(d: &RelayDirectoryBody) -> Result<String, MeshError> {
    apex("servicesApex", &d.services_apex)?;
    if d.directory_version < 1 {
        return bad("directoryVersion", "must be ≥ 1");
    }
    if d.expires_at <= d.issued_at {
        return bad("expiresAt", "must be after issuedAt");
    }
    let sum = relay_directory_entries_sha256(&d.relays, &d.services_apex)?;
    Ok(CanonicalV1::new(TAG_RELAY_DIRECTORY)?
        .text(&d.services_apex)?
        .uint(d.directory_version)?
        .uint(d.issued_at)?
        .uint(d.expires_at)?
        .text(&sum)?
        .finish_string())
}

/// `Ok(expired)` for a verified directory (an expired one still routes). Reasons: `malformed`, `wrong-apex`,
/// `no-authorized-ca-keys`, `future`, `signature-unverified`.
///
/// # Errors
/// The reason code.
pub fn verify_relay_directory(
    d: &RelayDirectory,
    ca_keys: &[String],
    now: u64,
    services_apex: &str,
) -> Result<bool, &'static str> {
    let Ok(canonical) = relay_directory_canonical(&d.body) else {
        return Err("malformed");
    };
    if d.body.services_apex != services_apex {
        return Err("wrong-apex");
    }
    if ca_keys.is_empty() {
        return Err("no-authorized-ca-keys");
    }
    if d.body.issued_at > now.saturating_add(MESH_CLOCK_SKEW_MS) {
        return Err("future");
    }
    if !ca_signed(&d.signed_by, &d.signatures, &canonical, ca_keys) {
        return Err("signature-unverified");
    }
    Ok(now >= d.body.expires_at)
}

/// A higher version, or the same version re-minted later.
#[must_use]
pub fn newer_relay_directory(
    current: Option<&RelayDirectoryBody>,
    candidate: &RelayDirectoryBody,
) -> bool {
    match current {
        None => true,
        Some(c) if c.directory_version != candidate.directory_version => {
            candidate.directory_version > c.directory_version
        }
        Some(c) => candidate.issued_at > c.issued_at,
    }
}

#[must_use]
pub fn directory_relay<'a>(
    d: Option<&'a RelayDirectoryBody>,
    relay_id: &str,
) -> Option<&'a RelayDirectoryEntry> {
    d?.relays.iter().find(|r| r.relay_id == relay_id)
}

// ── the relay log (§4.2) ──────────────────────────────────────────────────

/// One log row. `kind` stays text so a malformed row can be represented (and refused).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayLogEntry {
    pub sequence: u64,
    pub kind: String,
    pub at: u64,
    pub f1: String,
    pub f2: String,
    pub f3: String,
    pub f4: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayLogBody {
    BoxRegister {
        name_hash: String,
        box_pub: String,
        reg_gen: u64,
    },
    BoxRevoke {
        box_pub: String,
        reg_gen: u64,
    },
    AccountAuthority {
        account_hash: String,
        admin_root_pub: Option<String>,
        irk_pub: String,
        authority_gen: u64,
    },
    PolicyHead {
        box_pub: String,
        reg_gen: u64,
        policy_gen: u64,
        policy_sha256: String,
    },
    RenewalKeyRevoke {
        renewal_pub: String,
    },
    DeviceGrantRevoke {
        grant_id: String,
        device_pub: String,
    },
    CertRevoke {
        account_hash: String,
        cert_id: String,
    },
    RelayRevoke {
        relay_id: String,
        relay_key: String,
    },
}

impl RelayLogBody {
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::BoxRegister { .. } => "box-register",
            Self::BoxRevoke { .. } => "box-revoke",
            Self::AccountAuthority { .. } => "account-authority",
            Self::PolicyHead { .. } => "policy-head",
            Self::RenewalKeyRevoke { .. } => "renewal-key-revoke",
            Self::DeviceGrantRevoke { .. } => "device-grant-revoke",
            Self::CertRevoke { .. } => "cert-revoke",
            Self::RelayRevoke { .. } => "relay-revoke",
        }
    }
}

/// `^(?:0|[1-9][0-9]{0,15})$`, a safe integer ≥ `min`.
fn decimal(name: &str, v: &str, min: u64) -> Result<u64, MeshError> {
    let b = v.as_bytes();
    let shape = (1..=16).contains(&b.len())
        && b.iter().all(u8::is_ascii_digit)
        && (b.len() == 1 || !v.starts_with('0'));
    match v.parse::<u64>() {
        Ok(n) if shape && n >= min && n <= flagship_protocol::parse::MAX_SAFE_INTEGER => Ok(n),
        _ => bad(name, "must be a decimal integer in range"),
    }
}

fn empty(name: &str, v: &str) -> Result<(), MeshError> {
    if v.is_empty() {
        Ok(())
    } else {
        bad(name, "must be empty")
    }
}

/// Validate an entry and read its fields.
///
/// # Errors
/// [`MeshError`] for anything malformed.
pub fn parse_relay_log_entry(e: &RelayLogEntry) -> Result<RelayLogBody, MeshError> {
    if e.sequence < 1 {
        return bad("sequence", "must be ≥ 1");
    }
    if e.sequence > flagship_protocol::parse::MAX_SAFE_INTEGER
        || e.at > flagship_protocol::parse::MAX_SAFE_INTEGER
    {
        return bad("sequence", "must be a safe integer");
    }
    match e.kind.as_str() {
        "box-register" => {
            hex64("f1 nameHash", &e.f1)?;
            hex64("f2 boxPub", &e.f2)?;
            empty("f4", &e.f4)?;
            Ok(RelayLogBody::BoxRegister {
                name_hash: e.f1.clone(),
                box_pub: e.f2.clone(),
                reg_gen: decimal("f3 regGen", &e.f3, 1)?,
            })
        }
        "box-revoke" => {
            hex64("f1 boxPub", &e.f1)?;
            empty("f3", &e.f3)?;
            empty("f4", &e.f4)?;
            Ok(RelayLogBody::BoxRevoke {
                box_pub: e.f1.clone(),
                reg_gen: decimal("f2 regGen", &e.f2, 1)?,
            })
        }
        "account-authority" => {
            hex64("f1 accountHash", &e.f1)?;
            if !e.f2.is_empty() {
                hex64("f2 adminRootPub", &e.f2)?;
            }
            hex64("f3 irkPub", &e.f3)?;
            Ok(RelayLogBody::AccountAuthority {
                account_hash: e.f1.clone(),
                admin_root_pub: (!e.f2.is_empty()).then(|| e.f2.clone()),
                irk_pub: e.f3.clone(),
                authority_gen: decimal("f4 authorityGen", &e.f4, 1)?,
            })
        }
        "policy-head" => {
            hex64("f1 boxPub", &e.f1)?;
            hex64("f4 policySha256", &e.f4)?;
            Ok(RelayLogBody::PolicyHead {
                box_pub: e.f1.clone(),
                reg_gen: decimal("f2 regGen", &e.f2, 1)?,
                policy_gen: decimal("f3 policyGen", &e.f3, 1)?,
                policy_sha256: e.f4.clone(),
            })
        }
        "renewal-key-revoke" => {
            if !p256_pub(&e.f1) {
                return bad("f1 renewalPub", "must be a compressed P-256 key");
            }
            empty("f2", &e.f2)?;
            empty("f3", &e.f3)?;
            empty("f4", &e.f4)?;
            Ok(RelayLogBody::RenewalKeyRevoke {
                renewal_pub: e.f1.clone(),
            })
        }
        "device-grant-revoke" => {
            hex64("f1 grantId", &e.f1)?;
            hex64("f2 devicePub", &e.f2)?;
            empty("f3", &e.f3)?;
            empty("f4", &e.f4)?;
            Ok(RelayLogBody::DeviceGrantRevoke {
                grant_id: e.f1.clone(),
                device_pub: e.f2.clone(),
            })
        }
        "cert-revoke" => {
            hex64("f1 accountHash", &e.f1)?;
            hex64("f2 certId", &e.f2)?;
            empty("f3", &e.f3)?;
            empty("f4", &e.f4)?;
            Ok(RelayLogBody::CertRevoke {
                account_hash: e.f1.clone(),
                cert_id: e.f2.clone(),
            })
        }
        "relay-revoke" => {
            relay_id("f1 relayId", &e.f1)?;
            hex64("f2 relayKey", &e.f2)?;
            empty("f3", &e.f3)?;
            empty("f4", &e.f4)?;
            Ok(RelayLogBody::RelayRevoke {
                relay_id: e.f1.clone(),
                relay_key: e.f2.clone(),
            })
        }
        _ => bad("kind", "is not a relay log kind"),
    }
}

/// The row for a body.
///
/// # Errors
/// [`MeshError`] when the result is malformed.
pub fn make_relay_log_entry(
    sequence: u64,
    at: u64,
    b: &RelayLogBody,
) -> Result<RelayLogEntry, MeshError> {
    let (f1, f2, f3, f4) = match b {
        RelayLogBody::BoxRegister {
            name_hash,
            box_pub,
            reg_gen,
        } => (
            name_hash.clone(),
            box_pub.clone(),
            reg_gen.to_string(),
            String::new(),
        ),
        RelayLogBody::BoxRevoke { box_pub, reg_gen } => (
            box_pub.clone(),
            reg_gen.to_string(),
            String::new(),
            String::new(),
        ),
        RelayLogBody::AccountAuthority {
            account_hash,
            admin_root_pub,
            irk_pub,
            authority_gen,
        } => (
            account_hash.clone(),
            admin_root_pub.clone().unwrap_or_default(),
            irk_pub.clone(),
            authority_gen.to_string(),
        ),
        RelayLogBody::PolicyHead {
            box_pub,
            reg_gen,
            policy_gen,
            policy_sha256,
        } => (
            box_pub.clone(),
            reg_gen.to_string(),
            policy_gen.to_string(),
            policy_sha256.clone(),
        ),
        RelayLogBody::RenewalKeyRevoke { renewal_pub } => (
            renewal_pub.clone(),
            String::new(),
            String::new(),
            String::new(),
        ),
        RelayLogBody::DeviceGrantRevoke {
            grant_id,
            device_pub,
        } => (
            grant_id.clone(),
            device_pub.clone(),
            String::new(),
            String::new(),
        ),
        RelayLogBody::CertRevoke {
            account_hash,
            cert_id,
        } => (
            account_hash.clone(),
            cert_id.clone(),
            String::new(),
            String::new(),
        ),
        RelayLogBody::RelayRevoke {
            relay_id,
            relay_key,
        } => (
            relay_id.clone(),
            relay_key.clone(),
            String::new(),
            String::new(),
        ),
    };
    let e = RelayLogEntry {
        sequence,
        kind: b.kind().to_owned(),
        at,
        f1,
        f2,
        f3,
        f4,
    };
    parse_relay_log_entry(&e)?;
    Ok(e)
}

/// # Errors
/// [`MeshError`] for a malformed entry or apex.
pub fn relay_log_entry_canonical(
    services_apex: &str,
    e: &RelayLogEntry,
) -> Result<String, MeshError> {
    apex("servicesApex", services_apex)?;
    parse_relay_log_entry(e)?;
    Ok(CanonicalV1::new(TAG_RELAY_LOG)?
        .text(services_apex)?
        .uint(e.sequence)?
        .text(&e.kind)?
        .uint(e.at)?
        .text(&e.f1)?
        .text(&e.f2)?
        .text(&e.f3)?
        .text(&e.f4)?
        .finish_string())
}

/// sha256 hex of the entry's canonical bytes (what a head's `tipSha256` names).
///
/// # Errors
/// As [`relay_log_entry_canonical`].
pub fn relay_log_entry_hash(services_apex: &str, e: &RelayLogEntry) -> Result<String, MeshError> {
    Ok(sha256_hex(
        relay_log_entry_canonical(services_apex, e)?.as_bytes(),
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayLogHead {
    pub services_apex: String,
    pub sequence: u64,
    pub tip_sha256: String,
    pub directory_version: u64,
    pub issued_at: u64,
}

/// # Errors
/// [`MeshError`] for any field out of shape.
pub fn relay_log_head_canonical(h: &RelayLogHead) -> Result<String, MeshError> {
    apex("servicesApex", &h.services_apex)?;
    hex64("tipSha256", &h.tip_sha256)?;
    if h.sequence == 0 && h.tip_sha256 != RELAY_LOG_ZERO_TIP {
        return bad("tipSha256", "must be zeros before any entry");
    }
    Ok(CanonicalV1::new(TAG_RELAY_LOG_HEAD)?
        .text(&h.services_apex)?
        .uint(h.sequence)?
        .text(&h.tip_sha256)?
        .uint(h.directory_version)?
        .uint(h.issued_at)?
        .finish_string())
}

/// Reasons: `malformed`, `wrong-apex`, `bad-signature`.
///
/// # Errors
/// The reason code.
pub fn verify_relay_log_head(
    h: &RelayLogHead,
    signature: &str,
    log_key: &str,
    services_apex: &str,
) -> Result<(), &'static str> {
    let Ok(canonical) = relay_log_head_canonical(h) else {
        return Err("malformed");
    };
    if h.services_apex != services_apex {
        return Err("wrong-apex");
    }
    if !verify(&canonical, signature, log_key) {
        return Err("bad-signature");
    }
    Ok(())
}

/// Later `issuedAt`, then higher sequence.
#[must_use]
pub fn newer_relay_log_head(a: Option<&RelayLogHead>, b: &RelayLogHead) -> bool {
    match a {
        None => true,
        Some(a) if a.issued_at != b.issued_at => b.issued_at > a.issued_at,
        Some(a) => b.sequence > a.sequence,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayLogBox {
    pub box_pub: String,
    pub reg_gen: u64,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayLogAuthority {
    pub admin_root_pub: Option<String>,
    pub irk_pub: String,
    pub authority_gen: u64,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayLogPolicyHead {
    pub policy_gen: u64,
    pub policy_sha256: String,
    pub sequence: u64,
}

/// What a relay knows from the log (see `RelayLogState` in relayMesh.ts for each map).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayLogState {
    pub services_apex: String,
    pub sequence: u64,
    pub tip_sha256: String,
    pub recent_tips: BTreeMap<u64, String>,
    pub boxes_by_name: BTreeMap<String, RelayLogBox>,
    pub box_names: BTreeMap<String, String>,
    pub revoked_boxes: BTreeMap<String, u64>,
    pub authorities: BTreeMap<String, RelayLogAuthority>,
    /// `<boxPub>|<regGen>` → the newest head.
    pub policy_heads: BTreeMap<String, RelayLogPolicyHead>,
    pub revoked_renewal_keys: BTreeSet<String>,
    pub revoked_grants: BTreeMap<String, String>,
    /// `<accountHash>|<certId>`.
    pub revoked_certs: BTreeSet<String>,
    pub revoked_relays: BTreeMap<String, String>,
}

impl RelayLogState {
    /// The empty state (`emptyRelayLogState`).
    ///
    /// # Errors
    /// [`MeshError`] for a malformed apex.
    pub fn new(services_apex: &str) -> Result<Self, MeshError> {
        apex("servicesApex", services_apex)?;
        Ok(Self {
            services_apex: services_apex.to_owned(),
            sequence: 0,
            tip_sha256: RELAY_LOG_ZERO_TIP.to_owned(),
            recent_tips: BTreeMap::from([(0, RELAY_LOG_ZERO_TIP.to_owned())]),
            boxes_by_name: BTreeMap::new(),
            box_names: BTreeMap::new(),
            revoked_boxes: BTreeMap::new(),
            authorities: BTreeMap::new(),
            policy_heads: BTreeMap::new(),
            revoked_renewal_keys: BTreeSet::new(),
            revoked_grants: BTreeMap::new(),
            revoked_certs: BTreeSet::new(),
            revoked_relays: BTreeMap::new(),
        })
    }

    fn apply_body(&mut self, b: RelayLogBody, seq: u64) {
        match b {
            RelayLogBody::BoxRegister {
                name_hash,
                box_pub,
                reg_gen,
            } => {
                if let Some(had) = self.boxes_by_name.get(&name_hash)
                    && had.box_pub != box_pub
                    && self.box_names.get(&had.box_pub) == Some(&name_hash)
                {
                    let old = had.box_pub.clone();
                    self.box_names.remove(&old);
                }
                if let Some(old_name) = self.box_names.get(&box_pub)
                    && *old_name != name_hash
                {
                    let old_name = old_name.clone();
                    self.boxes_by_name.remove(&old_name);
                }
                self.boxes_by_name.insert(
                    name_hash.clone(),
                    RelayLogBox {
                        box_pub: box_pub.clone(),
                        reg_gen,
                        sequence: seq,
                    },
                );
                self.box_names.insert(box_pub, name_hash);
            }
            RelayLogBody::BoxRevoke { box_pub, reg_gen } => {
                let had = self.revoked_boxes.get(&box_pub).copied().unwrap_or(0);
                self.revoked_boxes.insert(box_pub, had.max(reg_gen));
            }
            RelayLogBody::AccountAuthority {
                account_hash,
                admin_root_pub,
                irk_pub,
                authority_gen,
            } => {
                if self
                    .authorities
                    .get(&account_hash)
                    .is_none_or(|h| authority_gen >= h.authority_gen)
                {
                    self.authorities.insert(
                        account_hash,
                        RelayLogAuthority {
                            admin_root_pub,
                            irk_pub,
                            authority_gen,
                            sequence: seq,
                        },
                    );
                }
            }
            RelayLogBody::PolicyHead {
                box_pub,
                reg_gen,
                policy_gen,
                policy_sha256,
            } => {
                let key = format!("{box_pub}|{reg_gen}");
                if self
                    .policy_heads
                    .get(&key)
                    .is_none_or(|h| policy_gen >= h.policy_gen)
                {
                    self.policy_heads.insert(
                        key,
                        RelayLogPolicyHead {
                            policy_gen,
                            policy_sha256,
                            sequence: seq,
                        },
                    );
                }
            }
            RelayLogBody::RenewalKeyRevoke { renewal_pub } => {
                self.revoked_renewal_keys.insert(renewal_pub);
            }
            RelayLogBody::DeviceGrantRevoke {
                grant_id,
                device_pub,
            } => {
                self.revoked_grants.insert(grant_id, device_pub);
            }
            RelayLogBody::CertRevoke {
                account_hash,
                cert_id,
            } => {
                self.revoked_certs
                    .insert(format!("{account_hash}|{cert_id}"));
            }
            RelayLogBody::RelayRevoke {
                relay_id,
                relay_key,
            } => {
                self.revoked_relays.insert(relay_id, relay_key);
            }
        }
    }
}

/// [`apply_relay_log`]'s outcome. On failure `at` is where to fetch from; `state`/`applied` hold the valid prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayLogApply {
    Applied {
        state: RelayLogState,
        applied: u64,
    },
    Failed {
        reason: &'static str,
        at: u64,
        state: RelayLogState,
        applied: u64,
    },
}

/// Apply entries in sequence order under the log key: duplicates skipped, `gap`, `bad-signature`, `malformed` stop.
/// `state` is unchanged.
#[must_use]
pub fn apply_relay_log(
    state: &RelayLogState,
    entries: &[(RelayLogEntry, String)],
    log_key: &str,
) -> RelayLogApply {
    let mut sorted: Vec<&(RelayLogEntry, String)> = entries.iter().collect();
    sorted.sort_by_key(|(e, _)| e.sequence);
    let mut next = state.clone();
    let mut applied: u64 = 0;
    for (entry, signature) in sorted {
        let parsed = parse_relay_log_entry(entry)
            .and_then(|b| relay_log_entry_canonical(&state.services_apex, entry).map(|c| (b, c)));
        let Ok((body, canonical)) = parsed else {
            let at = if entry.sequence >= 1 {
                entry.sequence
            } else {
                next.sequence.saturating_add(1)
            };
            return RelayLogApply::Failed {
                reason: "malformed",
                at,
                state: next,
                applied,
            };
        };
        if entry.sequence <= next.sequence {
            continue;
        }
        let expected = next.sequence.saturating_add(1);
        if entry.sequence != expected {
            return RelayLogApply::Failed {
                reason: "gap",
                at: expected,
                state: next,
                applied,
            };
        }
        if !verify(&canonical, signature, log_key) {
            return RelayLogApply::Failed {
                reason: "bad-signature",
                at: entry.sequence,
                state: next,
                applied,
            };
        }
        next.apply_body(body, entry.sequence);
        let tip = sha256_hex(canonical.as_bytes());
        next.sequence = entry.sequence;
        next.tip_sha256.clone_from(&tip);
        next.recent_tips.insert(entry.sequence, tip);
        if let Some(old) = entry.sequence.checked_sub(RELAY_LOG_TIP_HISTORY) {
            next.recent_tips.remove(&old);
        }
        applied = applied.saturating_add(1);
    }
    RelayLogApply::Applied {
        state: next,
        applied,
    }
}

/// `applied`, `behind`, `fork` or `unknown` (see `relayLogHeadStatus`).
#[must_use]
pub fn relay_log_head_status(state: &RelayLogState, head: &RelayLogHead) -> &'static str {
    if head.sequence > state.sequence {
        return "behind";
    }
    match state.recent_tips.get(&head.sequence) {
        None => "unknown",
        Some(t) if *t == head.tip_sha256 => "applied",
        Some(_) => "fork",
    }
}

/// Fresh while the newest verified head is applied and at most [`HEAD_FRESH_MS`] old.
#[must_use]
pub fn relay_log_fresh(state: &RelayLogState, head: Option<&RelayLogHead>, now: u64) -> bool {
    head.is_some_and(|h| {
        h.issued_at >= now.saturating_sub(HEAD_FRESH_MS)
            && relay_log_head_status(state, h) == "applied"
    })
}

#[must_use]
pub fn relay_log_box<'a>(state: &'a RelayLogState, server_fqdn: &str) -> Option<&'a RelayLogBox> {
    state.boxes_by_name.get(&name_hash(server_fqdn).ok()?)
}

/// The account's admin root, else its IRK.
#[must_use]
pub fn relay_log_admin_key<'a>(state: &'a RelayLogState, account: &str) -> Option<&'a str> {
    let a = state.authorities.get(&account_hash(account).ok()?)?;
    Some(a.admin_root_pub.as_deref().unwrap_or(&a.irk_pub))
}

#[must_use]
pub fn relay_log_policy_head<'a>(
    state: &'a RelayLogState,
    box_pub: &str,
    reg_gen: u64,
) -> Option<&'a RelayLogPolicyHead> {
    state.policy_heads.get(&format!("{box_pub}|{reg_gen}"))
}

/// The revocations `serving_decision` reads, keyed by box key alone (a copy; TS shares the maps).
#[must_use]
pub fn relay_log_revocations(state: &RelayLogState) -> RevocationState {
    RevocationState {
        sequence: state.sequence,
        boxes: state.revoked_boxes.clone(),
        renewal_keys: state.revoked_renewal_keys.clone(),
    }
}

// ── attachments (§5) ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoxAttachment {
    pub server_fqdn: String,
    pub box_pub: String,
    pub reg_gen: u64,
    pub relay_id: String,
    pub attached_at: u64,
    pub issued_at: u64,
    pub not_after: u64,
}

fn attachment_canonical(tag: &str, a: &BoxAttachment) -> Result<String, MeshError> {
    host_labels("serverFqdn", &a.server_fqdn, 1)?;
    hex64("boxPub", &a.box_pub)?;
    if a.reg_gen < 1 {
        return bad("regGen", "must be ≥ 1");
    }
    relay_id("relayId", &a.relay_id)?;
    if a.attached_at > a.issued_at || a.issued_at >= a.not_after {
        return bad("times", "must satisfy attachedAt ≤ issuedAt < notAfter");
    }
    Ok(CanonicalV1::new(tag)?
        .text(&a.server_fqdn)?
        .text(&a.box_pub)?
        .uint(a.reg_gen)?
        .text(&a.relay_id)?
        .uint(a.attached_at)?
        .uint(a.issued_at)?
        .uint(a.not_after)?
        .finish_string())
}

/// # Errors
/// [`MeshError`] for any field out of shape.
pub fn box_attachment_canonical(a: &BoxAttachment) -> Result<String, MeshError> {
    attachment_canonical(TAG_RELAY_ATTACHMENT, a)
}

/// # Errors
/// [`MeshError`] for any field out of shape.
pub fn legacy_attachment_canonical(a: &BoxAttachment) -> Result<String, MeshError> {
    attachment_canonical(TAG_RELAY_LEGACY_ATTACHMENT, a)
}

/// The apex, the verified log state and directory, and the clock.
#[derive(Debug, Clone, Copy)]
pub struct MeshCheckContext<'a> {
    pub services_apex: &'a str,
    pub log: &'a RelayLogState,
    pub directory: Option<&'a RelayDirectoryBody>,
    pub now: u64,
}

/// The holder's extra checks: this tunnel's box and name, and itself.
#[derive(Debug, Clone, Copy)]
pub struct AttachmentHolder<'a> {
    pub relay_id: &'a str,
    pub box_pub: &'a str,
    pub server_fqdn: &'a str,
}

fn check_attachment_common<'a>(
    a: &BoxAttachment,
    legacy: bool,
    ctx: &MeshCheckContext<'a>,
    holder: Option<&AttachmentHolder<'_>>,
) -> Result<(String, &'a RelayDirectoryEntry), &'static str> {
    let canonical = if legacy {
        legacy_attachment_canonical(a)
    } else {
        box_attachment_canonical(a)
    };
    let Ok(canonical) = canonical else {
        return Err("malformed");
    };
    if !is_pod_name(&a.server_fqdn, ctx.services_apex) {
        return Err("not-pod-name");
    }
    let ttl = if legacy { LEGACY_TTL_MS } else { ATTACH_TTL_MS };
    if a.not_after.saturating_sub(a.issued_at) > ttl {
        return Err("ttl-too-long");
    }
    if a.issued_at > ctx.now.saturating_add(MESH_CLOCK_SKEW_MS) {
        return Err("future");
    }
    if a.not_after <= ctx.now {
        return Err("expired");
    }
    let Some(reg) = relay_log_box(ctx.log, &a.server_fqdn) else {
        return Err("not-registered");
    };
    if reg.box_pub != a.box_pub || reg.reg_gen != a.reg_gen {
        return Err("mismatch");
    }
    if ctx.log.revoked_boxes.get(&a.box_pub).copied().unwrap_or(0) >= a.reg_gen {
        return Err("revoked");
    }
    if ctx.log.revoked_relays.contains_key(&a.relay_id) {
        return Err("relay-revoked");
    }
    let Some(relay) = directory_relay(ctx.directory, &a.relay_id) else {
        return Err("unknown-relay");
    };
    if let Some(h) = holder {
        if a.box_pub != h.box_pub || a.server_fqdn != h.server_fqdn {
            return Err("not-this-tunnel");
        }
        if a.relay_id != h.relay_id {
            return Err("not-this-relay");
        }
    }
    Ok((canonical, relay))
}

/// §5.1 (see `checkBoxAttachment`).
///
/// # Errors
/// The reason code.
pub fn check_box_attachment(
    a: &BoxAttachment,
    signature: &str,
    ctx: &MeshCheckContext<'_>,
    holder: Option<&AttachmentHolder<'_>>,
) -> Result<(), &'static str> {
    let (canonical, _) = check_attachment_common(a, false, ctx, holder)?;
    if !verify(&canonical, signature, &a.box_pub) {
        return Err("bad-signature");
    }
    Ok(())
}

/// §5.3: from a `full` relay, signed by its directory key, [`LEGACY_TTL_MS`].
///
/// # Errors
/// The reason code.
pub fn check_legacy_attachment(
    a: &BoxAttachment,
    signature: &str,
    ctx: &MeshCheckContext<'_>,
    holder: Option<&AttachmentHolder<'_>>,
) -> Result<(), &'static str> {
    let (canonical, relay) = check_attachment_common(a, true, ctx, holder)?;
    if relay.relay_kind != RelayKind::Full {
        return Err("not-full");
    }
    if !verify(&canonical, signature, &relay.relay_key) {
        return Err("bad-signature");
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentKind {
    Box,
    Legacy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentItem {
    pub kind: AttachmentKind,
    pub attachment: BoxAttachment,
    pub signature: String,
}

/// # Errors
/// The reason code.
pub fn check_attachment_item(
    item: &AttachmentItem,
    ctx: &MeshCheckContext<'_>,
    holder: Option<&AttachmentHolder<'_>>,
) -> Result<(), &'static str> {
    match item.kind {
        AttachmentKind::Box => check_box_attachment(&item.attachment, &item.signature, ctx, holder),
        AttachmentKind::Legacy => {
            check_legacy_attachment(&item.attachment, &item.signature, ctx, holder)
        }
    }
}

/// The ATTACHMENT frame's code for a refusal: `clock`, `mismatch`, `not-registered` or `revoked`.
#[must_use]
pub fn attachment_refusal_code(reason: &str) -> &'static str {
    match reason {
        "future" | "expired" => "clock",
        "not-registered" => "not-registered",
        "revoked" => "revoked",
        _ => "mismatch",
    }
}

/// §5.2: `Greater` when `a` wins. Higher regGen; box beats legacy; later `issuedAt`; smaller relayId.
#[must_use]
pub fn compare_attachments(a: &AttachmentItem, b: &AttachmentItem) -> Ordering {
    let (x, y) = (&a.attachment, &b.attachment);
    let rank = |k: AttachmentKind| u8::from(k == AttachmentKind::Box);
    x.reg_gen
        .cmp(&y.reg_gen)
        .then(rank(a.kind).cmp(&rank(b.kind)))
        .then(x.issued_at.cmp(&y.issued_at))
        .then(y.relay_id.cmp(&x.relay_id))
}

// ── withdrawal (§5.4) ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayWithdraw {
    /// `box` or `phone`.
    pub subject_kind: String,
    pub subject: String,
    pub relay_id: String,
    pub withdrawn_issued_at: u64,
    pub at: u64,
}

/// # Errors
/// [`MeshError`] for any field out of shape.
pub fn relay_withdraw_canonical(w: &RelayWithdraw) -> Result<String, MeshError> {
    if w.subject_kind != "box" && w.subject_kind != "phone" {
        return bad("subjectKind", "must be box or phone");
    }
    host_labels("subject", &w.subject, 1)?;
    relay_id("relayId", &w.relay_id)?;
    Ok(CanonicalV1::new(TAG_RELAY_WITHDRAW)?
        .text(&w.subject_kind)?
        .text(&w.subject)?
        .text(&w.relay_id)?
        .uint(w.withdrawn_issued_at)?
        .uint(w.at)?
        .finish_string())
}

/// Reasons: `malformed`, `not-subject`, `future`, `unknown-relay`, `bad-signature`.
///
/// # Errors
/// The reason code.
pub fn check_withdraw(
    w: &RelayWithdraw,
    signature: &str,
    ctx: &MeshCheckContext<'_>,
) -> Result<(), &'static str> {
    let Ok(canonical) = relay_withdraw_canonical(w) else {
        return Err("malformed");
    };
    let subject_ok = if w.subject_kind == "box" {
        is_pod_name(&w.subject, ctx.services_apex)
    } else {
        is_bare_phone_name(&w.subject, ctx.services_apex)
    };
    if !subject_ok {
        return Err("not-subject");
    }
    if w.at > ctx.now.saturating_add(MESH_CLOCK_SKEW_MS) {
        return Err("future");
    }
    let Some(relay) = directory_relay(ctx.directory, &w.relay_id) else {
        return Err("unknown-relay");
    };
    if !verify(&canonical, signature, &relay.relay_key) {
        return Err("bad-signature");
    }
    Ok(())
}

/// An item in the attachment store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MeshItem {
    Attachment(AttachmentItem),
    Phone(PhoneItem),
}

/// Does a checked withdrawal remove `item`?
#[must_use]
pub fn withdraw_covers(w: &RelayWithdraw, item: &MeshItem) -> bool {
    match item {
        MeshItem::Phone(p) => {
            w.subject_kind == "phone"
                && p.grant.hostname == w.subject
                && p.grant.holder_relay_id == w.relay_id
                && p.grant.issued_at <= w.withdrawn_issued_at
        }
        MeshItem::Attachment(a) => {
            w.subject_kind == "box"
                && a.attachment.server_fqdn == w.subject
                && a.attachment.relay_id == w.relay_id
                && a.attachment.issued_at <= w.withdrawn_issued_at
        }
    }
}

// ── bridge auth (§6.2) ────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeAuth {
    /// `client` (dialer) or `server` (acceptor): the signer's role.
    pub role: String,
    pub signer_relay_id: String,
    pub peer_relay_id: String,
    pub server_nonce: String,
    pub client_nonce: String,
    pub at: u64,
}

/// # Errors
/// [`MeshError`] for any field out of shape.
pub fn bridge_auth_canonical(b: &BridgeAuth) -> Result<String, MeshError> {
    if b.role != "client" && b.role != "server" {
        return bad("role", "must be client or server");
    }
    relay_id("signerRelayId", &b.signer_relay_id)?;
    relay_id("peerRelayId", &b.peer_relay_id)?;
    if b.signer_relay_id == b.peer_relay_id {
        return bad("peerRelayId", "must differ from the signer");
    }
    hex64("serverNonce", &b.server_nonce)?;
    hex64("clientNonce", &b.client_nonce)?;
    Ok(CanonicalV1::new(TAG_RELAY_BRIDGE_AUTH)?
        .text(&b.role)?
        .text(&b.signer_relay_id)?
        .text(&b.peer_relay_id)?
        .text(&b.server_nonce)?
        .text(&b.client_nonce)?
        .uint(b.at)?
        .finish_string())
}

/// The peer's `mesh-auth` message (`type`/`v` already checked by the parser).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeshAuth {
    pub relay_id: String,
    pub peer: String,
    pub nonce: String,
    pub at: u64,
    pub blessing: Option<RelayBlessing>,
    pub sig: String,
}

/// Inputs of [`check_bridge_auth`]; `role` is the PEER's role.
#[derive(Debug, Clone, Copy)]
pub struct BridgeAuthCheck<'a> {
    pub auth: &'a MeshAuth,
    pub role: &'a str,
    pub self_relay_id: &'a str,
    pub self_nonce: &'a str,
    pub held_blessing: Option<&'a RelayBlessing>,
    pub ca_keys: &'a [String],
    pub ctx: MeshCheckContext<'a>,
}

/// §6.2 (see `checkBridgeAuth`): the blessing used on success. Reasons in order: `wrong-peer`, `stale`,
/// `bad-blessing`, `revoked`, `not-in-directory`, `bad-signature`.
///
/// # Errors
/// The reason code.
pub fn check_bridge_auth<'a>(c: &BridgeAuthCheck<'a>) -> Result<&'a RelayBlessing, &'static str> {
    let a = c.auth;
    if !is_relay_id(&a.relay_id) || a.peer != c.self_relay_id || a.relay_id == c.self_relay_id {
        return Err("wrong-peer");
    }
    if a.at.abs_diff(c.ctx.now) > MESH_CLOCK_SKEW_MS {
        return Err("stale");
    }
    let Some(blessing) = a.blessing.as_ref().or(c.held_blessing) else {
        return Err("bad-blessing");
    };
    if blessing.body.relay_id != a.relay_id
        || verify_relay_blessing(blessing, c.ca_keys, c.ctx.now, c.ctx.services_apex).is_err()
    {
        return Err("bad-blessing");
    }
    if c.ctx.log.revoked_relays.contains_key(&a.relay_id) {
        return Err("revoked");
    }
    match directory_relay(c.ctx.directory, &a.relay_id) {
        Some(e) if e.relay_key == blessing.body.relay_key => {}
        _ => return Err("not-in-directory"),
    }
    let (server_nonce, client_nonce) = if c.role == "client" {
        (c.self_nonce, a.nonce.as_str())
    } else {
        (a.nonce.as_str(), c.self_nonce)
    };
    let msg = BridgeAuth {
        role: c.role.to_owned(),
        signer_relay_id: a.relay_id.clone(),
        peer_relay_id: c.self_relay_id.to_owned(),
        server_nonce: server_nonce.to_owned(),
        client_nonce: client_nonce.to_owned(),
        at: a.at,
    };
    match bridge_auth_canonical(&msg) {
        Ok(canonical) if verify(&canonical, &a.sig, &blessing.body.relay_key) => Ok(blessing),
        _ => Err("bad-signature"),
    }
}

// ── move hints (§9.3) ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveHint {
    pub server_fqdn: String,
    pub box_pub: String,
    pub from_relay_id: String,
    pub to_relay_id: String,
    /// `locality`, `co-locate` or `retire`.
    pub reason: String,
    pub issued_at: u64,
    pub not_after: u64,
}

/// # Errors
/// [`MeshError`] for any field out of shape.
pub fn move_hint_canonical(h: &MoveHint) -> Result<String, MeshError> {
    host_labels("serverFqdn", &h.server_fqdn, 1)?;
    hex64("boxPub", &h.box_pub)?;
    relay_id("fromRelayId", &h.from_relay_id)?;
    relay_id("toRelayId", &h.to_relay_id)?;
    if h.from_relay_id == h.to_relay_id {
        return bad("toRelayId", "must differ from fromRelayId");
    }
    if !matches!(h.reason.as_str(), "locality" | "co-locate" | "retire") {
        return bad("reason", "must be locality, co-locate or retire");
    }
    if h.not_after <= h.issued_at {
        return bad("notAfter", "must be after issuedAt");
    }
    Ok(CanonicalV1::new(TAG_RELAY_MOVE_HINT)?
        .text(&h.server_fqdn)?
        .text(&h.box_pub)?
        .text(&h.from_relay_id)?
        .text(&h.to_relay_id)?
        .text(&h.reason)?
        .uint(h.issued_at)?
        .uint(h.not_after)?
        .finish_string())
}

/// The box's hint bookkeeping (persisted by the box).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MoveHintRateState {
    pub last_locality_at: Option<u64>,
    pub co_locate_at: Vec<u64>,
    pub failed_targets: BTreeMap<String, u64>,
}

/// Inputs of [`check_move_hint`].
#[derive(Debug, Clone, Copy)]
pub struct MoveHintCheck<'a> {
    pub hint: &'a MoveHint,
    pub signature: &'a str,
    pub target: &'a RelayBlessing,
    pub box_server_fqdn: &'a str,
    pub box_pub: &'a str,
    pub services_apex: &'a str,
    pub current_relay_id: &'a str,
    pub current_relay_key: &'a str,
    pub directory: Option<&'a RelayDirectoryBody>,
    pub directory_fetched_at: Option<u64>,
    pub ca_keys: &'a [String],
    pub rate: &'a MoveHintRateState,
    pub now: u64,
}

/// §9.3 (see `checkMoveHint`). Reasons in order: `malformed`, `not-this-box`, `wrong-from`, `bad-signature`,
/// `ttl-too-long`, `future`, `expired`, `bad-target`, `target-not-full`, `target-mismatch`, `directory-stale`,
/// `not-in-directory`, `target-failed`, `rate-limited`.
///
/// # Errors
/// The reason code.
pub fn check_move_hint(c: &MoveHintCheck<'_>) -> Result<(), &'static str> {
    let h = c.hint;
    let Ok(canonical) = move_hint_canonical(h) else {
        return Err("malformed");
    };
    if h.server_fqdn != c.box_server_fqdn || h.box_pub != c.box_pub {
        return Err("not-this-box");
    }
    if h.from_relay_id != c.current_relay_id {
        return Err("wrong-from");
    }
    if !verify(&canonical, c.signature, c.current_relay_key) {
        return Err("bad-signature");
    }
    if h.not_after.saturating_sub(h.issued_at) > MOVE_HINT_TTL_MS {
        return Err("ttl-too-long");
    }
    if h.issued_at > c.now.saturating_add(MESH_CLOCK_SKEW_MS) {
        return Err("future");
    }
    if h.not_after <= c.now {
        return Err("expired");
    }
    if verify_relay_blessing(c.target, c.ca_keys, c.now, c.services_apex).is_err() {
        return Err("bad-target");
    }
    if c.target.body.relay_kind != RelayKind::Full {
        return Err("target-not-full");
    }
    if c.target.body.relay_id != h.to_relay_id {
        return Err("target-mismatch");
    }
    let fresh = c
        .directory_fetched_at
        .is_some_and(|t| c.now.saturating_sub(t) <= BOX_DIRECTORY_MAX_AGE_MS);
    if c.directory.is_none() || !fresh {
        return Err("directory-stale");
    }
    match directory_relay(c.directory, &h.to_relay_id) {
        Some(e) if e.relay_key == c.target.body.relay_key => {}
        _ => return Err("not-in-directory"),
    }
    if let Some(t) = c.rate.failed_targets.get(&h.to_relay_id)
        && c.now.saturating_sub(*t) < MOVE_FAILED_TARGET_MS
    {
        return Err("target-failed");
    }
    match h.reason.as_str() {
        "locality" => {
            if c.rate
                .last_locality_at
                .is_some_and(|t| c.now.saturating_sub(t) < MOVE_LOCALITY_MIN_MS)
            {
                return Err("rate-limited");
            }
        }
        "co-locate" => {
            let day: Vec<u64> = c
                .rate
                .co_locate_at
                .iter()
                .copied()
                .filter(|t| c.now.saturating_sub(*t) < DAY)
                .collect();
            if day
                .iter()
                .any(|t| c.now.saturating_sub(*t) < MOVE_COLOCATE_MIN_MS)
                || day.len() >= MOVE_COLOCATE_MAX_PER_DAY
            {
                return Err("rate-limited");
            }
        }
        _ => {}
    }
    Ok(())
}

/// The rate state after acting on a hint.
#[must_use]
pub fn record_move_hint(rate: &MoveHintRateState, reason: &str, now: u64) -> MoveHintRateState {
    let mut co_locate_at: Vec<u64> = rate
        .co_locate_at
        .iter()
        .copied()
        .filter(|t| now.saturating_sub(*t) < DAY)
        .collect();
    if reason == "co-locate" {
        co_locate_at.push(now);
    }
    MoveHintRateState {
        last_locality_at: if reason == "locality" {
            Some(now)
        } else {
            rate.last_locality_at
        },
        co_locate_at,
        failed_targets: rate
            .failed_targets
            .iter()
            .filter(|(_, t)| now.saturating_sub(**t) < MOVE_FAILED_TARGET_MS)
            .map(|(k, t)| (k.clone(), *t))
            .collect(),
    }
}

/// The rate state after a move to `relay_id` failed.
#[must_use]
pub fn record_move_target_failed(
    rate: &MoveHintRateState,
    relay_id: &str,
    now: u64,
) -> MoveHintRateState {
    let mut failed_targets: BTreeMap<String, u64> = rate
        .failed_targets
        .iter()
        .filter(|(_, t)| now.saturating_sub(**t) < MOVE_FAILED_TARGET_MS)
        .map(|(k, t)| (k.clone(), *t))
        .collect();
    failed_targets.insert(relay_id.to_owned(), now);
    MoveHintRateState {
        last_locality_at: rate.last_locality_at,
        co_locate_at: rate.co_locate_at.clone(),
        failed_targets,
    }
}

// ── account moves (§10.3) ─────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountMove {
    pub account_hash: String,
    pub from_relay_id: String,
    pub to_relay_id: String,
    pub issued_at: u64,
    pub not_after: u64,
}

/// # Errors
/// [`MeshError`] for any field out of shape.
pub fn account_move_canonical(m: &AccountMove) -> Result<String, MeshError> {
    hex64("accountHash", &m.account_hash)?;
    relay_id("fromRelayId", &m.from_relay_id)?;
    relay_id("toRelayId", &m.to_relay_id)?;
    if m.from_relay_id == m.to_relay_id {
        return bad("toRelayId", "must differ from fromRelayId");
    }
    if m.not_after <= m.issued_at {
        return bad("notAfter", "must be after issuedAt");
    }
    Ok(CanonicalV1::new(TAG_RELAY_ACCOUNT_MOVE)?
        .text(&m.account_hash)?
        .text(&m.from_relay_id)?
        .text(&m.to_relay_id)?
        .uint(m.issued_at)?
        .uint(m.not_after)?
        .finish_string())
}

/// §10.3 (see `checkAccountMove`). Reasons in order: `malformed`, `ttl-too-long`, `future`, `expired`, `not-home`,
/// `relay-revoked`, `unknown-relay`, `target-not-full`, `too-soon`, `bad-signature`.
///
/// # Errors
/// The reason code.
pub fn check_account_move(
    m: &AccountMove,
    signature: &str,
    expected_home: Option<&str>,
    last_accepted_at: Option<u64>,
    ctx: &MeshCheckContext<'_>,
) -> Result<(), &'static str> {
    let Ok(canonical) = account_move_canonical(m) else {
        return Err("malformed");
    };
    if m.not_after.saturating_sub(m.issued_at) > ACCOUNT_MOVE_TTL_MS {
        return Err("ttl-too-long");
    }
    if m.issued_at > ctx.now.saturating_add(MESH_CLOCK_SKEW_MS) {
        return Err("future");
    }
    if m.not_after <= ctx.now {
        return Err("expired");
    }
    if expected_home != Some(m.from_relay_id.as_str()) {
        return Err("not-home");
    }
    if ctx.log.revoked_relays.contains_key(&m.from_relay_id)
        || ctx.log.revoked_relays.contains_key(&m.to_relay_id)
    {
        return Err("relay-revoked");
    }
    let (Some(from), Some(to)) = (
        directory_relay(ctx.directory, &m.from_relay_id),
        directory_relay(ctx.directory, &m.to_relay_id),
    ) else {
        return Err("unknown-relay");
    };
    if to.relay_kind != RelayKind::Full {
        return Err("target-not-full");
    }
    if last_accepted_at.is_some_and(|t| ctx.now.saturating_sub(t) < ACCOUNT_MOVE_MIN_INTERVAL_MS) {
        return Err("too-soon");
    }
    if !verify(&canonical, signature, &from.relay_key) {
        return Err("bad-signature");
    }
    Ok(())
}

// ── phone grants (§8.3, §8.4) ─────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneRouteGrant {
    pub hostname: String,
    pub phone_route_pub: String,
    pub generation: u64,
    pub holder_relay_id: String,
    pub ledger_relay_id: String,
    pub issued_at: u64,
    pub not_after: u64,
}

/// # Errors
/// [`MeshError`] for any field out of shape.
pub fn phone_route_grant_canonical(g: &PhoneRouteGrant) -> Result<String, MeshError> {
    host_labels("hostname", &g.hostname, 3)?;
    hex64("phoneRoutePub", &g.phone_route_pub)?;
    if g.generation < 1 {
        return bad("generation", "must be ≥ 1");
    }
    relay_id("holderRelayId", &g.holder_relay_id)?;
    relay_id("ledgerRelayId", &g.ledger_relay_id)?;
    if g.not_after <= g.issued_at {
        return bad("notAfter", "must be after issuedAt");
    }
    Ok(CanonicalV1::new(TAG_PHONE_ROUTE_GRANT)?
        .text(&g.hostname)?
        .text(&g.phone_route_pub)?
        .uint(g.generation)?
        .text(&g.holder_relay_id)?
        .text(&g.ledger_relay_id)?
        .uint(g.issued_at)?
        .uint(g.not_after)?
        .finish_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneItem {
    pub grant: PhoneRouteGrant,
    pub signature: String,
}

/// §8.4 (see `checkPhoneItem`). Reasons in order: `malformed`, `not-bare-name`, `ttl-too-long`, `future`, `expired`,
/// `wrong-holder`, `relay-revoked`, `unknown-relay`, `not-full`, `bad-signature`.
///
/// # Errors
/// The reason code.
pub fn check_phone_item(
    item: &PhoneItem,
    announcer_relay_id: &str,
    ctx: &MeshCheckContext<'_>,
) -> Result<(), &'static str> {
    let g = &item.grant;
    let Ok(canonical) = phone_route_grant_canonical(g) else {
        return Err("malformed");
    };
    if !is_bare_phone_name(&g.hostname, ctx.services_apex) {
        return Err("not-bare-name");
    }
    if g.not_after.saturating_sub(g.issued_at) > PHONE_ROUTE_GRANT_TTL_MS {
        return Err("ttl-too-long");
    }
    if g.issued_at > ctx.now.saturating_add(MESH_CLOCK_SKEW_MS) {
        return Err("future");
    }
    if g.not_after <= ctx.now {
        return Err("expired");
    }
    if announcer_relay_id != g.holder_relay_id {
        return Err("wrong-holder");
    }
    if ctx.log.revoked_relays.contains_key(&g.ledger_relay_id)
        || ctx.log.revoked_relays.contains_key(&g.holder_relay_id)
    {
        return Err("relay-revoked");
    }
    let (Some(ledger), Some(holder)) = (
        directory_relay(ctx.directory, &g.ledger_relay_id),
        directory_relay(ctx.directory, &g.holder_relay_id),
    ) else {
        return Err("unknown-relay");
    };
    if ledger.relay_kind != RelayKind::Full || holder.relay_kind != RelayKind::Full {
        return Err("not-full");
    }
    if !verify(&canonical, &item.signature, &ledger.relay_key) {
        return Err("bad-signature");
    }
    Ok(())
}

/// `Greater` when `a` wins: higher generation, later `issuedAt`, smaller holder id.
#[must_use]
pub fn compare_phone_items(a: &PhoneItem, b: &PhoneItem) -> Ordering {
    let (x, y) = (&a.grant, &b.grant);
    x.generation
        .cmp(&y.generation)
        .then(x.issued_at.cmp(&y.issued_at))
        .then(y.holder_relay_id.cmp(&x.holder_relay_id))
}

// ── routing (§7.3, §8.1, §10.2) ───────────────────────────────────────────

/// One live, valid, winning attachment of the account: `(relayId, attachedAt)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeAttachment {
    pub relay_id: String,
    pub attached_at: u64,
}

/// §7.3 (see `accountHome`). `account_move` is `(toRelayId, notAfter)` of an accepted move.
#[must_use]
pub fn account_home(
    attachments: &[HomeAttachment],
    directory: Option<&RelayDirectoryBody>,
    account_move: Option<(&str, u64)>,
    now: u64,
) -> Option<String> {
    if let Some((to, not_after)) = account_move
        && not_after > now
        && attachments.iter().any(|a| a.relay_id == to)
    {
        return Some(to.to_owned());
    }
    let mut per: BTreeMap<&str, (u64, u64)> = BTreeMap::new();
    for a in attachments {
        if directory_relay(directory, &a.relay_id).is_none_or(|r| r.relay_kind != RelayKind::Full) {
            continue;
        }
        let e = per.entry(a.relay_id.as_str()).or_insert((0, a.attached_at));
        e.0 = e.0.saturating_add(1);
        e.1 = e.1.min(a.attached_at);
    }
    per.into_iter()
        .max_by(|(ia, (na, fa)), (ib, (nb, fb))| na.cmp(nb).then(fb.cmp(fa)).then(ib.cmp(ia)))
        .map(|(id, _)| id.to_owned())
}

/// §8.1: `full`, unrevoked relays by `sha256hex(accountHash + "|" + relayId)`, highest first.
///
/// # Errors
/// [`MeshError`] for a malformed account.
pub fn phone_ledger_ranking(
    account: &str,
    directory: Option<&RelayDirectoryBody>,
    log: Option<&RelayLogState>,
) -> Result<Vec<String>, MeshError> {
    let ah = account_hash(account)?;
    let mut ranked: Vec<(String, String)> = directory
        .map(|d| d.relays.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|r| {
            r.relay_kind == RelayKind::Full
                && log.is_none_or(|l| !l.revoked_relays.contains_key(&r.relay_id))
        })
        .map(|r| {
            (
                sha256_hex(format!("{ah}|{}", r.relay_id).as_bytes()),
                r.relay_id.clone(),
            )
        })
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(ranked.into_iter().map(|(_, id)| id).collect())
}

/// One entry relay's share of the window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebalanceWindow {
    pub relay_id: String,
    pub bytes: u64,
    pub streams: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebalanceRelay {
    pub relay_id: String,
    pub relay_kind: RelayKind,
    pub last_load_at: Option<u64>,
    pub draining: bool,
    pub tunnels: u64,
    pub capacity: u64,
}

/// §10.2, pure (see `rebalanceDecision`): `Ok(target)` to move. Refusals in order: `legacy-box`, `recent-move`,
/// `below-threshold`, `no-candidate`, `share`, `lead`, `unknown-relay`, `not-full`, `load-stale`, `draining`,
/// `load-high`.
///
/// # Errors
/// The reason code.
pub fn rebalance_decision(
    home: &str,
    window: &[RebalanceWindow],
    relays: &[RebalanceRelay],
    last_move_at: Option<u64>,
    has_legacy_box: bool,
    now: u64,
) -> Result<String, &'static str> {
    if has_legacy_box {
        return Err("legacy-box");
    }
    if last_move_at.is_some_and(|t| now.saturating_sub(t) < ACCOUNT_MOVE_MIN_INTERVAL_MS) {
        return Err("recent-move");
    }
    let mut bytes: BTreeMap<&str, u128> = BTreeMap::new();
    let mut total: u128 = 0;
    let mut streams: u128 = 0;
    for w in window {
        let e = bytes.entry(w.relay_id.as_str()).or_insert(0);
        *e = e.saturating_add(u128::from(w.bytes));
        total = total.saturating_add(u128::from(w.bytes));
        streams = streams.saturating_add(u128::from(w.streams));
    }
    if total < u128::from(REBALANCE_MIN_BYTES) && streams < u128::from(REBALANCE_MIN_STREAMS) {
        return Err("below-threshold");
    }
    let top = bytes
        .iter()
        .filter(|(id, b)| **id != home && **b > 0)
        .max_by(|(ia, ba), (ib, bb)| ba.cmp(bb).then(ib.cmp(ia)));
    let Some((to, bt)) = top else {
        return Err("no-candidate");
    };
    let bt = *bt;
    let bh = bytes.get(home).copied().unwrap_or(0);
    if bt.saturating_mul(10) < u128::from(REBALANCE_MIN_SHARE_TENTHS).saturating_mul(total) {
        return Err("share");
    }
    if bt.saturating_sub(bh).saturating_mul(10)
        < u128::from(REBALANCE_MIN_LEAD_TENTHS).saturating_mul(total)
        || bt < bh
    {
        return Err("lead");
    }
    let Some(t) = relays.iter().find(|r| r.relay_id == *to) else {
        return Err("unknown-relay");
    };
    if t.relay_kind != RelayKind::Full {
        return Err("not-full");
    }
    if t.last_load_at
        .is_none_or(|l| now.saturating_sub(l) >= MESH_LOAD_FRESH_MS)
    {
        return Err("load-stale");
    }
    if t.draining {
        return Err("draining");
    }
    if t.capacity == 0
        || u128::from(t.tunnels).saturating_mul(10)
            >= u128::from(REBALANCE_MAX_LOAD_TENTHS).saturating_mul(u128::from(t.capacity))
    {
        return Err("load-high");
    }
    Ok((*to).to_owned())
}

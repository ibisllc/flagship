//! Hybrid companions of admin-root rotations and device capability grants
//! (docs/architecture-v2/pq-suites.md §20). Twin of `packages/protocol/src/pqAuthorityRecords.ts`;
//! both read `packages/protocol/test-vectors/pq-authority/vectors.json`.

use crate::key_id;
use crate::trust::{
    BindingWire, Envelope, Expectation, PolicyState, Role, TrustError, VerifiedBinding, hex,
    verify_binding, verify_critical_signature,
};
use flagship_protocol::SuiteId;
use flagship_protocol::parse::parse_lower_hex;

pub const TAG_ADMIN_ROOT_ROTATION_V2: &str = "flagship/admin-root-rotation/v2";
pub const TAG_DEVICE_CAPABILITY_GRANT: &str = "flagship/device-capability-grant/v2";
const HYBRID: &str = "hybrid-ed25519-mldsa65/v1";
const ED25519_PK_LEN: usize = 32;
const MLDSA65_PK_LEN: usize = 1952;

/// The device scopes in canonical order (`DEVICE_SCOPES` in deviceCapability.ts).
pub const DEVICE_SCOPES: [&str; 9] = [
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

fn field_ok(s: &str) -> bool {
    s.bytes().all(|c| c != b'|' && c > 0x1f && c != 0x7f)
}

fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// The hybrid key id of a binding's two keys (no signature check).
///
/// # Errors
/// `bad-public-key` when either key is not lowercase hex of its length.
pub fn binding_key_id_hex(
    ed25519_pub_hex: &str,
    mldsa_pub_hex: &str,
) -> Result<String, TrustError> {
    let ed = parse_lower_hex(ed25519_pub_hex, ED25519_PK_LEN, ED25519_PK_LEN)
        .map_err(|_| TrustError::BadPublicKey)?;
    let ml = parse_lower_hex(mldsa_pub_hex, MLDSA65_PK_LEN, MLDSA65_PK_LEN)
        .map_err(|_| TrustError::BadPublicKey)?;
    let mut pk = ed;
    pk.extend_from_slice(&ml);
    Ok(hex(&key_id(SuiteId::HybridSigEd25519MlDsa65V1, &pk)))
}

/// The v1 rotation's fields.
#[derive(Clone, Copy, Debug)]
pub struct Rotation<'a> {
    pub username: &'a str,
    pub old_admin_root_pub_hex: &'a str,
    pub new_admin_root_pub_hex: &'a str,
    pub issued_at: u64,
}

/// `flagship/admin-root-rotation/v2|<username>|<oldRootHex>|<newRootHex>|<issuedAt>|<newRootKeyIdHex>`.
///
/// # Errors
/// `binding-malformed` for a field the TypeScript builder refuses.
pub fn canonical_admin_root_rotation_v2(
    r: &Rotation<'_>,
    new_root_key_id_hex: &str,
) -> Result<Vec<u8>, TrustError> {
    if !field_ok(r.username)
        || !is_lower_hex(new_root_key_id_hex, 64)
        || r.issued_at > (1 << 53) - 1
    {
        return Err(TrustError::BindingMalformed);
    }
    Ok(format!(
        "{TAG_ADMIN_ROOT_ROTATION_V2}|{}|{}|{}|{}|{new_root_key_id_hex}",
        r.username,
        r.old_admin_root_pub_hex.to_ascii_lowercase(),
        r.new_admin_root_pub_hex.to_ascii_lowercase(),
        r.issued_at
    )
    .into_bytes())
}

/// The companion's envelope as TypeScript reads it: only the hybrid suite counts.
fn hybrid_envelope<'a>(e: Option<Envelope<'a>>) -> Result<Envelope<'a>, TrustError> {
    let e = e.ok_or(TrustError::BadSignature)?;
    if e.suite == HYBRID {
        Ok(e)
    } else if e.suite == "ed25519/v1" {
        Err(TrustError::StrictRequiresHybrid)
    } else {
        Err(TrustError::UnknownSuite)
    }
}

/// A rotation's companion: the old root's hybrid signature and the new root's binding.
#[derive(Clone, Copy, Debug)]
pub struct RotationPq<'a> {
    pub signature: Option<Envelope<'a>>,
    pub new_root_binding: BindingWire<'a>,
}

/// Verifies a rotation's companion and returns the new root's verified binding.
/// `old_root_binding` is the verifier's own pin for the old root. `pq` is `None` when no
/// companion was sent.
///
/// # Errors
/// Any [`TrustError`], in the TypeScript port's order.
pub fn verify_admin_root_rotation_pq(
    rotation: &Rotation<'_>,
    pq: Option<&RotationPq<'_>>,
    old_root_binding: Option<&VerifiedBinding>,
    policy: &PolicyState,
    now: u64,
) -> Result<VerifiedBinding, TrustError> {
    let pq = pq.ok_or(TrustError::StrictRequiresHybrid)?;
    let envelope = hybrid_envelope(pq.signature)?;
    let subject = rotation.username.to_ascii_lowercase();
    let new_hex = rotation.new_admin_root_pub_hex.to_ascii_lowercase();
    let new_binding = verify_binding(
        &pq.new_root_binding,
        &Expectation {
            role: Role::AdminRoot,
            subject_id: &subject,
            ed25519_pub_hex: &new_hex,
            mldsa_pub_hex: None,
            now,
            min_issued_at: None,
        },
    )?;
    let key_id = binding_key_id_hex(
        pq.new_root_binding.ed25519_pub_hex,
        pq.new_root_binding.mldsa_pub_hex,
    )?;
    let message = canonical_admin_root_rotation_v2(rotation, &key_id)?;
    verify_critical_signature(
        &message,
        TAG_ADMIN_ROOT_ROTATION_V2,
        envelope,
        rotation.old_admin_root_pub_hex,
        old_root_binding,
        policy,
    )?;
    Ok(new_binding)
}

/// A device capability grant's fields.
#[derive(Clone, Debug)]
pub struct DeviceGrant<'a> {
    pub grant_id: &'a str,
    pub username: &'a str,
    pub device_id: &'a str,
    pub device_pub_hex: &'a str,
    pub scopes: Vec<&'a str>,
    pub issued_at: u64,
    pub expires_at: u64,
}

/// The grant's canonical bytes, exactly as `canonicalDeviceCapabilityGrant` builds them.
///
/// # Errors
/// `bad-signature` for a grant the TypeScript builder refuses (the gate's code for it).
pub fn canonical_device_capability_grant(g: &DeviceGrant<'_>) -> Result<Vec<u8>, TrustError> {
    let bad = TrustError::BadSignature;
    if ![g.grant_id, g.username, g.device_id]
        .iter()
        .all(|f| field_ok(f))
        || g.expires_at <= g.issued_at
        || g.scopes.is_empty()
        || !is_lower_hex(g.device_id, 32)
        || !is_lower_hex(&g.device_pub_hex.to_ascii_lowercase(), 64)
    {
        return Err(bad);
    }
    let mut idx = Vec::with_capacity(g.scopes.len());
    for s in &g.scopes {
        let i = DEVICE_SCOPES.iter().position(|k| k == s).ok_or(bad)?;
        if idx.contains(&i) {
            return Err(bad);
        }
        idx.push(i);
    }
    idx.sort_unstable();
    let scopes: Vec<&str> = idx
        .iter()
        .filter_map(|&i| DEVICE_SCOPES.get(i).copied())
        .collect();
    Ok(format!(
        "{TAG_DEVICE_CAPABILITY_GRANT}|{}|{}|{}|{}|{}|{}|{}",
        g.grant_id,
        g.username,
        g.device_id,
        g.device_pub_hex.to_ascii_lowercase(),
        scopes.join(","),
        g.issued_at,
        g.expires_at
    )
    .into_bytes())
}

/// Verifies a grant's companion: the hybrid signature of `signer_pub_hex` (the root the grant's
/// classical signature verified under) by that root's verified binding.
///
/// # Errors
/// Any [`TrustError`], in the TypeScript port's order.
pub fn verify_device_grant_pq(
    grant: &DeviceGrant<'_>,
    pq: Option<Envelope<'_>>,
    signer_pub_hex: &str,
    signer_binding: Option<&VerifiedBinding>,
    policy: &PolicyState,
) -> Result<(), TrustError> {
    let envelope = hybrid_envelope(pq)?;
    let message = canonical_device_capability_grant(grant)?;
    verify_critical_signature(
        &message,
        TAG_DEVICE_CAPABILITY_GRANT,
        envelope,
        signer_pub_hex,
        signer_binding,
        policy,
    )?;
    Ok(())
}

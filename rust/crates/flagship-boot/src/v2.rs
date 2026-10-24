//! Boot unlock v2 (`packages/protocol/src/bootUnlockV2.ts`, `docs/architecture-v2/pq-suites.md`
//! §19): the box side of the hybrid reply and the v3 lease, and the hybrid-signed v2 request,
//! the same as the Go helper (`installer/unseal-helper/internal/unseal/v2.go`). Shared vectors:
//! `packages/protocol/test-vectors/boot-unlock-v2/vectors.json`.

use crate::gohex;
use crate::gojson;
use crate::lease::{self, LeaseError};
use core::fmt;
use ed25519_dalek::SigningKey;
use flagship_crypto::seal::{self as hseal, HybridSealSecretKey};
use flagship_crypto::{CryptoError, HybridSigningKey, HybridVerifyingKey};
use flagship_protocol::SuiteId;
use sha2::{Digest, Sha512};
use zeroize::Zeroizing;

/// Purpose of the v1 request the worker checks.
pub const TAG_SECRET_REQUEST_V1: &str = "flagship/secret-request/v1";
/// Purpose of the v2 request the phone checks.
pub const TAG_SECRET_REQUEST_V2: &str = "flagship/secret-request/v2";
/// Seal purpose and statement tag of a v2 reply.
pub const TAG_BOOT_REPLY_V2: &str = "flagship/boot-reply/v2";
/// Seal purpose and statement tag of a v3 lease.
pub const TAG_AUTO_UNLOCK_LEASE_V3: &str = "flagship/auto-unlock-lease/v3";
const MAGIC: &[u8] = b"flagship/envelope/v2";
const HYBRID_SIG_LEN: usize = 3373;
/// The owner's hybrid public key length (Ed25519 || ML-DSA-65).
pub const HYBRID_PK_LEN: usize = 1984;
const MAX_DISK_KEY: usize = 1024;

/// A v2 refusal; `code()` is the vectors' `expect`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V2Error {
    /// Shape, bounds or a header problem.
    Malformed,
    /// A classical reply or lease under the strict unlock policy.
    StrictRefusesV1,
    /// The owner's hybrid signature does not verify, or the signed fields differ.
    OwnerSignature,
    /// Sealed to another key.
    RecipientMismatch,
    /// Anything after the header: wrong context, tampering, a non-contributory share.
    DecryptFailed,
    /// The lease expired by the floor-raised clock.
    LeaseExpired,
}

impl V2Error {
    /// The stable code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Malformed => "v2-malformed",
            Self::StrictRefusesV1 => "strict-refuses-v1",
            Self::OwnerSignature => "owner-signature",
            Self::RecipientMismatch => "recipient-mismatch",
            Self::DecryptFailed => "decrypt-failed",
            Self::LeaseExpired => "lease-expired",
        }
    }
}

impl fmt::Display for V2Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "boot-unlock-v2: {}", self.code())
    }
}

impl std::error::Error for V2Error {}

fn from_crypto(e: CryptoError) -> V2Error {
    match e {
        CryptoError::RecipientMismatch => V2Error::RecipientMismatch,
        CryptoError::DecryptFailed => V2Error::DecryptFailed,
        _ => V2Error::Malformed,
    }
}

/// True when `b` is a v2 envelope; a v1 seal starts with an X25519 point.
#[must_use]
pub fn is_v2_sealed(b: &[u8]) -> bool {
    b.split_first().is_some_and(|(n, rest)| {
        usize::from(*n) == MAGIC.len() && rest.len() > MAGIC.len() && rest.starts_with(MAGIC)
    })
}

/// The box's unlock policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlockPolicy {
    /// v1 and v2 are both taken.
    Compat,
    /// Only v2.
    Strict,
}

/// `/boot/flagship-unlock-policy` as `parseUnlockPolicy` reads it: no file is compat; exactly
/// `compat` or `strict` (one trailing newline) are themselves; anything else is strict once the
/// box holds v2 material.
#[must_use]
pub fn parse_unlock_policy(text: Option<&[u8]>, has_v2_material: bool) -> UnlockPolicy {
    let Some(t) = text else {
        return UnlockPolicy::Compat;
    };
    let t = t.strip_suffix(b"\n").unwrap_or(t);
    match t {
        b"compat" => UnlockPolicy::Compat,
        b"strict" => UnlockPolicy::Strict,
        _ if has_v2_material => UnlockPolicy::Strict,
        _ => UnlockPolicy::Compat,
    }
}

/// Refuses a classical reply or lease under strict.
///
/// # Errors
/// [`V2Error::StrictRefusesV1`].
pub fn box_accepts(policy: UnlockPolicy, sealed: &[u8]) -> Result<(), V2Error> {
    if policy == UnlockPolicy::Strict && !is_v2_sealed(sealed) {
        return Err(V2Error::StrictRefusesV1);
    }
    Ok(())
}

fn kem_key_id_hex(seed: &[u8; 32]) -> Result<String, V2Error> {
    let sk = HybridSealSecretKey::from_seed(seed).map_err(|_| V2Error::Malformed)?;
    Ok(gohex::encode(&flagship_crypto::key_id(
        SuiteId::HybridSealV1,
        sk.public_key().as_bytes(),
    )))
}

fn unpack(p: &[u8]) -> Result<(Zeroizing<Vec<u8>>, &[u8]), V2Error> {
    let (n, rest) = p.split_first_chunk::<2>().ok_or(V2Error::Malformed)?;
    let n = usize::from(u16::from_be_bytes(*n));
    if n == 0 || n > MAX_DISK_KEY || rest.len() != n + HYBRID_SIG_LEN {
        return Err(V2Error::Malformed);
    }
    let (k, sig) = rest.split_at(n);
    Ok((Zeroizing::new(k.to_vec()), sig))
}

fn owner_verifies(owner_pq: &[u8], purpose: &str, statement: &str, sig: &[u8]) -> bool {
    HybridVerifyingKey::from_bytes(owner_pq)
        .and_then(|k| k.verify(purpose, statement.as_bytes(), sig))
        .is_ok()
}

fn digest_hex(key: &[u8]) -> String {
    gohex::encode(&Sha512::digest(key))
}

/// Opens a v2 reply with the per-boot reply key and checks the owner's hybrid signature.
///
/// # Errors
/// See [`V2Error`].
pub fn open_boot_reply_v2(
    sealed: &[u8],
    server_domain: &str,
    boot_pub_hex: &str,
    nonce_hex: &str,
    reply_seed: &[u8; 32],
    owner_pq: &[u8],
) -> Result<Zeroizing<Vec<u8>>, V2Error> {
    let domain = server_domain.to_ascii_lowercase();
    let boot_hex = boot_pub_hex.to_ascii_lowercase();
    let nonce_hex = nonce_hex.to_ascii_lowercase();
    let boot = gohex::decode(boot_hex.as_bytes()).map_err(|_| V2Error::Malformed)?;
    let nonce = gohex::decode(nonce_hex.as_bytes()).map_err(|_| V2Error::Malformed)?;
    if boot.len() != 32 || nonce.len() != 32 || owner_pq.len() != HYBRID_PK_LEN {
        return Err(V2Error::Malformed);
    }
    if !is_v2_sealed(sealed) {
        return Err(V2Error::Malformed);
    }
    let sk = HybridSealSecretKey::from_seed(reply_seed).map_err(|_| V2Error::Malformed)?;
    let ctx: [&[u8]; 4] = [domain.as_bytes(), &boot, b"unlock-key", &nonce];
    let opened = hseal::open(&sk, TAG_BOOT_REPLY_V2, &ctx, sealed).map_err(from_crypto)?;
    let (key, sig) = unpack(&opened.plaintext)?;
    if opened
        .header
        .session_nonce
        .as_ref()
        .map(<[u8; 32]>::as_slice)
        != Some(nonce.as_slice())
    {
        return Err(V2Error::DecryptFailed);
    }
    let statement = [
        TAG_BOOT_REPLY_V2,
        &domain,
        &boot_hex,
        "unlock-key",
        &nonce_hex,
        &kem_key_id_hex(reply_seed)?,
        &digest_hex(&key),
        &opened.header.issued_at.to_string(),
    ]
    .join("|");
    if !owner_verifies(owner_pq, TAG_BOOT_REPLY_V2, &statement, sig) {
        return Err(V2Error::OwnerSignature);
    }
    Ok(key)
}

/// The lease fields the owner's v3 signature covers.
#[derive(Debug, Clone)]
pub struct LeaseV3Fields {
    /// The box.
    pub server_domain: String,
    /// The box's boot key, hex.
    pub boot_pub_hex: String,
    /// The revoke handle.
    pub lease_id: String,
    /// Epoch ms.
    pub issued_at: i64,
    /// Epoch ms.
    pub expires_at: i64,
    /// -1 when absent.
    pub max_uses: i64,
}

/// Opens a v3 lease's sealed key with the lease key and checks the owner's hybrid signature over
/// the lease fields and the expiry against `now_ms` (the clock raised to the time floor).
///
/// # Errors
/// See [`V2Error`].
pub fn open_lease_v3_sealed(
    l: &LeaseV3Fields,
    sealed: &[u8],
    lease_seed: &[u8; 32],
    owner_pq: &[u8],
    now_ms: i64,
) -> Result<Zeroizing<Vec<u8>>, V2Error> {
    let domain = l.server_domain.to_ascii_lowercase();
    let boot_hex = l.boot_pub_hex.to_ascii_lowercase();
    let lease_id = l.lease_id.to_ascii_lowercase();
    let boot = gohex::decode(boot_hex.as_bytes()).map_err(|_| V2Error::Malformed)?;
    if boot.len() != 32 || owner_pq.len() != HYBRID_PK_LEN || !is_v2_sealed(sealed) {
        return Err(V2Error::Malformed);
    }
    let sk = HybridSealSecretKey::from_seed(lease_seed).map_err(|_| V2Error::Malformed)?;
    let ctx: [&[u8]; 3] = [domain.as_bytes(), &boot, lease_id.as_bytes()];
    let opened = hseal::open(&sk, TAG_AUTO_UNLOCK_LEASE_V3, &ctx, sealed).map_err(from_crypto)?;
    let (key, sig) = unpack(&opened.plaintext)?;
    let statement = [
        TAG_AUTO_UNLOCK_LEASE_V3.to_owned(),
        domain,
        boot_hex,
        kem_key_id_hex(lease_seed)?,
        lease_id,
        digest_hex(&key),
        l.issued_at.to_string(),
        l.expires_at.to_string(),
        l.max_uses.to_string(),
    ]
    .join("|");
    let times = i64::try_from(opened.header.issued_at).ok() == Some(l.issued_at)
        && opened.header.expires_at.and_then(|e| i64::try_from(e).ok()) == Some(l.expires_at);
    if !owner_verifies(owner_pq, TAG_AUTO_UNLOCK_LEASE_V3, &statement, sig) || !times {
        return Err(V2Error::OwnerSignature);
    }
    if l.expires_at <= now_ms {
        return Err(V2Error::LeaseExpired);
    }
    Ok(key)
}

/// Why a lease (either version) was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnyLeaseError {
    /// The v1 checks, with the Go helper's text.
    V1(LeaseError),
    /// A v2 refusal.
    V2(V2Error),
}

impl fmt::Display for AnyLeaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::V1(e) => e.fmt(f),
            Self::V2(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for AnyLeaseError {}

/// Opens what `GET /api/boot/lease` returns: v1 through [`lease::open_auto_unlock_lease`]
/// (refused under strict), v3 through [`open_lease_v3_sealed`].
///
/// # Errors
/// See [`AnyLeaseError`].
#[allow(clippy::too_many_arguments)]
pub fn open_auto_unlock_lease_any(
    body: &[u8],
    boot_seed: &[u8; 32],
    server_domain: &[u8],
    owner_pub: &[u8],
    owner_pq: Option<&[u8]>,
    lease_seed: Option<&[u8; 32]>,
    policy: UnlockPolicy,
    now_ms: i64,
) -> Result<Zeroizing<Vec<u8>>, AnyLeaseError> {
    let l = gojson::unmarshal_lease(body).map_err(|_| AnyLeaseError::V1(LeaseError::Malformed))?;
    let sealed = l
        .sealed_key
        .as_deref()
        .and_then(|s| gohex::decode(s.as_bytes()).ok())
        .filter(|b| !b.is_empty())
        .ok_or(AnyLeaseError::V1(LeaseError::Malformed))?;
    box_accepts(policy, &sealed).map_err(AnyLeaseError::V2)?;
    if !is_v2_sealed(&sealed) {
        return lease::open_auto_unlock_lease(body, boot_seed, server_domain, owner_pub, now_ms)
            .map_err(AnyLeaseError::V1);
    }
    let (Some(owner_pq), Some(lease_seed)) = (owner_pq, lease_seed) else {
        return Err(AnyLeaseError::V2(V2Error::Malformed));
    };
    let (Some(domain), Some(lease_id), Some(stk_pub), Some(issued_at), Some(expires_at)) = (
        &l.server_domain,
        &l.lease_id,
        &l.stk_pub,
        l.issued_at,
        l.expires_at,
    ) else {
        return Err(AnyLeaseError::V1(LeaseError::Malformed));
    };
    if !domain.as_bytes().eq_ignore_ascii_case(server_domain) {
        return Err(AnyLeaseError::V1(LeaseError::OtherServer));
    }
    let own = gohex::encode(SigningKey::from_bytes(boot_seed).verifying_key().as_bytes());
    if stk_pub.to_ascii_lowercase() != own {
        return Err(AnyLeaseError::V1(LeaseError::Recipient));
    }
    let f = LeaseV3Fields {
        server_domain: domain.clone(),
        boot_pub_hex: own,
        lease_id: lease_id.clone(),
        issued_at,
        expires_at,
        max_uses: l.max_uses.unwrap_or(-1),
    };
    open_lease_v3_sealed(&f, &sealed, lease_seed, owner_pq, now_ms).map_err(AnyLeaseError::V2)
}

/// The v2 request body for `POST /api/boot/request`, byte for byte what the Go helper prints:
/// the v1 request signed by the boot key (the worker checks it) and the hybrid-signed extension.
///
/// # Errors
/// [`V2Error::Malformed`] for bad inputs or a failed signature.
pub fn sign_request_v2(
    boot_seed: &[u8; 32],
    boot_mldsa_seed: &[u8; 32],
    server_domain: &str,
    nonce_hex: &str,
    issued_at: i64,
    reply_seed: &[u8; 32],
    deterministic: bool,
) -> Result<String, V2Error> {
    let domain = server_domain.to_ascii_lowercase();
    let nonce_hex = nonce_hex.to_ascii_lowercase();
    let ok_domain = !domain.is_empty()
        && domain
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-');
    if !ok_domain || gohex::decode(nonce_hex.as_bytes()).map(|n| n.len()) != Ok(32) {
        return Err(V2Error::Malformed);
    }
    let ed = SigningKey::from_bytes(boot_seed);
    let boot_pub = gohex::encode(ed.verifying_key().as_bytes());
    let at = issued_at.to_string();
    let v1 = [
        TAG_SECRET_REQUEST_V1,
        &domain,
        &boot_pub,
        "unlock-key",
        &nonce_hex,
        &at,
    ]
    .join("|");
    let reply = HybridSealSecretKey::from_seed(reply_seed).map_err(|_| V2Error::Malformed)?;
    let reply_pub = reply.public_key().as_bytes();
    let v2 = [
        TAG_SECRET_REQUEST_V2,
        &domain,
        &boot_pub,
        "unlock-key",
        &nonce_hex,
        &gohex::encode(&flagship_crypto::key_id(SuiteId::HybridSealV1, reply_pub)),
        &at,
    ]
    .join("|");
    let hk =
        HybridSigningKey::from_seeds(boot_seed, boot_mldsa_seed).map_err(|_| V2Error::Malformed)?;
    let sig = if deterministic {
        hk.sign_deterministic(TAG_SECRET_REQUEST_V2, v2.as_bytes())
    } else {
        hk.sign(TAG_SECRET_REQUEST_V2, v2.as_bytes())
    }
    .map_err(|_| V2Error::Malformed)?;
    let v1_sig = ed25519_dalek::Signer::sign(&ed, v1.as_bytes());
    Ok(format!(
        "{{\"request\":{{\"serverDomain\":\"{domain}\",\"stkPub\":\"{boot_pub}\",\"purpose\":\"unlock-key\",\"nonce\":\"{nonce_hex}\",\"issuedAt\":{issued_at}}},\"signature\":\"{}\",\"pq\":{{\"v\":2,\"replyKemPubHex\":\"{}\",\"signature\":\"{}\"}}}}",
        gohex::encode(&v1_sig.to_bytes()),
        gohex::encode(reply_pub),
        gohex::encode(&sig)
    ))
}

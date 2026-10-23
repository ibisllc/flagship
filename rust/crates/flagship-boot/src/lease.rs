//! The auto-unlock lease check of the Go helper's `OpenAutoUnlockLease`
//! (`installer/unseal-helper/internal/unseal/lease.go`), in the same order
//! and with the same error text, shared with the TS, Go and phone tests
//! through `packages/protocol/test-vectors/boot-key/vectors.json`.
//!
//! ```text
//! signed = flagship/auto-unlock-lease/v2|domain|hex(recipient)|leaseId|hex(sealedKey)|issuedAt|expiresAt|maxUses or -1
//! ```
//!
//! The boot worker remains the authority on `maxUses` and revocation; the box
//! cannot count uses, and before an authenticated time source its clock may be
//! wrong (behind accepts a lease the worker should refuse; ahead falls back to
//! asking the phone).

use crate::gohex;
use crate::gojson;
use crate::seal::{self, SealError};
use core::fmt;
use ed25519_dalek::{Signature, SigningKey, Verifier, VerifyingKey};
use zeroize::Zeroizing;

/// The lease's signature tag (`TAG_AUTO_UNLOCK_LEASE_V2` in phoneEndpoint.ts).
pub const TAG_AUTO_UNLOCK_LEASE_V2: &str = "flagship/auto-unlock-lease/v2";

/// Why a lease was refused. The `Display` text is the Go helper's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseError {
    /// Not JSON of the lease's shape, a missing field, or bad hex.
    Malformed,
    /// `serverDomain` is not this box.
    OtherServer,
    /// `stkPub` is not this box's boot key.
    Recipient,
    /// The owner did not sign these bytes.
    Signature,
    /// `expiresAt` is not after the box's clock.
    Expired,
    /// The sealed key did not open.
    Open(SealError),
}

impl fmt::Display for LeaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed => f.write_str("lease is malformed"),
            Self::OtherServer => f.write_str("lease is for another server"),
            Self::Recipient => f.write_str("lease is not sealed to this box's boot key"),
            Self::Signature => f.write_str("lease signature does not verify under the owner key"),
            Self::Expired => f.write_str("lease has expired"),
            Self::Open(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for LeaseError {}

fn canonical_field(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|c| c != b'|' && c > 0x1f && c != 0x7f)
}

fn hex_of(s: &str, n: usize) -> Option<Vec<u8>> {
    let b = gohex::decode(s.as_bytes()).ok()?;
    (!b.is_empty() && (n == 0 || b.len() == n)).then_some(b)
}

/// Go's per-byte `RuneError` decoding of a string that may not be UTF-8.
fn go_runes(s: &[u8]) -> Vec<char> {
    let mut out = Vec::with_capacity(s.len());
    for chunk in s.utf8_chunks() {
        out.extend(chunk.valid().chars());
        out.extend(chunk.invalid().iter().map(|_| char::REPLACEMENT_CHARACTER));
    }
    out
}

fn simple_case(c: char, upper: bool) -> char {
    let mut it: Box<dyn Iterator<Item = char>> = if upper {
        Box::new(c.to_uppercase())
    } else {
        Box::new(c.to_lowercase())
    };
    match (it.next(), it.next()) {
        (Some(m), None) => m,
        _ => c,
    }
}

/// `strings.EqualFold` (Unicode simple folding, approximated by single-char
/// case mappings, which agree on every host name).
fn equal_fold(a: &str, b: &[u8]) -> bool {
    let (a, b) = (go_runes(a.as_bytes()), go_runes(b));
    a.len() == b.len()
        && a.iter().zip(&b).all(|(&x, &y)| {
            x == y
                || simple_case(x, false) == simple_case(y, false)
                || simple_case(x, true) == simple_case(y, true)
        })
}

/// Check a `GET /api/boot/lease` body and open its sealed key with `seed`
/// (the boot key): this server, this box's key, the owner's signature, not
/// expired at `now_ms`.
pub fn open_auto_unlock_lease(
    body: &[u8],
    seed: &[u8; 32],
    server_domain: &[u8],
    owner_pub: &[u8],
    now_ms: i64,
) -> Result<Zeroizing<Vec<u8>>, LeaseError> {
    let l = gojson::unmarshal_lease(body).map_err(|_| LeaseError::Malformed)?;
    let (
        Some(domain),
        Some(lease_id),
        Some(stk_pub),
        Some(sealed_key),
        Some(issued_at),
        Some(expires_at),
        Some(signature),
    ) = (
        &l.server_domain,
        &l.lease_id,
        &l.stk_pub,
        &l.sealed_key,
        l.issued_at,
        l.expires_at,
        &l.signature,
    )
    else {
        return Err(LeaseError::Malformed);
    };
    if !canonical_field(domain) || !canonical_field(lease_id) || owner_pub.len() != 32 {
        return Err(LeaseError::Malformed);
    }
    let (Some(recipient), Some(sealed), Some(sig)) = (
        hex_of(stk_pub, 32),
        hex_of(sealed_key, 0),
        hex_of(signature, 64),
    ) else {
        return Err(LeaseError::Malformed);
    };
    if !equal_fold(domain, server_domain) {
        return Err(LeaseError::OtherServer);
    }
    let own = SigningKey::from_bytes(seed).verifying_key();
    if recipient.as_slice() != own.as_bytes().as_slice() {
        return Err(LeaseError::Recipient);
    }
    let canonical = [
        TAG_AUTO_UNLOCK_LEASE_V2.to_owned(),
        domain.clone(),
        gohex::encode(&recipient),
        lease_id.clone(),
        gohex::encode(&sealed),
        issued_at.to_string(),
        expires_at.to_string(),
        l.max_uses.unwrap_or(-1).to_string(),
    ]
    .join("|");
    let verified = <[u8; 32]>::try_from(owner_pub)
        .ok()
        .and_then(|k| VerifyingKey::from_bytes(&k).ok())
        .zip(<[u8; 64]>::try_from(sig.as_slice()).ok())
        .is_some_and(|(k, s)| {
            k.verify(canonical.as_bytes(), &Signature::from_bytes(&s))
                .is_ok()
        });
    if !verified {
        return Err(LeaseError::Signature);
    }
    if expires_at <= now_ms {
        return Err(LeaseError::Expired);
    }
    seal::open_sealed_from_ed25519_seed(&sealed, seed).map_err(LeaseError::Open)
}

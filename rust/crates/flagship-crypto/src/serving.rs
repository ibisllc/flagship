//! Who may serve what, and until when: the Rust twin of `packages/protocol/src/servingAuthority.ts` (plan H,
//! `docs/architecture-v2/issuance-and-lease-records.md`, owner decisions of 2026-10-31), for the Rust relay.
//!
//! ```text
//! flagship/serving-policy/v1|<account>|<box>|<regGen>|<policyGen>|<grace>|<onLapse>|<scopeSha256>|<issuedAt>
//! flagship/renewal-key-delegation/v1|<account>|<renewalPub>|<deviceId>|<issuedAt>
//! flagship/serving-lease/v1|<account>|<box>|<regGen>|<policyGen>|<leaseId>|<issuedAt>|<notAfter>
//! flagship/revocation-entry/v1|<sequence>|<kind>|<account>|<subject>|<generation>|<revokedAt>
//! flagship/certificate-order/v1|<class>|<device>|<regGen>|<csrSha256>|<requestId>|<issuedAt>
//! flagship/route-claim/v1|<account>|<phoneRoutePub>|<hostname>|<generation>|<sessionNonce>|<issuedAt>
//! ```
//!
//! Under an indefinite policy (the default) the policy alone authorizes serving: there are no leases. Under a finite
//! one a lease (signed by the admin root, or by a renewal key the admin root delegated) reaches at most one grace past
//! its issue and is bound to the policy generation. A lease counts only when `.com`'s published admin key and the
//! box's pinned key are the same key. Revocation is a signed, sequenced log. `onLapse` is what the lapse does:
//! `stop-apps`, or `lock-server` (the box also restarts with its disk locked; the old dead-man lock folded in). Shared vectors:
//! `packages/protocol/test-vectors/serving-authority`.

use crate::entitlements::verify;
use flagship_protocol::canonical_v1::CanonicalV1;
use flagship_protocol::error::ProtocolError;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const TAG_SERVING_POLICY: &str = "flagship/serving-policy/v1";
pub const TAG_RENEWAL_KEY_DELEGATION: &str = "flagship/renewal-key-delegation/v1";
pub const TAG_SERVING_LEASE: &str = "flagship/serving-lease/v1";
pub const TAG_REVOCATION_ENTRY: &str = "flagship/revocation-entry/v1";
pub const TAG_CERTIFICATE_ORDER: &str = "flagship/certificate-order/v1";
pub const TAG_ROUTE_CLAIM: &str = "flagship/route-claim/v1";

const DAY_MS: u64 = 86_400_000;
/// How far a signer's clock may run ahead of the verifier's.
pub const SERVING_CLOCK_SKEW_MS: u64 = 5 * 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServingError {
    BadAccount,
    BadHex(&'static str),
    BadNumber(&'static str),
    BadGrace,
    BadOnLapse,
    LockNeedsTimeLimit,
    BadKind,
    BadClass,
    BadHostname,
    LeaseEndsBeforeIssue,
    BadName(String),
    NameInTwoClasses(String),
    Canonical(ProtocolError),
}

impl std::fmt::Display for ServingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadAccount => write!(f, "account must be a lowercase account name"),
            Self::BadHex(n) => write!(f, "{n} must be lowercase hex of the right length"),
            Self::BadNumber(n) => write!(f, "{n} is out of range"),
            Self::BadGrace => write!(f, "grace must be 7d, 30d or indefinite"),
            Self::BadOnLapse => write!(f, "onLapse must be stop-apps or lock-server"),
            Self::LockNeedsTimeLimit => write!(f, "locking needs a time limit"),
            Self::BadKind => write!(f, "kind must be box or renewal-key"),
            Self::BadClass => write!(f, "class must be control, apps or phone"),
            Self::BadHostname => write!(f, "hostname must be the account's own bare name"),
            Self::LeaseEndsBeforeIssue => write!(f, "notAfter must be after issuedAt"),
            Self::BadName(n) => write!(f, "not a listed name: {n}"),
            Self::NameInTwoClasses(n) => write!(f, "{n} is listed under two classes"),
            Self::Canonical(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ServingError {}

impl From<ProtocolError> for ServingError {
    fn from(e: ProtocolError) -> Self {
        Self::Canonical(e)
    }
}

fn lower_hex(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex64(name: &'static str, s: &str) -> Result<(), ServingError> {
    if lower_hex(s, 64) {
        Ok(())
    } else {
        Err(ServingError::BadHex(name))
    }
}

fn hex32(name: &'static str, s: &str) -> Result<(), ServingError> {
    if lower_hex(s, 32) {
        Ok(())
    } else {
        Err(ServingError::BadHex(name))
    }
}

fn at_least(name: &'static str, v: u64, min: u64) -> Result<(), ServingError> {
    if v >= min {
        Ok(())
    } else {
        Err(ServingError::BadNumber(name))
    }
}

/// `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`, the label rule an account name and a DNS label share.
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

fn account(s: &str) -> Result<(), ServingError> {
    if label_ok(s) {
        Ok(())
    } else {
        Err(ServingError::BadAccount)
    }
}

/// The grace of a serving policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grace {
    SevenDays,
    ThirtyDays,
    Indefinite,
}

impl Grace {
    /// `7d`, `30d` or `indefinite`.
    ///
    /// # Errors
    /// [`ServingError::BadGrace`].
    pub fn parse(s: &str) -> Result<Self, ServingError> {
        match s {
            "7d" => Ok(Self::SevenDays),
            "30d" => Ok(Self::ThirtyDays),
            "indefinite" => Ok(Self::Indefinite),
            _ => Err(ServingError::BadGrace),
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SevenDays => "7d",
            Self::ThirtyDays => "30d",
            Self::Indefinite => "indefinite",
        }
    }

    /// The grace in milliseconds; `None` when indefinite.
    #[must_use]
    pub fn millis(self) -> Option<u64> {
        match self {
            Self::SevenDays => Some(7 * DAY_MS),
            Self::ThirtyDays => Some(30 * DAY_MS),
            Self::Indefinite => None,
        }
    }
}

/// What happens when no admin device renewed within the grace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnLapse {
    StopApps,
    LockServer,
}

impl OnLapse {
    /// # Errors
    /// [`ServingError::BadOnLapse`].
    pub fn parse(s: &str) -> Result<Self, ServingError> {
        match s {
            "stop-apps" => Ok(Self::StopApps),
            "lock-server" => Ok(Self::LockServer),
            _ => Err(ServingError::BadOnLapse),
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StopApps => "stop-apps",
            Self::LockServer => "lock-server",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServingPolicy {
    pub account: String,
    pub box_pub: String,
    pub reg_gen: u64,
    pub policy_gen: u64,
    pub grace: Grace,
    pub on_lapse: OnLapse,
    pub scope_sha256: String,
    pub issued_at: u64,
}

/// # Errors
/// [`ServingError`] for any field out of shape.
pub fn policy_canonical(p: &ServingPolicy) -> Result<String, ServingError> {
    account(&p.account)?;
    hex64("box", &p.box_pub)?;
    at_least("regGen", p.reg_gen, 1)?;
    at_least("policyGen", p.policy_gen, 1)?;
    if p.on_lapse == OnLapse::LockServer && p.grace == Grace::Indefinite {
        return Err(ServingError::LockNeedsTimeLimit);
    }
    hex64("scopeSha256", &p.scope_sha256)?;
    Ok(CanonicalV1::new(TAG_SERVING_POLICY)?
        .text(&p.account)?
        .text(&p.box_pub)?
        .uint(p.reg_gen)?
        .uint(p.policy_gen)?
        .text(p.grace.as_str())?
        .text(p.on_lapse.as_str())?
        .text(&p.scope_sha256)?
        .uint(p.issued_at)?
        .finish_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenewalKeyDelegation {
    pub account: String,
    pub renewal_pub: String,
    pub device_id: String,
    pub issued_at: u64,
}

/// # Errors
/// [`ServingError`] for any field out of shape.
pub fn delegation_canonical(d: &RenewalKeyDelegation) -> Result<String, ServingError> {
    account(&d.account)?;
    hex64("renewalPub", &d.renewal_pub)?;
    hex64("deviceId", &d.device_id)?;
    Ok(CanonicalV1::new(TAG_RENEWAL_KEY_DELEGATION)?
        .text(&d.account)?
        .text(&d.renewal_pub)?
        .text(&d.device_id)?
        .uint(d.issued_at)?
        .finish_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServingLease {
    pub account: String,
    pub box_pub: String,
    pub reg_gen: u64,
    pub policy_gen: u64,
    pub lease_id: String,
    pub issued_at: u64,
    pub not_after: u64,
}

/// # Errors
/// [`ServingError`] for any field out of shape.
pub fn lease_canonical(l: &ServingLease) -> Result<String, ServingError> {
    account(&l.account)?;
    hex64("box", &l.box_pub)?;
    at_least("regGen", l.reg_gen, 1)?;
    at_least("policyGen", l.policy_gen, 1)?;
    hex32("leaseId", &l.lease_id)?;
    if l.not_after <= l.issued_at {
        return Err(ServingError::LeaseEndsBeforeIssue);
    }
    Ok(CanonicalV1::new(TAG_SERVING_LEASE)?
        .text(&l.account)?
        .text(&l.box_pub)?
        .uint(l.reg_gen)?
        .uint(l.policy_gen)?
        .text(&l.lease_id)?
        .uint(l.issued_at)?
        .uint(l.not_after)?
        .finish_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevocationKind {
    Box,
    RenewalKey,
}

impl RevocationKind {
    /// # Errors
    /// [`ServingError::BadKind`].
    pub fn parse(s: &str) -> Result<Self, ServingError> {
        match s {
            "box" => Ok(Self::Box),
            "renewal-key" => Ok(Self::RenewalKey),
            _ => Err(ServingError::BadKind),
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Box => "box",
            Self::RenewalKey => "renewal-key",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevocationEntry {
    pub sequence: u64,
    pub kind: RevocationKind,
    pub account: String,
    pub subject: String,
    pub generation: u64,
    pub revoked_at: u64,
}

/// # Errors
/// [`ServingError`] for any field out of shape.
pub fn revocation_canonical(e: &RevocationEntry) -> Result<String, ServingError> {
    at_least("sequence", e.sequence, 1)?;
    account(&e.account)?;
    hex64("subject", &e.subject)?;
    match e.kind {
        RevocationKind::Box => at_least("generation", e.generation, 1)?,
        RevocationKind::RenewalKey if e.generation != 0 => {
            return Err(ServingError::BadNumber("generation"));
        }
        RevocationKind::RenewalKey => {}
    }
    Ok(CanonicalV1::new(TAG_REVOCATION_ENTRY)?
        .uint(e.sequence)?
        .text(e.kind.as_str())?
        .text(&e.account)?
        .text(&e.subject)?
        .uint(e.generation)?
        .uint(e.revoked_at)?
        .finish_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertificateOrder {
    pub class: String,
    pub device: String,
    pub reg_gen: u64,
    pub csr_sha256: String,
    pub request_id: String,
    pub issued_at: u64,
}

/// # Errors
/// [`ServingError`] for any field out of shape.
pub fn certificate_order_canonical(o: &CertificateOrder) -> Result<String, ServingError> {
    let min_gen = match o.class.as_str() {
        "control" | "apps" => 1,
        "phone" => 0,
        _ => return Err(ServingError::BadClass),
    };
    hex64("device", &o.device)?;
    at_least("regGen", o.reg_gen, min_gen)?;
    hex64("csrSha256", &o.csr_sha256)?;
    hex32("requestId", &o.request_id)?;
    Ok(CanonicalV1::new(TAG_CERTIFICATE_ORDER)?
        .text(&o.class)?
        .text(&o.device)?
        .uint(o.reg_gen)?
        .text(&o.csr_sha256)?
        .text(&o.request_id)?
        .uint(o.issued_at)?
        .finish_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteClaim {
    pub account: String,
    pub phone_route_pub: String,
    pub hostname: String,
    pub generation: u64,
    pub session_nonce: String,
    pub issued_at: u64,
}

/// # Errors
/// [`ServingError`] for any field out of shape.
pub fn route_claim_canonical(c: &RouteClaim) -> Result<String, ServingError> {
    account(&c.account)?;
    hex64("phoneRoutePub", &c.phone_route_pub)?;
    let prefix = format!("{}.", c.account);
    if c.hostname != c.hostname.to_ascii_lowercase()
        || !c.hostname.starts_with(&prefix)
        || c.hostname.split('.').count() < 3
    {
        return Err(ServingError::BadHostname);
    }
    at_least("generation", c.generation, 1)?;
    hex32("sessionNonce", &c.session_nonce)?;
    Ok(CanonicalV1::new(TAG_ROUTE_CLAIM)?
        .text(&c.account)?
        .text(&c.phone_route_pub)?
        .text(&c.hostname)?
        .uint(c.generation)?
        .text(&c.session_nonce)?
        .uint(c.issued_at)?
        .finish_string())
}

/// Strict Ed25519 over a canonical form; false when the form could not be built.
#[must_use]
pub fn verify_canonical(
    canonical: &Result<String, ServingError>,
    sig_hex: &str,
    pub_hex: &str,
) -> bool {
    match canonical {
        Ok(c) => lower_hex(sig_hex, 128) && lower_hex(pub_hex, 64) && verify(c, sig_hex, pub_hex),
        Err(_) => false,
    }
}

// ── the canonical name list ───────────────────────────────────────────────

/// A DNS name in list form: lowercase ASCII labels, a leading `*.` only for wildcards.
#[must_use]
pub fn is_listed_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 253 {
        return false;
    }
    let labels: Vec<&str> = name.split('.').collect();
    labels.len() >= 2
        && labels
            .iter()
            .enumerate()
            .all(|(i, l)| (i == 0 && *l == "*") || label_ok(l))
}

/// `<class> <name>` lines, sorted bytewise, no duplicates, joined by `\n`.
///
/// # Errors
/// [`ServingError`] for an unknown class, a name not in list form, a non-app wildcard, or a name under two classes.
pub fn canonical_name_list(names: &[(&str, &str)]) -> Result<String, ServingError> {
    let mut by_name: BTreeMap<&str, &str> = BTreeMap::new();
    for (class, name) in names {
        if !matches!(*class, "control" | "apps" | "phone") {
            return Err(ServingError::BadClass);
        }
        if !is_listed_name(name) || (*class != "apps" && name.starts_with("*.")) {
            return Err(ServingError::BadName((*name).to_owned()));
        }
        if let Some(had) = by_name.insert(name, class)
            && had != *class
        {
            return Err(ServingError::NameInTwoClasses((*name).to_owned()));
        }
    }
    let mut lines: Vec<String> = by_name.iter().map(|(n, c)| format!("{c} {n}")).collect();
    lines.sort();
    Ok(lines.join("\n"))
}

/// # Errors
/// As [`canonical_name_list`].
pub fn name_list_sha256(names: &[(&str, &str)]) -> Result<String, ServingError> {
    let list = canonical_name_list(names)?;
    Ok(Sha256::digest(list.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// App route names that would take a server's name or the phone's bare name.
#[must_use]
pub fn route_collisions<'a>(
    control_names: &[&str],
    phone_name: &str,
    app_names: &[&'a str],
) -> Vec<&'a str> {
    let mut reserved: BTreeSet<String> = control_names
        .iter()
        .map(|n| n.to_ascii_lowercase())
        .collect();
    reserved.insert(phone_name.to_ascii_lowercase());
    app_names
        .iter()
        .copied()
        .filter(|n| reserved.contains(&n.to_ascii_lowercase()))
        .collect()
}

// ── the revocation log ────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RevocationState {
    pub sequence: u64,
    /// `<account>|<box>` → the highest revoked registration generation.
    pub boxes: BTreeMap<String, u64>,
    pub renewal_keys: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevocationApply {
    Applied {
        state: RevocationState,
        applied: u64,
    },
    Gap {
        at: u64,
    },
    BadSignature {
        at: u64,
    },
    Malformed {
        at: u64,
    },
}

/// Applies pushed entries in order; duplicates are skipped, a gap or a bad signature stops it. `state` is unchanged.
#[must_use]
pub fn apply_revocation_entries(
    state: &RevocationState,
    entries: &[(RevocationEntry, String)],
    revocation_key_hex: &str,
) -> RevocationApply {
    let mut next = state.clone();
    let mut applied: u64 = 0;
    let mut sorted: Vec<&(RevocationEntry, String)> = entries.iter().collect();
    sorted.sort_by_key(|(e, _)| e.sequence);
    for (entry, signature) in sorted {
        let canonical = revocation_canonical(entry);
        if canonical.is_err() {
            return RevocationApply::Malformed { at: entry.sequence };
        }
        if entry.sequence <= next.sequence {
            continue;
        }
        let expected = next.sequence.saturating_add(1);
        if entry.sequence != expected {
            return RevocationApply::Gap { at: expected };
        }
        if !verify_canonical(&canonical, signature, revocation_key_hex) {
            return RevocationApply::BadSignature { at: entry.sequence };
        }
        match entry.kind {
            RevocationKind::Box => {
                let k = format!("{}|{}", entry.account, entry.subject);
                let had = next.boxes.get(&k).copied().unwrap_or(0);
                next.boxes.insert(k, had.max(entry.generation));
            }
            RevocationKind::RenewalKey => {
                next.renewal_keys.insert(entry.subject.clone());
            }
        }
        next.sequence = entry.sequence;
        applied = applied.saturating_add(1);
    }
    RevocationApply::Applied {
        state: next,
        applied,
    }
}

#[must_use]
pub fn box_revoked(state: &RevocationState, account: &str, box_pub: &str, reg_gen: u64) -> bool {
    state
        .boxes
        .get(&format!("{account}|{box_pub}"))
        .is_some_and(|g| *g >= reg_gen)
}

// ── the relay's decision ──────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SignedLease {
    pub lease: ServingLease,
    pub signature: String,
    pub delegation: Option<(RenewalKeyDelegation, String)>,
}

#[derive(Debug, Clone)]
pub struct ServingInput<'a> {
    pub account: &'a str,
    pub box_pub: &'a str,
    pub reg_gen: u64,
    pub admin_key_from_com: &'a str,
    pub admin_key_from_box: &'a str,
    pub policy: Option<(&'a ServingPolicy, &'a str)>,
    pub leases: &'a [SignedLease],
    pub revocations: &'a RevocationState,
    pub now: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServingDecision {
    /// The tunnel and the app routes; `until` is when app routes stop without a newer lease (None: never).
    Serve {
        until: Option<u64>,
        policy_gen: u64,
        on_lapse: OnLapse,
    },
    /// No app routes; `control` says whether the box's own control name stays routable, `lock` whether the
    /// owner's verified policy has the box lock itself now.
    Refuse {
        control: bool,
        reason: &'static str,
        lock: bool,
    },
}

/// The relay's whole rule (see the module doc).
#[must_use]
pub fn serving_decision(i: &ServingInput<'_>) -> ServingDecision {
    let refuse = |control, reason| ServingDecision::Refuse {
        control,
        reason,
        lock: false,
    };
    if !lower_hex(i.admin_key_from_com, 64) || i.admin_key_from_com != i.admin_key_from_box {
        return refuse(false, "admin-keys-differ");
    }
    if box_revoked(i.revocations, i.account, i.box_pub, i.reg_gen) {
        return refuse(false, "revoked");
    }
    let admin = i.admin_key_from_com;
    let Some((p, sig)) = i.policy else {
        return refuse(true, "no-policy");
    };
    if !verify_canonical(&policy_canonical(p), sig, admin) {
        return refuse(true, "policy-signature");
    }
    if p.account != i.account || p.box_pub != i.box_pub || p.reg_gen != i.reg_gen {
        return refuse(true, "policy-mismatch");
    }
    let Some(grace) = p.grace.millis() else {
        return ServingDecision::Serve {
            until: None,
            policy_gen: p.policy_gen,
            on_lapse: p.on_lapse,
        };
    };
    let mut best: Option<u64> = None;
    for l in i.leases {
        let r = &l.lease;
        if r.account != p.account
            || r.box_pub != p.box_pub
            || r.reg_gen != p.reg_gen
            || r.policy_gen != p.policy_gen
        {
            continue;
        }
        if r.issued_at > i.now.saturating_add(SERVING_CLOCK_SKEW_MS)
            || r.not_after.saturating_sub(r.issued_at) > grace
        {
            continue;
        }
        if !lease_signed_by_admin(l, admin, &p.account, i.revocations) {
            continue;
        }
        best = Some(best.map_or(r.not_after, |b| b.max(r.not_after)));
    }
    let lapsed = |reason| ServingDecision::Refuse {
        control: true,
        reason,
        lock: p.on_lapse == OnLapse::LockServer,
    };
    match best {
        None => lapsed("no-lease"),
        Some(b) if b <= i.now => lapsed("lease-expired"),
        Some(b) => ServingDecision::Serve {
            until: Some(b),
            policy_gen: p.policy_gen,
            on_lapse: p.on_lapse,
        },
    }
}

fn lease_signed_by_admin(
    l: &SignedLease,
    admin: &str,
    account: &str,
    revocations: &RevocationState,
) -> bool {
    let canonical = lease_canonical(&l.lease);
    if verify_canonical(&canonical, &l.signature, admin) {
        return true;
    }
    let Some((d, dsig)) = &l.delegation else {
        return false;
    };
    if d.account != account || revocations.renewal_keys.contains(&d.renewal_pub) {
        return false;
    }
    verify_canonical(&delegation_canonical(d), dsig, admin)
        && verify_canonical(&canonical, &l.signature, &d.renewal_pub)
}

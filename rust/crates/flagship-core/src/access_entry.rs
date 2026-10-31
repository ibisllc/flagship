//! Verifying a handed-over access entry, the authority half of `serviceAccess.ts`'s `applyEntry` (release plan R4):
//! given the trust THIS box holds, is the entry's proof good? Applying it (allow-list, grants, caps, removals that
//! came later) stays with the store; this module only says refused, left to another applier, or verified, and what
//! was verified. A caller cannot make an entry verified by supplying it: the trust is the box's own.
//!
//! Shared verdicts: `packages/server-daemon/test-vectors/access-entries.json`, written by the TypeScript applier.

use crate::access_journal::AccessEntry;
use flagship_crypto::access_orders::{ServiceAccessModeOrder, ServiceAllowRemoveOrder, verify_service_access_mode, verify_service_allow_remove};
use flagship_crypto::server_share::{ServerShareGrant, ServerShareLeave, ServerShareRevoke, verify_grant, verify_leave, verify_revoke};
use flagship_crypto::service_invite::{
    AcceptServiceInvite, CreateServiceInvite, RedeemServiceInvite, RevokeServiceInvite, verify_accept, verify_create, verify_redeem, verify_revoke as verify_invite_revoke,
};
use serde_json::{Map, Value};

/// Who made an invite, as far as this box can tell (`InviteTier` in TypeScript).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InviteTier {
    Admin,
    Member,
    CoManager,
}

impl InviteTier {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "admin" => Some(Self::Admin),
            "member" => Some(Self::Member),
            "co-manager" => Some(Self::CoManager),
            _ => None,
        }
    }
}

/// What this box trusts to sign, from its own state (the pinned admin root, the account's device book, the
/// co-managers it knows): lower-hex public keys.
#[derive(Debug, Clone, Default)]
pub struct EntryTrust {
    /// Keys that may sign an admin-only order right now (the admin root and admin-granted devices; the owner key
    /// only on a box that pins no admin root).
    pub admin_signers: Vec<String>,
    /// Keys that may sign an invite create, with the tier each gives the invite.
    pub create_signers: Vec<(String, InviteTier)>,
    /// Apps installed on this box.
    pub installed: Vec<String>,
}

/// A create that verified: the fields a later step needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedCreate {
    pub invite_id: String,
    pub service_ref: String,
    pub secret_hash: String,
    pub max_redemptions: Option<u64>,
    pub expires_at: Option<u64>,
    pub tier: InviteTier,
    pub creator_pub: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verified {
    Mode { mode: String, issued_at: u64 },
    Remove { aid: String, issued_at: u64 },
    /// A withdraw is always kept (a later join through the invite is refused once its creator is known); whether an
    /// admin signed it decides which apps it may prune.
    Withdraw { invite_id: String, issued_at: u64, signature: String, admin_signed: bool },
    Join { create: VerifiedCreate, visitor_aid: String, redeemed_at: u64 },
    Accept { create: VerifiedCreate, contact_aid: String, accepted_at: u64 },
    Share { share_id: String, member_pub: String, level: String, label: String, server_domain: String, issued_at: u64, ended: bool },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Refused,
    /// Another applier owns this kind (rank orders).
    Skipped,
    Verified(Verified),
}

fn lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn any_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn text<'a>(o: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    o.get(k).and_then(Value::as_str)
}

fn int(o: &Map<String, Value>, k: &str) -> Option<u64> {
    o.get(k).and_then(Value::as_u64)
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| s.get(i..i.saturating_add(2)).and_then(|p| u8::from_str_radix(p, 16).ok())).collect()
}

fn obj(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
}

fn admin_signed(t: &EntryTrust, verify: impl Fn(&str) -> bool) -> bool {
    t.admin_signers.iter().any(|k| verify(k))
}

/// `verifyComCreate`: the create's shape, its secret hash when one is expected, and a signature by one of the
/// signers this box trusts (which also names the tier).
fn verify_com_create(create: &Value, sig: &Value, expect_secret_hash: Option<&str>, t: &EntryTrust) -> Option<VerifiedCreate> {
    let c = obj(create)?;
    let sig = sig.as_str().filter(|s| any_hex(s, 128))?;
    let (invite_id, author, service_ref, secret_hash, bundle) = (text(c, "inviteId")?, text(c, "authorAID")?, text(c, "serviceRef")?, text(c, "secretHash")?, text(c, "encryptedBundle")?);
    if !any_hex(author, 64) || !any_hex(secret_hash, 64) || !c.get("issuedAt").is_some_and(Value::is_number) {
        return None;
    }
    if expect_secret_hash.is_some_and(|e| secret_hash.to_lowercase() != e) {
        return None;
    }
    // A cap or expiry that is a number but not a non-negative integer cannot be signed: refuse, as the TypeScript encoder throws.
    let cap = |k: &str| -> Result<Option<u64>, ()> {
        match c.get(k) {
            Some(v) if v.is_number() => v.as_u64().map(Some).ok_or(()),
            _ => Ok(None),
        }
    };
    let (max_redemptions, expires_at) = (cap("maxRedemptions").ok()?, cap("expiresAt").ok()?);
    let candidate = CreateServiceInvite {
        invite_id: invite_id.to_string(),
        author_aid: decode_hex(author)?,
        service_ref: service_ref.to_string(),
        secret_hash: secret_hash.to_string(),
        encrypted_bundle: bundle.to_string(),
        issued_at: c.get("issuedAt").and_then(Value::as_u64)?,
        max_redemptions,
        expires_at,
    };
    let (pub_hex, tier) = t.create_signers.iter().find(|(k, _)| verify_create(&candidate, sig, k))?;
    Some(VerifiedCreate {
        invite_id: candidate.invite_id,
        service_ref: candidate.service_ref,
        secret_hash: candidate.secret_hash,
        max_redemptions,
        expires_at,
        tier: *tier,
        creator_pub: pub_hex.clone(),
    })
}

fn share_grant(v: &Value) -> Option<ServerShareGrant> {
    let g = obj(v)?;
    Some(ServerShareGrant {
        server_domain: text(g, "serverDomain")?.to_string(),
        share_id: text(g, "shareId")?.to_string(),
        member_pub_hex: text(g, "memberPubHex")?.to_string(),
        level: text(g, "level")?.to_string(),
        unlock_at_boot: g.get("unlockAtBoot")?.as_bool()?,
        see_app_data: g.get("seeAppData")?.as_bool()?,
        label: text(g, "label")?.to_string(),
        issued_at: int(g, "issuedAt")?,
    })
}

/// A share entry: the grant under an admin-only key, and its end (the admin's revoke, or the member's own leave
/// under the grant's member key) when there is one.
fn verify_share(e: &Value, t: &EntryTrust) -> Option<Verified> {
    let g = share_grant(e.get("grant")?)?;
    let sig = e.get("signature")?.as_str().filter(|s| any_hex(s, 128))?;
    if !admin_signed(t, |k| verify_grant(&g, sig, k)) {
        return None;
    }
    let mut ended = false;
    if let Some(end) = e.get("end") {
        let end = obj(end)?;
        let end_sig = text(end, "signature").filter(|s| any_hex(s, 128))?;
        match text(end, "kind")? {
            "revoke" => {
                let r = obj(end.get("revoke")?)?;
                let revoke = ServerShareRevoke { server_domain: text(r, "serverDomain")?.to_string(), share_id: text(r, "shareId")?.to_string(), issued_at: int(r, "issuedAt")? };
                if revoke.share_id != g.share_id || revoke.server_domain != g.server_domain || !admin_signed(t, |k| verify_revoke(&revoke, end_sig, k)) {
                    return None;
                }
            }
            _ => {
                let l = obj(end.get("leave")?)?;
                let leave = ServerShareLeave {
                    server_domain: text(l, "serverDomain")?.to_string(),
                    share_id: text(l, "shareId")?.to_string(),
                    member_pub_hex: text(l, "memberPubHex")?.to_string(),
                    issued_at: int(l, "issuedAt")?,
                };
                if leave.share_id != g.share_id || leave.server_domain != g.server_domain || leave.member_pub_hex != g.member_pub_hex || !verify_leave(&leave, end_sig, &g.member_pub_hex) {
                    return None;
                }
            }
        }
        ended = true;
    }
    Some(Verified::Share { share_id: g.share_id, member_pub: g.member_pub_hex, level: g.level, label: g.label, server_domain: g.server_domain, issued_at: g.issued_at, ended })
}

/// Whether `entry`, handed over for `service_ref`, carries a proof this box accepts.
pub fn verify_entry(entry: &AccessEntry, service_ref: &str, t: &EntryTrust) -> Verdict {
    let e = entry.as_json();
    let installed = t.installed.iter().any(|s| s == service_ref);
    let verified = match e.get("kind").and_then(Value::as_str) {
        Some("rank") => return Verdict::Skipped,
        Some("share") => (installed).then(|| verify_share(e, t)).flatten(),
        Some("mode") => (|| {
            let o = obj(e.get("order")?)?;
            if o.contains_key("serverId") {
                return None;
            }
            let order = ServiceAccessModeOrder { service_ref: text(o, "serviceRef")?.to_string(), mode: text(o, "mode")?.to_string(), issued_at: int(o, "issuedAt")? };
            let sig = text(e.as_object()?, "signature")?;
            if order.service_ref != service_ref || !installed || !admin_signed(t, |k| verify_service_access_mode(&order, sig, k)) {
                return None;
            }
            Some(Verified::Mode { mode: order.mode, issued_at: order.issued_at })
        })(),
        Some("remove") => (|| {
            let o = obj(e.get("order")?)?;
            if o.contains_key("serverId") {
                return None;
            }
            let order = ServiceAllowRemoveOrder { service_ref: text(o, "serviceRef")?.to_string(), aid: text(o, "aid")?.to_string(), issued_at: int(o, "issuedAt")? };
            let sig = text(e.as_object()?, "signature")?;
            if order.service_ref != service_ref || !admin_signed(t, |k| verify_service_allow_remove(&order, sig, k)) {
                return None;
            }
            Some(Verified::Remove { aid: order.aid, issued_at: order.issued_at })
        })(),
        Some("withdraw") => (|| {
            let r = obj(e.get("revoke")?)?;
            let revoke = RevokeServiceInvite { invite_id: text(r, "inviteId")?.to_string(), issued_at: int(r, "issuedAt")? };
            let sig = text(e.as_object()?, "signature")?.to_string();
            let admin = admin_signed(t, |k| verify_invite_revoke(&revoke, &sig, k));
            Some(Verified::Withdraw { invite_id: revoke.invite_id, issued_at: revoke.issued_at, signature: sig.to_lowercase(), admin_signed: admin })
        })(),
        Some("join") => (|| {
            let d = obj(e.get("redeem")?)?;
            let aid = text(d, "visitorAID")?.to_lowercase();
            let secret_hash = text(d, "secretHash")?;
            let redeemed_at = int(d, "redeemedAt")?;
            if !lower_hex(&aid, 64) || !any_hex(secret_hash, 64) {
                return None;
            }
            let redeem = RedeemServiceInvite { secret_hash: secret_hash.to_lowercase(), visitor_aid: decode_hex(&aid)?, redeemed_at };
            if !verify_redeem(&redeem, text(d, "aidSig")?, &aid) {
                return None;
            }
            let create = verify_com_create(e.get("create")?, e.get("createSig")?, Some(&secret_hash.to_lowercase()), t)?;
            if create.service_ref != service_ref || !installed {
                return None;
            }
            Some(Verified::Join { create, visitor_aid: aid, redeemed_at })
        })(),
        Some("accept") => (|| {
            let a = obj(e.get("accept")?)?;
            let aid = text(a, "contactAID")?.to_lowercase();
            let (invite_id, a_ref, accepted_at) = (text(a, "inviteId")?, text(a, "serviceRef")?, int(a, "acceptedAt")?);
            let create = verify_com_create(e.get("create")?, e.get("createSig")?, None, t)?;
            if create.invite_id != invite_id || create.service_ref != service_ref || a_ref != service_ref || !installed {
                return None;
            }
            let accept = AcceptServiceInvite { invite_id: invite_id.to_string(), service_ref: a_ref.to_string(), contact_aid: decode_hex(&aid)?, accepted_at };
            if !verify_accept(&accept, text(e.as_object()?, "acceptSig")?, &aid) {
                return None;
            }
            Some(Verified::Accept { create, contact_aid: aid, accepted_at })
        })(),
        _ => None,
    };
    verified.map_or(Verdict::Refused, Verdict::Verified)
}

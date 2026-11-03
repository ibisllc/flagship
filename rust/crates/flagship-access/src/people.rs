//! Who a signing key is on this box (docs/service-access-gating.md "Account members"), the Rust twin of
//! `AccountDeviceBook` + `AccessPrincipals` in `packages/server-daemon/src/accessPrincipals.ts` and the share
//! store's load check (`shares/shareStore.ts`):
//!
//! - a DEVICE of the owning account: its grant, from the box's own device book file, verifies under the keys the
//!   box pins. An `admin`-scope grant signed by the admin root is an admin device; any other verifying grant (the
//!   admin root without `admin`, or the owner key on a pinned box) a non-admin one; on a box that pins no admin
//!   root, a grant the owner key signed is an admin device. The account's legacy AID is a non-admin device (admin
//!   on a box with no admin root);
//! - a CO-MANAGER: the member key of a share this server holds (the owner's grant and the member's acceptance
//!   both verify, for this server, and the share has not ended);
//! - otherwise nobody (an invited person is found on the app's allow-list).
//!
//! The caller supplies the anchors its boot resolution verified (the owner key, the admin root, the owner AID, the
//! account name, this server's name, whether the owner's assurance policy is strict); everything about the people
//! is read and verified here, so the caller cannot name a key an admin device or a co-manager.
//!
//! Shared vectors: `packages/server-daemon/test-vectors/access-writes.json` ("people").

use crate::rank::{AdminTrust, GrantView, device_grant_canonical};
use flagship_crypto::entitlements::verify;
use flagship_crypto::server_share::{ServerShareAccept, verify_accept, verify_grant};
use serde_json::{Value, json};

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

/// What the box's boot resolution pinned (config, admin-root rotation chain, re-home), lower hex.
#[derive(Debug, Clone, Default)]
pub struct Anchors {
    pub username: String,
    pub owner_irk_hex: String,
    pub admin_root_hex: Option<String>,
    pub owner_aid_hex: Option<String>,
    pub server_domain: String,
    /// The owner's assurance policy requires a hybrid signature on admin orders (none ride on journal entries).
    pub strict: bool,
}

fn lower_hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn any_hex(s: &str) -> bool {
    s.len().is_multiple_of(2) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

impl Anchors {
    /// From the wire (`{username, ownerIrkHex, adminRootHex?, ownerAidHex?, serverDomain, strict?}`).
    #[must_use]
    pub fn from_json(v: &Value) -> Option<Self> {
        let s = |k: &str| {
            v.get(k)
                .and_then(Value::as_str)
                .map(str::to_ascii_lowercase)
        };
        let irk = s("ownerIrkHex").filter(|k| lower_hex(k, 64))?;
        Some(Self {
            username: v.get("username").and_then(Value::as_str)?.to_owned(),
            owner_irk_hex: irk,
            admin_root_hex: s("adminRootHex").filter(|k| lower_hex(k, 64)),
            owner_aid_hex: s("ownerAidHex").filter(|k| lower_hex(k, 64)),
            server_domain: s("serverDomain").unwrap_or_default(),
            strict: v.get("strict").and_then(Value::as_bool) == Some(true),
        })
    }

    #[must_use]
    pub fn pinned(&self) -> bool {
        self.admin_root_hex.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Admin,
    Member,
}

impl Tier {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Member => "member",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Device {
    pub pub_hex: String,
    pub device_id: Option<String>,
    pub tier: Tier,
    pub legacy: bool,
    grant: Option<GrantView>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoManager {
    pub pub_hex: String,
    pub share_id: String,
    pub label: String,
    /// `view` or `manage`.
    pub level: String,
}

/// Who someone is on this box.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Person {
    Device {
        pub_hex: String,
        tier: Tier,
        legacy: bool,
    },
    CoManager(CoManager),
}

/// The account's people as this box verified them.
#[derive(Debug, Clone, Default)]
pub struct People {
    pub anchors: Anchors,
    /// Book devices in the book's order (the legacy AID excluded).
    pub devices: Vec<Device>,
    pub co_managers: Vec<CoManager>,
    /// The device book is wired (always on a box with a config); without it the owner AID is the owner.
    pub book_present: bool,
}

fn str_field<'a>(o: &'a Value, k: &str) -> Option<&'a str> {
    o.get(k).and_then(Value::as_str)
}

/// `parseListed` + `toGrant`: a listed grant's shape, or `None`.
fn parse_listed(r: &Value) -> Option<GrantView> {
    let pub_hex = str_field(r, "devicePubHex")?.to_ascii_lowercase();
    if !lower_hex(&pub_hex, 64) {
        return None;
    }
    let scopes: Vec<String> = r
        .get("scopes")?
        .as_array()?
        .iter()
        .map(|s| {
            s.as_str()
                .filter(|s| DEVICE_SCOPES.contains(s))
                .map(str::to_owned)
        })
        .collect::<Option<_>>()?;
    let (issued, expires) = (r.get("issuedAt")?, r.get("expiresAt")?);
    if !issued.is_number() || !expires.is_number() {
        return None;
    }
    Some(GrantView {
        grant_id: str_field(r, "grantId")?.to_owned(),
        username: str_field(r, "username")?.to_owned(),
        device_id: str_field(r, "deviceId")?.to_owned(),
        device_pub_hex: pub_hex,
        scopes,
        // A time that is not a non-negative integer makes no canonical bytes: it never verifies.
        issued_at: issued.as_u64().unwrap_or(u64::MAX),
        expires_at: expires.as_u64().unwrap_or(0),
        signature_hex: str_field(r, "signatureHex")?.to_ascii_lowercase(),
        signer_root: "admin-root".into(),
        revoked: false,
    })
}

/// `AccountDeviceBook.verify`: the tier a listed grant earns under the pinned keys, or `None`.
fn verify_tier(g: &GrantView, a: &Anchors) -> Option<Tier> {
    if !any_hex(&g.signature_hex) {
        return None;
    }
    let mut lowered = g.clone();
    lowered.username = g.username.to_lowercase();
    let canonical = device_grant_canonical(&lowered)?;
    let ok = |k: &str| verify(&canonical, &g.signature_hex, k);
    match &a.admin_root_hex {
        Some(root) if ok(root) => Some(if g.scopes.iter().any(|s| s == "admin") {
            Tier::Admin
        } else {
            Tier::Member
        }),
        Some(_) => ok(&a.owner_irk_hex).then_some(Tier::Member),
        None => ok(&a.owner_irk_hex).then_some(Tier::Admin),
    }
}

/// The grant ids the admin root revoked on this box (`DeviceRevocations`; unreadable: none, as TypeScript).
fn revoked_ids(text: Option<&str>) -> Vec<String> {
    let ok_id = |id: &str| {
        (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    text.and_then(|t| serde_json::from_str::<Value>(t).ok())
        .and_then(|v| v.get("revoked").and_then(Value::as_object).cloned())
        .map(|m| m.keys().filter(|k| ok_id(k)).cloned().collect())
        .unwrap_or_default()
}

impl People {
    /// The people from the box's own files (each `None` when absent). `now_ms` decides which admin grants are live.
    #[must_use]
    pub fn from_files(
        anchors: Anchors,
        book: Option<&str>,
        revocations: Option<&str>,
        shares: Option<&str>,
        book_present: bool,
    ) -> Self {
        let revoked = revoked_ids(revocations);
        let mut devices: Vec<Device> = Vec::new();
        let listed = book
            .and_then(|t| serde_json::from_str::<Value>(t).ok())
            .and_then(|v| v.get("grants").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        for r in &listed {
            let Some(g) = parse_listed(r) else { continue };
            if g.username.to_lowercase() != anchors.username.to_lowercase()
                || revoked.contains(&g.grant_id)
            {
                continue;
            }
            let Some(tier) = verify_tier(&g, &anchors) else {
                continue;
            };
            if let Some(prev) = devices.iter_mut().find(|d| d.pub_hex == g.device_pub_hex) {
                if prev.tier == Tier::Admin || tier == Tier::Member {
                    continue;
                }
                prev.device_id = Some(g.device_id.clone());
                prev.tier = tier;
                prev.grant = Some(g);
                continue;
            }
            devices.push(Device {
                pub_hex: g.device_pub_hex.clone(),
                device_id: Some(g.device_id.clone()),
                tier,
                legacy: false,
                grant: Some(g),
            });
        }
        let mut people = Self {
            anchors,
            devices,
            co_managers: Vec::new(),
            book_present,
        };
        people.co_managers = people.shares_from(shares);
        people
    }

    /// The active shares of `shares.json` whose chain verifies for this server (`ShareStore.load`).
    fn shares_from(&self, text: Option<&str>) -> Vec<CoManager> {
        let Some(v) = text.and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
            return Vec::new();
        };
        let ended: Vec<&str> = v
            .get("ended")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|e| e.get("endedAt").is_some_and(Value::is_number))
            .filter_map(|e| str_field(e, "shareId"))
            .collect();
        let mut out: Vec<CoManager> = Vec::new();
        for h in v
            .get("active")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(c) = self.held_share(h) else {
                continue;
            };
            if ended.contains(&c.share_id.as_str()) {
                continue;
            }
            out.retain(|x| x.share_id != c.share_id);
            out.push(c);
        }
        out
    }

    fn held_share(&self, h: &Value) -> Option<CoManager> {
        let g = crate::access_entry::share_grant(h.get("grant")?)?;
        let a = h.get("accept")?;
        let accept = ServerShareAccept {
            server_domain: str_field(a, "serverDomain")?.to_owned(),
            share_id: str_field(a, "shareId")?.to_owned(),
            member_pub_hex: str_field(a, "memberPubHex")?.to_owned(),
            accepted_at: a.get("acceptedAt")?.as_u64()?,
        };
        let (sig, accept_sig) = (str_field(h, "signature")?, str_field(h, "acceptSignature")?);
        if g.server_domain != self.anchors.server_domain
            || accept.server_domain != g.server_domain
            || accept.share_id != g.share_id
            || accept.member_pub_hex != g.member_pub_hex
        {
            return None;
        }
        if !self.admin_signed(|k| verify_grant(&g, sig, k))
            || !verify_accept(&accept, accept_sig, &accept.member_pub_hex)
        {
            return None;
        }
        Some(CoManager {
            pub_hex: g.member_pub_hex.to_lowercase(),
            share_id: g.share_id,
            label: g.label,
            level: g.level,
        })
    }

    /// `AccessPrincipals.classify`: the book (and the legacy AID), then this server's co-managers.
    #[must_use]
    pub fn classify(&self, key: &str) -> Option<Person> {
        let k = key.to_lowercase();
        if let Some(d) = self.devices.iter().find(|d| d.pub_hex == k) {
            return Some(Person::Device {
                pub_hex: k,
                tier: d.tier,
                legacy: false,
            });
        }
        let is_aid = self.anchors.owner_aid_hex.as_deref() == Some(k.as_str());
        if is_aid && self.book_present {
            let tier = if self.anchors.pinned() {
                Tier::Member
            } else {
                Tier::Admin
            };
            return Some(Person::Device {
                pub_hex: k,
                tier,
                legacy: true,
            });
        }
        if let Some(c) = self.co_managers.iter().find(|c| c.pub_hex == k) {
            return Some(Person::CoManager(c.clone()));
        }
        if is_aid {
            return Some(Person::Device {
                pub_hex: k,
                tier: Tier::Admin,
                legacy: true,
            });
        }
        None
    }

    /// The admin devices' grants (`AccountDeviceBook.adminGrants`): only on a box that pins an admin root.
    #[must_use]
    pub fn admin_trust(&self, now_ms: u64) -> AdminTrust {
        let grants = if self.anchors.pinned() {
            self.devices
                .iter()
                .filter(|d| d.tier == Tier::Admin)
                .filter_map(|d| d.grant.clone())
                .map(|mut g| {
                    g.username = g.username.to_lowercase();
                    g
                })
                .collect()
        } else {
            Vec::new()
        };
        AdminTrust {
            owner_irk_hex: self.anchors.owner_irk_hex.clone(),
            admin_root_hex: self.anchors.admin_root_hex.clone(),
            username: self.anchors.username.clone(),
            grants,
            now_ms,
        }
    }

    /// `authorizeSensitiveOrder`: the order verifies under a key that may sign admin orders here, and the
    /// assurance policy still takes a classical-only order. `verify` checks the signature under one key.
    pub fn admin_signed(&self, verify_under: impl Fn(&str) -> bool) -> bool {
        self.admin_signed_at(verify_under, crate::now_ms(), self.anchors.strict)
    }

    /// [`Self::admin_signed`] at a given time and strictness (vectors, and journal admission without the PQ gate).
    pub fn admin_signed_at(
        &self,
        verify_under: impl Fn(&str) -> bool,
        now_ms: u64,
        strict: bool,
    ) -> bool {
        if strict {
            return false;
        }
        let t = self.admin_trust(now_ms);
        let Some(root) = &t.admin_root_hex else {
            return verify_under(&t.owner_irk_hex);
        };
        if verify_under(root) {
            return true;
        }
        t.grants.iter().any(|g| {
            now_ms < g.expires_at
                && g.scopes.iter().any(|s| s == "admin")
                && verify_under(&g.device_pub_hex)
                && device_grant_canonical(g).is_some_and(|c| verify(&c, &g.signature_hex, root))
        })
    }

    /// The account people as the decision needs them.
    #[must_use]
    pub fn principals(&self) -> crate::decide::Principals {
        use crate::decide::Principal;
        let mut list: Vec<Principal> = self
            .devices
            .iter()
            .map(|d| Principal::Device {
                pub_hex: d.pub_hex.clone(),
                admin: d.tier == Tier::Admin,
            })
            .collect();
        if let Some(Person::Device {
            pub_hex,
            tier,
            legacy: true,
        }) = self
            .anchors
            .owner_aid_hex
            .as_deref()
            .and_then(|a| self.classify(a))
        {
            list.push(Principal::Device {
                pub_hex,
                admin: tier == Tier::Admin,
            });
        }
        list.extend(self.co_managers.iter().map(|c| Principal::CoManager {
            pub_hex: c.pub_hex.clone(),
            share_id: c.share_id.clone(),
        }));
        crate::decide::Principals {
            list,
            owner_aid: self.anchors.owner_aid_hex.clone(),
        }
    }

    /// The people as the daemon's resolver lists them (`devices()`, `coManagers()`), for the shadow comparison.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "devices": self.devices.iter().map(|d| json!({
                "pub": d.pub_hex, "deviceId": d.device_id, "tier": d.tier.as_str(),
            })).collect::<Vec<_>>(),
            "coManagers": self.co_managers.iter().map(|c| json!({
                "pub": c.pub_hex, "shareId": c.share_id, "label": c.label, "level": c.level,
            })).collect::<Vec<_>>(),
        })
    }
}

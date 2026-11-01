//! The decision at the effect boundary: may this request reach the app's container, and as whom?
//! (`prepareAppRequest` in serviceProxy.ts with `buildAppSessionResolver` in appMemberSession.ts.)
//!
//! The app is the one the router selected (SNI, or the ingress's route table): [`AppFacts`] comes
//! from the trusted installation record, never from the request or the app's own files.

use crate::origin::is_cross_origin_unsafe;
use crate::path::matches_public_route;
use crate::state::{AccessState, AccountRank, Entry, Rank};
use std::collections::BTreeMap;

/// Who a signing key is on this box: a device of the owning account, or a co-manager of this server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Principal {
    Device { pub_hex: String, admin: bool },
    CoManager { pub_hex: String, share_id: String },
}

#[derive(Debug, Clone, Default)]
pub struct Principals {
    pub list: Vec<Principal>,
    /// The owner's account id: every device of the account is this one person to an app.
    pub owner_aid: Option<String>,
}

impl Principals {
    #[must_use]
    pub fn classify(&self, key: &str) -> Option<&Principal> {
        let k = key.to_lowercase();
        self.list.iter().find(|p| match p {
            Principal::Device { pub_hex, .. } | Principal::CoManager { pub_hex, .. } => {
                *pub_hex == k
            }
        })
    }
}

/// The installed app as the router selected it.
#[derive(Debug, Clone)]
pub struct AppFacts {
    pub service_ref: String,
    /// The host it was selected by: the app's own origin.
    pub routed_host: String,
    pub public_routes: Vec<String>,
    /// The manifest's `default_role`: only an admin's invite takes it.
    pub default_role: String,
}

/// The session cookie's record, as the box's session store holds it.
#[derive(Debug, Clone)]
pub struct SessionFact {
    pub service_ref: String,
    pub aid: String,
    /// Present, unexpired and not closed.
    pub live: bool,
}

/// The result of checking an `Authorization: Bearer fsk_…` key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiKeyCheck {
    None,
    Invalid,
    Scope,
    RateLimited,
    Ok { key_id: String },
}

#[derive(Debug, Clone)]
pub struct RequestFacts {
    pub method: String,
    pub path: String,
    pub upgrade: bool,
    /// Lower-case header names: `origin`, `sec-fetch-site`, `referer` are the ones read.
    pub headers: BTreeMap<String, String>,
    pub session: Option<SessionFact>,
    pub api_key: ApiKeyCheck,
    /// N07: may external (guest) access be honoured now.
    pub external_fresh: bool,
    /// The app's access list is being caught up after a restart: invited people and co-managers wait.
    pub catching_up: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Deny,
    ApiInvalid,
    ApiScope,
    ApiRateLimited,
    Anonymous,
    Api {
        key_id: String,
    },
    Member {
        rank: Rank,
        /// The key the app's member id is derived from (the owner's account id for every account device).
        identity: String,
        /// Outside the owner's own devices (an invited person, a co-manager).
        external: bool,
    },
}

impl Decision {
    /// The shared vectors' `outcome`.
    #[must_use]
    pub fn outcome(&self) -> &'static str {
        match self {
            Self::Deny => "deny",
            Self::ApiInvalid => "api-invalid",
            Self::ApiScope => "api-scope",
            Self::ApiRateLimited => "api-rate-limited",
            Self::Anonymous | Self::Api { .. } | Self::Member { .. } => "forward",
        }
    }
}

fn is_lower_hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn rank_key(p: &Principal) -> String {
    match p {
        Principal::Device { pub_hex, .. } => format!("device:{pub_hex}"),
        Principal::CoManager { share_id, .. } => format!("share:{share_id}"),
    }
}

/// The access questions about one app, over the state file and the account people.
#[derive(Debug, Clone, Copy)]
pub struct AppAccess<'a> {
    pub state: &'a AccessState,
    pub principals: &'a Principals,
    pub service_ref: &'a str,
    pub catching_up: bool,
}

impl AppAccess<'_> {
    fn entry(&self) -> Option<&Entry> {
        self.state.services.get(self.service_ref)
    }

    /// An account device's or co-manager's rank: the admin's override, else the default (admin
    /// device master, every other one manager); `None` when refused or held.
    #[must_use]
    pub fn account_rank(&self, p: &Principal) -> Option<Rank> {
        let set = self
            .entry()
            .and_then(|e| e.roles.ranks.get(&rank_key(p)).copied());
        if set == Some(AccountRank::Refused) {
            return None;
        }
        if matches!(p, Principal::CoManager { .. }) && self.catching_up {
            return None;
        }
        if let Some(AccountRank::Rank(r)) = set {
            return Some(r);
        }
        Some(match p {
            Principal::Device { admin: true, .. } => Rank::Master,
            _ => Rank::Manager,
        })
    }

    /// Whether a key is let in at all: account people unless refused, anyone else only on the list.
    #[must_use]
    pub fn is_allowed(&self, key: &str) -> bool {
        let k = key.to_lowercase();
        if let Some(p) = self.principals.classify(&k) {
            return self.account_rank(p).is_some();
        }
        if self.catching_up {
            return false;
        }
        self.entry().is_some_and(|e| e.allow.contains(&k))
    }

    fn unset_rank(e: &Entry, invite: &str, default_role: &str) -> Rank {
        if e.roles.tiers.get(invite).map(String::as_str) == Some("admin") {
            return Rank::ladder(Some(default_role)).unwrap_or(Rank::Member);
        }
        Rank::Member
    }

    /// An invited person's rank: an admin order on them replaces everything, else the highest of
    /// their grants; `None` when no grant says (the caller then gives Member).
    #[must_use]
    pub fn role_of(&self, aid: &str, default_role: &str) -> Option<Rank> {
        let e = self.entry()?;
        let aid = aid.to_lowercase();
        if let Some(r) = Rank::ladder(e.roles.aids.get(&aid).map(String::as_str)) {
            return Some(r);
        }
        let mut best: Option<Rank> = None;
        let mut any_set = false;
        for (id, members) in &e.groups {
            if !members.contains(&aid) {
                continue;
            }
            let set = Rank::ladder(
                e.roles
                    .grants
                    .get(&format!("{id}/{aid}"))
                    .map(String::as_str),
            )
            .or_else(|| Rank::ladder(e.roles.invites.get(id).map(String::as_str)));
            let tier = e.roles.tiers.get(id).map(String::as_str);
            if set.is_some() || matches!(tier, Some("member" | "co-manager" | "admin")) {
                any_set = true;
            }
            let r = set.unwrap_or_else(|| Self::unset_rank(e, id, default_role));
            best = Some(best.map_or(r, |b| b.max(r)));
        }
        any_set.then_some(best).flatten()
    }
}

/// The member a live session names, or `None` (anonymous).
fn session_member(acc: &AppAccess<'_>, app: &AppFacts, s: &SessionFact) -> Option<Decision> {
    if !s.live || s.service_ref != app.service_ref || !is_lower_hex64(&s.aid) {
        return None;
    }
    if !acc.is_allowed(&s.aid) {
        return None;
    }
    let p = acc.principals.classify(&s.aid);
    let rank = match p {
        Some(p) => acc.account_rank(p)?,
        None => acc
            .role_of(&s.aid, &app.default_role)
            .unwrap_or(Rank::Member),
    };
    let identity = match p {
        Some(Principal::Device { pub_hex, .. }) => acc
            .principals
            .owner_aid
            .clone()
            .unwrap_or_else(|| pub_hex.clone()),
        _ => s.aid.clone(),
    };
    let external = !matches!(p, Some(Principal::Device { .. }));
    Some(Decision::Member {
        rank,
        identity,
        external,
    })
}

/// Decide one request (docs/app-apis.md §2-§5).
#[must_use]
pub fn decide(
    state: &AccessState,
    principals: &Principals,
    app: &AppFacts,
    req: &RequestFacts,
) -> Decision {
    match &req.api_key {
        ApiKeyCheck::Invalid => return Decision::ApiInvalid,
        ApiKeyCheck::RateLimited => return Decision::ApiRateLimited,
        ApiKeyCheck::Scope => return Decision::ApiScope,
        ApiKeyCheck::Ok { key_id } => {
            return Decision::Api {
                key_id: key_id.clone(),
            };
        }
        ApiKeyCheck::None => {}
    }
    let acc = AppAccess {
        state,
        principals,
        service_ref: &app.service_ref,
        catching_up: req.catching_up,
    };
    let mut member = req
        .session
        .as_ref()
        .and_then(|s| session_member(&acc, app, s));
    if member.is_some()
        && is_cross_origin_unsafe(&req.method, req.upgrade, &req.headers, &app.routed_host)
    {
        member = None;
    }
    if matches!(member, Some(Decision::Member { external: true, .. })) && !req.external_fresh {
        member = None;
    }
    if let Some(m) = member {
        return m;
    }
    if !state.restricted(&app.service_ref) || matches_public_route(&req.path, &app.public_routes) {
        return Decision::Anonymous;
    }
    Decision::Deny
}

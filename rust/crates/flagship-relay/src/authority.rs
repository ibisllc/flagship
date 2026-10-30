//! The real HELLO authority (release plan G7): the cryptographic half of admission, in the TypeScript hub's order
//! (`tunnelHub.ts` `authenticateHello`), on the shared entitlement contract (`flagship_crypto::entitlements`).
//!
//! Who the account's keys are, which certs it revoked and which STK a server registered with `.com` come from a
//! [`Directory`]; this module only decides what the signed bytes mean. Every check fails closed except the two the TS hub
//! deliberately fails open, so a `.com` blip cannot brick live boxes: an unreachable revocation list ([`Directory::revoked`]
//! answering `None`) and an unreachable eviction chain ([`Directory::retired`] answering `false`).

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;

use flagship_crypto::entitlements::{
    EntitlementRevocationList, GrantRoute, RootEntitlement, RouteScope, ServiceEntitlement,
    ServiceGrant, TunnelHelloV2, cert_id, grant_active_at, grant_authorizes_pod, root_entitlement,
    service_entitlement, service_grant, tunnel_hello_v2, verify,
};
use serde_json::Value;

use crate::hello::{AuthFailure, AuthFuture, EvictFuture, HelloAuthority, ParsedHello};

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// An account's two authorities as `.com` serves them (`GET /api/username/<u>`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountKeys {
    pub irk_pub_hex: String,
    /// Present on an admin-pinned account: it, not the IRK, signs the RootEntitlement.
    pub admin_root_pub_hex: Option<String>,
}

/// What the relay asks `.com` (and caches). Implementations must not return a key they did not receive from `.com`.
pub trait Directory: Send + Sync + 'static {
    fn account<'a>(&'a self, username: &'a str) -> BoxFut<'a, Option<AccountKeys>>;
    /// The account's revoked cert ids, already checked against the IRK's signature on the list; `None` when the list
    /// cannot be had (the hub fails open then).
    fn revoked<'a>(&'a self, username: &'a str) -> BoxFut<'a, Option<HashSet<String>>>;
    /// The STK (hex) registered for a server, `None` when it is unknown or revoked.
    fn stk<'a>(&'a self, server_id: &'a str) -> BoxFut<'a, Option<String>>;
    /// True when this STK has been retired for the pod (graceful decommission). A lookup outage answers `false`.
    fn retired<'a>(&'a self, pod_canonical: &'a str, stk_hex: &'a str) -> BoxFut<'a, bool>;
}

#[derive(Debug)]
pub struct DirectoryAuthority<D: Directory> {
    dir: D,
}

impl<D: Directory> DirectoryAuthority<D> {
    pub const fn new(dir: D) -> Self {
        Self { dir }
    }
}

fn fail(reason: &str, code: u16) -> AuthFailure {
    AuthFailure::new(reason, code)
}

/// A JSON number that is a whole, non-negative integer within `Number.MAX_SAFE_INTEGER`.
fn whole(v: f64) -> Option<u64> {
    (v.is_finite() && v >= 0.0 && v.fract() == 0.0 && v <= 9_007_199_254_740_991.0)
        .then_some(v as u64)
}

fn grant_of(wire: &Value) -> Option<ServiceGrant> {
    let o = wire.as_object()?;
    let s = |k: &str| o.get(k)?.as_str().map(str::to_owned);
    let strings = |k: &str| -> Option<Vec<String>> {
        o.get(k)?
            .as_array()?
            .iter()
            .map(|x| x.as_str().map(str::to_owned))
            .collect()
    };
    let routes = o
        .get("routes")?
        .as_array()?
        .iter()
        .map(|r| {
            Some(GrantRoute {
                url: r.get("url")?.as_str()?.to_owned(),
                scope: match r.get("scope")?.as_str()? {
                    "canonical" => RouteScope::Canonical,
                    "non-canonical" => RouteScope::NonCanonical,
                    "subpath" => RouteScope::Subpath,
                    _ => return None,
                },
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(ServiceGrant {
        grant_id: s("grantId")?,
        username: s("username")?,
        service_canonical: s("serviceCanonical")?,
        service_instance_id: o
            .get("serviceInstanceId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        server_domains: strings("serverDomains")?,
        server_identities_hex: strings("serverIdentitiesHex")?,
        routes,
        issued_at: whole(o.get("issuedAt")?.as_f64()?)?,
        expires_at: whole(o.get("expiresAt")?.as_f64()?)?,
    })
}

impl<D: Directory> DirectoryAuthority<D> {
    async fn check(&self, h: &ParsedHello, now_ms: f64) -> Result<Vec<usize>, AuthFailure> {
        let root = &h.root_entitlement;
        let malformed = |what: &str| fail(&format!("{what} is not canonically encodable"), 1002);
        let root_canon = root_entitlement(&RootEntitlement {
            username: root.username.clone(),
            pod_pub_key_hex: root.pod_pub_key_hex.clone(),
            pod_canonical: root.pod_canonical.clone(),
            issued_at: whole(root.issued_at).ok_or_else(|| malformed("rootEntitlement"))?,
        })
        .map_err(|_| malformed("rootEntitlement"))?;
        if cert_id(&root_canon) != h.root_entitlement_cert_id {
            return Err(fail("rootEntitlementCertId does not match cert", 1002));
        }
        let service_canon = match &h.service_entitlement {
            Some(se) => {
                let canon = service_entitlement(&ServiceEntitlement {
                    username: se.username.clone(),
                    pod_pub_key_hex: se.pod_pub_key_hex.clone(),
                    canonicals: se.canonicals.clone(),
                    issued_at: whole(se.issued_at)
                        .ok_or_else(|| malformed("serviceEntitlement"))?,
                    expires_at: whole(se.expires_at)
                        .ok_or_else(|| malformed("serviceEntitlement"))?,
                })
                .map_err(|_| malformed("serviceEntitlement"))?;
                if cert_id(&canon) != h.service_entitlement_cert_id {
                    return Err(fail("serviceEntitlementCertId does not match cert", 1002));
                }
                Some(canon)
            }
            None => None,
        };

        let keys = self
            .dir
            .account(&root.username)
            .await
            .ok_or_else(|| fail("username not registered with .com", 1008))?;
        let root_authority = keys
            .admin_root_pub_hex
            .as_deref()
            .unwrap_or(&keys.irk_pub_hex);
        if !verify(&root_canon, &h.root_entitlement_sig_hex, root_authority) {
            return Err(fail("rootEntitlement signature failed verification", 1008));
        }
        if let (Some(canon), Some(sig)) = (&service_canon, &h.service_entitlement_sig_hex)
            && !verify(canon, sig, &keys.irk_pub_hex)
        {
            return Err(fail(
                "serviceEntitlement signature failed verification",
                1008,
            ));
        }

        let revoked = self.dir.revoked(&root.username).await;
        if let Some(set) = &revoked {
            if set.contains(&h.root_entitlement_cert_id) {
                return Err(fail("rootEntitlement is revoked", 1008));
            }
            if service_canon.is_some() && set.contains(&h.service_entitlement_cert_id) {
                return Err(fail("serviceEntitlement is revoked", 1008));
            }
        }

        let stk = self
            .dir
            .stk(&h.server_id)
            .await
            .ok_or_else(|| fail("serverId not registered with .com", 1008))?;
        // The STK must be the cert's podPubKey: closes a substitution loophole.
        if !stk.eq_ignore_ascii_case(&root.pod_pub_key_hex) {
            return Err(fail(
                "STK pubkey mismatches rootEntitlement.podPubKey",
                1008,
            ));
        }
        let envelope = tunnel_hello_v2(&TunnelHelloV2 {
            server_id: h.server_id.clone(),
            root_entitlement_cert_id: h.root_entitlement_cert_id.clone(),
            service_entitlement_cert_id: h.service_entitlement_cert_id.clone(),
            nonce_hex: h.nonce_hex.clone(),
            issued_at: whole(h.issued_at).ok_or_else(|| malformed("HELLO"))?,
        })
        .map_err(|_| malformed("HELLO"))?;
        if !verify(&envelope, &h.signature_hex, &stk) {
            return Err(fail("HELLO STK signature failed verification", 1008));
        }

        // ServiceGrants: every presented one must verify, be active, name this pod and not be revoked. Fail closed.
        let mut verified = Vec::new();
        for (i, g) in h.app_grants.iter().enumerate() {
            let grant = grant_of(&g.wire).ok_or_else(|| fail("ServiceGrant is malformed", 1008))?;
            let canon =
                service_grant(&grant).map_err(|_| fail("ServiceGrant is malformed", 1008))?;
            if !verify(&canon, &g.signature_hex, &keys.irk_pub_hex) {
                return Err(fail("ServiceGrant signature failed verification", 1008));
            }
            let now = whole(now_ms.floor()).unwrap_or(0);
            if !grant_active_at(grant.issued_at, grant.expires_at, now) {
                return Err(fail("ServiceGrant outside active window", 1008));
            }
            if !grant_authorizes_pod(&grant, &root.pod_pub_key_hex) {
                return Err(fail("ServiceGrant does not authorize this pod", 1008));
            }
            if revoked
                .as_ref()
                .is_some_and(|set| set.contains(&cert_id(&canon)))
            {
                return Err(fail("ServiceGrant is revoked", 1008));
            }
            verified.push(i);
        }
        Ok(verified)
    }
}

impl<D: Directory> HelloAuthority for DirectoryAuthority<D> {
    fn verifies_signatures(&self) -> bool {
        true
    }

    fn authenticate<'a>(&'a self, hello: &'a ParsedHello, now_ms: f64) -> AuthFuture<'a> {
        Box::pin(self.check(hello, now_ms))
    }

    fn evicted<'a>(&'a self, hello: &'a ParsedHello) -> EvictFuture<'a> {
        Box::pin(async move {
            self.dir
                .retired(
                    &hello.root_entitlement.pod_canonical,
                    &hello.root_entitlement.pod_pub_key_hex,
                )
                .await
        })
    }
}

/// The list a revocation lookup would verify before trusting it (the signature is the account IRK's).
///
/// # Errors
/// Never, but kept fallible so a future stricter list form can refuse.
#[must_use]
pub fn revocation_list_verifies(
    list: &EntitlementRevocationList,
    signature_hex: &str,
    irk_pub_hex: &str,
) -> bool {
    flagship_crypto::entitlements::entitlement_revocation_list(list)
        .is_ok_and(|canon| verify(&canon, signature_hex, irk_pub_hex))
}

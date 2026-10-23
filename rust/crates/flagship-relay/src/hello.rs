//! HELLO v2 parsing and the hub's structural admission checks (`tunnelHub.ts` `parseHello`,
//! the non-cryptographic half of `authenticateHello`, and `buildClaimedCanonicals`).
//!
//! Signature, cert-id, revocation, STK and grant verification are delegated to a
//! [`HelloAuthority`]; this module never decides that a signature is good.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use crate::json::{self, is_lower_hex};

#[derive(Debug, Clone, PartialEq)]
pub struct RootEntitlement {
    pub username: String,
    pub pod_pub_key_hex: String,
    pub pod_canonical: String,
    pub issued_at: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ServiceEntitlement {
    pub username: String,
    pub pod_pub_key_hex: String,
    pub canonicals: Vec<String>,
    pub issued_at: f64,
    pub expires_at: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GrantRoute {
    pub url: String,
    pub scope: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppGrant {
    /// The wire object, verbatim, for the authority's canonical-bytes check.
    pub wire: Value,
    pub signature_hex: String,
    pub routes: Vec<GrantRoute>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedHello {
    pub server_id: String,
    pub root_entitlement: RootEntitlement,
    pub root_entitlement_sig_hex: String,
    pub root_entitlement_cert_id: String,
    pub service_entitlement: Option<ServiceEntitlement>,
    pub service_entitlement_sig_hex: Option<String>,
    pub service_entitlement_cert_id: String,
    pub nonce_hex: String,
    pub issued_at: f64,
    pub signature_hex: String,
    pub app_grants: Vec<AppGrant>,
    /// Extension capabilities the box offers (`stream-credit-v1`, `drain-v1`). Not covered
    /// by the STK signature: only ever used to enable features both ends implement.
    pub capabilities: Vec<String>,
    /// The raw JSON, for an authority that re-derives canonical bytes itself.
    pub raw: Value,
}

fn hex_ok(v: Option<&Value>, len: usize) -> Option<String> {
    v.and_then(Value::as_str)
        .filter(|s| is_lower_hex(s, len))
        .map(str::to_owned)
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

/// JS `typeof v === "object" && v !== null`: an array passes and simply has no fields.
fn object_like(v: &Value) -> Option<Map<String, Value>> {
    match v {
        Value::Object(m) => Some(m.clone()),
        Value::Array(_) => Some(Map::new()),
        _ => None,
    }
}

fn parse_root(o: &Value) -> Result<RootEntitlement, &'static str> {
    let r = object_like(o).ok_or("rootEntitlement not object")?;
    let username = r
        .get("username")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("rootEntitlement.username missing")?;
    let pod =
        hex_ok(r.get("podPubKey"), 64).ok_or("rootEntitlement.podPubKey must be 32-byte hex")?;
    let pc = r
        .get("podCanonical")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("rootEntitlement.podCanonical missing")?;
    let issued = num(r.get("issuedAt")).ok_or("rootEntitlement.issuedAt must be a number")?;
    Ok(RootEntitlement {
        username: username.to_owned(),
        pod_pub_key_hex: pod,
        pod_canonical: pc.to_lowercase(),
        issued_at: issued,
    })
}

fn parse_service(o: &Value) -> Result<ServiceEntitlement, &'static str> {
    let r = object_like(o).ok_or("serviceEntitlement not object")?;
    let username = r
        .get("username")
        .and_then(Value::as_str)
        .ok_or("serviceEntitlement.username missing")?;
    let pod =
        hex_ok(r.get("podPubKey"), 64).ok_or("serviceEntitlement.podPubKey must be 32-byte hex")?;
    let list = r
        .get("canonicals")
        .and_then(Value::as_array)
        .ok_or("serviceEntitlement.canonicals must be an array")?;
    let mut canonicals = Vec::with_capacity(list.len());
    for c in list {
        let s = c
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("serviceEntitlement.canonicals contains a non-string")?;
        canonicals.push(s.to_lowercase());
    }
    let issued = num(r.get("issuedAt")).ok_or("serviceEntitlement.issuedAt must be a number")?;
    let expires = num(r.get("expiresAt")).ok_or("serviceEntitlement.expiresAt must be a number")?;
    Ok(ServiceEntitlement {
        username: username.to_owned(),
        pod_pub_key_hex: pod,
        canonicals,
        issued_at: issued,
        expires_at: expires,
    })
}

fn parse_grant(o: &Map<String, Value>) -> Result<Vec<GrantRoute>, &'static str> {
    let s = |k: &str| o.get(k).and_then(Value::as_str);
    s("grantId").ok_or("ServiceGrant.grantId missing")?;
    s("username").ok_or("ServiceGrant.username missing")?;
    s("serviceCanonical").ok_or("ServiceGrant.serviceCanonical missing")?;
    let domains = o
        .get("serverDomains")
        .and_then(Value::as_array)
        .ok_or("ServiceGrant.serverDomains must be an array")?;
    let ids = o
        .get("serverIdentitiesHex")
        .and_then(Value::as_array)
        .ok_or("ServiceGrant.serverIdentitiesHex must be an array")?;
    let routes = o
        .get("routes")
        .and_then(Value::as_array)
        .ok_or("ServiceGrant.routes must be an array")?;
    num(o.get("issuedAt")).ok_or("ServiceGrant.issuedAt must be a number")?;
    num(o.get("expiresAt")).ok_or("ServiceGrant.expiresAt must be a number")?;
    if domains.iter().any(|d| !d.is_string()) {
        return Err("ServiceGrant.serverDomains must be strings");
    }
    if ids
        .iter()
        .any(|h| !h.as_str().is_some_and(|h| is_lower_hex(h, 64)))
    {
        return Err("ServiceGrant.serverIdentitiesHex must be 32-byte hex");
    }
    let mut out = Vec::with_capacity(routes.len());
    for r in routes {
        let rr = object_like(r).ok_or("ServiceGrant.route not object")?;
        let url = rr
            .get("url")
            .and_then(Value::as_str)
            .ok_or("ServiceGrant.route.url missing")?;
        let scope = rr
            .get("scope")
            .and_then(Value::as_str)
            .filter(|s| matches!(*s, "canonical" | "non-canonical" | "subpath"))
            .ok_or("ServiceGrant.route.scope invalid")?;
        out.push(GrantRoute {
            url: url.to_owned(),
            scope: scope.to_owned(),
        });
    }
    Ok(out)
}

/// `parseHello`, reason strings verbatim.
pub fn parse_hello(payload: &[u8]) -> Result<ParsedHello, &'static str> {
    let v = json::parse(payload).ok_or("HELLO payload not JSON")?;
    if v.is_array() {
        return Err("HELLO version must be 2");
    }
    let o = v.as_object().ok_or("HELLO not object")?;
    if num(o.get("version")) != Some(2.0) {
        return Err("HELLO version must be 2");
    }
    let server_id = o
        .get("serverId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("HELLO.serverId missing")?;
    let issued_at = num(o.get("issuedAt"))
        .filter(|n| n.is_finite())
        .ok_or("HELLO.issuedAt must be a number")?;
    let nonce = hex_ok(o.get("nonce"), 64).ok_or("HELLO.nonce must be 32-byte hex")?;
    let signature = hex_ok(o.get("signature"), 128).ok_or("HELLO.signature must be 64-byte hex")?;
    let re = o
        .get("rootEntitlement")
        .filter(|r| r.is_object() || r.is_array())
        .ok_or("HELLO.rootEntitlement missing")?;
    let re_sig = hex_ok(o.get("rootEntitlementSig"), 128)
        .ok_or("HELLO.rootEntitlementSig must be 64-byte hex")?;
    let re_id = hex_ok(o.get("rootEntitlementCertId"), 64)
        .ok_or("HELLO.rootEntitlementCertId must be 32-byte hex")?;
    let root = parse_root(re)?;

    let mut service = None;
    let mut service_sig = None;
    let mut service_id = String::new();
    if let Some(se) = o.get("serviceEntitlement").filter(|s| !s.is_null()) {
        if !(se.is_object() || se.is_array()) {
            return Err("HELLO.serviceEntitlement not an object");
        }
        service_sig = Some(
            hex_ok(o.get("serviceEntitlementSig"), 128)
                .ok_or("HELLO.serviceEntitlementSig must be 64-byte hex")?,
        );
        service_id = hex_ok(o.get("serviceEntitlementCertId"), 64)
            .ok_or("HELLO.serviceEntitlementCertId must be 32-byte hex")?;
        service = Some(parse_service(se)?);
    }

    let mut app_grants = Vec::new();
    if let Some(g) = o.get("appGrants") {
        let list = g.as_array().ok_or("HELLO.appGrants must be an array")?;
        for raw in list {
            if !(raw.is_object() || raw.is_array()) {
                return Err("HELLO.appGrants entry not object");
            }
            let wire = raw
                .get("grant")
                .filter(|w| w.is_object() || w.is_array())
                .ok_or("HELLO.appGrants entry missing grant")?;
            let sig = hex_ok(raw.get("signatureHex"), 128)
                .ok_or("HELLO.appGrants entry signatureHex must be 64-byte hex")?;
            let routes = parse_grant(&object_like(wire).unwrap_or_default())?;
            app_grants.push(AppGrant {
                wire: wire.clone(),
                signature_hex: sig,
                routes,
            });
        }
    }
    let capabilities = o
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    Ok(ParsedHello {
        server_id: server_id.to_owned(),
        root_entitlement: root,
        root_entitlement_sig_hex: re_sig,
        root_entitlement_cert_id: re_id,
        service_entitlement: service,
        service_entitlement_sig_hex: service_sig,
        service_entitlement_cert_id: service_id,
        nonce_hex: nonce,
        issued_at,
        signature_hex: signature,
        app_grants,
        capabilities,
        raw: v.clone(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthFailure {
    pub reason: String,
    pub close_code: u16,
}

impl AuthFailure {
    pub fn new(reason: impl Into<String>, close_code: u16) -> Self {
        Self {
            reason: reason.into(),
            close_code,
        }
    }
}

pub const DEFAULT_MAX_HELLO_AGE_MS: f64 = 5.0 * 60_000.0;

fn label_ok(p: &str) -> bool {
    let b = p.as_bytes();
    let alnum = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    match b.split_first() {
        Some((f, rest)) => {
            alnum(f) && rest.len() <= 62 && rest.iter().all(|c| alnum(c) || *c == b'-')
        }
        None => false,
    }
}

fn head_under_apex<'a>(name: &'a str, apex: &str) -> Option<&'a str> {
    name.strip_suffix(apex)?.strip_suffix('.')
}

/// `podCanonicalShapeOk`: `<server>.<user>.<apex>` of plain DNS labels (no `*`).
pub fn pod_canonical_shape_ok(pc: &str, apex: &str) -> bool {
    let Some(head) = head_under_apex(pc, apex) else {
        return false;
    };
    let parts: Vec<&str> = head.split('.').collect();
    parts.len() >= 2 && parts.iter().all(|p| label_ok(p))
}

/// `extractMiddleLabel`: the user-zone label left of the apex.
pub fn middle_label(name: &str, apex: &str) -> Option<String> {
    let lower = name.to_lowercase();
    let head = head_under_apex(&lower, apex)?;
    let parts: Vec<&str> = head.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let user = *parts.last()?;
    label_ok(user).then(|| user.to_owned())
}

/// The ordered, synchronous checks `authenticateHello` makes before any lookup.
pub fn structural_checks(
    h: &ParsedHello,
    now_ms: f64,
    max_age_ms: f64,
    apex: &str,
) -> Result<(), AuthFailure> {
    let age = now_ms - h.issued_at;
    if age > max_age_ms || age < -60_000.0 {
        return Err(AuthFailure::new(
            "HELLO issuedAt is stale or in the future",
            1008,
        ));
    }
    if h.server_id.to_lowercase() != h.root_entitlement.pod_canonical {
        return Err(AuthFailure::new(
            "serverId must equal rootEntitlement.podCanonical",
            1002,
        ));
    }
    if !pod_canonical_shape_ok(&h.root_entitlement.pod_canonical, apex) {
        return Err(AuthFailure::new(
            "rootEntitlement.podCanonical is not a valid pod name under the data-plane apex",
            1008,
        ));
    }
    if middle_label(&h.root_entitlement.pod_canonical, apex).as_deref()
        != Some(h.root_entitlement.username.as_str())
    {
        return Err(AuthFailure::new(
            "rootEntitlement.podCanonical does not live in its declared user zone",
            1008,
        ));
    }
    if let Some(s) = &h.service_entitlement {
        if s.expires_at <= now_ms {
            return Err(AuthFailure::new("serviceEntitlement expired", 1008));
        }
        if s.username != h.root_entitlement.username {
            return Err(AuthFailure::new(
                "serviceEntitlement.username mismatches root",
                1008,
            ));
        }
        if s.pod_pub_key_hex != h.root_entitlement.pod_pub_key_hex {
            return Err(AuthFailure::new(
                "serviceEntitlement.podPubKey mismatches root",
                1008,
            ));
        }
    }
    Ok(())
}

/// `appGrantHosts`: unique route hosts of grants the authority verified.
pub fn app_grant_hosts(grants: &[&AppGrant]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for g in grants {
        for r in &g.routes {
            let host = r.url.split('/').next().unwrap_or_default().to_lowercase();
            if !host.is_empty() && !out.contains(&host) {
                out.push(host);
            }
        }
    }
    out
}

/// `buildClaimedCanonicals`: the pod's own name, plus every service-entitlement canonical and
/// verified grant host in its own user zone; `*.<podCanonical>` is consumed (the registry's
/// one-label strip routes it), any other wildcard rejects the HELLO.
pub fn build_claimed_canonicals(
    pod_canonical: &str,
    service: Option<&ServiceEntitlement>,
    verified_grant_hosts: &[String],
    username: &str,
    apex: &str,
) -> Result<Vec<String>, String> {
    let pc = pod_canonical.to_lowercase();
    let user = username.to_lowercase();
    let mut out = vec![pc.clone()];
    let claims = service
        .map(|s| s.canonicals.as_slice())
        .unwrap_or_default()
        .iter()
        .chain(verified_grant_hosts);
    for claim in claims {
        let c = claim.to_lowercase();
        if let Some(base) = c.strip_prefix("*.") {
            if base != pc {
                return Err(format!(
                    "wildcard claim {c} rejected — a pod may only claim its own per-box wildcard *.{pc}"
                ));
            }
            continue;
        }
        if c.contains('*') {
            return Err(format!(
                "claim {c} rejected — '*' is only valid as the leading label of *.{pc}"
            ));
        }
        if middle_label(&c, apex).as_deref() != Some(user.as_str()) {
            return Err(format!(
                "claim {c} rejected — outside user zone '{user}' (foreign-zone canonical)"
            ));
        }
        out.push(c);
    }
    Ok(out)
}

pub type AuthFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Vec<usize>, AuthFailure>> + Send + 'a>>;
pub type EvictFuture<'a> = Pin<Box<dyn Future<Output = bool> + Send + 'a>>;

/// The cryptographic half of admission: cert ids, entitlement and grant signatures under the
/// account's admin root / IRK, revocation, the STK binding and the HELLO signature.
///
/// Returns the indices of `hello.app_grants` it verified. Must fail closed.
pub trait HelloAuthority: Send + Sync + 'static {
    fn verifies_signatures(&self) -> bool;
    fn authenticate<'a>(&'a self, hello: &'a ParsedHello, now_ms: f64) -> AuthFuture<'a>;
    /// Eviction (graceful decommission): true iff this box's STK is retired. A lookup outage
    /// answers false (fail-open, as the TS hub does).
    fn evicted<'a>(&'a self, _hello: &'a ParsedHello) -> EvictFuture<'a> {
        Box::pin(async { false })
    }
}

/// Development authority: accepts every structurally valid HELLO and verifies no signature.
/// The relay refuses to start with it when configured as the production data plane.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnverifiedDevAuthority;

impl HelloAuthority for UnverifiedDevAuthority {
    fn verifies_signatures(&self) -> bool {
        false
    }
    fn authenticate<'a>(&'a self, hello: &'a ParsedHello, _now_ms: f64) -> AuthFuture<'a> {
        let n = hello.app_grants.len();
        Box::pin(async move {
            if n > 0 {
                return Err(AuthFailure::new(
                    "AppGrants presented but no irkLookup configured",
                    1008,
                ));
            }
            Ok(Vec::new())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "flagship.services";

    #[test]
    fn claims_follow_ts_rules() {
        let pc = "home.alice.flagship.services";
        let ok = build_claimed_canonicals(
            pc,
            None,
            &[
                "*.home.alice.flagship.services".into(),
                "Chess.alice.flagship.services".into(),
            ],
            "alice",
            A,
        );
        assert_eq!(
            ok,
            Ok(vec![
                pc.to_owned(),
                "chess.alice.flagship.services".to_owned()
            ])
        );
        assert!(
            build_claimed_canonicals(pc, None, &["*.alice.flagship.services".into()], "alice", A)
                .is_err()
        );
        assert!(
            build_claimed_canonicals(
                pc,
                None,
                &["chess.bob.flagship.services".into()],
                "alice",
                A
            )
            .is_err()
        );
        assert!(
            build_claimed_canonicals(pc, None, &["a*.alice.flagship.services".into()], "alice", A)
                .is_err()
        );
    }

    #[test]
    fn shape_and_zone() {
        assert!(pod_canonical_shape_ok("home.alice.flagship.services", A));
        assert!(!pod_canonical_shape_ok("alice.flagship.services", A));
        assert!(!pod_canonical_shape_ok("*.alice.flagship.services", A));
        assert_eq!(
            middle_label("x.home.alice.flagship.services", A).as_deref(),
            Some("alice")
        );
    }

    #[test]
    fn parse_hello_reasons() {
        assert_eq!(parse_hello(b"nope").err(), Some("HELLO payload not JSON"));
        assert_eq!(parse_hello(b"1").err(), Some("HELLO not object"));
        assert_eq!(
            parse_hello(b"{\"version\":1}").err(),
            Some("HELLO version must be 2")
        );
        assert_eq!(
            parse_hello(b"{\"version\":2}").err(),
            Some("HELLO.serverId missing")
        );
    }
}

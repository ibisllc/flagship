#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use std::collections::HashSet;
use std::sync::Mutex;

use ed25519_dalek::{Signer, SigningKey};
use flagship_crypto::entitlements::{
    GrantRoute, RootEntitlement, RouteScope, ServiceEntitlement, ServiceGrant, TunnelHelloV2,
    cert_id, root_entitlement, service_entitlement, service_grant, tunnel_hello_v2,
};
use flagship_relay::authority::{AccountKeys, BoxFut, Directory, DirectoryAuthority};
use flagship_relay::hello::{HelloAuthority, parse_hello};
use serde_json::{Value, json};

const POD: &str = "kitchen.john.flagship.services";
const NOW: u64 = 1_760_000_000_000;

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}
fn pubhex(k: &SigningKey) -> String {
    flagship_crypto::trust::hex(&k.verifying_key().to_bytes())
}
fn sig(k: &SigningKey, canon: &str) -> String {
    flagship_crypto::trust::hex(&k.sign(canon.as_bytes()).to_bytes())
}

struct Dir {
    account: Option<AccountKeys>,
    revoked: Mutex<Option<HashSet<String>>>,
    stk: Option<String>,
    retired: bool,
}

impl Directory for Dir {
    fn account<'a>(&'a self, _u: &'a str) -> BoxFut<'a, Option<AccountKeys>> {
        Box::pin(async { self.account.clone() })
    }
    fn revoked<'a>(&'a self, _u: &'a str) -> BoxFut<'a, Option<HashSet<String>>> {
        Box::pin(async { self.revoked.lock().unwrap().clone() })
    }
    fn stk<'a>(&'a self, _s: &'a str) -> BoxFut<'a, Option<String>> {
        Box::pin(async { self.stk.clone() })
    }
    fn retired<'a>(&'a self, _p: &'a str, _k: &'a str) -> BoxFut<'a, bool> {
        Box::pin(async { self.retired })
    }
}

struct World {
    irk: SigningKey,
    admin: SigningKey,
    stk: SigningKey,
    dir: Dir,
}

fn world(with_admin: bool) -> World {
    let (irk, admin, stk) = (key(1), key(2), key(3));
    let dir = Dir {
        account: Some(AccountKeys {
            irk_pub_hex: pubhex(&irk),
            admin_root_pub_hex: with_admin.then(|| pubhex(&admin)),
        }),
        revoked: Mutex::new(Some(HashSet::new())),
        stk: Some(pubhex(&stk)),
        retired: false,
    };
    World {
        irk,
        admin,
        stk,
        dir,
    }
}

struct Built {
    json: Value,
    root_id: String,
    grant_id: String,
}

fn grant_wire(w: &World, mutate: impl Fn(&mut ServiceGrant)) -> (Value, String, String) {
    let mut g = ServiceGrant {
        grant_id: "5d7b1a3e-9c1a-4f6e-8a55-0a1b2c3d4e5f".into(),
        username: "john".into(),
        service_canonical: "chess@a1b2c3d4e5f6".into(),
        service_instance_id: None,
        server_domains: vec![POD.into()],
        server_identities_hex: vec![pubhex(&w.stk)],
        routes: vec![GrantRoute {
            url: "chess.john.flagship.services".into(),
            scope: RouteScope::Canonical,
        }],
        issued_at: NOW - 1000,
        expires_at: NOW + 86_400_000,
    };
    mutate(&mut g);
    let canon = service_grant(&g).unwrap();
    let wire = json!({
        "grantId": g.grant_id, "username": g.username, "serviceCanonical": g.service_canonical, "serverDomains": g.server_domains,
        "serverIdentitiesHex": g.server_identities_hex, "routes": [{"url": g.routes[0].url, "scope": "canonical"}],
        "issuedAt": g.issued_at, "expiresAt": g.expires_at
    });
    (wire, sig(&w.irk, &canon), cert_id(&canon))
}

/// A correctly signed HELLO; `root_signer` and `with_service` and `with_grant` shape it.
fn hello(
    w: &World,
    root_signer: &SigningKey,
    with_service: bool,
    grant: Option<(Value, String, String)>,
) -> Built {
    let root = RootEntitlement {
        username: "john".into(),
        pod_pub_key_hex: pubhex(&w.stk),
        pod_canonical: POD.into(),
        issued_at: NOW - 5000,
    };
    let root_canon = root_entitlement(&root).unwrap();
    let root_id = cert_id(&root_canon);
    let mut v = json!({
        "version": 2, "serverId": POD, "issuedAt": NOW, "nonce": "ab".repeat(32),
        "rootEntitlement": {"username": "john", "podPubKey": pubhex(&w.stk), "podCanonical": POD, "issuedAt": NOW - 5000},
        "rootEntitlementSig": sig(root_signer, &root_canon), "rootEntitlementCertId": root_id,
    });
    let mut service_id = String::new();
    if with_service {
        let se = ServiceEntitlement {
            username: "john".into(),
            pod_pub_key_hex: pubhex(&w.stk),
            canonicals: vec!["chess.kitchen.john.flagship.services".into()],
            issued_at: NOW - 5000,
            expires_at: NOW + 86_400_000,
        };
        let canon = service_entitlement(&se).unwrap();
        service_id = cert_id(&canon);
        v["serviceEntitlement"] = json!({"username": "john", "podPubKey": pubhex(&w.stk), "canonicals": se.canonicals, "issuedAt": se.issued_at, "expiresAt": se.expires_at});
        v["serviceEntitlementSig"] = json!(sig(&w.irk, &canon));
        v["serviceEntitlementCertId"] = json!(service_id);
    }
    let envelope = tunnel_hello_v2(&TunnelHelloV2 {
        server_id: POD.into(),
        root_entitlement_cert_id: root_id.clone(),
        service_entitlement_cert_id: service_id,
        nonce_hex: "ab".repeat(32),
        issued_at: NOW,
    })
    .unwrap();
    v["signature"] = json!(sig(&w.stk, &envelope));
    let mut grant_id = String::new();
    if let Some((wire, gsig, gid)) = grant {
        grant_id = gid;
        v["appGrants"] = json!([{"grant": wire, "signatureHex": gsig}]);
    }
    Built {
        json: v,
        root_id,
        grant_id,
    }
}

async fn run(w: &World, b: &Built) -> Result<Vec<usize>, (String, u16)> {
    let parsed = parse_hello(b.json.to_string().as_bytes()).unwrap();
    let revoked = w.dir.revoked.lock().unwrap().clone();
    DirectoryAuthority::new(Dir {
        account: w.dir.account.clone(),
        revoked: Mutex::new(revoked),
        stk: w.dir.stk.clone(),
        retired: w.dir.retired,
    })
    .authenticate(&parsed, NOW as f64)
    .await
    .map_err(|e| (e.reason, e.close_code))
}

fn refused(r: Result<Vec<usize>, (String, u16)>) -> String {
    r.unwrap_err().0
}

#[tokio::test]
async fn a_correctly_signed_hello_is_admitted() {
    let w = world(false);
    assert_eq!(run(&w, &hello(&w, &w.irk, false, None)).await, Ok(vec![]));
    assert_eq!(run(&w, &hello(&w, &w.irk, true, None)).await, Ok(vec![]));
    let g = grant_wire(&w, |_| {});
    assert_eq!(
        run(&w, &hello(&w, &w.irk, true, Some(g))).await,
        Ok(vec![0])
    );
}

#[tokio::test]
async fn on_an_admin_pinned_account_the_root_entitlement_needs_the_admin_root() {
    let w = world(true);
    assert_eq!(
        refused(run(&w, &hello(&w, &w.irk, false, None)).await),
        "rootEntitlement signature failed verification"
    );
    assert_eq!(run(&w, &hello(&w, &w.admin, false, None)).await, Ok(vec![]));
    let stranger = key(9);
    assert_eq!(
        refused(run(&w, &hello(&w, &stranger, false, None)).await),
        "rootEntitlement signature failed verification"
    );
}

#[tokio::test]
async fn cert_ids_must_match_the_certs_they_name() {
    let w = world(false);
    let mut b = hello(&w, &w.irk, true, None);
    b.json["rootEntitlementCertId"] = json!("00".repeat(32));
    assert_eq!(
        refused(run(&w, &b).await),
        "rootEntitlementCertId does not match cert"
    );
    let mut b = hello(&w, &w.irk, true, None);
    b.json["serviceEntitlementCertId"] = json!("00".repeat(32));
    assert_eq!(
        refused(run(&w, &b).await),
        "serviceEntitlementCertId does not match cert"
    );
    // a forged service entitlement (signed by the STK, not the IRK)
    let mut b = hello(&w, &w.irk, true, None);
    let canon = service_entitlement(&ServiceEntitlement {
        username: "john".into(),
        pod_pub_key_hex: pubhex(&w.stk),
        canonicals: vec!["chess.kitchen.john.flagship.services".into()],
        issued_at: NOW - 5000,
        expires_at: NOW + 86_400_000,
    })
    .unwrap();
    b.json["serviceEntitlementSig"] = json!(sig(&w.stk, &canon));
    assert_eq!(
        refused(run(&w, &b).await),
        "serviceEntitlement signature failed verification"
    );
}

#[tokio::test]
async fn an_unknown_account_server_or_a_mismatched_stk_is_refused() {
    let mut w = world(false);
    let b = hello(&w, &w.irk, false, None);
    w.dir.account = None;
    assert_eq!(
        refused(run(&w, &b).await),
        "username not registered with .com"
    );
    let mut w = world(false);
    let b = hello(&w, &w.irk, false, None);
    w.dir.stk = None;
    assert_eq!(
        refused(run(&w, &b).await),
        "serverId not registered with .com"
    );
    let mut w = world(false);
    let b = hello(&w, &w.irk, false, None);
    w.dir.stk = Some(pubhex(&key(7)));
    assert_eq!(
        refused(run(&w, &b).await),
        "STK pubkey mismatches rootEntitlement.podPubKey"
    );
}

#[tokio::test]
async fn the_hello_envelope_must_be_signed_by_the_stk() {
    let w = world(false);
    let mut b = hello(&w, &w.irk, false, None);
    b.json["nonce"] = json!("cd".repeat(32));
    assert_eq!(
        refused(run(&w, &b).await),
        "HELLO STK signature failed verification"
    );
    let mut b = hello(&w, &w.irk, false, None);
    let other = key(8);
    b.json["signature"] = json!(sig(&other, "anything"));
    assert_eq!(
        refused(run(&w, &b).await),
        "HELLO STK signature failed verification"
    );
}

#[tokio::test]
async fn revoked_certs_are_refused_and_an_unreachable_list_fails_open() {
    let w = world(false);
    let b = hello(&w, &w.irk, true, None);
    *w.dir.revoked.lock().unwrap() = Some(HashSet::from([b.root_id.clone()]));
    assert_eq!(refused(run(&w, &b).await), "rootEntitlement is revoked");
    *w.dir.revoked.lock().unwrap() = Some(HashSet::from([b.json["serviceEntitlementCertId"]
        .as_str()
        .unwrap()
        .to_owned()]));
    assert_eq!(refused(run(&w, &b).await), "serviceEntitlement is revoked");
    *w.dir.revoked.lock().unwrap() = None;
    assert_eq!(run(&w, &b).await, Ok(vec![]));
}

#[tokio::test]
async fn service_grants_must_verify_be_active_name_this_pod_and_not_be_revoked() {
    let w = world(false);
    let ok = grant_wire(&w, |_| {});
    assert_eq!(
        run(&w, &hello(&w, &w.irk, false, Some(ok.clone()))).await,
        Ok(vec![0])
    );

    let mut forged = ok.clone();
    forged.1 = sig(&key(9), "x");
    assert_eq!(
        refused(run(&w, &hello(&w, &w.irk, false, Some(forged))).await),
        "ServiceGrant signature failed verification"
    );

    let expired = grant_wire(&w, |g| {
        g.issued_at = NOW - 2_000_000;
        g.expires_at = NOW - 1_000_000;
    });
    assert_eq!(
        refused(run(&w, &hello(&w, &w.irk, false, Some(expired))).await),
        "ServiceGrant outside active window"
    );
    let future = grant_wire(&w, |g| {
        g.issued_at = NOW + 1_000;
        g.expires_at = NOW + 2_000;
    });
    assert_eq!(
        refused(run(&w, &hello(&w, &w.irk, false, Some(future))).await),
        "ServiceGrant outside active window"
    );

    let elsewhere = grant_wire(&w, |g| g.server_identities_hex = vec![pubhex(&key(9))]);
    assert_eq!(
        refused(run(&w, &hello(&w, &w.irk, false, Some(elsewhere))).await),
        "ServiceGrant does not authorize this pod"
    );

    let b = hello(&w, &w.irk, false, Some(ok));
    *w.dir.revoked.lock().unwrap() = Some(HashSet::from([b.grant_id.clone()]));
    assert_eq!(refused(run(&w, &b).await), "ServiceGrant is revoked");

    let mut broken = hello(&w, &w.irk, false, Some(grant_wire(&w, |_| {})));
    broken.json["appGrants"][0]["grant"]["routes"] = json!([{"url": 5, "scope": "canonical"}]);
    let parsed = parse_hello(broken.json.to_string().as_bytes());
    assert!(
        parsed.is_err(),
        "a malformed grant never reaches the authority: the parser refuses it"
    );
}

#[tokio::test]
async fn eviction_is_the_directorys_answer_and_the_authority_verifies_signatures() {
    let w = world(false);
    let b = hello(&w, &w.irk, false, None);
    let parsed = parse_hello(b.json.to_string().as_bytes()).unwrap();
    let make = |retired: bool| {
        DirectoryAuthority::new(Dir {
            account: None,
            revoked: Mutex::new(None),
            stk: None,
            retired,
        })
    };
    assert!(make(true).evicted(&parsed).await);
    assert!(!make(false).evicted(&parsed).await);
    assert!(make(false).verifies_signatures());
}

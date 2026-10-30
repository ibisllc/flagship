#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ed25519_dalek::{Signer, SigningKey};
use flagship_crypto::entitlements::{EntitlementRevocationList, entitlement_revocation_list};
use flagship_relay::authority::Directory;
use flagship_relay::com::{ComDirectory, HttpGet, Ttls};
use serde_json::{Value, json};

#[derive(Clone, Default)]
struct Canned {
    routes: Arc<Mutex<HashMap<String, (u16, Value)>>>,
    seen: Arc<Mutex<Vec<String>>>,
}

impl Canned {
    fn put(&self, path: &str, status: u16, body: Value) {
        self.routes
            .lock()
            .unwrap()
            .insert(format!("https://com.test{path}"), (status, body));
    }
    fn calls(&self, needle: &str) -> usize {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|u| u.contains(needle))
            .count()
    }
}

impl HttpGet for Canned {
    fn get_json(&self, url: &str) -> Result<(u16, Value), String> {
        self.seen.lock().unwrap().push(url.to_owned());
        self.routes
            .lock()
            .unwrap()
            .get(url)
            .cloned()
            .ok_or_else(|| format!("unreachable {url}"))
    }
}

fn hexs(k: &SigningKey) -> String {
    flagship_crypto::trust::hex(&k.verifying_key().to_bytes())
}

fn dir(c: &Canned, ttl: Ttls) -> ComDirectory<Canned> {
    ComDirectory::new("https://com.test/", c.clone(), ttl)
}

#[tokio::test]
async fn account_keys_come_from_com_and_are_cached() {
    let c = Canned::default();
    let (irk, admin) = (
        SigningKey::from_bytes(&[1; 32]),
        SigningKey::from_bytes(&[2; 32]),
    );
    c.put(
        "/api/username/john",
        200,
        json!({"irkPub": hexs(&irk), "adminRootPub": hexs(&admin)}),
    );
    c.put("/api/username/legacy", 200, json!({"irkPub": hexs(&irk)}));
    c.put("/api/username/bad", 200, json!({"irkPub": "xyz"}));
    c.put(
        "/api/username/badadmin",
        200,
        json!({"irkPub": hexs(&irk), "adminRootPub": 5}),
    );
    let d = dir(&c, Ttls::default());
    let k = d.account("john").await.unwrap();
    assert_eq!(
        (k.irk_pub_hex, k.admin_root_pub_hex),
        (hexs(&irk), Some(hexs(&admin)))
    );
    assert_eq!(d.account("legacy").await.unwrap().admin_root_pub_hex, None);
    assert!(d.account("bad").await.is_none());
    assert!(d.account("badadmin").await.is_none());
    d.account("john").await.unwrap();
    assert_eq!(
        c.calls("/api/username/john"),
        1,
        "the second lookup is served from the cache"
    );
}

#[tokio::test]
async fn an_unknown_account_is_cached_briefly_and_an_outage_is_not() {
    let c = Canned::default();
    c.put("/api/username/ghost", 404, json!({}));
    let d = dir(
        &c,
        Ttls {
            negative_keys: Duration::from_secs(30),
            ..Ttls::default()
        },
    );
    assert!(d.account("ghost").await.is_none());
    assert!(d.account("ghost").await.is_none());
    assert_eq!(c.calls("/api/username/ghost"), 1);
    // nothing answers for this one: not cached, asked again
    assert!(d.account("nobody").await.is_none());
    assert!(d.account("nobody").await.is_none());
    assert_eq!(c.calls("/api/username/nobody"), 2);
}

#[tokio::test]
async fn usernames_are_percent_encoded_in_the_path() {
    let c = Canned::default();
    let d = dir(&c, Ttls::default());
    let _ = d.account("a/../b").await;
    assert_eq!(
        c.seen.lock().unwrap()[0],
        "https://com.test/api/username/a%2F..%2Fb"
    );
}

#[tokio::test]
async fn a_revocation_list_counts_only_with_the_irks_signature() {
    let c = Canned::default();
    let irk = SigningKey::from_bytes(&[1; 32]);
    c.put("/api/username/john", 200, json!({"irkPub": hexs(&irk)}));
    let ids = vec!["bb".repeat(32), "aa".repeat(32)];
    let canon = entitlement_revocation_list(&EntitlementRevocationList {
        username: "john".into(),
        cert_ids: ids.clone(),
        issued_at: 77,
    })
    .unwrap();
    let sig = flagship_crypto::trust::hex(&irk.sign(canon.as_bytes()).to_bytes());
    c.put(
        "/api/cert-revocations/john",
        200,
        json!({"username": "john", "certIds": ids, "issuedAt": 77, "signature": sig}),
    );
    let d = dir(&c, Ttls::default());
    let set = d.revoked("john").await.unwrap();
    assert!(set.contains(&"aa".repeat(32)) && set.contains(&"bb".repeat(32)));
    // a list signed by someone else is not believed
    let other = SigningKey::from_bytes(&[5; 32]);
    let forged = flagship_crypto::trust::hex(&other.sign(canon.as_bytes()).to_bytes());
    c.put("/api/cert-revocations/mary", 200, json!({"username": "mary", "certIds": ["cc".repeat(32)], "issuedAt": 1, "signature": forged}));
    c.put("/api/username/mary", 200, json!({"irkPub": hexs(&irk)}));
    assert_eq!(
        d.revoked("mary").await,
        None,
        "unknown, so the hub fails open"
    );
}

#[tokio::test]
async fn no_list_ever_posted_is_a_definite_empty_answer_and_an_outage_is_unknown() {
    let c = Canned::default();
    c.put(
        "/api/cert-revocations/john",
        200,
        json!({"username": "john", "certIds": [], "signature": null}),
    );
    let d = dir(&c, Ttls::default());
    assert_eq!(d.revoked("john").await, Some(Default::default()));
    assert_eq!(d.revoked("nobody").await, None);
    // an outage after a good answer keeps the last good set
    let c2 = Canned::default();
    let irk = SigningKey::from_bytes(&[1; 32]);
    c2.put("/api/username/john", 200, json!({"irkPub": hexs(&irk)}));
    let ids = vec!["aa".repeat(32)];
    let canon = entitlement_revocation_list(&EntitlementRevocationList {
        username: "john".into(),
        cert_ids: ids.clone(),
        issued_at: 1,
    })
    .unwrap();
    c2.put("/api/cert-revocations/john", 200, json!({"certIds": ids, "issuedAt": 1, "signature": flagship_crypto::trust::hex(&irk.sign(canon.as_bytes()).to_bytes())}));
    let d2 = dir(
        &c2,
        Ttls {
            revocations: Duration::ZERO,
            ..Ttls::default()
        },
    );
    assert_eq!(d2.revoked("john").await.unwrap().len(), 1);
    c2.routes
        .lock()
        .unwrap()
        .remove("https://com.test/api/cert-revocations/john");
    assert_eq!(
        d2.revoked("john").await.unwrap().len(),
        1,
        "the last good list is kept through an outage"
    );
}

#[tokio::test]
async fn a_servers_stk_comes_from_the_registry_unless_it_is_revoked() {
    let c = Canned::default();
    let stk = "ab".repeat(32);
    c.put(
        "/api/server/by-domain/home.john.flagship.services",
        200,
        json!({"identityPubKey": stk}),
    );
    c.put(
        "/api/server/by-domain/gone.john.flagship.services",
        200,
        json!({"identityPubKey": stk, "revoked": true}),
    );
    c.put(
        "/api/server/by-domain/odd.john.flagship.services",
        200,
        json!({"identityPubKey": "short"}),
    );
    c.put(
        "/api/server/by-domain/missing.john.flagship.services",
        404,
        json!({}),
    );
    let d = dir(&c, Ttls::default());
    assert_eq!(
        d.stk("home.john.flagship.services").await.as_deref(),
        Some(stk.as_str())
    );
    assert_eq!(
        d.stk("Home.John.flagship.services").await.as_deref(),
        Some(stk.as_str()),
        "case-insensitive cache key"
    );
    assert_eq!(c.calls("home.john"), 1);
    for p in ["gone", "odd", "missing", "unreachable"] {
        assert_eq!(
            d.stk(&format!("{p}.john.flagship.services")).await,
            None,
            "{p}"
        );
    }
}

#[tokio::test]
async fn retirement_follows_the_eviction_chain_and_fails_open() {
    let c = Canned::default();
    let retired = "cd".repeat(32);
    c.put(
        "/api/server/home.john.flagship.services/eviction-chain",
        200,
        json!({"evictions": [
            {"orderJson": json!({"retiredStkPubHex": retired.to_uppercase()}).to_string()},
            {"orderJson": "not json"},
            {"orderJson": 5}
        ]}),
    );
    let d = dir(&c, Ttls::default());
    assert!(d.retired("home.john.flagship.services", &retired).await);
    assert!(
        !d.retired("home.john.flagship.services", &"ee".repeat(32))
            .await
    );
    assert_eq!(
        c.calls("eviction-chain"),
        1,
        "one fetch covers both questions"
    );
    assert!(
        !d.retired("down.john.flagship.services", &retired).await,
        "an outage fails open"
    );
}

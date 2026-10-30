#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use flagship_crypto::entitlements::{
    EntitlementRevocationList, GrantRoute, RootEntitlement, RouteScope, ServiceEntitlement,
    ServiceGrant, TunnelHelloV2, cert_id, entitlement_revocation_list, grant_active_at,
    grant_authorizes_pod, root_entitlement, service_entitlement, service_grant, tunnel_hello_v2,
    verify,
};
use serde_json::Value;

const VECTORS: &str =
    include_str!("../../../../packages/protocol/test-vectors/entitlements/vectors.json");

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap().to_owned()
}
fn n(v: &Value, k: &str) -> u64 {
    v[k].as_u64().unwrap()
}
fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_owned())
        .collect()
}

fn grant_of(i: &Value) -> ServiceGrant {
    ServiceGrant {
        grant_id: s(i, "grantId"),
        username: s(i, "username"),
        service_canonical: s(i, "serviceCanonical"),
        service_instance_id: i
            .get("serviceInstanceId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        server_domains: strings(&i["serverDomains"]),
        server_identities_hex: strings(&i["serverIdentitiesHex"]),
        routes: i["routes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| GrantRoute {
                url: s(r, "url"),
                scope: match r["scope"].as_str().unwrap() {
                    "canonical" => RouteScope::Canonical,
                    "non-canonical" => RouteScope::NonCanonical,
                    _ => RouteScope::Subpath,
                },
            })
            .collect(),
        issued_at: n(i, "issuedAt"),
        expires_at: n(i, "expiresAt"),
    }
}

fn canonical_of(kind: &str, i: &Value) -> Result<String, flagship_protocol::ProtocolError> {
    match kind {
        "root" => root_entitlement(&RootEntitlement {
            username: s(i, "username"),
            pod_pub_key_hex: s(i, "podPubKeyHex"),
            pod_canonical: s(i, "podCanonical"),
            issued_at: n(i, "issuedAt"),
        }),
        "service" => service_entitlement(&ServiceEntitlement {
            username: s(i, "username"),
            pod_pub_key_hex: s(i, "podPubKeyHex"),
            canonicals: strings(&i["canonicals"]),
            issued_at: n(i, "issuedAt"),
            expires_at: n(i, "expiresAt"),
        }),
        "hello" => tunnel_hello_v2(&TunnelHelloV2 {
            server_id: s(i, "serverId"),
            root_entitlement_cert_id: s(i, "rootEntitlementCertId"),
            service_entitlement_cert_id: s(i, "serviceEntitlementCertId"),
            nonce_hex: s(i, "nonceHex"),
            issued_at: n(i, "issuedAt"),
        }),
        "revocation" => entitlement_revocation_list(&EntitlementRevocationList {
            username: s(i, "username"),
            cert_ids: strings(&i["certIds"]),
            issued_at: n(i, "issuedAt"),
        }),
        "grant" => service_grant(&grant_of(i)),
        other => panic!("unknown kind {other}"),
    }
}

#[test]
fn every_shared_vector_gets_the_typescript_canonical_bytes_cert_id_and_verdict() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 18);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let kind = c["kind"].as_str().unwrap();
        let got = canonical_of(kind, &c["input"]);
        match c["canonical"].as_str() {
            None => assert!(
                got.is_err(),
                "{name}: the TypeScript encoder refuses this, so must Rust"
            ),
            Some(want) => {
                let got = got.unwrap_or_else(|e| panic!("{name}: {e:?}"));
                assert_eq!(got, want, "{name}");
                if let Some(id) = c.get("certId").and_then(Value::as_str) {
                    assert_eq!(cert_id(&got), id, "{name}: cert id");
                }
                if let (Some(pk), Some(sig), Some(expect)) = (
                    c["signerPubHex"].as_str(),
                    c["signatureHex"].as_str(),
                    c["verifies"].as_bool(),
                ) {
                    assert_eq!(verify(&got, sig, pk), expect, "{name}: verdict");
                }
            }
        }
    }
}

#[test]
fn grant_windows_and_pod_authorisation_follow_the_typescript() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let w = &v["grantWindow"];
    let g = grant_of(&w["grant"]);
    for c in w["checks"].as_array().unwrap() {
        assert_eq!(
            grant_active_at(g.issued_at, g.expires_at, n(c, "at")),
            c["active"].as_bool().unwrap(),
            "{c}"
        );
    }
    for p in w["pods"].as_array().unwrap() {
        assert_eq!(
            grant_authorizes_pod(&g, p["podPubKeyHex"].as_str().unwrap()),
            p["authorized"].as_bool().unwrap(),
            "{p}"
        );
    }
}

#[test]
fn malformed_keys_and_signatures_are_simply_not_verified() {
    let canon = "flagship/root-entitlement/v1|a|b|c|1";
    for (sig, pk) in [
        ("", ""),
        ("zz", "00"),
        (&"0".repeat(128), &"0".repeat(64)),
        (&"0".repeat(128), "short"),
    ] {
        assert!(!verify(canon, sig, pk));
    }
}

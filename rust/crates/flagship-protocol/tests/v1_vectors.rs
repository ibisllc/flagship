//! Rebuilds v1 canonical bytes from the shared fixtures' structured inputs
//! with the Rust builder and requires byte equality with the bytes the
//! TypeScript encoders signed. Ed25519 checks of the same bytes live in
//! `flagship-crypto`'s tests.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use flagship_protocol::CanonicalV1;
use flagship_protocol::parse::{encode_lower_hex, parse_lower_hex, purpose_tag_of};
use serde_json::Value;
use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn load(rel: &str) -> Value {
    let p = repo_root().join(rel);
    serde_json::from_str(&std::fs::read_to_string(&p).expect("vector file")).expect("json")
}

#[derive(Clone, Copy)]
enum K {
    S(&'static str),
    U(&'static str),
    Hex(&'static str),
    Bool(&'static str),
    Num(&'static str),
    List(&'static str),
    Sorted(&'static str),
    NullableS(&'static str),
    NullableU(&'static str),
    NullableHex(&'static str),
    Prefixed(&'static str, &'static str),
    IntOr(&'static str, i64),
}

fn build(tag: &str, spec: &[K], input: &Value) -> String {
    let mut c = CanonicalV1::new(tag).unwrap();
    let get = |k: &str| input.get(k).unwrap_or(&Value::Null);
    for f in spec {
        c = match *f {
            K::S(k) => c.text(get(k).as_str().unwrap()).unwrap(),
            K::U(k) => c.uint(get(k).as_u64().unwrap()).unwrap(),
            K::Hex(k) => {
                let s = get(k).as_str().unwrap();
                c.hex(&parse_lower_hex(s, 0, 4096).unwrap())
            }
            K::Bool(k) => c.flag01(get(k).as_bool().unwrap()),
            K::Num(k) => c.js_number(get(k).as_f64().unwrap()).unwrap(),
            K::List(k) | K::Sorted(k) => {
                let items: Vec<&str> = get(k)
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap())
                    .collect();
                c.list(&items, matches!(f, K::Sorted(_))).unwrap()
            }
            K::NullableS(k) => c.text(get(k).as_str().unwrap_or("")).unwrap(),
            K::NullableU(k) => match get(k).as_u64() {
                Some(v) => c.uint(v).unwrap(),
                None => c.text("").unwrap(),
            },
            K::NullableHex(k) => match get(k).as_str() {
                Some(s) => c.hex(&parse_lower_hex(s, 0, 4096).unwrap()),
                None => c.text("").unwrap(),
            },
            K::Prefixed(prefix, k) => match get(k).as_str() {
                Some(s) => c.text(&format!("{prefix}{s}")).unwrap(),
                None => c,
            },
            K::IntOr(k, default) => c.int(get(k).as_i64().unwrap_or(default)).unwrap(),
        };
    }
    c.finish_string()
}

fn spec_for(name: &str) -> Option<(&'static str, Vec<K>)> {
    use K::*;
    let s = match name {
        "rebuild" => (
            "flagship/rebuild/v1",
            vec![
                S("userId"),
                S("newServerId"),
                S("wifiSsid"),
                Hex("wifiPskHash"),
                Num("shareRatio"),
                U("issuedAt"),
            ],
        ),
        "revoke" => (
            "flagship/revoke/v1",
            vec![
                S("userId"),
                S("revokedServerId"),
                S("reason"),
                U("issuedAt"),
            ],
        ),
        "membership" => (
            "flagship/membership/v1",
            vec![
                S("serviceId"),
                Hex("targetIrkPub"),
                NullableS("role"),
                U("issuedAt"),
            ],
        ),
        "migration" => (
            "flagship/migration/v1",
            vec![
                S("serviceId"),
                S("fromUser"),
                S("toUser"),
                S("mode"),
                Bool("withData"),
                U("issuedAt"),
            ],
        ),
        "invite" => (
            "flagship/invite/v1",
            vec![
                S("serviceId"),
                S("role"),
                Hex("nonce"),
                U("issuedAt"),
                U("expiresAt"),
            ],
        ),
        "invite-acceptance" => (
            "flagship/invite-accept/v1",
            vec![Hex("inviteNonce"), Hex("accepterIrkPub"), U("acceptedAt")],
        ),
        "tunnel-hello" => (
            "flagship/tunnel-hello/v1",
            vec![
                S("serverId"),
                Sorted("subdomains"),
                Hex("nonce"),
                U("issuedAt"),
            ],
        ),
        "register-server" => (
            "flagship/register-server/v1",
            vec![S("userId"), S("serverId"), Hex("stkPub"), U("issuedAt")],
        ),
        "account-recovery" => (
            "flagship/account-recovery/v1",
            vec![
                S("userId"),
                Hex("newPushTokenHash"),
                S("platform"),
                U("issuedAt"),
            ],
        ),
        "pb-announce" => (
            "pb/announce/v1",
            vec![
                S("serverId"),
                U("pledgedBytes"),
                Num("shareRatio"),
                U("maxShardSize"),
                S("region"),
                S("tunnelEndpoint"),
                U("issuedAt"),
            ],
        ),
        "pb-request-peers" => (
            "pb/request-peers/v1",
            vec![
                S("requesterServerId"),
                U("n"),
                U("shardSizeBytes"),
                S("durabilityHint"),
                U("issuedAt"),
            ],
        ),
        "pb-peer-confirm" => (
            "pb/peer-confirm/v1",
            vec![
                S("peerServerId"),
                S("requesterServerId"),
                S("shardId"),
                U("issuedAt"),
            ],
        ),
        "auth-code" => (
            "flagship/auth-code/v1",
            vec![
                U("version"),
                S("serial"),
                S("username"),
                S("serverName"),
                S("serverDomain"),
                Hex("delegatedPubKey"),
                Hex("userPubKey"),
                U("issuedAt"),
                U("expiresAt"),
            ],
        ),
        "install-blob" => (
            "flagship/install-blob/v1",
            vec![
                U("version"),
                S("serverDomain"),
                S("username"),
                S("serverName"),
                Hex("phoneDelegatedPubKey"),
                S("registrationUrl"),
                S("authCodeSerial"),
                Hex("authCodeUserPubKey"),
                Hex("authCodeUserSignature"),
                S("installerGitRef"),
                Hex("rckPubKey"),
                S("bootUnlockMode"),
                Prefixed("de=", "diskEncryption"),
            ],
        ),
        "server-register" => (
            "flagship/server-register/v1",
            vec![
                S("authCodeSerial"),
                S("authCodeServerDomain"),
                Hex("serverIdentityPubKey"),
                U("issuedAt"),
                Hex("nonce"),
            ],
        ),
        "rck-set-target" => (
            "flagship/rck-set-target/v1",
            vec![
                S("subdomain"),
                Hex("newTargetIdentityPubKey"),
                U("issuedAt"),
                Hex("nonce"),
            ],
        ),
        "order-set-front-page" => (
            "flagship/order/set-front-page/v1",
            vec![S("serverId"), S("label"), U("issuedAt")],
        ),
        "order-power-off-off" | "order-power-off-restart" => (
            "flagship/order/power-off/v1",
            vec![S("serverId"), S("mode"), U("issuedAt")],
        ),
        "journal-read" => (
            "flagship/journal-read/v1",
            vec![S("serverId"), S("unit"), U("lines"), U("issuedAt")],
        ),
        "watch-delegate-key" => (
            "flagship/watch-delegate-key/v1",
            vec![
                S("grantId"),
                S("username"),
                Hex("delegatePubKey"),
                List("scopes"),
                U("issuedAt"),
                U("expiresAt"),
            ],
        ),
        "device-capability-grant" => (
            "flagship/device-capability-grant/v2",
            vec![
                S("grantId"),
                S("username"),
                S("deviceId"),
                Hex("devicePubKey"),
                Sorted("scopes"),
                U("issuedAt"),
                U("expiresAt"),
            ],
        ),
        "revoke-device-capability-grant" => (
            "flagship/revoke-device-capability-grant/v1",
            vec![S("grantId"), S("username"), S("reason"), U("issuedAt")],
        ),
        "push-token-revoke" => (
            "flagship/push-token-revoke/v1",
            vec![S("tokenId"), U("issuedAt")],
        ),
        "re-pair-initiate" => (
            "flagship/re-pair-initiate/v1",
            vec![
                S("username"),
                Hex("newIrkPub"),
                Hex("oldIrkPub"),
                U("issuedAt"),
            ],
        ),
        "re-pair-object" => (
            "flagship/re-pair-object/v1",
            vec![S("username"), Hex("newIrkPub"), U("issuedAt")],
        ),
        "daemon-status" | "daemon-status-liveness" => (
            "flagship/daemon-status/v1",
            vec![
                S("serverDomain"),
                NullableHex("certSha256"),
                NullableU("certValidUntil"),
                NullableS("certIssuer"),
                Sorted("appsServed"),
                Hex("nonce"),
                U("issuedAt"),
            ],
        ),
        "admin-root-rotation" => (
            "flagship/admin-root-rotation/v1",
            vec![
                S("username"),
                Hex("oldAdminRootPub"),
                Hex("newAdminRootPub"),
                U("issuedAt"),
            ],
        ),
        "server-transfer-claim" => (
            "flagship/server-transfer-claim/v2",
            vec![
                S("serverDomain"),
                Hex("transferNonce"),
                S("acquirerUsername"),
                Hex("acquirerIrkPub"),
                Hex("acquirerAdminRootPubHex"),
                U("issuedAt"),
            ],
        ),
        "admin-root-transfer" => (
            "flagship/admin-root-transfer/v1",
            vec![
                S("serverDomain"),
                S("giverUsername"),
                S("acquirerUsername"),
                Hex("oldAdminRootPubHex"),
                Hex("newAdminRootPubHex"),
                Hex("transferNonce"),
                U("issuedAt"),
            ],
        ),
        "uninstall-service" => (
            "flagship/uninstall-service/v1",
            vec![S("serverId"), S("creator"), S("slug"), U("issuedAt")],
        ),
        "auto-unlock-lease-v2" => (
            "flagship/auto-unlock-lease/v2",
            vec![
                S("serverDomain"),
                Hex("stkPub"),
                S("leaseId"),
                Hex("sealedKey"),
                U("issuedAt"),
                U("expiresAt"),
                IntOr("maxUses", -1),
            ],
        ),
        "auto-unlock-lease-revoke" => (
            "flagship/auto-unlock-lease-revoke/v1",
            vec![S("serverDomain"), S("leaseId"), U("issuedAt")],
        ),
        _ => return None,
    };
    Some(s)
}

#[test]
fn canonical_bytes_fixture_every_vector() {
    let file = load("test-vectors/canonical-bytes.json");
    let vectors = file["vectors"].as_array().unwrap();
    assert!(vectors.len() >= 34);
    for v in vectors {
        let name = v["name"].as_str().unwrap();
        let (tag, spec) =
            spec_for(name).unwrap_or_else(|| panic!("no Rust spec for vector {name}"));
        let got = build(tag, &spec, &v["input"]);
        let want = v["canonicalHex"].as_str().unwrap();
        assert_eq!(
            encode_lower_hex(got.as_bytes()),
            want,
            "vector {name}: {got}"
        );
        assert_eq!(purpose_tag_of(&got).unwrap(), tag);
    }
}

fn check_cases(
    rel: &str,
    cases: &[Value],
    tag: &str,
    spec: &[K],
    input_of: impl Fn(&Value) -> &Value,
) {
    assert!(!cases.is_empty(), "{rel}");
    for c in cases {
        let got = build(tag, spec, input_of(c));
        assert_eq!(got, c["canonical"].as_str().unwrap(), "{rel}");
    }
}

#[test]
fn per_envelope_fixtures() {
    use K::*;
    let f = load("packages/protocol/test-vectors/app-api-key/vectors.json");
    check_cases(
        "app-api-key",
        f["cases"].as_array().unwrap(),
        "flagship/app-api-key/v1",
        &[
            S("serverDomain"),
            S("serviceId"),
            S("keyId"),
            S("scope"),
            U("expiresAt"),
            U("issuedAt"),
        ],
        |c| c,
    );
    let f = load("packages/protocol/test-vectors/llm-promo-issue/vectors.json");
    check_cases(
        "llm-promo-issue",
        f["cases"].as_array().unwrap(),
        "flagship/llm-promo-issue/v1",
        &[
            S("username"),
            S("serverFqdn"),
            S("provider"),
            U("desiredDailyInputTokenCap"),
            U("desiredDailyOutputTokenCap"),
            U("issuedAt"),
        ],
        |c| c,
    );
    let f = load("packages/protocol/test-vectors/backup-policy/vectors.json");
    check_cases(
        "backup-policy",
        f["cases"].as_array().unwrap(),
        "flagship/backup-policy/v1",
        &[
            S("serverDomain"),
            S("policy"),
            U("phoneReserveBytes"),
            U("issuedAt"),
        ],
        |c| c,
    );
    let f = load("packages/protocol/test-vectors/service-env-change/vectors.json");
    check_cases(
        "service-env-change",
        f["cases"].as_array().unwrap(),
        "flagship/service-env-change/v1",
        &[
            S("serverId"),
            S("serviceId"),
            S("op"),
            S("name"),
            S("valueSha256"),
            U("issuedAt"),
            S("nonce"),
        ],
        |c| &c["change"],
    );
    let f = load("packages/protocol/test-vectors/server-order/vectors.json");
    let order = f["order"].clone();
    check_cases(
        "server-order",
        std::slice::from_ref(&order),
        "flagship/server-order/v1",
        &[S("user"), List("stks"), U("issuedAt"), S("nonce")],
        |c| &c["fields"],
    );
}

#[test]
fn every_typescript_purpose_tag_passes_the_grammar() {
    let dir = repo_root().join("packages/protocol/src");
    let mut seen = 0usize;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("ts") {
            continue;
        }
        let src = std::fs::read_to_string(&path).unwrap();
        for (i, _) in src.match_indices("\"flagship/") {
            let rest = &src[i + 1..];
            let Some(end) = rest.find('"') else { continue };
            let tag = &rest[..end];
            if tag.contains(['|', '$', '`', ' ']) || !tag.contains("/v") {
                continue;
            }
            if purpose_tag_of(tag).is_ok() {
                seen += 1;
            } else if tag
                .rsplit('/')
                .next()
                .is_some_and(|v| v.starts_with('v') && v[1..].bytes().all(|b| b.is_ascii_digit()))
            {
                panic!(
                    "TypeScript tag {tag} in {} fails the grammar",
                    path.display()
                );
            }
        }
    }
    assert!(seen > 100, "only {seen} tags found");
}

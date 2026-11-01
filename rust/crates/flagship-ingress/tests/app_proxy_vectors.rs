//! The proxy's HTTP rules against the vectors the TS proxy runs too
//! (packages/server-daemon/tests/appProxyVectors.test.ts).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::BTreeMap;

use flagship_ingress::http::{
    Injection, RequestBody, RequestHead, Version, forward_request_headers, parse_request_head,
    request_body,
};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/server-daemon/test-vectors/app-proxy.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn latin1(s: &str) -> Vec<u8> {
    s.chars()
        .map(|c| u8::try_from(u32::from(c)).unwrap())
        .collect()
}

fn map(v: &Value) -> Vec<(String, String)> {
    v.as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
        .collect()
}

fn as_map(h: &[(String, String)]) -> BTreeMap<String, String> {
    h.iter().cloned().collect()
}

fn head_with(headers: &Value) -> RequestHead {
    RequestHead {
        method: "POST".into(),
        target: "/".into(),
        version: Version::Http11,
        headers: map(headers),
    }
}

#[test]
fn heads() {
    let v = vectors();
    for c in v["heads"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let got = parse_request_head(&latin1(c["raw"].as_str().unwrap()));
        if c["expect"].is_null() {
            assert!(got.is_err(), "{name}: parsed {got:?}");
            continue;
        }
        let p = got.unwrap_or_else(|_| panic!("{name}: not parsed"));
        let e = &c["expect"];
        assert_eq!(p.method, e["method"].as_str().unwrap(), "{name}");
        assert_eq!(p.target, e["target"].as_str().unwrap(), "{name}");
        assert_eq!(p.version.as_str(), e["version"].as_str().unwrap(), "{name}");
        assert_eq!(as_map(&p.headers), as_map(&map(&e["headers"])), "{name}");
    }
}

#[test]
fn bodies_and_upgrades() {
    let v = vectors();
    for c in v["bodies"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let got = request_body(&head_with(&c["headers"]));
        match &c["expect"] {
            Value::Number(n) => assert_eq!(
                got.map_err(|r| u64::from(r.status)),
                Err(n.as_u64().unwrap()),
                "{name}"
            ),
            Value::String(s) => {
                let kind = match got.unwrap_or_else(|r| panic!("{name}: refused {r:?}")) {
                    RequestBody::None => "none",
                    RequestBody::Length(_) => "length",
                    RequestBody::Chunked => "chunked",
                };
                assert_eq!(kind, s, "{name}");
            }
            other => panic!("{name}: {other}"),
        }
    }
    for c in v["upgrades"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        assert_eq!(
            head_with(&c["headers"]).is_websocket_upgrade(),
            c["expect"].as_bool().unwrap(),
            "{name}"
        );
    }
}

#[test]
fn forwarded_headers() {
    let v = vectors();
    for c in v["forward"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let inj = Injection {
            set: map(&c["set"]),
            remove: c["remove"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap().to_owned())
                .collect(),
        };
        inj.validate().unwrap();
        let body = match &c["body"] {
            Value::String(s) if s == "none" => RequestBody::None,
            Value::String(s) if s == "chunked" => RequestBody::Chunked,
            Value::Object(o) => RequestBody::Length(o["length"].as_u64().unwrap()),
            other => panic!("{name}: {other}"),
        };
        let out = forward_request_headers(
            &map(&c["headers"]),
            &inj,
            c["upgrade"].as_bool().unwrap(),
            body,
        );
        assert_eq!(as_map(&out), as_map(&map(&c["expect"])), "{name}");
    }
}

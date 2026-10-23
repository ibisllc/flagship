//! packages/protocol/test-vectors/boot-unseal (tools/boot-unseal-vectors.mjs):
//! the same cases the TS protocol, the boot-core gate and the Go helper pass.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use flagship_boot::canonical::{self, RequestRefusal};
use flagship_boot::compat;
use flagship_boot::gohex;
use flagship_boot::identity::BoxIdentity;
use flagship_boot::seal;
use serde_json::Value;
use std::collections::HashSet;

const VECTORS: &str =
    include_str!("../../../../packages/protocol/test-vectors/boot-unseal/vectors.json");

fn v() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("missing {k}"))
}

fn seed(hex: &str) -> [u8; 32] {
    gohex::decode(hex.as_bytes()).unwrap().try_into().unwrap()
}

fn cli(args: &[&str]) -> (i32, Vec<u8>, String) {
    let args: Vec<Vec<u8>> = args.iter().map(|a| a.as_bytes().to_vec()).collect();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = compat::run(&args, &mut std::io::empty(), &mut out, &mut err);
    (code, out, String::from_utf8(err).unwrap())
}

#[test]
fn unseal_cases_through_the_library_and_the_v1_cli() {
    let v = v();
    let cases = v["unseal"].as_array().unwrap();
    assert!(cases.len() >= 19);
    for c in cases {
        let name = s(c, "name");
        let id = s(c, "identityPrivHex");
        let sealed_hex = s(c, "sealedHex");
        let sealed = gohex::decode(sealed_hex.as_bytes()).unwrap();
        let lib = if s(c, "kind") == "raw" {
            seal::open_sealed_from_ed25519_seed(&sealed, &seed(id))
        } else {
            seal::open_sealed_secret_response(&sealed, &seed(id), s(c, "nonceHex"), s(c, "purpose"))
        };
        let mut args = vec!["--identity-priv-hex", id, "--sealed-hex", sealed_hex];
        if s(c, "kind") == "response" {
            args.extend([
                "--response",
                "--nonce-hex",
                s(c, "nonceHex"),
                "--purpose",
                s(c, "purpose"),
            ]);
        }
        let (code, out, err) = cli(&args);
        let e = &c["expect"];
        if e["ok"].as_bool().unwrap() {
            assert_eq!(gohex::encode(&lib.unwrap()), s(e, "secretHex"), "{name}");
            assert_eq!(
                (code, String::from_utf8(out).unwrap(), err),
                (0, format!("{}\n", s(e, "secretHex")), String::new()),
                "{name}"
            );
        } else {
            assert_eq!(lib.unwrap_err().to_string(), s(e, "error"), "{name}");
            assert_eq!(
                (code, out, err),
                (
                    1,
                    Vec::new(),
                    format!("flagship-unseal: {}\n", s(e, "error"))
                ),
                "{name}"
            );
        }
    }
}

#[test]
fn box_keys_and_x25519_targets() {
    let v = v();
    for b in ["A", "B"] {
        let box_ = &v["boxes"][b];
        let sd = seed(s(box_, "seedHex"));
        assert_eq!(BoxIdentity::from_seed(&sd).pub_hex(), s(box_, "pubHex"));
        assert_eq!(
            gohex::encode(&seal::x25519_public_from_ed25519_seed(&sd).unwrap()),
            s(box_, "x25519PubHex")
        );
    }
}

#[test]
fn the_secret_request_body_is_byte_identical() {
    let v = v();
    let r = &v["secretRequest"];
    let id = BoxIdentity::from_seed(&seed(s(&v["boxes"]["A"], "seedHex")));
    let issued = r["issuedAt"].as_u64().unwrap();
    let canon = canonical::canonical_secret_request(
        s(r, "serverDomain"),
        id.pub_hex(),
        s(r, "purpose"),
        s(r, "nonceHex"),
        issued,
    )
    .unwrap();
    assert_eq!(canon, s(r, "canonical"));
    assert_eq!(
        gohex::encode(&id.sign(canon.as_bytes())),
        s(r, "signatureHex")
    );
    let body = canonical::secret_request_body(
        &id,
        s(r, "serverDomain"),
        s(r, "purpose"),
        s(r, "nonceHex"),
        issued,
    )
    .unwrap();
    assert_eq!(body, s(r, "body"));
    assert!(canonical::verify_secret_request(
        s(r, "serverDomain"),
        s(r, "stkPubHex"),
        s(r, "purpose"),
        s(r, "nonceHex"),
        issued,
        s(r, "signatureHex")
    ));
    assert!(!canonical::verify_secret_request(
        s(r, "serverDomain"),
        s(r, "stkPubHex"),
        s(r, "purpose"),
        s(r, "nonceHex"),
        issued,
        s(r, "signatureByBoxBHex")
    ));
}

#[test]
fn box_auth_headers_are_byte_identical() {
    let v = v();
    let id = BoxIdentity::from_seed(&seed(s(&v["boxes"]["A"], "seedHex")));
    for name in ["leaseGet", "requestPost", "responsePoll"] {
        let h = &v["bootAuth"][name];
        let issued = h["issuedAt"].as_u64().unwrap();
        let canon = canonical::canonical_boot_auth(
            "box",
            s(h, "serverDomain"),
            s(h, "method"),
            s(h, "path"),
            id.pub_hex(),
            s(h, "nonceHex"),
            issued,
        );
        assert_eq!(canon, s(h, "canonical"), "{name}");
        let header = canonical::box_auth_header(
            &id,
            s(h, "serverDomain"),
            s(h, "method"),
            s(h, "path"),
            s(h, "nonceHex"),
            issued,
        )
        .unwrap();
        assert_eq!(header, s(h, "authorization"), "{name}");
    }
}

#[test]
fn gate_cases_through_the_oracle() {
    let v = v();
    for c in v["gateCases"].as_array().unwrap() {
        let name = s(c, "name");
        let header = s(&v["headers"], s(c, "header"));
        let route = &c["route"];
        let domain = s(route, "serverDomain");
        let stk = if domain == s(&v["boxes"]["A"], "serverDomain") {
            s(&v["boxes"]["A"], "pubHex")
        } else {
            s(&v["boxes"]["B"], "pubHex")
        };
        let now = c["now"].as_u64().unwrap();
        let mut seen = HashSet::new();
        let mut check = || {
            canonical::verify_box_auth(
                header,
                stk,
                domain,
                s(route, "method"),
                s(route, "path"),
                now,
            )
            .map_err(|e| match e {
                RequestRefusal::Stale => "stale request".to_owned(),
                RequestRefusal::BadSignature => "invalid signature".to_owned(),
                RequestRefusal::WrongKey => "box STK not bound to this server".to_owned(),
                RequestRefusal::Binding(b) => b.to_owned(),
                RequestRefusal::Malformed => "malformed authorization".to_owned(),
            })
            .and_then(|env| {
                if seen.insert(env.nonce_hex) {
                    Ok(())
                } else {
                    Err("replayed nonce".to_owned())
                }
            })
        };
        let mut got = check();
        if c["replay"].as_bool() == Some(true) {
            assert!(got.is_ok(), "{name}");
            got = check();
        }
        let e = &c["expect"];
        if e["ok"].as_bool().unwrap() {
            assert!(got.is_ok(), "{name}: {got:?}");
        } else {
            assert_eq!(got.unwrap_err(), s(e, "error"), "{name}");
        }
    }
}

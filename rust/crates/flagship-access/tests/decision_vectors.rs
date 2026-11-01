//! The shared access-decision contract (packages/protocol/test-vectors/access-enforcement/decisions.json),
//! also run through the TypeScript proxy by packages/server-daemon/tests/accessEnforcementVectors.test.ts.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use flagship_access::decide::{AppFacts, RequestFacts, SessionFact, decide};
use flagship_access::server::{
    Context, api_key_from, decision_json, handle_decide, principals_from,
};
use flagship_access::state::AccessState;
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/test-vectors/access-enforcement/decisions.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn expected(c: &Value) -> Value {
    let e = &c["expect"];
    if e["outcome"] == "forward" {
        json!({
            "outcome": "forward",
            "visitor": e["visitor"],
            "role": e["role"],
            "identity": e["identity"],
            "external": e.get("external").cloned().unwrap_or(Value::Bool(false)),
        })
    } else {
        e.clone()
    }
}

#[test]
fn every_case_gets_the_contracted_decision() {
    let v = vectors();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 90);
    let mut failures = Vec::new();
    for c in cases {
        let f = &v["fixtures"][c["fixture"].as_str().unwrap()];
        let state = AccessState::parse(f["stateText"].as_str());
        let principals = principals_from(f);
        let app = &c["app"];
        let r = &c["request"];
        let service_ref = app["serviceRef"].as_str().unwrap().to_owned();
        let facts = AppFacts {
            service_ref: service_ref.clone(),
            routed_host: app["host"].as_str().unwrap().to_owned(),
            public_routes: app["publicRoutes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap().to_owned())
                .collect(),
            default_role: app["defaultRole"].as_str().unwrap().to_owned(),
        };
        let mut headers: BTreeMap<String, String> = r["headers"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, x)| (k.clone(), x.as_str().unwrap().to_owned()))
            .collect();
        headers.insert(
            "host".into(),
            r.get("host")
                .and_then(Value::as_str)
                .unwrap_or(&facts.routed_host)
                .to_owned(),
        );
        let catching = c
            .get("catchingUp")
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|x| x.as_str() == Some(&service_ref)));
        let req = RequestFacts {
            method: r["method"].as_str().unwrap().to_owned(),
            path: r["path"].as_str().unwrap().to_owned(),
            upgrade: r["upgrade"].as_bool().unwrap(),
            headers,
            session: r["session"].as_object().map(|s| SessionFact {
                service_ref: s["serviceRef"].as_str().unwrap().to_owned(),
                aid: s["aid"].as_str().unwrap().to_owned(),
                live: s["live"].as_bool().unwrap(),
            }),
            api_key: api_key_from(Some(&r["apiKey"])),
            external_fresh: r["externalFresh"].as_bool().unwrap(),
            catching_up: catching,
        };
        let got = decision_json(&decide(&state, &principals, &facts, &req));
        if got != expected(c) {
            failures.push(format!("{}: got {got}, want {}", c["name"], expected(c)));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn the_socket_handler_reads_the_state_and_sessions_itself() {
    let dir = std::env::temp_dir().join(format!("flagship-access-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let friend = "f1".repeat(32);
    std::fs::write(
        dir.join("state.json"),
        json!({ "alice--club": { "mode": "restricted", "allow": [friend], "groups": {} } })
            .to_string(),
    )
    .unwrap();
    std::fs::write(
        dir.join("sessions.json"),
        json!({ "good": { "serviceRef": "alice--club", "aid": friend, "expiresAt": 9.0e15 }, "upper": { "serviceRef": "alice--club", "aid": friend.to_uppercase(), "expiresAt": 9.0e15 }, "old": { "serviceRef": "alice--club", "aid": friend, "expiresAt": 1 } }).to_string(),
    )
    .unwrap();
    let ctx = Context {
        state_path: dir.join("state.json"),
        sessions_path: dir.join("sessions.json"),
    };
    let ask = |token: &str| {
        handle_decide(&ctx, &json!({ "serviceRef": "alice--club", "routedHost": "club.h.alice.flagship.services", "publicRoutes": [], "defaultRole": "member", "method": "GET", "path": "/", "sessionToken": token, "principals": [] })).unwrap()
    };
    assert_eq!(ask("good")["role"], "member");
    assert_eq!(ask("old")["outcome"], "deny");
    // The socket path reads the session file itself and must not normalise what decide refuses.
    assert_eq!(ask("upper")["outcome"], "deny");
    assert_eq!(ask("forged")["outcome"], "deny");
    // A caller that claims a mode or an allow-list grants nothing: only the file counts.
    let forged = handle_decide(&ctx, &json!({ "serviceRef": "alice--club", "routedHost": "club.h.alice.flagship.services", "mode": "open", "allow": ["e1"], "method": "GET", "path": "/" })).unwrap();
    assert_eq!(forged["outcome"], "deny");
    std::fs::write(dir.join("state.json"), "{ torn").unwrap();
    assert_eq!(ask("good")["outcome"], "deny");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_socket_speaks_privd_framing_and_wants_hello_first() {
    use flagship_access::server::serve_connection;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    let dir = std::env::temp_dir().join(format!("flagship-access-sock-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let ctx = Context {
        state_path: dir.join("absent.json"),
        sessions_path: dir.join("absent-sessions.json"),
    };
    let (mut client, server) = UnixStream::pair().unwrap();
    let t = std::thread::spawn(move || serve_connection(&ctx, server));
    let send = |s: &mut UnixStream, v: Value| {
        let b = v.to_string();
        s.write_all(&u32::try_from(b.len()).unwrap().to_be_bytes())
            .unwrap();
        s.write_all(b.as_bytes()).unwrap();
        let mut h = [0u8; 4];
        s.read_exact(&mut h).unwrap();
        let mut buf = vec![0u8; u32::from_be_bytes(h) as usize];
        s.read_exact(&mut buf).unwrap();
        serde_json::from_slice::<Value>(&buf).unwrap()
    };
    let decide = json!({ "id": 2, "op": "decide", "args": { "serviceRef": "alice--x", "routedHost": "x.h.alice.flagship.services", "method": "GET", "path": "/" } });
    assert_eq!(send(&mut client, decide.clone())["code"], "hello-first");
    assert_eq!(
        send(
            &mut client,
            json!({ "id": 1, "op": "hello", "args": { "version": 1 } })
        )["ok"],
        true
    );
    let r = send(&mut client, decide);
    assert_eq!(r["result"]["visitor"], "anonymous");
    assert_eq!(
        send(&mut client, json!({ "id": 3, "op": "grant", "args": {} }))["code"],
        "unknown-op"
    );
    drop(client);
    t.join().unwrap().unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
}

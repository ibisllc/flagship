//! The serving gate (`serving-wiring.md` §2, the TS `servingGate.ts`): decisions from `.com`'s record and the HELLO, the
//! lease timer, pushed revocations, the lost-contact rule; and the allocator/registry half (apps stopped, control names,
//! the bare account name). The same behaviour over sockets against both relays: `tools/relay-conformance`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use ed25519_dalek::{Signer, SigningKey};
use flagship_crypto::serving::{
    Grace, OnLapse, RevocationApply, RevocationEntry, RevocationKind, RevocationState,
    ServingLease, ServingPolicy, apply_revocation_entries, lease_canonical, policy_canonical,
    revocation_canonical,
};
use flagship_relay::allocator::{Allocator, TransferError};
use flagship_relay::authority::BoxFut;
use flagship_relay::com::HttpGet;
use flagship_relay::registry::{Registry, ServingView};
use flagship_relay::serving::{
    ComServingFetch, ComServingRecord, Contact, GateConfig, GateDecision, ServingFetch,
    ServingFetched, ServingGate, ServingHandle, ServingHello, parse_com_serving_record,
};
use serde_json::{Value, json};

const APEX: &str = "flagship.services";

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn pubhex(k: &SigningKey) -> String {
    hex(k.verifying_key().as_bytes())
}

fn sign(k: &SigningKey, canonical: &str) -> String {
    hex(&k.sign(canonical.as_bytes()).to_bytes())
}

fn now() -> u64 {
    flagship_relay::hub::now_ms() as u64
}

struct Fake {
    rec: Mutex<Option<ServingFetched>>,
}

impl ServingFetch for Fake {
    fn record<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFut<'a, Option<ServingFetched>> {
        let r = self.rec.lock().unwrap().clone();
        Box::pin(async move { r })
    }
    fn admin_key<'a>(&'a self, _: &'a str) -> BoxFut<'a, Option<String>> {
        Box::pin(async { None })
    }
}

#[derive(Default)]
struct Calls(Mutex<Vec<String>>);

impl ServingHandle for Calls {
    fn close_tunnel(&self, code: u16, reason: &str) {
        self.0
            .lock()
            .unwrap()
            .push(format!("close {code} {reason}"));
    }
    fn close_app_streams(&self) {
        self.0.lock().unwrap().push("close-apps".into());
    }
    fn on_apps_changed(&self, apps: bool) {
        self.0.lock().unwrap().push(format!("apps {apps}"));
    }
}

fn gate(rec: Option<ComServingRecord>, cfg: GateConfig) -> ServingGate {
    gate_on(
        Arc::new(Fake {
            rec: Mutex::new(rec.map(ServingFetched::Record)),
        }),
        cfg,
    )
}

fn gate_on(fake: Arc<Fake>, cfg: GateConfig) -> ServingGate {
    ServingGate::new(fake, cfg, Box::new(|_| {}))
}

fn hello(admin: Option<&SigningKey>, boxk: &SigningKey) -> ServingHello {
    ServingHello {
        username: "alice".into(),
        box_pub: pubhex(boxk),
        pod_canonical: format!("home.alice.{APEX}"),
        admin_key: admin.map(pubhex),
        policy: None,
        leases: Vec::new(),
    }
}

fn policy(admin: &SigningKey, boxk: &SigningKey, grace: Grace) -> (ServingPolicy, String) {
    let p = ServingPolicy {
        account: "alice".into(),
        box_pub: pubhex(boxk),
        reg_gen: 1,
        policy_gen: 1,
        grace,
        on_lapse: OnLapse::StopApps,
        scope_sha256: "ab".repeat(32),
        issued_at: 1_000,
    };
    let sig = sign(admin, &policy_canonical(&p).unwrap());
    (p, sig)
}

fn record(admin: &SigningKey) -> ComServingRecord {
    ComServingRecord {
        admin_key: Some(pubhex(admin)),
        reg_gen: 1,
        revoked: false,
        policy: None,
        leases: Vec::new(),
        mesh: None,
    }
}

#[tokio::test]
async fn decisions_follow_the_keys() {
    let admin = key(1);
    let boxk = key(2);
    let g = gate(Some(record(&admin)), GateConfig::default());
    let calls = Arc::new(Calls::default());
    let b = g.attach(hello(Some(&admin), &boxk), calls.clone()).await;
    assert_eq!(b.decision(), GateDecision::Serve { until: None });
    b.detach();

    let b = g.attach(hello(None, &boxk), calls.clone()).await;
    assert_eq!(
        b.decision(),
        GateDecision::Deny {
            control: true,
            reason: "admin-keys-differ".into()
        }
    );
    b.detach();

    let b = g.attach(hello(Some(&key(9)), &boxk), calls.clone()).await;
    assert!(!b.decision().control());
    assert_eq!(b.decision().reason(), "admin-keys-differ");
    // The first decision acts by the caller's refusal, not a close.
    assert!(calls.0.lock().unwrap().is_empty());

    let unknown = gate(None, GateConfig::default());
    let b = unknown
        .attach(hello(Some(&admin), &boxk), calls.clone())
        .await;
    assert_eq!(b.decision().reason(), "unavailable");
    assert!(b.decision().control() && !b.decision().apps());
    assert_eq!(unknown.stats().apps_stopped, 1);
}

#[tokio::test]
async fn a_lease_end_stops_the_apps_and_keeps_the_tunnel() {
    let admin = key(1);
    let boxk = key(2);
    let (p, psig) = policy(&admin, &boxk, Grace::SevenDays);
    let t = now();
    let l = ServingLease {
        account: "alice".into(),
        box_pub: pubhex(&boxk),
        reg_gen: 1,
        policy_gen: 1,
        lease_id: "0".repeat(31) + "1",
        issued_at: t,
        not_after: t + 300,
    };
    let lsig = sign(&admin, &lease_canonical(&l).unwrap());
    let body = json!({
        "adminKey": pubhex(&admin), "regGen": 1,
        "policy": {"record": {"account": "alice", "box": pubhex(&boxk), "regGen": 1, "policyGen": 1, "grace": "7d",
            "onLapse": "stop-apps", "scopeSha256": p.scope_sha256, "issuedAt": 1000}, "signature": psig},
        "leases": [{"lease": {"account": "alice", "box": pubhex(&boxk), "regGen": 1, "policyGen": 1, "leaseId": l.lease_id,
            "issuedAt": l.issued_at, "notAfter": l.not_after}, "signature": lsig}],
        "delegations": [],
    });
    let rec = parse_com_serving_record(&body).unwrap();
    assert_eq!(rec.leases.len(), 1);
    let g = gate(Some(rec), GateConfig::default());
    let calls = Arc::new(Calls::default());
    let b = g.attach(hello(Some(&admin), &boxk), calls.clone()).await;
    assert_eq!(
        b.decision(),
        GateDecision::Serve {
            until: Some(t + 300)
        }
    );
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(!b.decision().apps() && b.decision().control());
    assert_eq!(*calls.0.lock().unwrap(), vec!["close-apps", "apps false"]);
}

#[tokio::test]
async fn a_pushed_revocation_closes_the_box() {
    let admin = key(1);
    let boxk = key(2);
    let rk = key(3);
    let g = gate(Some(record(&admin)), GateConfig::default());
    let calls = Arc::new(Calls::default());
    let b = g.attach(hello(Some(&admin), &boxk), calls.clone()).await;
    let e = RevocationEntry {
        sequence: 1,
        kind: RevocationKind::Box,
        account: "alice".into(),
        subject: pubhex(&boxk),
        generation: 1,
        revoked_at: 5,
    };
    let sig = sign(&rk, &revocation_canonical(&e).unwrap());
    let RevocationApply::Applied { state, .. } =
        apply_revocation_entries(&RevocationState::default(), &[(e, sig)], &pubhex(&rk))
    else {
        panic!("not applied");
    };
    g.adopt_revocations(state);
    assert_eq!(*calls.0.lock().unwrap(), vec!["close 1008 revoked"]);
    assert_eq!(b.decision().reason(), "revoked");
    assert_eq!(g.stats().revoked, 1);
}

#[tokio::test]
async fn an_unknown_box_is_refused_and_an_open_tunnel_closed() {
    let admin = key(1);
    let boxk = key(2);
    let calls = Arc::new(Calls::default());
    let g = gate_on(
        Arc::new(Fake {
            rec: Mutex::new(Some(ServingFetched::UnknownBox)),
        }),
        GateConfig::default(),
    );
    for pinned in [Some(&admin), None] {
        let b = g.attach(hello(pinned, &boxk), calls.clone()).await;
        assert_eq!(
            b.decision(),
            GateDecision::Deny {
                control: false,
                reason: "unknown-box".into()
            }
        );
        b.detach();
    }
    assert!(calls.0.lock().unwrap().is_empty());

    // The name moves to another key while the old key's tunnel is open: `.com` no longer knows the old key.
    let fake = Arc::new(Fake {
        rec: Mutex::new(Some(ServingFetched::Record(record(&admin)))),
    });
    let g = gate_on(Arc::clone(&fake), GateConfig::default());
    let b = g.attach(hello(Some(&admin), &boxk), calls.clone()).await;
    assert!(b.decision().apps());
    *fake.rec.lock().unwrap() = Some(ServingFetched::UnknownBox);
    g.changed("alice", &pubhex(&boxk)).await;
    assert_eq!(*calls.0.lock().unwrap(), vec!["close 1008 unknown-box"]);
    assert_eq!(g.stats().refused_tunnels, 1);
}

#[tokio::test]
async fn a_revoked_record_is_refused_on_every_path() {
    let admin = key(1);
    let boxk = key(2);
    let calls = Arc::new(Calls::default());
    let revoked = ComServingRecord {
        revoked: true,
        ..record(&admin)
    };
    let no_admin = ComServingRecord {
        admin_key: None,
        ..revoked.clone()
    };
    for rec in [revoked, no_admin] {
        let g = gate(Some(rec), GateConfig::default());
        for pinned in [Some(&admin), None] {
            let b = g.attach(hello(pinned, &boxk), calls.clone()).await;
            assert_eq!(
                b.decision(),
                GateDecision::Deny {
                    control: false,
                    reason: "revoked".into()
                }
            );
        }
    }
}

#[tokio::test]
async fn the_revocation_log_counts_when_com_names_no_admin_key() {
    let boxk = key(2);
    let rk = key(3);
    let rec = ComServingRecord {
        admin_key: None,
        ..record(&key(1))
    };
    let g = gate(Some(rec), GateConfig::default());
    let e = RevocationEntry {
        sequence: 1,
        kind: RevocationKind::Box,
        account: "alice".into(),
        subject: pubhex(&boxk),
        generation: 1,
        revoked_at: 5,
    };
    let sig = sign(&rk, &revocation_canonical(&e).unwrap());
    let RevocationApply::Applied { state, .. } =
        apply_revocation_entries(&RevocationState::default(), &[(e, sig)], &pubhex(&rk))
    else {
        panic!("not applied");
    };
    g.adopt_revocations(state);
    let b = g
        .attach(hello(Some(&key(1)), &boxk), Arc::new(Calls::default()))
        .await;
    assert_eq!(b.decision().reason(), "revoked");
    assert!(!b.decision().control());
}

struct Answer(Mutex<Result<(u16, Value), String>>);

impl HttpGet for Answer {
    fn get_json(&self, _: &str) -> Result<(u16, Value), String> {
        self.0.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn com_fetch_tells_an_unknown_box_from_an_outage() {
    let ask = |a: Result<(u16, Value), String>| async move {
        let f = ComServingFetch::new(
            "https://com.test",
            Answer(Mutex::new(a)),
            Box::new(|_| Box::pin(async { None })),
        );
        f.record("alice", &"ab".repeat(32)).await
    };
    assert!(matches!(
        ask(Ok((
            404,
            json!({"error": "x", "code": "serving-unknown-box"})
        )))
        .await,
        Some(ServingFetched::UnknownBox)
    ));
    assert!(
        ask(Ok((404, json!({"error": "not found"}))))
            .await
            .is_none()
    );
    assert!(
        ask(Ok((503, json!({"code": "serving-unknown-box"}))))
            .await
            .is_none()
    );
    assert!(ask(Err("connection refused".into())).await.is_none());
    let Some(ServingFetched::Record(r)) = ask(Ok((
        200,
        json!({"adminKey": "cd".repeat(32), "regGen": 2, "revoked": true, "leases": []}),
    )))
    .await
    else {
        panic!("no record");
    };
    assert!(r.revoked && r.reg_gen == 2);
}

#[tokio::test]
async fn lost_contact_refuses_new_tunnels_then_closes_every_tunnel() {
    let admin = key(1);
    let boxk = key(2);
    let g = gate(
        Some(record(&admin)),
        GateConfig {
            refuse_new_after: Duration::from_millis(100),
            close_all_after: Duration::from_millis(250),
            ..GateConfig::default()
        },
    );
    let calls = Arc::new(Calls::default());
    let _b = g.attach(hello(Some(&admin), &boxk), calls.clone()).await;
    assert!(g.accepting_new_tunnels());
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(g.contact(), Contact::RefuseNew);
    g.tick();
    assert!(calls.0.lock().unwrap().is_empty());
    tokio::time::sleep(Duration::from_millis(150)).await;
    g.tick();
    g.tick();
    assert_eq!(
        *calls.0.lock().unwrap(),
        vec!["close 1013 serving-feed-lost"]
    );
    g.note_contact();
    assert!(g.accepting_new_tunnels());
}

#[test]
fn a_lease_without_a_hint_is_offered_under_each_key() {
    let body = json!({
        "adminKey": "aa".repeat(32), "regGen": 2,
        "leases": [{"record": {"account": "alice", "box": "bb".repeat(32), "regGen": 2, "policyGen": 1,
            "leaseId": "0".repeat(32), "issuedAt": 1, "notAfter": 2}, "signature": "cc".repeat(64)}],
        "delegations": [{"delegation": {"account": "alice", "alg": "p256", "renewalPub": "04", "deviceId": "dd".repeat(32),
            "issuedAt": 1}, "signature": "ee"}],
    });
    let r = parse_com_serving_record(&body).unwrap();
    assert_eq!(r.leases.len(), 2);
    assert!(r.leases[0].delegation.is_none() && r.leases[1].delegation.is_some());
    assert!(parse_com_serving_record(&json!({"regGen": 0})).is_none());
}

#[test]
fn stopped_apps_hold_no_slot_and_hand_theirs_on() {
    let k = format!("kitchen.john.{APEX}");
    let w = format!("woodshed.john.{APEX}");
    let notes = format!("notes.john.{APEX}");
    let mut a = Allocator::new(APEX);
    a.add_pod(&k, &[format!("notes.kitchen.john.{APEX}")], 1);
    a.add_pod_serving(&w, &[format!("notes.woodshed.john.{APEX}")], 2, false);
    assert_eq!(a.find_holder(&notes).as_deref(), Some(k.as_str()));
    a.set_apps_allowed(&k, false);
    assert_eq!(a.find_holder(&notes), None);
    a.set_apps_allowed(&w, true);
    assert_eq!(a.find_holder(&notes).as_deref(), Some(w.as_str()));
    a.set_apps_allowed(&k, true);
    assert_eq!(a.find_holder(&notes).as_deref(), Some(w.as_str()));
    a.remove_pod(&w);
    assert_eq!(a.find_holder(&notes).as_deref(), Some(k.as_str()));
    a.set_apps_allowed(&k, false);
    assert_eq!(
        a.request_transfer(&k, &notes).unwrap_err(),
        TransferError::AppsStopped
    );
}

#[test]
fn a_control_name_is_never_an_app_slot() {
    let home = format!("home.john.{APEX}");
    let evil = format!("evil.john.{APEX}");
    let mut a = Allocator::new(APEX);
    a.add_pod(&home, &[], 1);
    // A sibling declaring the other box's control name as a short service name gets no slot for it.
    a.add_pod(&evil, std::slice::from_ref(&home), 2);
    assert_eq!(a.find_holder(&home).as_deref(), Some(home.as_str()));
    assert_eq!(
        a.request_transfer(&evil, &home).unwrap_err(),
        TransferError::ControlNameReserved
    );
    a.remove_pod(&home);
    assert_eq!(a.find_holder(&home), None, "the claim never became a slot");
}

#[test]
fn routing_applies_the_serving_view_and_never_the_bare_name() {
    let mut r: Registry<&'static str> = Registry::new(APEX);
    let home = format!("home.alice.{APEX}");
    r.register(&home, "home", &[format!("notes.alice.{APEX}")], 1);
    assert_eq!(r.find_by_sni(&format!("notes.alice.{APEX}")), Some("home"));
    assert_eq!(r.find_by_sni(&format!("alice.{APEX}")), None);
    r.set_serving(
        &home,
        ServingView {
            control: true,
            apps: false,
        },
    );
    assert_eq!(r.find_by_sni(&home), Some("home"));
    assert_eq!(r.find_by_sni(&format!("notes.alice.{APEX}")), None);
    assert_eq!(r.find_by_sni(&format!("notes.home.alice.{APEX}")), None);
    r.set_serving(
        &home,
        ServingView {
            control: false,
            apps: false,
        },
    );
    assert_eq!(r.find_by_sni(&home), None);
}

//! The endpoint table, address pool and container match against the shared vectors
//! (packages/server-daemon/test-vectors/endpoints.json), which the TypeScript twin passes too.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

use flagship_core::endpoints::{
    AddressPool, ContainerObservation, Endpoint, EndpointEnv, EndpointKey, EndpointRole,
    EndpointTable, ExpectedContainer, Lease, matches_expected, parse_observation,
};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/server-daemon/test-vectors/endpoints.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or_else(|| panic!("{k} missing in {v}")).to_string()
}

fn key_of(text: &str) -> EndpointKey {
    let p: Vec<&str> = text.split('/').collect();
    EndpointKey {
        env: EndpointEnv::parse(p[0]).unwrap(),
        service_id: p[1].to_string(),
        component: p[2].to_string(),
        role: EndpointRole::parse(p[3]).unwrap(),
    }
}

fn endpoint_of(v: &Value) -> Endpoint {
    Endpoint {
        host: s(v, "host"),
        port: u16::try_from(v["port"].as_u64().unwrap()).unwrap(),
        generation: v["generation"].as_i64().unwrap(),
        incarnation: s(v, "incarnation"),
    }
}

fn observation_of(v: &Value) -> ContainerObservation {
    ContainerObservation {
        container_id: s(v, "containerId"),
        generation: v["generation"].as_i64(),
        service_label: v["serviceLabel"].as_str().map(str::to_string),
        running: v["running"].as_bool().unwrap(),
        started_at: s(v, "startedAt"),
        addresses: v["addresses"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, x)| (k.clone(), x.as_str().unwrap().to_string()))
            .collect::<BTreeMap<_, _>>(),
    }
}

fn expected_of(v: &Value) -> ExpectedContainer {
    ExpectedContainer {
        service_id: s(v, "serviceId"),
        container: s(v, "container"),
        network: s(v, "network"),
        address: v["address"].as_str().map(str::to_string),
        port: u16::try_from(v["port"].as_u64().unwrap()).unwrap(),
        generation: v["generation"].as_i64().unwrap(),
        unlabelled: v["unlabelled"].as_bool().unwrap_or(false),
    }
}

fn opt_str(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

fn expect_endpoint(got: Option<Endpoint>, want: &Value, what: &str) {
    match (got, want) {
        (None, Value::Null) => {}
        (Some(g), w) if !w.is_null() => assert_eq!(g, endpoint_of(w), "{what}"),
        (g, w) => panic!("{what}: got {g:?}, want {w}"),
    }
}

#[test]
fn pool_vectors() {
    for c in vectors()["pool"].as_array().unwrap() {
        let name = s(c, "name");
        let reserved: Vec<String> = c["reserved"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let reserved_refs: Vec<&str> = reserved.iter().map(String::as_str).collect();
        let made = AddressPool::new(&s(c, "subnet"), &reserved_refs, c["quarantineMs"].as_u64().unwrap());
        if c["constructError"].as_bool() == Some(true) {
            assert!(made.is_err(), "{name}: should refuse the subnet");
            continue;
        }
        let mut pool = made.unwrap();
        let mut clock = 0u64;
        for st in c["steps"].as_array().unwrap() {
            if let Some(n) = st["now"].as_u64() {
                clock = n;
            }
            let what = format!("{name}: {st}");
            match st["op"].as_str().unwrap() {
                "assign" => {
                    let r = pool.assign(&s(st, "owner"), clock);
                    if st["expectError"].as_bool() == Some(true) {
                        assert!(r.is_err(), "{what}");
                    } else {
                        assert_eq!(r.unwrap(), s(st, "expect"), "{what}");
                    }
                }
                "release" => pool.release(&s(st, "owner"), clock),
                "releasePrefix" => pool.release_prefix(&s(st, "prefix"), clock),
                "occupy" => pool.occupy(&s(st, "ip"), &s(st, "tag")),
                "adopt" => pool.adopt(&s(st, "owner"), &s(st, "ip")),
                "vacate" => pool.vacate(&s(st, "ip")),
                "ownerOf" => assert_eq!(pool.owner_of(&s(st, "ip")).map(str::to_string), opt_str(st, "expect"), "{what}"),
                "addressOf" => assert_eq!(pool.address_of(&s(st, "owner")).map(str::to_string), opt_str(st, "expect"), "{what}"),
                other => panic!("unknown pool op {other}"),
            }
        }
    }
}

#[test]
fn match_vectors() {
    for c in vectors()["match"].as_array().unwrap() {
        let got = matches_expected(&observation_of(&c["observation"]), &expected_of(&c["want"]));
        assert_eq!(got, opt_str(c, "expect"), "{}", s(c, "name"));
    }
}

#[test]
fn inspect_vectors() {
    for c in vectors()["inspect"].as_array().unwrap() {
        let got = parse_observation(&s(c, "json"));
        match &c["expect"] {
            Value::Null => assert!(got.is_none(), "{}", s(c, "name")),
            w => assert_eq!(got.unwrap(), observation_of(w), "{}", s(c, "name")),
        }
    }
}

#[test]
fn table_vectors() {
    for c in vectors()["table"].as_array().unwrap() {
        let name = s(c, "name");
        let table = EndpointTable::new();
        let mut leases: BTreeMap<String, Lease> = BTreeMap::new();
        let cancelled: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        for st in c["steps"].as_array().unwrap() {
            let what = format!("{name}: {st}");
            match st["op"].as_str().unwrap() {
                "publish" => table.publish(&key_of(&s(st, "key")), endpoint_of(&st["endpoint"])),
                "lookup" => expect_endpoint(table.lookup(&key_of(&s(st, "key"))), &st["expect"], &what),
                "acquire" => {
                    let l = table.acquire(&key_of(&s(st, "key")));
                    assert_eq!(l.is_some(), st["expect"].as_bool().unwrap(), "{what}");
                    if let Some(l) = l {
                        let lease_name = s(st, "lease");
                        let set = Arc::clone(&cancelled);
                        let n = lease_name.clone();
                        l.bind(move || {
                            set.lock().unwrap().insert(n);
                        });
                        leases.insert(lease_name, l);
                    }
                }
                "current" => assert_eq!(leases[&s(st, "lease")].current(), st["expect"].as_bool().unwrap(), "{what}"),
                "cancelled" => assert_eq!(cancelled.lock().unwrap().contains(&s(st, "lease")), st["expect"].as_bool().unwrap(), "{what}"),
                "openLeases" => assert_eq!(table.open_leases(&s(st, "service")), usize::try_from(st["expect"].as_u64().unwrap()).unwrap(), "{what}"),
                "invalidate" => table.invalidate(
                    &s(st, "service"),
                    opt_str(st, "env").and_then(|e| EndpointEnv::parse(&e)),
                    opt_str(st, "component").as_deref(),
                ),
                "beginStop" => table.begin_stop(
                    &s(st, "service"),
                    EndpointEnv::parse(&s(st, "env")).unwrap(),
                    opt_str(st, "component").as_deref(),
                ),
                other => panic!("unknown table op {other}"),
            }
        }
    }
}

mod reconciler {
    use super::*;
    use flagship_core::endpoints::{EndpointReconciler, next_generation, publish_from_observation, PublishResult};

    fn want() -> ExpectedContainer {
        ExpectedContainer {
            service_id: "svc".into(),
            container: "c".into(),
            network: "flagship-apps".into(),
            address: Some("10.89.2.5".into()),
            port: 8080,
            generation: 7,
            unlabelled: false,
        }
    }

    fn obs(id: &str, started: &str, running: bool) -> ContainerObservation {
        ContainerObservation {
            container_id: id.into(),
            generation: Some(7),
            service_label: Some("svc".into()),
            running,
            started_at: started.into(),
            addresses: BTreeMap::from([("flagship-apps".to_string(), "10.89.2.5".to_string())]),
        }
    }

    fn key() -> EndpointKey {
        key_of("live/svc/main/http")
    }

    #[test]
    fn publishes_only_a_sound_container() {
        let t = EndpointTable::new();
        assert_eq!(publish_from_observation(&t, &key(), &want(), None), PublishResult::Refused("the engine has no such container".into()));
        assert!(t.lookup(&key()).is_none());
        assert!(matches!(publish_from_observation(&t, &key(), &want(), Some(&obs("c1", "t1", false))), PublishResult::Refused(_)));
        assert!(t.lookup(&key()).is_none());
        let PublishResult::Ok(e) = publish_from_observation(&t, &key(), &want(), Some(&obs("c1", "t1", true))) else {
            panic!("not published")
        };
        assert_eq!((e.host.as_str(), e.port, e.generation, e.incarnation.as_str()), ("10.89.2.5", 8080, 7, "c1:t1"));
    }

    #[test]
    fn follows_the_engine_through_stop_restart_and_return() {
        let t = EndpointTable::new();
        let mut r = EndpointReconciler::new(t.clone());
        r.watch(key(), want());
        let mut engine: Option<ContainerObservation> = Some(obs("c1", "t1", true));
        r.tick(&mut |_| engine.clone());
        let lease = t.acquire(&key()).unwrap();
        let dropped = Arc::new(Mutex::new(false));
        let d = Arc::clone(&dropped);
        lease.bind(move || *d.lock().unwrap() = true);
        // the same incarnation: nothing changes
        r.tick(&mut |_| engine.clone());
        assert!(lease.current() && !*dropped.lock().unwrap());
        // restarted behind our back: the old connections close, the new incarnation is published
        engine = Some(obs("c1", "t2", true));
        r.tick(&mut |_| engine.clone());
        assert!(*dropped.lock().unwrap() && !lease.current());
        assert_eq!(t.lookup(&key()).unwrap().incarnation, "c1:t2");
        // stopped: invalidated, nothing published
        engine = Some(obs("c1", "t2", false));
        r.tick(&mut |_| engine.clone());
        assert!(t.lookup(&key()).is_none());
        // gone
        engine = None;
        r.tick(&mut |_| engine.clone());
        assert!(t.lookup(&key()).is_none());
        // unwatched services are left alone
        engine = Some(obs("c1", "t3", true));
        r.unwatch("svc", None, None);
        r.tick(&mut |_| engine.clone());
        assert!(t.lookup(&key()).is_none());
    }

    #[test]
    fn generations_never_repeat_or_go_back() {
        let mut last = 0;
        let a = next_generation(&mut last, 1_000);
        let b = next_generation(&mut last, 1_000);
        let c = next_generation(&mut last, 500);
        assert!(a < b && b < c);
        assert_eq!(a, 1_000);
    }
}

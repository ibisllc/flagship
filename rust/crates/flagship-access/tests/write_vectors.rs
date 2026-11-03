//! The access writes against the TypeScript implementation's (packages/server-daemon/test-vectors/access-writes.json):
//! the account people from the box's files, and per scenario step the result, the state file after it and the
//! journal digest. Also the socket's authoritative path: the state and journal files it writes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use flagship_access::access_journal::{AccessJournal, parse_entry};
use flagship_access::apply::{EntryResult, Facts, admissible, apply_entry};
use flagship_access::people::{Anchors, People, Person};
use flagship_access::store::{Store, same_state};
use flagship_access::writes::{
    WritePaths, handle_apply_entry, handle_journal_add, handle_people, handle_store_mutate,
};
use serde_json::{Value, json};

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/server-daemon/test-vectors/access-writes.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn people_of(c: &Value) -> People {
    let f = &c["files"];
    People::from_files(
        Anchors::from_json(&c["anchors"]).unwrap(),
        Some(&f["book"].to_string()),
        Some(&f["revocations"].to_string()),
        Some(&f["shares"].to_string()),
        true,
    )
}

#[test]
fn account_people_match_typescript() {
    let v = vectors();
    for c in v["people"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let p = people_of(c);
        let got = p.to_json();
        assert_eq!(got["devices"], c["expect"]["devices"], "{name}: devices");
        assert_eq!(
            got["coManagers"], c["expect"]["coManagers"],
            "{name}: co-managers"
        );
        for (k, want) in c["expect"]["classify"].as_object().unwrap() {
            let key = c["keys"][k].as_str().unwrap();
            let got = match p.classify(key) {
                None => Value::Null,
                Some(Person::Device { tier, legacy, .. }) => {
                    json!({ "kind": "device", "tier": tier.as_str(), "legacy": legacy })
                }
                Some(Person::CoManager(m)) => {
                    json!({ "kind": "co-manager", "shareId": m.share_id, "level": m.level })
                }
            };
            assert_eq!(&got, want, "{name}: classify {k}");
        }
    }
}

fn mutate(s: &mut Store, m: &str, a: &Value) -> Value {
    // Through the socket's own dispatcher, in a dry run over the state so far.
    let dir = std::env::temp_dir();
    let p = WritePaths::new(
        dir.join("never-state.json"),
        dir.join("never-journal.json"),
        dir.join("never-book.json"),
        dir.join("never-revocations.json"),
        dir.join("never-shares.json"),
    );
    let r = handle_store_mutate(
        &p,
        &json!({ "method": m, "args": a, "dryRun": true, "state": s.to_json().to_string() }),
    )
    .unwrap();
    *s = Store::parse(Some(&r["state"].to_string())).unwrap();
    r["result"].clone()
}

#[test]
fn every_scenario_step_matches_typescript() {
    let v = vectors();
    for sc in v["scenarios"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        let people = people_of(sc);
        let app = sc["installedApp"].as_str().unwrap();
        let now = sc["now"].as_u64().unwrap();
        let mut store = Store::default();
        let mut journal = AccessJournal::new();
        for (i, st) in sc["steps"].as_array().unwrap().iter().enumerate() {
            let note = st["note"].as_str().unwrap();
            let want = &st["expect"];
            if st["op"] == "apply" {
                let catching: Vec<String> = if st["catchingUp"] == true {
                    vec![app.to_owned()]
                } else {
                    Vec::new()
                };
                let f = Facts {
                    installed: st["installed"] != false,
                    catching_up: &catching,
                    now_ms: now,
                };
                let e = parse_entry(&st["entry"]).expect(note);
                let r = apply_entry(&mut store, &people, &f, app, &e);
                assert_eq!(r.as_str(), want["result"], "{name} #{i} {note}: result");
                let kept = !matches!(r, EntryResult::Refused | EntryResult::Skipped)
                    && admissible(&store, &people, &f, app, &e)
                    && journal.add(app, e);
                assert_eq!(json!(kept), want["kept"], "{name} #{i} {note}: kept");
            } else {
                let r = mutate(&mut store, st["method"].as_str().unwrap(), &st["args"]);
                assert_eq!(r, want["result"], "{name} #{i} {note}: result");
            }
            assert!(
                same_state(&store.to_json(), &want["state"]),
                "{name} #{i} {note}: state\n rust {}\n ts   {}",
                store.to_json(),
                want["state"]
            );
            assert_eq!(
                journal.digest(app),
                want["digest"],
                "{name} #{i} {note}: digest"
            );
        }
    }
}

#[test]
fn the_socket_writes_the_files_it_is_authoritative_for() {
    let v = vectors();
    let sc = &v["scenarios"][0];
    let dir = std::env::temp_dir().join(format!("flagship-access-writes-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = &sc["files"];
    std::fs::write(dir.join("book.json"), f["book"].to_string()).unwrap();
    std::fs::write(dir.join("rev.json"), f["revocations"].to_string()).unwrap();
    std::fs::write(dir.join("shares.json"), f["shares"].to_string()).unwrap();
    let p = WritePaths::new(
        dir.join("state.json"),
        dir.join("journal.json"),
        dir.join("book.json"),
        dir.join("rev.json"),
        dir.join("shares.json"),
    );
    let first = &sc["steps"][0];
    let args = json!({ "anchors": sc["anchors"], "serviceRef": sc["installedApp"], "installed": true, "entry": first["entry"], "now": sc["now"] });
    let r = handle_apply_entry(&p, &args).unwrap();
    assert_eq!(r["result"], "applied");
    let on_disk: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("state.json")).unwrap()).unwrap();
    assert!(same_state(&on_disk, &first["expect"]["state"]));
    // The same order again is stale and the file is unchanged.
    assert_eq!(handle_apply_entry(&p, &args).unwrap()["result"], "stale");
    let j = handle_journal_add(&p, &args).unwrap();
    assert_eq!(j["result"], "kept");
    assert_eq!(j["app"]["digest"], first["expect"]["digest"]);
    assert!(dir.join("journal.json").exists());
    // A forged entry is never kept, whoever hands it over.
    let forged = &sc["steps"][2];
    let j = handle_journal_add(&p, &json!({ "anchors": sc["anchors"], "serviceRef": sc["installedApp"], "installed": true, "entry": forged["entry"], "now": sc["now"] })).unwrap();
    assert_eq!(j["result"], "unverified");
    // The people are this side's own; a caller-supplied list is not read.
    let ppl = handle_people(&p, &json!({ "anchors": sc["anchors"] })).unwrap();
    assert_eq!(ppl["devices"], v["people"][0]["expect"]["devices"]);
    // An unreadable state file is never written over.
    std::fs::write(dir.join("state.json"), "{ torn").unwrap();
    assert!(handle_apply_entry(&p, &args).is_err());
    assert_eq!(
        std::fs::read_to_string(dir.join("state.json")).unwrap(),
        "{ torn"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

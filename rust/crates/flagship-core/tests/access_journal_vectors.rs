//! The access journal's pure rules against the shared vectors
//! (packages/server-daemon/test-vectors/access-journal.json), written from the TypeScript twin.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use flagship_core::access_journal::{
    AccessJournal, JOURNAL_CAP, entry_hash, entry_key, parse_entry,
};
use serde_json::{Value, json};

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/server-daemon/test-vectors/access-journal.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn parse_and_key_vectors() {
    for c in vectors()["parse"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        match parse_entry(&c["entry"]) {
            None => assert!(
                c["expect"].is_null(),
                "{name}: refused, but the twin accepted it"
            ),
            Some(e) => assert_eq!(
                entry_key(&e),
                c["expect"]["key"].as_str().unwrap(),
                "{name}"
            ),
        }
        if c["expect"].is_null() {
            assert!(
                parse_entry(&c["entry"]).is_none(),
                "{name}: accepted, but the twin refused it"
            );
        }
    }
}

#[test]
fn add_vectors() {
    for c in vectors()["add"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let mut j = AccessJournal::new();
        let results: Vec<bool> = c["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|raw| j.add("svc", parse_entry(raw).unwrap()))
            .collect();
        let want: Vec<bool> = c["expect"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_bool().unwrap())
            .collect();
        assert_eq!(results, want, "{name}");
        let mut keys: Vec<&str> = j.keys("svc");
        keys.sort_unstable();
        let want_keys: Vec<&str> = c["expect"]["keys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap())
            .collect();
        assert_eq!(keys, want_keys, "{name}");
        assert_eq!(
            j.digest("svc"),
            c["expect"]["digest"].as_str().unwrap(),
            "{name}"
        );
    }
}

#[test]
fn hash_vectors() {
    for c in vectors()["hash"].as_array().unwrap() {
        let e = parse_entry(&c["entry"]).unwrap();
        assert_eq!(
            entry_hash(&e),
            c["expect"].as_str().unwrap(),
            "{}",
            c["name"].as_str().unwrap()
        );
    }
}

fn rank(target: &str, issued: u64) -> Value {
    json!({"kind":"rank","order":{"serviceRef":"svc","target":target,"rank":"member","issuedAt":issued},"signature":"a".repeat(128)})
}

#[test]
fn the_journal_is_capped_per_app_but_a_known_key_can_still_be_replaced() {
    let mut j = AccessJournal::new();
    for i in 0..JOURNAL_CAP {
        assert!(j.add("svc", parse_entry(&rank(&format!("t{i}"), 1)).unwrap()));
    }
    assert!(!j.add("svc", parse_entry(&rank("one-too-many", 1)).unwrap()));
    assert!(
        j.add("svc", parse_entry(&rank("t0", 2)).unwrap()),
        "a newer order for a held key is not a new key"
    );
    assert!(
        j.add("other", parse_entry(&rank("t0", 1)).unwrap()),
        "another app has its own room"
    );
}

#[test]
fn load_round_trips_and_marks_a_damaged_file_lost() {
    let mut j = AccessJournal::new();
    j.add("svc", parse_entry(&rank("t1", 5)).unwrap());
    assert!(j.note_peers("svc", &["Home2.User.example", "home3.user.example"]));
    assert!(
        !j.note_peers("svc", &["home2.user.example"]),
        "already known, lower-cased"
    );
    let text = j.to_json();

    let mut back = AccessJournal::new();
    back.load(Some(&text));
    assert!(!back.was_lost());
    assert_eq!(back.digest("svc"), j.digest("svc"));
    assert_eq!(
        back.peers("svc"),
        vec![
            "home2.user.example".to_string(),
            "home3.user.example".to_string()
        ]
    );

    back.load(None);
    assert!(
        !back.was_lost() && back.apps().is_empty(),
        "no file is an empty journal, not a lost one"
    );
    back.load(Some("{not json"));
    assert!(back.was_lost() && back.apps().is_empty());
    back.load(Some("[]"));
    assert!(back.was_lost(), "an array is not a journal");

    // an entry in the file that no longer passes the shape check is dropped, not trusted
    let mut tampered: Value = serde_json::from_str(&text).unwrap();
    tampered["svc"]["entries"]["rank:t1"]["signature"] = json!("short");
    back.load(Some(&tampered.to_string()));
    assert!(back.keys("svc").is_empty());
    assert!(back.forget("svc"));
    assert!(!back.forget("svc"));
}

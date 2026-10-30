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

use flagship_relay::outbound::com_policy::{ComHostPolicy, HttpPost, Ttls};
use flagship_relay::outbound::{HostPolicy, HostRow};
use serde_json::{Value, json};

type Call = (String, Vec<(String, String)>, Value);

#[derive(Clone, Default)]
struct Canned {
    answers: Arc<Mutex<HashMap<String, (u16, Value)>>>,
    calls: Arc<Mutex<Vec<Call>>>,
}

impl Canned {
    fn answer(&self, host: &str, status: u16, body: Value) {
        self.answers
            .lock()
            .unwrap()
            .insert(host.to_owned(), (status, body));
    }
    fn checks(&self) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.0.ends_with("/api/outbound/check"))
            .count()
    }
}

impl HttpPost for Canned {
    fn post_json(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &Value,
    ) -> Result<(u16, Value), String> {
        self.calls.lock().unwrap().push((
            url.to_owned(),
            headers
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
            body.clone(),
        ));
        if url.ends_with("/report") {
            return Ok((200, json!({})));
        }
        let host = body["host"].as_str().unwrap_or_default().to_owned();
        self.answers
            .lock()
            .unwrap()
            .get(&host)
            .cloned()
            .ok_or_else(|| "unreachable".to_owned())
    }
}

fn policy(c: &Canned, ttl: Ttls) -> ComHostPolicy<Canned> {
    ComHostPolicy::new("https://com.test/", "s3cret", c.clone(), ttl)
}

#[tokio::test]
async fn com_decides_and_the_answer_is_cached_with_the_secret_and_only_the_host_sent() {
    let c = Canned::default();
    c.answer("ok.example.com", 200, json!({"allowed": true}));
    c.answer("no.example.com", 200, json!({"allowed": false}));
    let p = policy(&c, Ttls::default());
    assert!(p.allowed("OK.example.com").await);
    assert!(!p.allowed("no.example.com").await);
    assert!(p.allowed("ok.example.com").await);
    assert_eq!(c.checks(), 2, "the repeat is served from the cache");
    let calls = c.calls.lock().unwrap().clone();
    assert_eq!(calls[0].0, "https://com.test/api/outbound/check");
    assert_eq!(
        calls[0].1,
        vec![("x-usage-secret".to_owned(), "s3cret".to_owned())]
    );
    assert_eq!(
        calls[0].2,
        json!({"host": "ok.example.com"}),
        "nothing but the host is sent"
    );
}

#[tokio::test]
async fn when_com_is_unreachable_the_last_answer_stands_and_otherwise_only_known_providers() {
    let c = Canned::default();
    let p = policy(
        &c,
        Ttls {
            allowed: Duration::ZERO,
            blocked: Duration::ZERO,
            max_cached: 10,
        },
    );
    assert!(
        p.allowed("api.anthropic.com").await,
        "a known provider passes while .com is down"
    );
    assert!(
        !p.allowed("random.example.com").await,
        "an unseen host does not"
    );
    c.answer("seen.example.com", 200, json!({"allowed": true}));
    assert!(p.allowed("seen.example.com").await);
    c.answers.lock().unwrap().clear();
    assert!(
        p.allowed("seen.example.com").await,
        "the last answer stands through an outage"
    );
    c.answer("seen.example.com", 500, json!({}));
    assert!(
        p.allowed("seen.example.com").await,
        "a 500 is an outage too"
    );
}

#[tokio::test]
async fn once_com_says_the_new_host_cap_is_reached_unseen_hosts_are_refused_without_asking() {
    let c = Canned::default();
    c.answer(
        "new1.example.com",
        200,
        json!({"allowed": false, "reason": "new-host-cap"}),
    );
    c.answer("new2.example.com", 200, json!({"allowed": true}));
    let p = policy(&c, Ttls::default());
    assert!(!p.allowed("new1.example.com").await);
    let before = c.checks();
    assert!(
        !p.allowed("new2.example.com").await,
        "refused locally, .com is not asked"
    );
    assert_eq!(c.checks(), before);
}

#[tokio::test]
async fn the_cache_is_bounded() {
    let c = Canned::default();
    for i in 0..5 {
        c.answer(&format!("h{i}.example.com"), 200, json!({"allowed": true}));
    }
    let p = policy(
        &c,
        Ttls {
            max_cached: 2,
            ..Ttls::default()
        },
    );
    for i in 0..5 {
        assert!(p.allowed(&format!("h{i}.example.com")).await);
    }
    // h0 was dropped to make room: asking again costs a request
    let before = c.checks();
    p.allowed("h0.example.com").await;
    assert_eq!(c.checks(), before + 1);
}

#[tokio::test]
async fn totals_are_reported_best_effort_up_to_500_rows() {
    let c = Canned::default();
    let p = policy(&c, Ttls::default());
    p.report(vec![]);
    let rows: Vec<HostRow> = (0..600)
        .map(|i| HostRow {
            host: format!("h{i}.example.com"),
            streams: 1,
            up: 2,
            down: 3,
            refused: 0,
        })
        .collect();
    p.report(rows);
    for _ in 0..200 {
        if c.calls
            .lock()
            .unwrap()
            .iter()
            .any(|x| x.0.ends_with("/api/outbound/report"))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let calls = c.calls.lock().unwrap().clone();
    let report = calls
        .iter()
        .find(|x| x.0.ends_with("/api/outbound/report"))
        .unwrap();
    assert_eq!(report.2["rows"].as_array().unwrap().len(), 500);
    assert_eq!(
        report.2["rows"][0],
        json!({"host": "h0.example.com", "streams": 1, "up": 2, "down": 3, "refused": 0})
    );
}
